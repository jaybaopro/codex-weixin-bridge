---
name: manage-weixin-bridge
description: Install, configure, bind, diagnose, update, back up, migrate, log out, or remove the local Weixin ClawBot to Codex bridge. Use when the user asks about 微信直连 Codex, ClawBot bridge status, QR login, project whitelists, Codex task binding, macOS or Windows background service, bridge upgrades, safe migration, or uninstallation.
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
- Never copy `credentials.json` to another machine. Use the safe backup and require
  a new QR login and task binding on the destination.
- Treat `logout` as a local credential removal. Do not claim Tencent server-side
  revocation unless the upstream protocol adds a documented, verified endpoint.

## Choose the workflow

### Diagnose

1. Run `codex-weixin-bridge doctor`.
2. Run `codex-weixin-bridge service-status` when the user asks about the
   background process.
3. Use `codex-weixin-bridge doctor --json` when a machine-readable redacted
   diagnostic report is useful.
4. Inspect only redacted logs from `~/.codex-weixin-direct/`; do not expose
   credentials or message content.
5. Report the failing layer separately: CLI, Codex App Server, project isolation,
   Weixin authorization, binding, or LaunchAgent.

### Install the CLI from a checked-out private repository

1. Confirm the repository is the team-approved source.
2. On macOS, run `zsh scripts/install-local.sh` from the repository root after
   approval. On Windows, run
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1`.
3. Run `codex-weixin-bridge doctor`.
4. Stop if the isolation self-check fails.

### First-time setup

1. Prefer `codex-weixin-bridge setup` so the user sees the project and task
   selection in one resumable wizard.
2. If the user already named the exact project and approved the defaults, the
   Agent may pass `--cwd`, `--project-name`, `--project-id`, `--thread-index`,
   and `--yes`.
3. Never choose an arbitrary project or task merely to avoid asking the user.
4. Verify the final binding by project name and task name, not by printing IDs.

### Authorize Weixin manually

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

### Install or remove the background service

- Preview with `codex-weixin-bridge service-render`.
- After confirmation, install with `codex-weixin-bridge service-install`.
- Verify with `codex-weixin-bridge service-status`.
- Restart an installed service with `codex-weixin-bridge service-restart`; do
  not uninstall and reinstall merely to restart it.
- Remove only after confirmation with
  `codex-weixin-bridge service-uninstall`.
- macOS uses LaunchAgent; Windows uses a per-user Task Scheduler task.

### Update

1. Confirm no bridge turn or approval is active.
2. Run `codex-weixin-bridge check-update`.
3. After confirmation, run `codex-weixin-bridge upgrade`.
4. The command must verify the Release checksum, preserve a safe backup, stop
   and restart the service, run `doctor`, and roll back on failure.
5. Do not enable silent upgrades for ordinary colleagues; `upgrade --yes` is
   limited to a separately approved managed environment.

Preserve `~/.codex-weixin-direct/` so authorization, project registration, and
binding survive ordinary upgrades.

### Safe backup, migration, and logout

- Create a non-secret backup with `codex-weixin-bridge backup`.
- Restore with `codex-weixin-bridge restore --input "<file>"`, then run `setup`.
- Explain that project paths may need remapping and a new QR login/task binding
  is mandatory.
- Use `codex-weixin-bridge logout` only after explicit confirmation. It creates
  a safe backup, stops the service, deletes local credentials/runtime/binding,
  and preserves the project registry and audit log.
