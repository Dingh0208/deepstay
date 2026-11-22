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

- Android 本机未安装 SDK；GitHub Actions [44990538939](https://github.com/Dingh0208/deepstay/actions/runs/44990538939) 已完成正式编译、14 项 Android release 单元测试与 APK 校验。未执行实体设备通话测试。
- 候选源码提交 `884214acabc880e446041d1d852acce1ffc61b38`；APK 为 `xyz.infralyx.deepstay`，`0.1.19 / versionCode 20`。签名证书 SHA-256 为 `64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`，与上一版一致。
- 构建产物 APK SHA-256 为 `efee5a32b2b1a58e2c5168d21cc2d86312ced625bcc2a629cfd5cf70c4d9fd62`。GitHub Actions 构建与发布均成功；[v0.1.19 Release](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.19) 于 2026-11-22 14:11（北京时间）公开发布，非草稿、非预发布，包含 APK、`latest.json` 与 `SHA256SUMS.txt`。
- 国内 `latest.json` 已切换为 `0.1.19 / code20`，与构建清单一致。国内 APK 完整 GET 下载为 20,325,373 字节，SHA-256 与上述构建产物一致；GitHub 附件大小及公开 digest 同样匹配。
