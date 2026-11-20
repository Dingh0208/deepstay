# deepstay

[English](README.md) | 简体中文

使用自己的 DeepSeek 或 OpenAI 兼容接口 API Key 聊天，无需注册、登录或应用后端。支持 Web 和 Android。

## 安装与开始

从 [GitHub Releases](https://github.com/Dingh0208/deepstay/releases/latest) 下载 APK 安装。首次启动按引导进入「设置 → 模型接口」，选择接口类型，填写 Key；使用自定义服务时还要填写 API 地址。拉取并选择模型后保存。默认连接 DeepSeek；第三方服务可选择 OpenAI 兼容接口，也可手动填写模型 ID。

空白会话显示透明背景图片 Logo 和「欢迎回来，随时开始吧」。侧栏的「方案」目前仅显示开发中提示，不提供充值、订阅或登录，也不调用平台接口。

后续更新时，从同一仓库的最新 Release 下载 APK，直接覆盖安装即可保留本机数据。**不要先卸载应用或清除应用存储。** 新版本必须沿用相同的应用标识和发布签名；导出重要对话后再更新更稳妥。

「设置 → 通用设置」提供「检查更新」。点击后查询更新，超时为 10 秒；Android 发现新版后可在应用内下载 APK，校验 SHA-256、包名和签名，再由系统安装器确认升级。首次安装更新需允许 deepstay 安装应用。关闭设置后重新打开仍可查看下载进度或继续安装。正式 Android 版本从 `ds.herohao.top` 检查和下载更新，GitHub 保留正式附件；也支持构建时配置 COS／OSS 源，详见[更新分发说明](docs/UPDATES.md)。

## 功能

- 多会话、自动标题、重命名、删除，编辑提问、重新生成与消息分支。触屏设备可长按消息打开相应操作。
- 在消息操作中选择「多选」，即可批量收藏或删除消息。侧栏「收藏夹」可跳回原聊天中的消息。收藏只保存在本机，不随历史 ZIP 导出。
- 消息操作中的「删除本轮」删除该提问及回答版本，保留其他轮次；输入区可快速切换已保存的模型，选择附件时支持一次多选。
- 流式回答、深度思考、搜索、链接阅读与来源引用。
- 附件、语音输入与回复朗读。
- Word / PDF 上传前确认解析方式，默认只解析文字；可在消息文件卡上暂停或恢复后续引用，详见[附件与费用说明](docs/ATTACHMENTS.md)。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 中英文、深浅主题、移动端布局与本机历史导入导出。
- 深度思考功能默认关闭，思考内容默认展开。可在「设置 → 聊天与 AI」中开启默认折叠，手动展开不受流式更新影响。
- 在「设置 → 外观」中调整主题、裁剪聊天背景、选择 27 款内置字体及全局字号，实时预览效果；字体和字号都可以跟随系统。
- 自定义 API 地址、Key、模型，支持测试连接、拉取模型与手动填写模型 ID。
- 从侧栏搜索本机和导入的聊天记录，可按时间正序或倒序排列，点击结果跳到对应消息。在「设置 → 模型接口」的「拉取模型」右侧可查询 DeepSeek 余额。
- 手机输入框按 Enter 换行，仅点击发送按钮才会发送消息。
- 长对话支持在聊天中输入 `/compact` 手动压缩，也可在「聊天与 AI」开启自动上下文压缩。原始记录保存在本机。
- 历史 ZIP 先预览会话并多选，确认后串行增量导入，显示进度条与百分比；重复内容跳过，保留本机原有历史和续聊。

实际能力取决于上游接口和账号权限。默认连接 `https://api.deepseek.com`，聊天通过 Anthropic 兼容的 Messages / Files API，语音使用 ASR / TTS；搜索、链接阅读和标题等依赖默认 DeepSeek 扩展。OpenAI 兼容模式通过 `/v1/chat/completions` 支持文本聊天与 `reasoning_content` 思考流，隐藏不支持的附件、搜索和语音入口；切换服务后只发送旧历史中的文字，本机原始记录保留。不同服务的额外参数和能力不保证通用。

API 地址可保留中转站的路径前缀和 `/v1`。OpenAI 兼容接口也支持粘贴完整的 `/v1/chat/completions` 或 `/v1/models` 地址。「测试连接」和「拉取模型」请求该服务的 `/v1/models`，不验证余额或生成权限。服务支持聊天但不提供模型列表时，可手动填写模型 ID 并保存。Web 端需要上游允许跨域请求；Android 的第三方 HTTPS 接口使用原生连接，需使用有效证书和最终接口地址。

`127.0.0.1` 和 `localhost` 指向运行应用的当前设备；电脑上的本机地址不能直接用于手机连接，Android 当前仅支持 HTTPS API。DeepSeek Pro 不支持服务端搜索、阅读链接与自动标题，这些请求扩展会按模型关闭。缓存命中率以接口返回的用量为准；旧会话缺少用量快照时，上下文详情显示本地估算。

## 数据

API Key 和设置保存在当前浏览器或应用 WebView 的 localStorage，会话与附件原件保存在 IndexedDB。Key 不上传至 deepstay 平台；模型列表、聊天等请求直接发送至用户配置的服务，默认扩展功能发送至 DeepSeek。localStorage 不等同于加密密钥库。

聊天背景独立保存在本机 IndexedDB，不包含在历史导出中。导入或清空历史不会修改背景；可在「设置 → 外观」恢复默认。

「设置 → 诊断日志」在本机保留最近 200 条诊断事件，支持导出为文件。Android 可打开系统分享面板，从本机已安装且兼容的应用中选择分享目标。日志不包含聊天内容、接口地址和凭据。

本版没有账号、云同步或跨设备同步。浏览器和 APK 的本地数据相互独立；卸载、清除应用存储或更换浏览器配置可能丢失记录。

「设置 → 数据管理」可导出、导入或清空历史。支持 DeepSeek / deepstay v3 ZIP，预览后选择会话，**增量去重导入并保留全部现有历史**；相同来源只补充缺少的消息。旧版导入缺少来源标记时，仅在完整消息匹配后去重；无法可靠确认身份的旧增量保留独立副本。导出包含对话及本机可用的图片原件，不含 API Key、设置或非图片附件原件。详见[归档格式说明](src/services/chat/history/README.md)。清空本机记录不会删除已经提交给上游的文件。

## 本地开发

参见[项目目录与 Android 调试指南](docs/PROJECT_STRUCTURE.md)。准备 Node.js 24+ 和 pnpm：

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
pnpm test # Node.js 24+
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
