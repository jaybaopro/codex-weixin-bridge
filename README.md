# 微信直连 Codex 桥接器

团队内测版 `0.6.1`：让每位同事在自己的 Mac 或 Windows 电脑上，通过自己的微信 ClawBot
继续自己的 Codex 项目任务。

代码通过公开 GitHub 仓库分发，不需要提交到 Codex 官方插件目录。
运行时直接连接腾讯微信 iLink 和本机 Codex App Server，不启动或经过
OpenClaw Gateway。

仓库公开可见，但当前仍采用 `Internal Use Notice`：公开可见不等于授予外部商业
分发或再许可权。团队成员可以按组织授权使用。

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
- 普通消息可以排队和短窗口合并，但每一批仍顺序进入同一个绑定任务；审批不会合并。
- 微信只显示输入状态和有限运行状态，不发送 Codex 隐藏推理、工具参数或原始工具输出。
- 只接收图片、PDF 和指定 UTF-8 文本格式；附件先做下载来源、大小、类型、文件名、
  AES 解密及哈希/声明元数据校验。
- 图片只在当前用户私有状态目录的隔离收件箱短暂保存，任务完成、清空队列、服务退出
  或退出授权时清理；PDF 和文本不会写进项目目录。
- 附件内容作为不可信只读数据交给 Codex，不会被解释为切换、状态或审批命令，也不会
  因附件而扩大项目权限。语音、视频、可执行文件和扫描 PDF OCR 暂不开放。

当前版本按“一位同事、一台电脑、一个微信授权身份、一个状态目录”设计。不要让
多位同事共用同一个桥接实例。

## 支持环境

- macOS 13 或更新版本
- Windows 11（Windows 10 仅做尽力支持）
- Node.js 22 或更高版本
- 已安装并登录 Codex 桌面版或 CLI
- 同事对自己的本地项目目录拥有正常访问权限

macOS 使用当前用户的 LaunchAgent；Windows 使用当前用户的登录计划任务，不要求
把桥接器安装成管理员级系统服务。Linux 常驻服务尚未接入。

## 通过 GitHub 和本机 Agent 安装

把仓库链接交给同事电脑上的 Codex Agent，或直接运行：

```bash
git clone https://github.com/jaybaopro/codex-weixin-bridge.git
cd codex-weixin-bridge
zsh scripts/install-local.sh
```

脚本会把 CLI 安装到当前用户的 npm 全局目录并执行安全自检。完成安装后运行：

```bash
codex-weixin-bridge setup
```

Agent 可以在获得网络和命令执行批准后完成 clone、安装及启动向导；扫码、全局安装、
后台服务安装仍需要使用者确认。GitHub 链接本身不能绕过公司设备策略。

## Windows 通过 GitHub 和本机 Agent 安装

先安装 Git、Node.js 22 和 Codex，然后在 PowerShell 中运行：

```powershell
git clone https://github.com/jaybaopro/codex-weixin-bridge.git
cd codex-weixin-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

安装脚本会执行自检并打开同一套 `setup` 向导。Agent 也可以按此流程协助安装；
如果设备由公司集中管理，PowerShell 执行策略、GitHub 网络访问或计划任务策略
仍可能需要 IT 放行。

也可以手动安装：

```bash
npm install --global .
codex-weixin-bridge doctor
```

## 首次配置

推荐直接运行：

```bash
codex-weixin-bridge setup
```

向导会依次检查 Codex、微信扫码、登记项目、列出该项目的任务、绑定任务并安装
当前平台的用户级常驻服务。中断后可以重新运行，已完成的微信授权会被复用。

Agent 自动化可传入已确认的非敏感选项：

```bash
codex-weixin-bridge setup \
  --cwd "/absolute/project/path" \
  --project-name "Project name" \
  --project-id "project-id" \
  --thread-index 1 \
  --yes
```

`--yes` 只接受向导内的预期步骤，不会放宽项目隔离或微信侧写入审批。以下命令仍可
用于分步配置和排错。

### 1. 微信授权

```bash
codex-weixin-bridge login
```

微信凭证保存在 `~/.codex-weixin-direct/credentials.json`。macOS 状态目录权限为
`0700`、敏感文件为 `0600`；Windows 使用 `icacls` 关闭继承并只授权当前用户。

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

## macOS / Windows 常驻服务

桥接器会根据使用者自己的 Home 目录、Node 路径、Codex 路径和状态目录动态生成
macOS LaunchAgent 或 Windows 用户级计划任务，不包含开发者个人路径。

先预览：

```bash
codex-weixin-bridge service-render
```

安装并检查：

```bash
codex-weixin-bridge service-install
codex-weixin-bridge service-status
```

重启已安装的服务：

```bash
codex-weixin-bridge service-restart
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

## 检查更新与安全升级

公开 GitHub Release 无需登录即可查询：

```bash
codex-weixin-bridge check-update
codex-weixin-bridge upgrade
```

`upgrade` 会在确认后创建不含凭证的安全备份、停止服务、下载 GitHub Release 中的
npm 安装包、核验 SHA-256、安装新版本、执行 `doctor` 并恢复服务。任何一步失败会
尝试自动安装本次升级前生成的回滚包。无人值守的受控环境可以使用
`codex-weixin-bridge upgrade --yes`；普通同事默认保留确认，不做静默升级。

每个 Release 必须包含且仅包含：

- `codex-weixin-direct-bridge-<version>.tgz`
- `codex-weixin-direct-bridge-<version>.tgz.sha256`

推送 `v*` tag 后，Release workflow 会在 macOS 和 Windows 上通过测试，再自动创建或
更新对应 GitHub Release 并上传这两个升级资产。

## 退出微信授权、备份和迁移

创建默认安全备份：

```bash
codex-weixin-bridge backup
```

指定文件并在另一台电脑导入：

```bash
codex-weixin-bridge backup --output "/safe/path/bridge-backup.json"
codex-weixin-bridge restore --input "/safe/path/bridge-backup.json"
codex-weixin-bridge setup
```

安全备份只保存项目登记和脱敏的绑定提示，不保存微信凭证、消息正文、日志、账号
ID 或完整任务 ID。迁移到新电脑后必须重新扫码、映射本机项目路径并重新选择任务；
当前版本不提供“复制在线微信 token 到另一台机器”的迁移模式。

退出本机授权：

```bash
codex-weixin-bridge logout
```

它会先创建安全备份，停止服务，并删除本机凭证、运行游标、二维码和当前绑定；
项目白名单与审计记录保留。腾讯目前公开的 iLink 接口没有可验证的服务端撤销
端点，因此此命令只承诺本机退出，不声称已在腾讯服务器远程吊销 token。

## 微信控制命令

```text
当前任务
状态
项目列表
项目 1
任务列表
切换 3
取消任务
清空队列
重连
帮助
```

项目和任务只显示短编号。执行切换后仍需回复一次性确认码；有任务正在运行或等待
审批、短消息合并或排队时禁止切换。微信侧不能提交完整任务 ID 或任意项目路径。

普通消息会先等待约 2.5 秒，以便合并连续发送的短句。Codex 忙碌时，新消息会进入
同一任务的顺序队列，不再被直接拒绝。`取消任务` 只取消当前运行项，`清空队列`
只清除尚未开始的消息。`状态`会显示当前项目和任务、运行时长、队列、待审批数量、
连接状态、最近收取/回复时间和版本号。

任务运行时会使用腾讯公开的 `getConfig` / `sendTyping` 接口显示微信输入状态。
如果 Codex 连续 10 分钟没有任何任务活动，看门狗会中断当前项并继续后续队列。
微信长轮询异常采用指数退避；`errcode=-14` 会明确记录为授权失效，需要在电脑重新
运行 `login` 和 `service-restart`。

## 微信附件

直接在与 ClawBot 的单聊中发送附件，可以附带一句处理要求。每条微信消息最多接收
1 个附件：

- 图片：PNG、JPEG、GIF、WebP，明文不超过 15 MB、单边不超过 16,384 像素，
  总像素不超过 6,400 万；
- PDF：不超过 10 MB、200 页，必须能直接提取文字；扫描件暂不 OCR；
- 文本：TXT、Markdown、CSV、JSON、XML、YAML、LOG，必须是 UTF-8，
  文件不超过 2 MB；
- 提取后的文字最多 250,000 字符，超过时会拒绝并要求拆分，不会静默截断。

附件通过腾讯 CDN 下载时只允许 `https://*.cdn.weixin.qq.com`，并按微信协议使用
AES-128-ECB 解密。文件声明的长度和 MD5（如有）必须匹配；扩展名和文件魔数必须
一致。图片的临时明文位于 `~/.codex-weixin-direct/inbox/`，目录为 `0700`、
文件为 `0600`；Windows 使用当前用户专属 ACL。

PDF/文本由桥接器在本机解析成只读文字后进入当前绑定任务，原文件不会复制到项目。
图片通过 Codex App Server 的本地图片输入进入当前任务，也不需要把私有状态目录加入
Codex 工作区读取白名单。服务启动时会清理超过 24 小时的异常遗留收件箱目录。

附件消息即使附带“状态”“切换 2”或“同意 4821”等文字，也只会作为普通任务输入，
不会触发桥接控制命令。要执行控制命令，请另发一条纯文字消息。

项目文件写入需要回复：

```text
同意 4821
拒绝 4821
```

## 可选的 Codex Plugin 和管理 Skill

`plugins/codex-weixin-bridge/` 是仓库内的团队管理入口，不是官方插件投稿。

直接从 GitHub 仓库添加：

```bash
codex plugin marketplace add jaybaopro/codex-weixin-bridge
codex plugin add codex-weixin-bridge@codex-weixin-team
```

安装后，新建 Codex 任务并调用 `$manage-weixin-bridge`，Codex 会按照固定安全流程
完成诊断、扫码、项目登记、任务绑定、服务安装或更新。

这个 marketplace 是仓库内的自托管来源，不会出现在 Codex 官方公共插件目录。

## 开发验证

```bash
npm ci
npm test
npm pack --dry-run
```

GitHub Actions 会在 macOS、Windows 和 Node.js 22 环境中执行这些检查。

## 高级运行参数

普通用户不需要修改。受控调试环境可以通过服务环境变量覆盖：

```text
CODEX_WEIXIN_BATCH_WINDOW_MS=2500
CODEX_WEIXIN_TURN_IDLE_TIMEOUT_MS=600000
CODEX_WEIXIN_RETRY_BASE_MS=1000
CODEX_WEIXIN_RETRY_MAX_MS=60000
```

所有值必须是正整数毫秒，非法值会回退到安全默认值。机器可读诊断使用：

```bash
codex-weixin-bridge doctor --json
```

## 协议和第三方组件

- 微信侧依据腾讯 `Tencent/openclaw-weixin` 仓库公开的 iLink HTTP 协议和
  QR 登录流程实现。
- Codex 侧依据 Codex App Server JSON-RPC 协议实现。
- 二维码由项目直接依赖的 MIT `qrcode-terminal` 生成，不要求安装 OpenClaw。
- PDF 文字提取使用 Apache-2.0 的 `pdf-parse`，在受限内存的 Worker 中运行并设置
  页数、文件大小、输出字符数和解析超时。

禁止提交的本地文件、凭证处理和问题报告要求见 `SECURITY.md`。
