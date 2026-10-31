#!/usr/bin/env bash
# set-release.sh <стенд> <тег>: пишет тег в deploy/<стенд>.env на ветке deploy, оттуда его читает агент.
# Ветка отдельная: main защищён и принимает только PR, а история кода не засоряется коммитами выкаток
set -euo pipefail

stand=${1:-}
tag=${2:-}
[[ $stand =~ ^(stage|prod)$ ]] || { echo "Неизвестный стенд: $stand" >&2; exit 1; }
[[ $tag =~ ^[0-9a-f]{40}$ ]] || { echo "Нужен полный SHA коммита: $tag" >&2; exit 1; }

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

if git ls-remote --exit-code --heads origin deploy > /dev/null; then
  git fetch --depth=1 origin deploy
  git switch --force-create deploy FETCH_HEAD
else
  git switch --orphan deploy
fi

mkdir -p deploy
printf 'IMAGE_TAG=%s\n' "$tag" > "deploy/$stand.env"
git add "deploy/$stand.env"

if git diff --cached --quiet; then
  echo "На $stand уже $tag"
  exit 0
fi
git commit -q -m "$stand: $tag"
git push -q origin deploy
echo "$stand → $tag"
