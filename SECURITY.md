# 安全说明

## 支持边界

当前团队内测版按“一位同事、一台电脑、一个微信授权身份、一个本地状态目录”设计。
不要把同一个桥接实例开放给多人，也不要把它部署成公网服务。

桥接器只允许浏览管理员显式登记的项目，并且在任一时刻只把当前绑定项目作为
Codex App Server 的可读工作区。项目内写入需要微信一次性批准；网络、MCP、
连接器、插件工具、删除和传统命令提权默认关闭。

## 禁止提交的文件

以下内容只能保存在使用者自己的 `~/.codex-weixin-direct/`，不得加入 Git：

- `credentials.json`
- `binding.json`
- `projects.json`
- `runtime.json`
- `audit.jsonl`
- `wechat-login-qr.png`
- `migration.json`
- `run-bridge.cmd`
- `service.log` 和 `service.error.log`

不要在 Issue、PR、截图或聊天消息中粘贴微信 token、二维码载荷、完整任务 ID、
账号 ID 或未脱敏的本地项目清单。

## 报告问题

请优先通过 GitHub Security Advisory 私下报告安全问题。不得在公开 Issue 中粘贴
凭证、二维码、完整任务 ID 或本机项目清单。报告时只提供：

- 版本号、操作系统和 Node.js 版本；
- 已脱敏的错误信息；
- 是否涉及越权读取、未批准写入或外部网络访问；
- 可复现步骤，但不包含凭证、消息正文和完整任务 ID。

如果怀疑凭证泄露，立即停止服务、删除本机
`~/.codex-weixin-direct/credentials.json`，并重新执行微信扫码授权。推荐使用
`codex-weixin-bridge logout --yes`，它会同时清理运行游标和当前绑定。

安全备份有意排除微信 token、账号 ID、完整任务 ID、消息正文和日志。迁移时必须
重新扫码并重新绑定；不要自行复制 `credentials.json` 到另一台电脑。

腾讯公开的 iLink API 当前没有可验证的远程撤销端点，因此 `logout` 只保证停止
本机服务并删除本机凭证，不应解释为已经远程吊销服务器 token。
