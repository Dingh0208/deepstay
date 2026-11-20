# 应用内更新与国内分发

每次启动或重新进入前台时自动检查更新；发现新版时，设置入口显示提示点。点击设置中的 deepstay 版本号可浏览完整更新历史，升级后首次进入会展示最近三个版本。Android 在应用内下载 APK，显示进度并核对 SHA-256、包名及签名，通过后由系统安装器确认更新。首次安装更新需用户允许 deepstay 安装应用。关闭设置不会丢失当前下载状态；授权导致进程重启时，重新进入设置可恢复缓存中已验证新版的安装入口。清缓存后需重新下载。

GitHub Release 继续保存源码、正式 APK 和校验和。正式版从自有服务器 `https://ds.herohao.top/updates/latest.json` 检查更新，同目录下载 APK，不依赖 GitHub 连通性。也可配置腾讯云 COS 或阿里云 OSS。

## 目录与版本清单

例如，分发目录为 `https://ds.herohao.top/updates/`，内含：

```text
latest.json
deepstay-0.1.9-<sha256>.apk
```

`latest.json` 格式：

```json
{
  "version": "0.1.9",
  "apkUrl": "https://ds.herohao.top/updates/deepstay-0.1.9-<sha256>.apk",
  "sha256": "APK 文件的 64 位 SHA-256 十六进制值"
}
```

版本清单和 APK 允许匿名 HTTPS GET。APK 必须位于清单同目录；不允许 HTTP。清单设置 `Cache-Control: no-cache`，Cloudflare 等 CDN 应对清单显式绕过缓存。APK 使用版本号和完整 SHA-256 组成的文件名，文件发布后不再覆盖，允许长期缓存。

如果 Web 版也使用此更新源，COS / OSS CORS 规则需允许网站来源的 GET 和 `Accept` 请求头。APK 由 Android 原生下载，不受 WebView CORS 限制。更新源不接收 API Key。

## 构建与发布

构建时在同一个终端设置 `DEEPSTAY_UPDATE_MANIFEST_URL` 为真实公开清单地址，Web 与 Android 原生会使用相同设置：

```powershell
$env:DEEPSTAY_UPDATE_MANIFEST_URL='https://ds.herohao.top/updates/latest.json'
pnpm android:release
pnpm updates:manifest https://ds.herohao.top/updates/
```

未配置时继续使用 GitHub 最新 Release。国内源上线后必须用该配置重新构建 APK；已经发布的旧版只知道旧更新源，需通过旧源升级或手动安装一次新包，之后即可走国内源。

GitHub Actions 使用仓库变量 `DEEPSTAY_UPDATE_MANIFEST_URL`，同时注入 Web 与 Android 构建；配置后在 Release 中额外生成 `latest.json`。该变量是公开 HTTPS 地址，不是访问密钥。修改变量后需重新构建发布。

本地及 GitHub Release 的文件名仍为 `release/deepstay-版本.apk`。国内分发时，将它上传为 `release/latest.json` 中 `apkUrl` 指定的哈希文件名；确认完整下载和校验和一致后，最后切换清单，避免用户发现新版却下载不到。

COS / OSS 控制台可手动上传这两个文件。使用默认 HTTPS 存储桶域名即可开始；若用中国大陆 CDN 自定义域名，按服务商要求完成域名备案和 HTTPS 配置。云服务访问密钥仅用于发布端，不得写入 APK、前端源码或 GitHub Release。

## 当前服务器发布

更新目录为 `/var/www/deepstay/updates`，Nginx 站点配置为 `/etc/nginx/sites-available/deepstay-updates`。源站已配置有效 HTTPS 证书，`certbot.timer` 自动续期。清单禁止缓存，版本 APK 可长期缓存；两者允许公开跨域 GET。

Android 发布工作流分为构建和发布两个任务。构建校验 APK 并生成清单后，立即保存 Actions artifact；发布任务只下载构建输出的固定 artifact ID，不重新构建。构建限时 30 分钟，发布限时 60 分钟。

发布任务先完整 GET 哈希文件名对应的 APK 并校验 SHA-256；已正确发布时跳过上传。否则通过 SFTP `reput` 续传到 `.<SHA-256>.apk.part`，上传成功后在同一目录原子改名为最终 APK，再完整下载校验，最后原子替换 `latest.json`。Web 服务器应拒绝公开访问点前缀暂存文件。发布账号 `deepstay-publisher` 只开放 SFTP，不使用 Ubuntu 密码或管理员 SSH 凭据。

上传失败保留服务器上的 `.part`。重试时选择重跑失败的发布任务，继续使用原 artifact 和哈希暂存文件；完整重跑工作流可能生成不同的 APK，因此只能续传相同 SHA-256 的产物。只有清单步骤失败时，重试会验证并复用已经发布的 APK。

仓库配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `DEEPSTAY_UPDATE_MANIFEST_URL` | `https://ds.herohao.top/updates/latest.json` |
| Variable | `DEEPSTAY_UPDATE_DEPLOY_HOST` | 更新服务器的 SSH 地址 |
| Secret | `DEEPSTAY_UPDATE_SSH_KEY` | 专用发布账号的私钥 |
| Secret | `DEEPSTAY_UPDATE_KNOWN_HOSTS` | 已核对的服务器 SSH 公钥 |

首次安装时，可直接下载 `latest.json` 中的 `apkUrl`，或从 GitHub Release 下载标准文件名的 APK。域名目前通过 Cloudflare 代理；切换为仅 DNS 时仍可使用源站 HTTPS。
