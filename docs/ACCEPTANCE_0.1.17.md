# 0.1.17 验收记录

本版覆盖 DeepSeek V4 搜索、附件入口、思考显示、V4 Pro 提醒兼容，以及超长会话的上下文整理和第三方附件发送。

## 回归

- `pnpm test` 两轮均通过 49 套。
- `pnpm type`、`pnpm lint`、`pnpm build` 和 `git diff --check` 通过。
- DeepSeek V4 Pro 搜索使用 `web_search_20250305`；V4 Flash 仍使用 DeepSeek 搜索工具。关闭深度思考时过滤意外的 reasoning；V4 Pro 请求省略 `latest_reminder`。
- DeepSeek 官方路由在 V4 Pro 下仍显示附件和语音入口。第三方路由显示文件入口，PDF/Word/文本在本机提取、图片本机编码后随请求发送；不将 DeepSeek `file_id` 发往第三方。第三方连接不调用 DeepSeek 专用 ASR 端点。
- 使用合成 80 MiB 单消息历史，在 OpenAI-compatible、Anthropic-compatible 和官方 DeepSeek 三种路由上验证整理样本有界、模型/密钥/地址匹配当前路由，并可召回中段证据。
- 真实 Store 回归覆盖 1M 配置、超过 800k tokens 的会话和服务端报告的 4096 上限。整理成功后同路由聊天按 3481 tokens 预算发送；切换 Key 不复用其他凭据预算。带本地文本附件的请求遇到上下文错误时不会自动重发。
- 整理连接失败、模型上下文限制、无效或截断结果、重试冷却和本地保存冲突均有区分提示；失败时原文保留，主聊天不使用不完整历史发送。

自动化测试使用合成对话、文件及 mock API，没有真实 API Key、上游模型调用或计费。

## Web 验收

开发版地址：[http://localhost:8090/](http://localhost:8090/)。首页、设置和上下文详情在 ego-browser 中打开通过；合成压缩会话显示“正在进行上下文压缩，请稍等”。真实第三方服务请求需在用户配置的服务上另行验收。

## Android 与发布

本机未发现 Android SDK、Build Tools 或 `adb`，未执行 Android 模拟器及本地 APK 验收。正式签名和 APK 身份、SHA-256、GitHub Release 与国内更新清单待 GitHub Release 工作流完成后补记。
