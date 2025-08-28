#!/usr/bin/env bash
set -euo pipefail

# Local → GitHub push
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "chore: update app (connections, prompt, runner)"
fi
GIT_SSH_COMMAND="ssh -i ./.ssh_api_eater/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.ssh_api_eater/known_hosts" git push origin main

# Local → Server sync via rsync (preserve server .env and node_modules)
RSYNC_SSH="ssh -p 404 -i ./.ssh_api_eater/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.ssh_api_eater/known_hosts"
rsync -e "$RSYNC_SSH" -avz --delete \
  --exclude='.git' \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='backend/node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='**/.env' \
  --exclude='**/.env.*' \
  --exclude='.ssh_api_eater/' \
  ./. batonsky@91.199.160.228:API-eater/

# Remote install + build + (re)start via PM2
REMOTE_CMDS='
  set -e
  cd API-eater
  if ! command -v pm2 >/dev/null 2>&1; then npm i -g pm2; fi
  npm --prefix backend ci || npm --prefix backend install
  npm --prefix frontend ci || npm --prefix frontend install
  npm --prefix frontend run build
  pm2 startOrReload ecosystem.config.js --update-env
'
ssh -p 404 -i ./.ssh_api_eater/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.ssh_api_eater/known_hosts batonsky@91.199.160.228 "$REMOTE_CMDS"

echo "Deployed to server and pushed to GitHub."
