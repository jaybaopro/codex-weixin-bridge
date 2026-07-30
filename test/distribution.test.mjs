import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  renderLaunchAgentPlist,
  resolveServiceConfig,
} from "../src/service.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("distribution package exposes a global CLI and direct QR dependency", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.version, "0.4.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin["codex-weixin-bridge"], "./src/cli.mjs");
  assert.equal(pkg.dependencies["qrcode-terminal"], "0.12.0");
});

test("LaunchAgent rendering uses the installing user's paths", () => {
  const config = resolveServiceConfig({
    homeDir: "/Users/example",
    stateDir: "/Users/example/.codex-weixin-direct",
    cliPath: "/opt/team/codex-weixin-bridge/src/cli.mjs",
    nodePath: "/opt/node/bin/node",
    codexBin: "/Applications/Codex.app/Contents/Resources/codex",
    label: "com.example.codex-weixin",
  });
  const plist = renderLaunchAgentPlist(config);

  assert.match(plist, /com\.example\.codex-weixin/);
  assert.match(plist, /\/Users\/example\/\.codex-weixin-direct/);
  assert.match(plist, /\/opt\/team\/codex-weixin-bridge\/src\/cli\.mjs/);
  assert.doesNotMatch(plist, /jay\.bao/);
});

test("repo marketplace points to the private management plugin", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "codex-weixin-team");
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/codex-weixin-bridge",
  });

  const manifest = readJson(
    "plugins/codex-weixin-bridge/.codex-plugin/plugin.json",
  );
  assert.equal(manifest.name, "codex-weixin-bridge");
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.skills, "./skills/");
});

test("publishable runtime files contain no developer home path", () => {
  const relativePaths = [
    "README.md",
    "package.json",
    "src/cli.mjs",
    "src/service.mjs",
    "scripts/install-launch-agent.sh",
    "scripts/status-launch-agent.sh",
    "scripts/install-local.sh",
  ];
  for (const relativePath of relativePaths) {
    const text = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(text, /\/Users\/jay\.bao/, relativePath);
  }
});
