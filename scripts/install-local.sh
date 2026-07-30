#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
package_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-weixin-install.XXXXXX")"
trap 'rm -rf "${package_dir}"' EXIT

package_name="$(npm pack "${repo_dir}" --pack-destination "${package_dir}" --silent)"
npm install --global "${package_dir}/${package_name}"

cli_path="$(npm prefix --global)/bin/codex-weixin-bridge"
"${cli_path}" doctor
