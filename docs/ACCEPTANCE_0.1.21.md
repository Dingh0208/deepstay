# 0.1.21 验收记录

日期：2026-11-24（北京时间）。版本：0.1.21 / Android versionCode 22。

## 本轮范围

- 模型按钮上方的紧凑推理强度浮层、官方支持等级发现、第三方展示等级选择，以及请求参数映射。
- Android 第三方模型大 JSON 请求分块上传、取消及早期 HTTP 拒绝处理；流中空工具元数据兼容。
- 累计历史图片的请求预算、按近期优先及重复引用去重；服务商累计图片上限错误的一次受控恢复。保护本轮图片，保留本地历史与原图。
- Android 历史 ZIP 逐块写入，不构造整个归档的 Base64；逐会话读出图片、进度、保存位置选择取消及失败收尾；深层倒序消息树改为迭代导出。

## 官方基线核对

已读取 deepseek-ai/chat-demo main 源码（核对时提交 cdf9617c5f265d58e0e1805635b2c10a3d41284d）。`src/services/chat/store.ts` 的 prepareFiles 会补传 getContextRounds 中的历史附件，随后把上下文一起发送；单图片检查不能替代整请求累计预算。这里增加累计图片预算，未改为跨会话记忆，也未开启自动文本压缩。

## 自动回归

- 两轮 `pnpm test` 均通过：54 个回归套件。第二轮包含新增的官方与第三方累计图片超限恢复用例。
- `pnpm type`、`pnpm lint`、`pnpm build` 通过。
- 新增回归覆盖 2.9 MB 当前图片 + 超过 200 MB 历史图片的取舍、当前图片总量提示、重复引用、本地数据保持、服务商尺寸口径差异恢复。
- 30,000 条倒序父链无递归栈溢出；成环仍拒绝。
- 80 MiB 图片 ZIP 通过异步分块接收、完整 CRC 验证、预览与再导入。原生接收路径不再同时返回一份完整输出 Blob。
- 实际设置组件回归验证进度、按钮锁定、保存位置取消、900 KB ZIP 输出分成多次不超过 192 KiB 的数据块、字节一致及写入失败关闭目标。

## 网页验收

使用 ego-browser 打开本地开发版，在隔离的 127.0.0.1 来源导入一份合成 80 MiB 图片 ZIP，再点击数据管理中的下载，实际保存到本地成功。下载 ZIP 完整 CRC 校验通过，图片 83,886,080 字节，与输入图片 SHA-256 相同。未使用私人对话作为发布附件；网页下载测试不等同于 Android 真机内存测试。

## Android 与发布

- 候选源码：`c5e76c3a2b59d7cc86243c4f60cb42c7dbfc5942`；标签 `v0.1.21`，版本 `0.1.21 / versionCode 22`。
- GitHub Actions [45408638358](https://github.com/Dingh0208/deepstay/actions/runs/45408638358) 的 build 任务已通过：签名 APK、`:app:testReleaseUnitTest`、包名和版本检查全部成功。
- 正式证书 SHA-256：`64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`，与上一版一致。
- 构建 artifact 中 `latest.json` 和 `SHA256SUMS.txt` 的 ZIP 条目已独立校验 CRC 并读取：APK 为 20,335,552 字节；预期 SHA-256 `19a747d1b22c41b9868e701e9bd30702df0a75659544adfd8763d942692580ab`。这些小条目校验不等于完整 APK 下载校验。
- 本机没有 Android SDK，Android 构建和单测由 CI 执行；未执行实体手机大历史导出内存测试。

## 发布验证

- GitHub Actions 45408638358 已全部成功；[v0.1.21 Release](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.21) 于北京时间 2026-11-24 22:27:43 发布，为正式公开版本。
- 远端标签已核对，指向上述候选源码提交；Release 包含 APK、`latest.json` 和 `SHA256SUMS.txt`，中文说明已补齐。
- [国内更新清单](https://ds.herohao.top/updates/latest.json) 已切换为 `0.1.21 / versionCode 22`，下载地址为同目录完整 SHA-256 命名的 APK。
- 已从国内公开 HTTPS 地址完整下载 APK：20,335,552 字节；本机计算 SHA-256 为 `19a747d1b22c41b9868e701e9bd30702df0a75659544adfd8763d942692580ab`，与构建清单、校验和及 GitHub APK asset digest 一致。
- 本地开发预览已重启至 0.1.21，可通过 `http://localhost:8090/` 继续测试。上述发布与文件一致性验证不替代实体手机导出内存验收。
