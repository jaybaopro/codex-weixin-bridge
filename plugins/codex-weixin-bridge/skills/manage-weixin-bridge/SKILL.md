---
name: manage-weixin-bridge
description: Install, configure, bind, diagnose, update, or remove the local Weixin ClawBot to Codex bridge. Use when the user asks about 微信直连 Codex, ClawBot bridge status, QR login, project whitelists, Codex task binding, the macOS background service, bridge upgrades, or safe uninstallation.
---

# Manage the Weixin bridge

Manage the `codex-weixin-bridge` CLI without weakening its one-user,
project-scoped security boundary.

## Safety rules

- Run `codex-weixin-bridge doctor` before making changes.
- Never print or read the contents of `credentials.json`, QR payloads, account IDs,
  full task IDs, or message bodies.
- Ask for explicit confirmation before QR login, adding a project, changing a
  binding, installing or removing the background service, or updating the package.
- Add only the exact project directory named by the user. Resolve it to an existing
  absolute directory before registration.
- Keep one user and one local state directory per bridge instance. Do not enable
  group access, shared credentials, arbitrary paths, network access, MCP tools, or
  multi-user routing.
- Use CLI commands instead of editing files under `~/.codex-weixin-direct/`.
- Do not remove the state directory during ordinary uninstallation. Credential or
  state deletion requires a separate, explicit user request.

## Choose the workflow

### Diagnose

1. Run `codex-weixin-bridge doctor`.
2. Run `codex-weixin-bridge service-status` when the user asks about the
   background process.
3. Inspect only redacted logs from `~/.codex-weixin-direct/`; do not expose
   credentials or message content.
4. Report the failing layer separately: CLI, Codex App Server, project isolation,
   Weixin authorization, binding, or LaunchAgent.

### Install the CLI from a checked-out private repository

1. Confirm the repository is the team-approved source.
2. Run `zsh scripts/install-local.sh` from the repository root after approval.
3. Run `codex-weixin-bridge doctor`.
4. Stop if the isolation self-check fails.

### Authorize Weixin

1. Explain that scanning binds the local service to the authorizing Weixin user.
2. After confirmation, run `codex-weixin-bridge login`.
3. Let the user scan the displayed QR code locally.
4. Report success without repeating the user ID or token.

### Register a project and bind a task

1. Confirm the exact project directory and user-facing project name.
2. Run:

   ```bash
   codex-weixin-bridge project-add \
     --id "stable-project-id" \
     --name "Project name" \
     --cwd "/absolute/project/path"
   ```

3. List only tasks from that project:

   ```bash
   codex-weixin-bridge threads --cwd "/absolute/project/path"
   ```

4. Confirm the selected task by name before binding it.
5. Run:

   ```bash
   codex-weixin-bridge bind \
     --cwd "/absolute/project/path" \
     --thread-id "selected-task-id"
   ```

6. Run `codex-weixin-bridge doctor` again.

### Install or remove the macOS service

- Preview with `codex-weixin-bridge service-render`.
- After confirmation, install with `codex-weixin-bridge service-install`.
- Verify with `codex-weixin-bridge service-status`.
- Remove only after confirmation with
  `codex-weixin-bridge service-uninstall`.

### Update

1. Confirm no bridge turn or approval is active.
2. Stop the service with `codex-weixin-bridge service-uninstall`.
3. In the approved repository checkout, fast-forward to the reviewed version.
4. Run `zsh scripts/install-local.sh`.
5. Reinstall and verify the service only after confirmation.

Preserve `~/.codex-weixin-direct/` so authorization, project registration, and
binding survive ordinary upgrades.
