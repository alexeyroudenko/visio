#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
npm run build
rm -rf .deploy_stage
mkdir -p .deploy_stage
cp -r dist/. .deploy_stage/
AA_FORCE_TAR="${AA_FORCE_TAR:-1}" exec ../../deploy.sh visio .deploy_stage "$@"
