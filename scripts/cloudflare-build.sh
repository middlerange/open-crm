#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CI=true
export VP_VERSION=0.1.24
export VP_NODE_MANAGER=no
export VP_HOME="${HOME}/.vite-plus"
export PATH="${VP_HOME}/bin:${PATH}"

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl --fail --silent --show-error --location https://vite.plus --output "$installer"
bash "$installer"

vp install --frozen-lockfile
vp run build:worker
vp exec tsc --noEmit
vp check
vp run test:unit
vp run test:deployment
