# syntax=docker/dockerfile:1.7
#
# Single-container image: Caddy on :80 serves the SPA and reverse-proxies
# /api + /images to a Node API on :3001. Supervisord runs both.
#
# Build context = repo root. See docker-compose.yml for the recommended
# /data + /config mount layout.

# ---------------------------------------------------------------------------
# 1) Pull Caddy from the official image (avoids adding their apt repo).
#    Pinned by digest for reproducibility; bump in lockstep with the upstream
#    Caddy release notes.
# ---------------------------------------------------------------------------
FROM caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794 AS caddy-bin


# ---------------------------------------------------------------------------
# 2) Builder: pnpm install + monorepo build. Native modules (better-sqlite3)
#    compile against Node 24 here and are copied as-is into the runtime stage,
#    which uses the same Node version + libc (Debian Trixie).
# ---------------------------------------------------------------------------
FROM node:24-trixie@sha256:8202a46483627d14c75c8078d8c1b1d8ec14b792390c7001adb4f698724c4ca9 AS builder

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

# Stage a prod-only deployment tree for the API. `pnpm deploy --prod` copies
# the API package + its production deps into a self-contained tree at the
# target path (no pnpm symlinks). The runtime picks this up verbatim and
# skips dev dependencies (esbuild's Go binary, vitest, tsx, typescript, etc.)
# entirely — that's where the bulk of "shipped but never executed" scanner
# findings live.
RUN pnpm --filter @visual-compare/api deploy --prod --legacy /deploy-api


# ---------------------------------------------------------------------------
# 3) ImageMagick 7 from the upstream AppImage. Debian's `imagemagick` package
#    is still 6.9.x in trixie (no unified `magick` entry point); the API
#    calls `magick compare …` / `magick identify` / `magick <image> -blur …`,
#    which is IM7-only syntax. We extract the AppImage (no FUSE required for
#    `--appimage-extract`) and copy the squashfs payload into the runtime
#    stage as /opt/magick, with a tiny shim that exports APPDIR so the
#    bundled libs load.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim@sha256:b6e2a152f22a40ff69d92cb397223c906017e1391a73c952b588e51af8883bf8 AS magick-bin

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
#    runtime libs (fonts, libnss, etc.). No build toolchain. Same Node major
#    and libc as the builder so prebuilt native modules load unchanged.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7 AS runtime

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
#
# `apt-get upgrade -y` picks up any out-of-band security fixes published
# since the base image was tagged — defense in depth against base-image
# stagnation between rebuilds.
RUN apt-get update \
 && apt-get upgrade -y \
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
# The API runs from a self-contained pnpm `deploy --prod` tree.
COPY --from=builder /deploy-api ./packages/api
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
