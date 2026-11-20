# 缓存、工具、图片与底部布局验收

基于已发布的 v0.1.9，在 `codex/provider-metrics-layout-fixes` 分支处理本轮六项反馈，发布版本为 v0.1.10（Android versionCode 11）。网页及隔离 Android 调试包用于发布前验收。

## 修复与实际验证

| 反馈 | 实现与验收 |
| --- | --- |
| 缓存命中率一直为 0% | 消费没有结束原因的中间用量帧；OpenAI 原始用量先跨帧合并再归一化，兼容直接缓存计数与命中/未命中字段。向第三方请求流式用量，仅服务端明确以 HTTP 400 拒绝该可选参数时降级一次。实际网页模拟初始缓存 0、最终缓存 80 / 输入 100，最终显示 80%；真实 0 和未返回用量保持不同。 |
| 关闭搜索仍有工具错误 | DeepSeek Pro 及其 Opus 别名不再发送不支持的工具、自动标题或历史工具协议块；本地历史不改写。Pro 实际网页发送体 `tools=[]` 且无 `title`，搜索入口隐藏；Flash 保留已有扩展。 |
| `messages.0.content.0` 图片过大 | 共用上传队列把超限图片的发送副本缩至最长边 4096，不修改本地原件。明确定位到旧图片 ID 的尺寸错误允许从原件重传；无法恢复时提示重新添加图片，不省略该图片。真实浏览器 6000×1000 PNG 经 ImageBitmap 与旧式 Image 回退均变为 4096×682，原件仍为 6000×1000；正常图片原样保留。编码失败不再次完整解码。 |
| 连接错误提示不明确 | Android 区分连接主机/端口失败、DNS、TLS 和普通连接中断。对本机地址明确解释当前设备含义，保留项目既有 HTTPS 要求。Android 原生调用关闭的回环端口返回 `PROVIDER_CONNECT`，页面仍挂载。用户截图的 HTTP 回环服务运行位置未确认，未将这项验证宣称为其真实接口已连通。 |
| 上下文详情都是横线 | 缺少已保存请求快照的旧会话按当前分支在本地估算，系统、工具和消息分项标“约”；有请求快照时优先使用，不在流式渲染时重复扫描全部历史。实际网页旧会话显示约 3,362 / 1,000,000，三个分项均有数字；估算不代表服务商精确计费或文件全文 Token。 |
| 底部留白和背景 | 自定义背景启用时取消输入区遮挡背景的纯色渐变；手机指标和免责声明合计高度由 72px 减至 52px，保留安全区。393、768、1024 CSS px 下无页面横向溢出，聊天与欢迎页背景均覆盖到底部。缩小浏览器视口并聚焦输入框时发送按钮仍在可视区内；该项不是实体设备 IME 验证。 |

实际网页使用隔离来源及合成数据，没有调用收费模型。预览为 `http://deepstay-footer-qa.localhost:8090/`，退出验收前已移除合成 API Key。原有 `localhost:8091` 数据未清除。

## 两轮回归与构建

- 产品代码冻结后，两次完整 `pnpm test` 各通过 32 套，退出码均为 0。日志为本机 `D:\codex_documents\deepstay-provider-metrics-qa-20261120\full-regression-round-1-retry.log` 和 `full-regression-round-2.log`。
- 首轮最初尝试的 `full-regression-round-1.log` 以 -1073740791 退出，没有断言堆栈，保留记录且未计为通过，不能据此确认异常原因。
- `pnpm type`、`pnpm lint`（0 warnings / errors）、`git diff --check`、Web 生产构建、Capacitor 同步和隔离 Android debug 构建通过。
- `:app:testDebugUnitTest` 通过：ProviderHttpPlugin 3 项、既有 ExampleUnitTest 1 项，均 0 failures / errors。一次整工程离线测试因 Capacitor 模块未缓存 Mockito 依赖失败，随后限定 app 模块执行；未改依赖来绕过测试。
- Android 11 / WebView 83，隔离包 `xyz.infralyx.deepstay.releaseqa` 覆盖安装后，正式会话/摘要各 12、附件 510，页面正常挂载。包名后缀仅通过仓库外 Gradle 初始化脚本设置，未写入工程发布配置。

网页几何、图片和流式用量证据位于本机 `D:\codex_documents\deepstay-release-qa-20261120\` 的 `footer-layout-*.json`、`footer-welcome-evidence.json`、`image-upload-browser-evidence.json`、`import-context-browser-evidence.json`、`cache-stream-browser-evidence.json` 和 `pro-tools-browser-evidence.json`。Android 与自动回归证据位于本轮独立 QA 目录。截图、真实归档、会话正文和凭据不提交仓库。

缓存由模型服务决定，前缀不匹配或服务商未提供统计时不能保证非零；本地模拟仅验证解析和界面显示。没有用户真实 Key 的第三方端到端验证，也没有新增厂商真机覆盖。

## v0.1.10 发布产物

- 更新版本元数据后，更新记录回归、类型检查、lint 和差异格式检查通过；独立只读复核未发现阻塞问题。
- 本地首次正式构建因 JVM 无法分配原生内存中断；保持应用代码不变，以 2 个 worker、1GB Java 堆和 2 个活动处理器重试成功，日志保留在本轮 QA 目录。
- 本地 APK 为 `release/deepstay-0.1.10.apk`，19,726,094 字节；包名 `xyz.infralyx.deepstay`，versionName `0.1.10`，versionCode `11`，最低 Android API 23。
- APK 签名验证通过，证书 SHA-256 为 `64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`，与既有发布签名一致。
- 本地 APK SHA-256 为 `d5f8e20acb62186b0dbdc27c8d4c2937cf8ab2c93432a62a473272734a90c7bd`。CI 会独立构建，公开 APK 的哈希以最终 Release 附件和清单为准。
- 包内 Web 版本正确，无开发服务器配置、签名私钥、数据库或测试归档。
