# syntax=docker/dockerfile:1.7
#
# Single-container image: Caddy on :80 serves the SPA and reverse-proxies
# /api + /images to a Node API on :3001. Supervisord runs both.
#
# Build context = repo root. See docker-compose.yml for the recommended
# /data + /config mount layout.

# ---------------------------------------------------------------------------
# 1) Pull Caddy from the official image (avoids adding their apt repo).
# ---------------------------------------------------------------------------
FROM caddy:2-alpine AS caddy-bin


# ---------------------------------------------------------------------------
# 2) Builder: pnpm install + monorepo build. Native modules (better-sqlite3)
#    compile against Node 22 here and are copied as-is into the runtime stage,
#    which uses the same Node version + libc (Debian Bookworm).
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    # Pin a stable browsers path that both stages share, so the Chromium
    # downloaded here is reachable from runtime.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Activate the pinned pnpm version via corepack rather than `npm i -g pnpm`,
# so it matches packageManager in package.json exactly.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# Workspace + lockfile first so dependency installs cache on package.json edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

# Now copy the rest of the source and build.
COPY tsconfig.base.json ./
COPY packages ./packages

RUN pnpm -r build

# Fetch Chromium + system deps for Playwright into the pinned browsers path.
# `playwright install-deps` needs root + apt; doing it in the builder keeps
# the runtime stage's apt layer focused on runtime-only packages.
RUN pnpm --filter @visual-compare/api exec playwright install --with-deps chromium


# ---------------------------------------------------------------------------
# 3) ImageMagick 7 from the upstream AppImage. Debian Bookworm's
#    `imagemagick` package is still 6.9.x (no unified `magick` entry point);
#    the API calls `magick compare …` / `magick identify` / `magick <image>
#    -blur …`, which is IM7-only syntax. We extract the AppImage (no FUSE
#    required for `--appimage-extract`) and copy the squashfs payload into
#    the runtime stage as /opt/magick, with a tiny shim that exports
#    LD_LIBRARY_PATH so the bundled libs load.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS magick-bin

ARG MAGICK_APPIMAGE_URL=https://imagemagick.org/archive/binaries/magick
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl file \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "$MAGICK_APPIMAGE_URL" -o /tmp/magick.appimage \
 && chmod +x /tmp/magick.appimage \
 && (cd /tmp && ./magick.appimage --appimage-extract) \
 && mv /tmp/squashfs-root /opt/magick \
 && /opt/magick/AppRun -version | head -n1


# ---------------------------------------------------------------------------
# 4) Runtime: slim Node image + ImageMagick + Caddy + supervisord + Chromium
#    runtime libs (fonts, libnss, etc.). No build toolchain.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # API process binds to localhost; Caddy is the only listener exposed.
    PORT=3001 \
    LISTEN_HOST=127.0.0.1 \
    # Default to /data so a single bind/volume mount is enough for state.
    DB_PATH=/data/visual-compare.sqlite \
    IMAGES_DIR=/data/images \
    LM_LAST_USE_PATH=/data/lm-last-use \
    # External LM endpoint by default — set LM_STUDIO_BASE_URL/API_KEY/MODEL
    # via the mounted /config/.env or compose env to point at your server.
    LM_BACKEND=none

# Runtime packages: supervisord (two-process orchestration), tini (PID 1
# signal forwarder), ca-certificates + wget (TLS + healthcheck), and the
# shared libs headless Chromium dlopen()s. Playwright's `install-deps`
# normally fetches these in the builder; we install them explicitly here
# because only the browsers payload is carried across the stage boundary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      wget \
      tini \
      supervisor \
      fonts-liberation \
      fonts-noto-color-emoji \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
 && rm -rf /var/lib/apt/lists/*

# Drop the extracted IM7 AppImage payload in /opt/magick and expose it as
# `magick` on PATH. A thin shim is more robust than symlinking AppRun
# directly — AppRun derives $APPDIR from $0, which breaks under symlinks
# placed outside the AppDir. Setting APPDIR explicitly + exec'ing AppRun
# sidesteps that.
COPY --from=magick-bin /opt/magick /opt/magick
RUN { \
      echo '#!/bin/sh'; \
      echo 'export APPDIR=/opt/magick'; \
      echo 'exec /opt/magick/AppRun "$@"'; \
    } > /usr/local/bin/magick \
 && chmod +x /usr/local/bin/magick \
 && /usr/local/bin/magick -version | head -n1

# Caddy binary from the alpine image; Caddy is statically linked so this works
# on Debian without pulling in any extra runtime libs.
COPY --from=caddy-bin /usr/bin/caddy /usr/local/bin/caddy

# Mirror the builder's /app layout so pnpm's symlinked node_modules resolve.
# We include the full top-level + per-package node_modules — pnpm's symlink
# tree only works when the directory structure matches the install.
WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/api/package.json ./packages/api/package.json
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/node_modules ./packages/api/node_modules
# Web build is served by Caddy from /app/web (matches docker/Caddyfile).
COPY --from=builder /app/packages/web/dist ./web

# Browser binaries.
COPY --from=builder /ms-playwright /ms-playwright

# Process orchestration + reverse proxy config.
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Persistent state + optional config mount points; created here so
# `docker run` without a volume still has writable destinations.
RUN mkdir -p /data /config

EXPOSE 80

# tini reaps zombies and forwards signals to supervisord, which in turn
# stops caddy + node cleanly on SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
