# 应用内更新与国内分发

Android 在应用内下载 APK，显示进度并核对 SHA-256、包名及签名，通过后由系统安装器确认更新。首次安装更新需用户允许 deepstay 安装应用。关闭设置不会丢失当前下载状态；安装包保存在应用缓存，清缓存或重启进程后可重新下载。

GitHub Release 继续保存源码、正式 APK 和校验和。国内更新使用腾讯云 COS 或阿里云 OSS 的 HTTPS 地址，不依赖 GitHub 连通性；存储桶和域名需产品方提供。

## 目录与版本清单

例如，分发目录为 `https://downloads.example.com/deepstay/`，内含：

```text
latest.json
deepstay-0.1.2.apk
```

`latest.json` 格式：

```json
{
  "version": "0.1.2",
  "apkUrl": "https://downloads.example.com/deepstay/deepstay-0.1.2.apk",
  "sha256": "APK 文件的 64 位 SHA-256 十六进制值"
}
```

版本清单和 APK 允许匿名 HTTPS GET。APK 必须位于清单同目录；不允许 HTTP。清单设置 `Cache-Control: no-cache`，APK 使用带版本号的文件名。

如果 Web 版也使用此更新源，COS / OSS CORS 规则需允许网站来源的 GET 和 `Accept` 请求头。APK 由 Android 原生下载，不受 WebView CORS 限制。更新源不接收 API Key。

## 构建与发布

构建时在同一个终端设置 `DEEPSTAY_UPDATE_MANIFEST_URL` 为真实公开清单地址，Web 与 Android 原生会使用相同设置：

```powershell
$env:DEEPSTAY_UPDATE_MANIFEST_URL='https://downloads.example.com/deepstay/latest.json'
pnpm android:release
pnpm updates:manifest https://downloads.example.com/deepstay/
```

未配置时继续使用 GitHub 最新 Release。国内源上线后必须用该配置重新构建 APK；已经发布的旧版只知道旧更新源，需手动下载安装一次新包，之后即可走国内源。

GitHub Actions 使用仓库变量 `DEEPSTAY_UPDATE_MANIFEST_URL`，同时注入 Web 与 Android 构建；配置后在 Release 中额外生成 `latest.json`。该变量是公开 HTTPS 地址，不是访问密钥。修改变量后需重新构建发布。

将 `release/deepstay-版本.apk` 先上传，确认下载和校验和一致后，再上传 `release/latest.json`。先发布 APK，最后切换清单，避免用户发现新版却下载不到。

COS / OSS 控制台可手动上传这两个文件。使用默认 HTTPS 存储桶域名即可开始；若用中国大陆 CDN 自定义域名，按服务商要求完成域名备案和 HTTPS 配置。云服务访问密钥仅用于发布端，不得写入 APK、前端源码或 GitHub Release。
