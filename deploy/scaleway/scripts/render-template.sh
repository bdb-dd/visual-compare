#!/usr/bin/env bash
# Render a deploy/scaleway template by substituting __PLACEHOLDERS__.
#
# Why not envsubst? Cloud-init YAML embeds shell scripts that already use
# `$VAR`; running envsubst over the whole file would clobber those. We
# only want to replace the `__UPPER_SNAKE__` placeholders we explicitly
# put in the templates. sed with `|` as the delimiter is enough.
#
# Usage:
#   render-template.sh <template-file> KEY=VALUE [KEY=VALUE...]
#
# Multi-line VALUEs are supported by reading from files: pass the value
# as `@/path/to/file`. The file content is inlined verbatim (YAML-quoted
# where needed by the caller — we don't try to second-guess context).

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <template> KEY=VALUE [KEY=VALUE...]" >&2
  exit 2
fi

template="$1"; shift
[ -f "$template" ] || { echo "template not found: $template" >&2; exit 1; }

out="$(cat "$template")"
for kv in "$@"; do
  key="${kv%%=*}"
  value="${kv#*=}"
  if [[ "$value" == @* ]]; then
    file="${value#@}"
    [ -f "$file" ] || { echo "value file not found: $file" >&2; exit 1; }
    value="$(cat "$file")"
  fi
  # Use a printf-safe sed replacement via a delimiter that's unlikely to
  # appear in our substitutions. Newlines in VALUE are handled by piping
  # through awk; sed can't substitute multi-line replacements portably.
  out="$(awk -v key="__${key}__" -v val="$value" '
    BEGIN { n = length(key) }
    {
      while ((i = index($0, key)) > 0) {
        $0 = substr($0, 1, i - 1) val substr($0, i + n)
      }
      print
    }
  ' <<< "$out")"
done

printf '%s\n' "$out"
