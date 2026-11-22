# 0.1.19 验收记录

本版增加语音通话和 Android 局域网 HTTP 模型连接，并修复上下文占用预算显示及第三方接口压缩重试。

## 回归与 Web

- `pnpm test` 通过 52 套回归；`pnpm type`、`pnpm lint`、`pnpm build` 和 `git diff --check` 通过。
- 语音回归覆盖 PCM 停顿分段、TTS 分句、WAV 编码、插话状态、语音转文字入口及当前模型连接 Key 提示。
- API 配置回归覆盖 Android 私网 HTTP 的模型发现、流式聊天和 OpenAI-compatible ASR；公网 HTTP 在请求前拒绝。浏览器 HTTPS 页面仍遵循 CORS 和混合内容限制。
- 上下文占用保持以名义模型窗口为分母；未自定义时显示 1M 模型窗口和独立的 128k 当前请求预算。长会话估算达到请求预算时，约显示 12.8%，而非表示整个会话仅剩 12.8%。
- 上下文整理回归覆盖 OpenAI-compatible `max_tokens` 截断后的有界重试、围栏 JSON、摘要-only 响应，以及无效结构化引用被丢弃但陪伴叙事摘要仍保留。
- Web 预览：<http://localhost:8090/>。手机视口检查语音输入、通话入口和上下文预算展示；真实麦克风与模型请求未在网页验收中执行。

## Android 与 Release

- Android 本机未安装 SDK，未执行原生音频插件 Gradle 编译或实体设备通话测试。
- 正式 Release APK 的 CI 构建、包名、版本、versionCode、签名证书、SHA-256、GitHub 附件及国内更新清单，待发布工作流完成后补录。
