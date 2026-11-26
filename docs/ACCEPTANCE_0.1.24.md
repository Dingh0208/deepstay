# v0.1.24 发布验收

- 发布日期：2026-11-26（Asia/Shanghai）
- GitHub Release：[v0.1.24](https://github.com/Dingh0208/deepstay/releases/tag/v0.1.24)
- 发布提交：`66a880e3ff3f97d0a367f5c205c488c93ae37d7b`
- Android `versionCode`：25
- GitHub Actions：[Android Release run 45800024929](https://github.com/Dingh0208/deepstay/actions/runs/45800024929)，build 与 publish job 均成功

## 本地验证

- `pnpm type`：通过
- `pnpm lint`：通过，0 warnings / 0 errors
- `pnpm build`：通过
- `pnpm test`：57 个回归套件通过
- `node tests/deepstay-remote-import-regression.mjs`：通过；覆盖流式进度、超限拒绝、取消及原生下载路径
- `git -c core.whitespace=cr-at-eol diff --check`：通过

## 发布产物

- APK：`deepstay-0.1.24.apk`，20,341,366 bytes
- SHA-256：`514970702ffccfee198735593caa7e357ef3e05a6a56ea8c5500ea354e9f59a4`
- GitHub Release 的 APK 资产摘要与 SHA-256 文件一致。
- 国内更新清单：[latest.json](https://ds.herohao.top/updates/latest.json)，版本为 `0.1.24`、`versionCode` 为 25，APK 地址为 `https://ds.herohao.top/updates/deepstay-0.1.24-514970702ffccfee198735593caa7e357ef3e05a6a56ea8c5500ea354e9f59a4.apk`，清单 SHA-256 与 GitHub APK 摘要一致。
- 发布工作流完成国内 APK 完整下载校验并比较 SHA-256 后才切换更新清单；公开清单读取确认现已指向 v0.1.24。
- GitHub Actions 已运行 Android release 单元测试，并验证 APK 的包名、版本与正式签名。

未执行实体 Android 设备上的安装覆盖测试或真实第三方 API 联网验收。
