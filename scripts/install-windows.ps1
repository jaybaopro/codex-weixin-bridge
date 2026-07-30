$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
$NodeVersion = (& node --version 2>$null)
if (-not $NodeVersion) {
    throw "未找到 Node.js。请先运行：winget install --id OpenJS.NodeJS.LTS"
}

$MajorVersion = [int](($NodeVersion -replace "^v", "").Split(".")[0])
if ($MajorVersion -lt 22) {
    throw "需要 Node.js 22 或更高版本，当前为 $NodeVersion。"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-weixin-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TempDir | Out-Null
$NpmCache = Join-Path $TempDir "npm-cache"

try {
    $PackageName = (& npm pack $RepoDir --pack-destination $TempDir --cache $NpmCache --silent | Select-Object -Last 1)
    if (-not $PackageName) {
        throw "无法生成安装包。"
    }
    & npm install --global --cache $NpmCache (Join-Path $TempDir $PackageName)
    if ($LASTEXITCODE -ne 0) {
        throw "npm 全局安装失败。"
    }
    & codex-weixin-bridge doctor
    if ($LASTEXITCODE -ne 0) {
        throw "安装完成，但安全自检失败。"
    }

    Write-Host ""
    Write-Host "CLI 已安装。现在启动一键配置向导。"
    & codex-weixin-bridge setup
} finally {
    if (Test-Path $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
}
