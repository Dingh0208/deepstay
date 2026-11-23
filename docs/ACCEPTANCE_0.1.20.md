# 0.1.20 验收记录

本版修复关闭自动压缩后仍自动裁短历史的问题，并包含 DeepSeek V4 Pro 官方联网搜索修复、多行输入框限高和底部输入框编辑消息。

## 发布前验证

- 两轮完整 `pnpm test` 各通过 53 套回归。升级版本元数据后再次通过类型检查、lint、更新记录、更新清单和更新服务回归；`git diff --check` 通过。
- 自动压缩关闭回归覆盖官方 DeepSeek、OpenAI-compatible 和 Anthropic-compatible 三种协议，以及连续短消息、重新生成、官方续写、手动压缩、固定检查点复用、接口超限、在途取消、重载持久化和普通生成不被误停。
- Web 使用隔离存储与模拟接口完成连续发送、开关切换、刷新、手动压缩及 390 × 844 手机视口检查。详见 `QA-2026-11-23-compaction-optout.md` 和 `QA-2026-11-22-pro-search.md`。
- 模型请求使用合成数据与模拟响应；未执行真实模型费用测试或安卓实体设备验收。

## Android 构建

- 候选源码提交：`1e50f6c0d79da01684c1f72e67ee64dd782dd1b3`；版本 `0.1.20 / versionCode 21`，包名仍为 `xyz.infralyx.deepstay`。
- GitHub Actions [45203333591](https://github.com/Dingh0208/deepstay/actions/runs/45203333591) 已完成签名 APK 构建、Android release 单元测试和 APK 包版本校验。
- 签名证书 SHA-256：`64dba31f8f30a392fc850dd81ead8bedccb374568a7e4821be0b64fdb2ec2f1f`，与 0.1.19 一致，支持覆盖安装。

## 发布状态

- [v0.1.20 Release](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.20) 已于 2026-11-23 23:29（北京时间）公开发布，非草稿、非预发布；APK、`latest.json` 和 `SHA256SUMS.txt` 均已上传。
- 为减少等待，先使用 GitHub 插件取得同一构建任务保存的 artifact，核对本地完整 APK 与清单、校验和后发布 GitHub Release；国内同步仍由原发布任务继续执行，不重新构建。
- APK 大小 20,326,230 字节，SHA-256：`1ec10ac6650ad7c4865bd67535b41a2f16a6493ecf606932cf4362842a37f530`；GitHub 公开附件 digest 与本地完整文件及构建清单一致。
- 截至本记录写入时，国内 `latest.json` 仍为 0.1.19，原工作流的 `Publish domestic update` 仍在运行。GitHub APK 已可直接下载覆盖安装，应用内更新源尚待流水线完成同步，未将其标记为已验证完成。
