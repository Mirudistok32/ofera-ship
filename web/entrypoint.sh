#!/bin/sh
# Один образ на все стенды: адрес API приходит при старте контейнера, а не при сборке
set -eu

# Без настройки API за тем же nginx: один origin, CORS не нужен
API_URL="${API_URL:-/api}"
# Имя стенда для плашки, у прода плашки нет
OFERA_STAND="${OFERA_STAND:-prod}"

# Значение попадает в код страницы: кавычка в нём превратила бы настройку в скрипт
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

# Старый HTML и открытые вкладки ещё просят чанки прошлых релизов: храним ASSET_RELEASES последних
ASSET_RELEASES="${ASSET_RELEASES:-3}"
case "$ASSET_RELEASES" in
  ''|*[!0-9]*|0)
    echo "ASSET_RELEASES должно быть числом больше нуля: $ASSET_RELEASES" >&2
    exit 1
    ;;
esac
mkdir -p /srv/releases/public/assets /srv/releases/lists
current=$(ls /usr/share/nginx/html/assets)
list=/srv/releases/lists/$(echo "$current" | cksum | cut -d' ' -f1)
cp -n /usr/share/nginx/html/assets/* /srv/releases/public/assets/
echo "$current" > "$list"
ls -t /srv/releases/lists | tail -n +"$((ASSET_RELEASES + 1))" | while read -r old; do
  rm "/srv/releases/lists/$old"
done
for file in /srv/releases/public/assets/*; do
  grep -qxF "${file##*/}" /srv/releases/lists/* || rm "$file"
done

# exec: nginx заменяет оболочку и сам получает SIGTERM от docker stop
exec "$@"
