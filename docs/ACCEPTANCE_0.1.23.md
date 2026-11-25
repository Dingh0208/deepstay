# 0.1.23 紧急修复验收

日期：2026-11-25（北京时间）。版本：0.1.23 / Android versionCode 24。

## 修复内容

- Android 第三方 API 原生请求传输及 OpenAI 兼容流式协议回退到 v0.1.20 实现；移除 v0.1.21 引入的长请求分块上传逻辑。
- 模型拉取、测试连接、聊天和局域网 HTTP 模型继续使用 v0.1.20 原有原生请求桥接。
- 保留 v0.1.21/v0.1.22 中与第三方传输无关的历史图片预算、导出、附件、版本和其他修复。

## 本地验证

- `pnpm test`：54 个回归套件通过；API 回归验证大于 128 KiB 的 Unicode 请求体仍以完整单请求传递，不再调用分块桥接方法。
- `pnpm type`、`pnpm lint`、`pnpm build` 通过。
- 本机未配置 Android SDK，原生单测与签名包在发布 CI 执行。
- 未使用真实用户 API Key 或真实设备；未完成第三方服务真实账号联网验收。

## 发布与分发

- 提交：`c16bd3e1791afce319d369ef733911bbaba75f40`。
- [GitHub Actions 45540909965](https://github.com/Dingh0208/deepstay/actions/runs/45540909965) 的 build 与 publish 任务均成功，包含 Android release 单测、APK 包名/版本/签名验证、国内源上传及 GitHub Release。
- [v0.1.23 Release](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.23) 已于北京时间 2026-11-25 11:49 发布。
- 国内更新清单 `https://ds.herohao.top/updates/latest.json` 已更新到 `0.1.23 / versionCode 24`。已完整下载 APK：20,332,475 字节；本机计算 SHA-256 为 `834ec0ff40436eaa22973a5e01f49591dc06c2e95b1f36b0f7bcc54db6233dc9`，与国内清单和 GitHub APK asset digest 一致。
