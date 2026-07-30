# 微信直连 Codex 桥接器

团队内测版 `0.4.0`：让每位同事在自己的 Mac 上，通过自己的微信 ClawBot
继续自己的 Codex 项目任务。

代码可以放在团队私有 GitHub 仓库中分发，不需要提交到 Codex 官方插件目录。
运行时直接连接腾讯微信 iLink 和本机 Codex App Server，不启动或经过
OpenClaw Gateway。

## 安全边界

- 只允许扫码授权时返回的微信用户 ID。
- 一个本地实例只有一个当前 `项目 + Codex 任务` 绑定。
- 微信只能浏览预先登记在 `projects.json` 中的项目，不接受任意本机路径。
- 文件读取在操作系统权限层只开放当前绑定项目，切换后旧项目不再可读。
- Codex 默认只读；项目内文件修改必须在微信逐次确认。
- 审批使用约 5 分钟失效的 4 位一次性码，不支持整段会话放行。
- 网络、Web 搜索、应用、MCP、插件工具、子代理、删除、外部发送和发布会被拒绝。
- 传统命令提权一律拒绝，避免绕过项目边界。
- 项目根目录不能相互嵌套，绑定时会核验任务确实属于该项目。
- 单实例锁会阻止两个桥接进程同时写同一任务。
- Codex App Server 使用本机 `stdio`，不监听网络端口。
- 日志和审计元数据不记录微信消息正文。

当前版本按“一位同事、一台 Mac、一个微信授权身份、一个状态目录”设计。不要让
多位同事共用同一个桥接实例。

## 支持环境

- macOS
- Node.js 22 或更高版本
- 已安装并登录 Codex 桌面版或 CLI
- 同事对自己的本地项目目录拥有正常访问权限

Windows/Linux 常驻服务尚未接入。

## 从团队 GitHub 安装

先确保自己的 GitHub 账号已经获得私有仓库访问权限，然后运行：

```bash
git clone https://github.com/jaybaopro/codex-weixin-bridge.git
cd codex-weixin-bridge
zsh scripts/install-local.sh
```

脚本会把 CLI 安装到当前用户的 npm 全局目录并执行安全自检。它不会自动扫码、
添加项目、绑定任务或启动常驻服务。

也可以手动安装：

```bash
npm install --global .
codex-weixin-bridge doctor
```

## 首次配置

### 1. 微信授权

```bash
codex-weixin-bridge login
```

微信凭证保存在 `~/.codex-weixin-direct/credentials.json`。状态目录权限为
`0700`，敏感文件权限为 `0600`。

### 2. 登记允许访问的项目

把示例替换为同事自己的项目名称和绝对路径：

```bash
codex-weixin-bridge project-add \
  --id "my-project" \
  --name "My project" \
  --cwd "/absolute/path/to/project"
```

查看白名单：

```bash
codex-weixin-bridge projects
```

### 3. 选择并绑定 Codex 任务

只列出指定项目的任务：

```bash
codex-weixin-bridge threads --cwd "/absolute/path/to/project"
```

确认任务名称后绑定：

```bash
codex-weixin-bridge bind \
  --cwd "/absolute/path/to/project" \
  --thread-id "019..."
```

最后再次验证：

```bash
codex-weixin-bridge doctor
```

## macOS 常驻服务

桥接器会根据使用者自己的 Home 目录、Node 路径、Codex 路径和状态目录动态生成
LaunchAgent，不包含开发者个人路径。

先预览：

```bash
codex-weixin-bridge service-render
```

安装并检查：

```bash
codex-weixin-bridge service-install
codex-weixin-bridge service-status
```

停止并移除常驻服务：

```bash
codex-weixin-bridge service-uninstall
```

卸载服务不会删除微信凭证、项目白名单、任务绑定或审计记录。

服务日志位于：

- `~/.codex-weixin-direct/service.log`
- `~/.codex-weixin-direct/service.error.log`
- `~/.codex-weixin-direct/audit.jsonl`

## 微信控制命令

```text
当前任务
项目列表
项目 1
任务列表
切换 3
取消任务
帮助
```

项目和任务只显示短编号。执行切换后仍需回复一次性确认码；有任务正在运行或等待
审批时禁止切换。微信侧不能提交完整任务 ID 或任意项目路径。

项目文件写入需要回复：

```text
同意 4821
拒绝 4821
```

## 可选的 Codex Plugin 和管理 Skill

`plugins/codex-weixin-bridge/` 是仓库内的私有管理入口，不是官方插件投稿。

直接从团队私有 GitHub 仓库添加：

```bash
codex plugin marketplace add jaybaopro/codex-weixin-bridge
codex plugin add codex-weixin-bridge@codex-weixin-team
```

安装后，新建 Codex 任务并调用 `$manage-weixin-bridge`，Codex 会按照固定安全流程
完成诊断、扫码、项目登记、任务绑定、服务安装或更新。

这个 marketplace 是团队私有来源，不会出现在官方公共插件目录。私有仓库成员
需要先在本机配置 GitHub 访问权限。

## 开发验证

```bash
npm ci
npm test
npm pack --dry-run
```

GitHub Actions 会在 macOS 和 Node.js 22 环境中执行这些检查。

## 协议和第三方组件

- 微信侧依据腾讯 `Tencent/openclaw-weixin` 仓库公开的 iLink HTTP 协议和
  QR 登录流程实现。
- Codex 侧依据 Codex App Server JSON-RPC 协议实现。
- 二维码由项目直接依赖的 MIT `qrcode-terminal` 生成，不要求安装 OpenClaw。

禁止提交的本地文件、凭证处理和问题报告要求见 `SECURITY.md`。
