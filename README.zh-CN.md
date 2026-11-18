# deepstay

[English](README.md) | 简体中文

使用自己的 DeepSeek API Key 聊天，无需注册、登录或应用后端。支持 Web 和 Android。

## 安装与开始

从 [GitHub Releases](https://github.com/Dingh0208/deepstay/releases/latest) 下载 APK 安装。首次启动按引导进入「设置 → 数据管理」，添加自己的 DeepSeek API Key 后开始聊天。

空白会话显示透明背景图片 Logo 和「欢迎回来，随时开始吧」。侧栏的「方案」目前仅显示开发中提示，不提供充值、订阅或登录，也不调用平台接口。

后续更新时，从同一仓库的最新 Release 下载 APK，直接覆盖安装即可保留本机数据。**不要先卸载应用或清除应用存储。** 新版本必须沿用相同的应用标识和发布签名；导出重要对话后再更新更稳妥。

「设置 → 通用设置」提供「检查更新」。点击后查询更新，超时为 10 秒；Android 发现新版后可在应用内下载 APK，校验 SHA-256、包名和签名，再由系统安装器确认升级。首次安装更新需允许 deepstay 安装应用。关闭设置后重新打开仍可查看下载进度或继续安装。正式 Android 版本从 `ds.herohao.top` 检查和下载更新，GitHub 保留正式附件；也支持构建时配置 COS／OSS 源，详见[更新分发说明](docs/UPDATES.md)。

## 功能

- 多会话、自动标题、重命名、删除，编辑提问、重新生成与消息分支。
- 流式回答、深度思考、搜索、链接阅读与来源引用。
- 附件、语音输入与回复朗读。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 中英文、深浅主题、移动端布局与本机历史导入导出。

实际能力取决于上游接口和账号权限。当前默认连接 `https://api.deepseek.com`，聊天通过 Anthropic 兼容的 Messages / Files API，语音使用 ASR / TTS；搜索、链接阅读和标题等也依赖 DeepSeek 扩展。**不承诺支持任意第三方 OpenAI 兼容接口。**

## 数据

API Key 和设置保存在当前浏览器或应用 WebView 的 localStorage，会话与附件原件保存在 IndexedDB。Key 不上传至 deepstay 平台；使用聊天、附件和语音时，相应数据会提交给 DeepSeek。localStorage 不等同于加密密钥库。

本版没有账号、云同步或跨设备同步。浏览器和 APK 的本地数据相互独立；卸载、清除应用存储或更换浏览器配置可能丢失记录。

「设置 → 数据管理」可导出、导入或清空历史。导入经确认后**替换全部本机历史**；导出包含对话及本机可用的图片原件，不含 API Key、设置或非图片附件原件。详见[归档格式说明](src/services/chat/history/README.md)。清空本机记录不会删除已经提交给上游的文件。

## 本地开发

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/Dingh0208/deepstay.git
cd deepstay
pnpm install --frozen-lockfile
pnpm dev
```

打开 http://localhost:8090 。

```sh
pnpm type
pnpm lint
pnpm build
```

静态产物位于 `dist/`，可部署至静态服务器。直接打开 `dist/index.html` 还要求浏览器允许 `file://` 存储和上游允许对应跨域请求。

Android 使用 Capacitor 包装内置 Web 资源。准备 JDK 21、Android SDK 35 与 Build Tools 35 后运行：

```sh
pnpm android:keystore
pnpm android:release
```

`android:keystore` 仅在第一次生成发布签名时运行；`android:release` 包含 Web 构建与资源同步。也可用 `pnpm android:sync` 单独构建并同步资源。详见 [RELEASING.md](docs/RELEASING.md)。

## 来源与许可

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 二次开发，基线提交 `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`。保留原 [MIT 许可证](LICENSE)，构建会复制到 `dist/LICENSE`；第三方依赖遵循各自许可证。

deepstay 图片 Logo 由产品方提供。本项目是独立应用。
