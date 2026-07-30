#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
dist_dir="${repo_dir}/dist"
bridge_npm_cache="${TMPDIR:-/tmp}/codex-weixin-release-npm-cache"
mkdir -p "${dist_dir}" "${bridge_npm_cache}"

package_name="$(npm pack "${repo_dir}" \
  --pack-destination "${dist_dir}" \
  --cache "${bridge_npm_cache}" \
  --silent)"
archive="${dist_dir}/${package_name}"
(
  cd "${dist_dir}"
  shasum -a 256 "${package_name}" > "${package_name}.sha256"
)

echo "${archive}"
echo "${archive}.sha256"
