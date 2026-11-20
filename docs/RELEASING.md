# deepstay Android 发布

当前公开版本为 [v0.1.15](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.15)（Android versionCode 16），国内源与 GitHub APK 的版本、完整下载哈希及正式签名已核对，见 [验收记录](ACCEPTANCE_0.1.15.md)。尾批 0.1.16/code17 已完成两轮回归及网页、Android 验收，公开发布状态以其 [验收记录](ACCEPTANCE_0.1.16.md) 为准。

`v0.1.12` 在用户追加人物需求后取消发布，其标签保留，原附件与搜索改动一并纳入 v0.1.13。公开源码仓库：[Dingh0208/deepstay](https://github.com/Dingh0208/deepstay)。应用支持用户自行添加 DeepSeek 或 OpenAI 兼容接口的 API Key，不依赖 Sub2API 后端。更新内容见 [CHANGELOG.md](../CHANGELOG.md)。

## 本地构建

准备 Node.js 22.12+、pnpm、JDK 21、Android SDK 35 与 Build Tools 35，并正确设置 Android SDK 路径。

```sh
pnpm install --frozen-lockfile
pnpm type
pnpm lint
pnpm android:keystore
pnpm android:release
```

`pnpm android:keystore` 仅首次运行，生成固定发布签名。`pnpm android:release` 构建 Web、同步 Capacitor 资源并构建 release APK，产物为 `release/deepstay-<package.json 版本>.apk`。`pnpm android:sync` 可单独执行 Web 构建与 `cap sync android`。

Android 6.0+ 安装包内置本次静态资源，不需要连接开发服务器。

Web 资源按 Chromium/WebView 83+ 编译。浏览器/WebView 可独立于 Android 系统版本更新；若应用仍无法打开，请收集机型系统版本与 Android System WebView 版本。

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

CI 构建任务在校验 APK、生成国内清单后立即保存 artifact，发布任务按固定 artifact ID 下载同一份产物；构建限时 30 分钟，发布限时 60 分钟。国内 APK 按完整 SHA-256 命名，续传到暂存文件后原子改名，完整 GET 校验通过后最后切换清单。上传失败时重跑失败的发布任务可保留已有续传进度；不要通过重新构建来替代重试。手动触发工作流只构建和同步国内源，不自动创建 GitHub Release。

应用每次启动或重新进入前台时自动检查更新；发现新版时设置入口显示提示点。设置中的 deepstay 版本号可打开完整更新历史，升级后首次进入会展示最近三个版本。用户也可在设置中手动检查，检查请求 10 秒超时并比较版本号。Android 有新版时可在应用内下载，校验 SHA-256、包名和发布签名，再打开系统安装器确认更新。关闭设置保留当前下载状态。正式版使用 `ds.herohao.top` 更新源，GitHub 保留正式附件。服务器及 COS／OSS 源的配置与发布顺序见 [UPDATES.md](UPDATES.md)。检查失败不影响本机聊天。

## 发布流程

1. 完成本地检查及浏览器验收；真实 API、Android 真机或模拟器测试以实际记录为准。
2. 将本轮前端和 Android 源码提交到 `Dingh0208/deepstay`，保留上游 MIT 许可证。不混入旧的后端、支付文档、运行数据或历史交付包。
3. 用固定 release 签名构建 APK，验证产物并记录 SHA-256。
4. 为对应提交创建 `v<package.json 版本>` 标签与 GitHub Release，附 APK、校验和及简洁版本说明。核对标签目标，避免误用继承自上游的同名标签。
5. 检查 Release 可访问且附件可以下载。后续版本继续使用同一应用 ID、同一签名和递增的版本号。

v0.1.1 类型检查、lint、生产构建及固定签名 APK 校验通过。流式回归使用本机模拟数据，核对完整内容、最终高亮与用户上滑阅读位置，不代表上游生成速度或真实手机帧率。Android 15 模拟器已复现旧版键盘遮挡，并验证新版输入框位于真实 IME 上方、收起键盘恢复高度、双指触摸不缩放及覆盖安装保留原设置；未进行实体手机测试。

v0.1.2 在 Android 11 / WebView 83 模拟器复现旧版启动白屏，并验证修复后冷启动、保存测试 Key 后关闭设置、DeepSeek ZIP 导入后的会话切换和新建对话。Key 校验使用本地模拟响应，没有调用真实模型；另有缺失现代内置方法时的历史与消息回归。未进行 OPPO 实体机测试。

v0.1.3 的导入回归覆盖 3MB ZIP、15 个会话、1,080 条消息，验证完成提示前列表与最新会话详情就绪、损坏归档保留数据、API Key 不变。Android 11 / WebView 83 本地验收包验证导入中状态、忙碌时关闭保护、完成后关闭设置立即显示最新会话；该验收包仅在内存中使用旧 versionCode 测试真实升级，正式 APK 仍为 code4。
