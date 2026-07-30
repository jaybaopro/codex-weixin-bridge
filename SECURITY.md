# 安全说明

## 支持边界

当前团队内测版按“一位同事、一台 Mac、一个微信授权身份、一个本地状态目录”设计。
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
- `service.log` 和 `service.error.log`

不要在 Issue、PR、截图或聊天消息中粘贴微信 token、二维码载荷、完整任务 ID、
账号 ID 或未脱敏的本地项目清单。

## 报告问题

在团队私有 GitHub 仓库中提交安全问题时，只提供：

- 版本号、macOS 和 Node.js 版本；
- 已脱敏的错误信息；
- 是否涉及越权读取、未批准写入或外部网络访问；
- 可复现步骤，但不包含凭证、消息正文和完整任务 ID。

如果怀疑凭证泄露，立即停止服务、删除本机
`~/.codex-weixin-direct/credentials.json`，并重新执行微信扫码授权。
