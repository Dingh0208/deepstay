# 0.1.18 验收记录

本版新增具名模型连接预设，放开全局设定长度并支持 TXT 导入，调整未自定义上下文窗口时的默认请求预算。

## 回归与 Web

- `pnpm test` 通过 49 套回归；`pnpm type`、`pnpm lint`、`pnpm build` 和 `git diff --check` 通过。
- 模型连接预设覆盖保存、重载、切换、删除、上下文容量按路由隔离，以及 API Key 不进入诊断日志；聊天输入区快速切换组件回归通过。
- 50,000 个中文字符及首尾空白可经设置保存、模块重载并完整进入下一轮请求；TXT 导入保留原文，读取中不可提交。
- 未设置路由容量时界面窗口仍显示 1M，发送和自动整理默认预算为 128k；长历史只在请求副本中裁剪，当前设定、最新消息和本地历史保留。
- 网页预览：[http://localhost:8090/](http://localhost:8090/)。浏览器检查模型接口设置页的预设管理入口和移动布局；未执行真实第三方 API 调用。

## Android 与发布

- GitHub Actions [44915011348](https://github.com/Dingh0208/deepstay/actions/runs/44915011348) build 与 publish 均成功，源码提交 `dc433fdfe4057320867563a68a03da889e6f3c03`。
- APK 元数据：`xyz.infralyx.deepstay`，`0.1.18 / versionCode 19`，minSdk 23，targetSdk 35。签名证书 SHA-256：`64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`。
- GitHub Release：[v0.1.18](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.18)。APK 大小 20,304,746 字节，SHA-256 `a6f4c64269a1f00d51cb4b0b90c2bab2384f5dc56e3dd192c1717eac404aaf98`。
- [国内更新清单](https://ds.herohao.top/updates/latest.json) 的版本、versionCode、APK 地址与 SHA-256 和 Release 一致。对公开 APK 完整下载后再次计算哈希一致。
- 未运行本机 Android 模拟器或实体设备；Android 签名 APK 由 GitHub Actions 构建与校验。
