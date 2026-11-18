# deepstay

English | [简体中文](README.zh-CN.md)

Chat with your own DeepSeek API key. No registration, sign-in, or application backend is required. Available for Web and Android.

## Install and start

Download the APK from [GitHub Releases](https://github.com/Dingh0208/deepstay/releases/latest). On first launch, follow the guide to **Settings → Data**, add your DeepSeek API key, and start chatting.

An empty conversation shows the image logo with a transparent background and a welcome message. The sidebar's Plans entry currently displays an under-development notice; it has no payment, subscription, sign-in, or platform API calls.

For updates, download the latest APK from the same repository and install it over the existing app. **Do not uninstall the app or clear its storage first.** Updates must retain the same application ID and release signing key. Export important conversations before updating.

Settings → General includes **Check for updates**, with a 10-second timeout. On Android, download a newer APK within the app, verify its SHA-256, package ID and signing certificate, then confirm the update in the system installer. The first update requires permission to install apps. Closing and reopening Settings preserves download progress and the install action. GitHub is the default source; a Tencent COS / Alibaba OSS source can be configured at build time. See [update distribution](docs/UPDATES.md).

## Features

- Multiple conversations, automatic titles, renaming and deletion; edit prompts, regenerate replies, and switch message branches.
- Streaming replies, deep thinking, search, link reading, and source citations.
- Attachments, voice input, and read-aloud replies.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- English and Simplified Chinese, light and dark themes, mobile layouts, and local history import/export.

Capabilities depend on the upstream API and account permissions. The default service is `https://api.deepseek.com`: chat uses Anthropic-compatible Messages / Files APIs, speech uses ASR / TTS, and features such as search, link reading, and titles require DeepSeek extensions. **Arbitrary third-party OpenAI-compatible APIs are not guaranteed to work.**

## Data

The API key and settings are stored in the browser or app WebView's localStorage. Conversations and original attachments are stored in IndexedDB. Keys are not uploaded to a deepstay platform; chats, attachments, and speech data are sent to DeepSeek when those features are used. localStorage is not an encrypted key vault.

This version has no accounts, cloud sync, or cross-device sync. Browser and Android data are separate. Uninstalling, clearing storage, or changing browser profiles can remove local history.

Settings → Data can export, import, or clear history. After confirmation, imports **replace all local history**. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [archive format documentation (Chinese)](src/services/chat/history/README.md). Clearing local history does not delete files already uploaded to the upstream API.

## Development

Install Node.js 22.12+ and pnpm:

```sh
git clone https://github.com/Dingh0208/deepstay.git
cd deepstay
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:8090.

```sh
pnpm type
pnpm lint
pnpm build
```

Static output is written to `dist/`. Deploy it to a static server. Opening `dist/index.html` directly additionally requires `file://` storage support and upstream cross-origin permission.

Android uses Capacitor with bundled Web assets. Install JDK 21, Android SDK 35, and Build Tools 35, then run:

```sh
pnpm android:keystore
pnpm android:release
```

Run `android:keystore` only when creating the initial release signing key. `android:release` includes the Web build and asset synchronization; `pnpm android:sync` performs just those steps. See [RELEASING.md](docs/RELEASING.md).

## Attribution and license

Derived from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), baseline commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`. The original [MIT license](LICENSE) is retained and copied to `dist/LICENSE` during builds. Third-party dependencies retain their respective licenses.

The deepstay image logo was supplied by the product owner. deepstay is an independent application.
