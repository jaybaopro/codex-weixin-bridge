#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
node "${script_dir}/../src/cli.mjs" service-install "$@"
