# deepstay Android 发布

首版版本：`v0.1.0`。公开源码仓库：[Dingh0208/deepstay](https://github.com/Dingh0208/deepstay)。本版只支持用户自行添加 DeepSeek API Key，不依赖 Sub2API 后端。

## 本地构建

准备 Node.js 22.12+、pnpm、JDK 21、Android SDK 35 与 Build Tools 35，并正确设置 Android SDK 路径。

```sh
pnpm install --frozen-lockfile
pnpm type
pnpm lint
pnpm android:keystore
pnpm android:release
```

`pnpm android:keystore` 仅首次运行，生成固定发布签名。`pnpm android:release` 构建 Web、同步 Capacitor 资源并构建 release APK，产物为 `release/deepstay-0.1.0.apk`。`pnpm android:sync` 可单独执行 Web 构建与 `cap sync android`。

Android 6.0+ 安装包内置本次静态资源，不需要连接开发服务器。

## 签名与升级

- 应用 ID 固定为 `xyz.infralyx.deepstay`。首版 `versionName` 为 `0.1.0`，`versionCode` 为 `1`。后续更新 `package.json` 版本并递增 Android `versionCode`。
- release keystore 与签名配置保存在本机用户目录 `~/.deepstay/signing/deepstay-release.jks` 和 `signing.properties`，必须私下备份。后续 APK 使用同一证书签名，不能以 debug 签名替代，也不能每次构建重新生成密钥。
- keystore、密码及其他凭据不提交到 Git，不放进源码 ZIP 或 GitHub Release。
- 发布前核对 APK 的包名、版本、签名证书及校验和，并确认不含测试 API Key、商户配置或开发服务器地址。
- 用户更新时下载最新 Release APK 覆盖安装，保留本机历史。卸载或清除存储会破坏这一保留条件；版本说明应提醒用户先导出重要历史。

## GitHub Actions

仓库需配置以下 Actions Secrets：

| 名称 | 内容 |
| --- | --- |
| `DEEPSTAY_KEYSTORE_BASE64` | 同一发布 keystore 的 Base64 内容 |
| `DEEPSTAY_STORE_PASSWORD` | keystore 密码 |
| `DEEPSTAY_KEY_PASSWORD` | 签名 Key 密码 |
| `DEEPSTAY_KEY_ALIAS` | 签名 Key alias |

推送 `v版本号` 标签触发 Android CI，使用上述固定签名构建并直接发布为最新 GitHub Release；若同名 Release 已存在，则更新附件。推送标签前应完成版本、签名和产物检查。

设置内的「检查更新」只在用户点击后请求 GitHub 公开的 latest Release API，10 秒超时并比较版本号。有新版时提供 APK 链接，由外部浏览器下载、系统安装器覆盖安装；没有自动下载或静默安装。检查失败不会阻止使用本机聊天。

## 发布流程

1. 完成本地检查及浏览器验收；真实 API、Android 真机或模拟器测试以实际记录为准。
2. 将本轮前端和 Android 源码提交到 `Dingh0208/deepstay`，保留上游 MIT 许可证。不混入旧的后端、支付文档、运行数据或历史交付包。
3. 用固定 release 签名构建 APK，验证产物并记录 SHA-256。
4. 为对应提交创建 `v0.1.0` 标签与 GitHub Release，附 APK、校验和及简洁版本说明。
5. 检查 Release 可访问且附件可以下载。后续版本继续使用同一应用 ID、同一签名和递增的版本号。

本轮类型检查、lint（124 个文件，0 错误、0 警告）及生产构建通过；BYOK 本机七项回归均未产生网络请求，更新服务四组回归通过。APK 签名和包名版本已有首编验证，最终打包及实际 Release 发布结果另行记录。真实 DeepSeek 请求和 Android 真机运行尚不在上述验证范围内。
