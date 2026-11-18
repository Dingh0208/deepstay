# 项目目录与本地验证

deepstay 用 React、TypeScript 和 Rspack 构建 Web 界面，通过 Capacitor 把同一份界面打包到 Android。日常功能改动优先放在 `src/`；只有需要调用 Android 系统能力时，才同时修改 `android/`。

| 路径 | 放什么 |
| --- | --- |
| [`src/`](../src) | 应用入口和共用代码。`app/` 放应用壳与主题，`components/` 按界面功能组织，`services/` 放会话、存储和接口逻辑，`i18n/` 放翻译，`assets/` 放共用资源，`utils/` 放通用工具。 |
| [`android/`](../android) | 由 Gradle Wrapper 管理的 Android 工程。`gradle/` 与 `gradlew*` 属于源代码，保证成员使用同一 Gradle 版本。 |
| [`android/app/src/main/`](../android/app/src/main) | Android 主模块。`AndroidManifest.xml` 声明应用入口、权限与组件；`java/xyz/infralyx/deepstay/` 放 Activity 和原生桥接；`res/` 放 Android 图标、主题、布局和 XML 配置。 |
| [`android/app/src/test/`](../android/app/src/test)、[`android/app/src/androidTest/`](../android/app/src/androidTest) | 分别放 JVM 单元测试，以及需要模拟器或设备的 Android 测试。 |
| [`tests/`](../tests) | 跨平台回归测试。`pnpm test` 运行 `*-regression.mjs`；可提交的测试样例使用合成数据。 |
| [`scripts/`](../scripts)、[`.github/workflows/`](../.github/workflows) | 前端构建、Android 同步、更新清单等脚本，以及 GitHub 自动化工作流。 |
| [`docs/`](.) | 开发指南、架构说明、研究和验收文档。归档格式这种与模块实现紧密关联的说明可随[模块源码](../src/services/chat/history/README.md)保存。 |
| 根目录 | 中英文 README、变更记录、许可证以及 pnpm、TypeScript、Rspack 和 Capacitor 配置。 |

`node_modules/`、`dist/`、`android/.gradle/`、`android/app/build/` 和 Capacitor 同步到 `android/app/src/main/assets/public/` 的网页资源都可重新生成。业务改动应写在源目录，避免直接修改同步产物。

本地参考资料统一放 `docs/project-history/`，以前生成的安装包放 `release/archive/`，经授权用于复现的真实导入归档放 `test-data/private/`。这些路径不进入 Git；真实聊天、联系人信息、运行日志和 API Key 不应进入公开文档或回归样例。发布密钥的位置和维护方式见[发布说明](RELEASING.md)。

## Web 验证

在项目根目录执行。Node.js 24+ 同时满足开发和回归测试需要：

```sh
pnpm install --frozen-lockfile
pnpm type
pnpm lint
pnpm test
pnpm dev
```

浏览器打开 [http://localhost:8090/](http://localhost:8090/)。可在不生成发布包的情况下验收设置、导入、搜索和聊天。测试导入时先选用合成数据，避免把真实聊天发送给模型服务。

## Android 调试

准备 JDK 21、Android SDK 35、Build Tools 35 和 Android SDK Platform Tools。在根目录执行 `pnpm android:sync` 生成并同步 Web 资源。用 Android Studio 打开 `android/`，选择独立测试模拟器并运行 `app`，或在 Windows PowerShell 执行：

```powershell
Push-Location android
.\gradlew.bat assembleDebug
Pop-Location
adb devices -l
$deepstayTestSerial = 'emulator-5554'
adb -s $deepstayTestSerial install -r android/app/build/outputs/apk/debug/app-debug.apk
```

请将示例序列号替换成 `adb` 显示的实际值。默认 debug 与正式版使用同一个应用 ID，签名不同。用未装正式版的模拟器测试，避免卸载或清除已有会话的应用。检查能否冷启动，并在 Android 上单独验证触屏交互、系统字体缩放、文件选择和分享面板。调试不需要发布签名；[发布流程](RELEASING.md)和[更新分发](UPDATES.md)另有说明。

目录规范参考 [Android Studio 项目结构](https://developer.android.com/studio/projects)与 [Capacitor 架构](https://github.com/ionic-team/capacitor/blob/main/ARCHITECTURE.md)。系统交互参考 [Android 分享面板](https://developer.android.com/training/sharing/send)、[日志信息披露指南](https://developer.android.com/privacy-and-security/risks/log-info-disclosure)与 [Android 字号缩放](https://developer.android.com/about/versions/14/features#non-linear-font-scaling)。
