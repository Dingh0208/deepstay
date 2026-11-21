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

本机未发现 Android SDK、Build Tools 或 `adb`，未执行本地 Android 模拟器验收。GitHub Actions 已使用固定签名构建并核对 APK：包名 `xyz.infralyx.deepstay`、`0.1.17 / versionCode 18`、minSdk 23 / targetSdk 35；签名证书 SHA-256 为 `64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`。

[v0.1.17 Release](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.17) 已发布，Android Release workflow [44902652729](https://github.com/Dingh0208/deepstay/actions/runs/44902652729) 的 build 和 publish 均成功，源码提交为 `15755464d4fdea3e09aff893612ee3a64610fa36`。APK `deepstay-0.1.17.apk` 为 20,303,113 字节，GitHub 附件 SHA-256 和国内源完整 GET 均为 `301b22a181c0835d97a46be636bc817c19c496d5b1036cb776ae4883d7f2e663`。GitHub Release 与 `https://ds.herohao.top/updates/latest.json` 的版本、versionCode、APK URL 和 SHA-256 一致；清单文件 SHA-256 为 `f42054a4af712e1a8acf17bb234951f2008d50e3e7c21c80f7de92f82e5daa38`。
