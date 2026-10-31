#!/bin/sh
set -eu
API_URL="${API_URL:-/api}"
OFERA_STAND="${OFERA_STAND:-prod}"
case "$API_URL" in
  *[!A-Za-z0-9:/._-]*)
    echo "API_URL содержит недопустимые символы: $API_URL" >&2
    exit 1
    ;;
esac
case "$OFERA_STAND" in
  dev|stage|prod) ;;
  *)
    echo "Неизвестный стенд: $OFERA_STAND" >&2
    exit 1
    ;;
esac

printf 'window.__CONFIG__ = { apiUrl: "%s", stand: "%s" };\n' "$API_URL" "$OFERA_STAND" > /usr/share/nginx/html/config.js
exec "$@"
