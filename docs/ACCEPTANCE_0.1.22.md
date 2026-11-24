# 0.1.22 紧急修复验收

日期：2026-11-24（北京时间）。版本：0.1.22 / Android versionCode 23。

## 故障与修复

0.1.21 为 Android 长上下文加入 128 KiB 以上 JSON 请求分块上传。Capacitor 的 PluginCall.getLong 只接受 Java Long；JSON 解析将常见的小于 2 GiB 的整数映射为 Integer，导致 bodyLength 读取为空，原生层把有效长请求误判为 `PROVIDER_URL`，显示“Android 接口请求格式不受支持”。现在先读取 Integer，再兼容 Long。

新增 Android 单测覆盖 `bodyLength=131072` 的 Integer 路径和大于 32 位的 Long 路径，验证兼容读取函数返回正确长度。Capacitor 源码中的 `PluginCall.getLong` 仅接受 Long、`getInt` 仅接受 Integer；用例不构造 Android `org.json` 桩。

## 验证

- `pnpm test`：54 个回归套件通过。
- `pnpm type`、`pnpm lint`、`pnpm build` 通过。
- 本机未安装 Android SDK，无法本地运行原生单测或签名构建；由紧急发布 CI 执行 `:app:testReleaseUnitTest`、APK 包名/版本/签名检查。
- 未调用真实第三方 API 或用户 Key。该故障的原生桥接类型转换由单测覆盖，未进行实体手机联网验收。

## 发布验证

标签 CI、GitHub Release、国内更新清单以及完整 APK 下载校验待完成后补记。
