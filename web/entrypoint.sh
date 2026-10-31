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
# Значение попадает в заголовок ответа и в настройки nginx
OFERA_RELEASE="${OFERA_RELEASE:-dev}"
case "$OFERA_RELEASE" in
  *[!A-Za-z0-9._-]*)
    echo "OFERA_RELEASE содержит недопустимые символы: $OFERA_RELEASE" >&2
    exit 1
    ;;
esac
printf 'set $release "%s";\n' "$OFERA_RELEASE" > /tmp/release.conf

case "$OFERA_STAND" in
  dev|stage|prod) ;;
  *)
    echo "Неизвестный стенд: $OFERA_STAND" >&2
    exit 1
    ;;
esac

printf 'window.__CONFIG__ = { apiUrl: "%s", stand: "%s" };\n' "$API_URL" "$OFERA_STAND" > /usr/share/nginx/html/config.js
exec "$@"
