# deepstay

English | [简体中文](README.zh-CN.md)

Chat with your own DeepSeek or OpenAI-compatible API key. No registration, sign-in, or application backend is required. Available for Web and Android.

## Install and start

Download the APK from [GitHub Releases](https://github.com/Dingh0208/deepstay/releases/latest). On first launch, follow the guide to **Settings → Model API**, choose the protocol, enter the API base URL if using a custom service, and provide your key. Load and select a model, then save. DeepSeek is the default; third-party services can use OpenAI-compatible mode. You can also enter a model ID manually.

An empty conversation shows the image logo with a transparent background and a welcome message. The sidebar's Plans entry currently displays an under-development notice; it has no payment, subscription, sign-in, or platform API calls.

For updates, download the latest APK from the same repository and install it over the existing app. **Do not uninstall the app or clear its storage first.** Updates must retain the same application ID and release signing key. Export important conversations before updating.

Settings → General includes **Check for updates**, with a 10-second timeout. On Android, download a newer APK within the app, verify its SHA-256, package ID and signing certificate, then confirm the update in the system installer. The first update requires permission to install apps. Closing and reopening Settings preserves download progress and the install action. Official Android builds check and download updates from `ds.herohao.top`, with official attachments also on GitHub. A COS / OSS source can also be configured at build time. See [update distribution](docs/UPDATES.md).

## Features

- Multiple conversations, automatic titles, renaming and deletion; edit prompts, regenerate replies, and switch message branches. On touch devices, press and hold a message for its actions.
- Open a message's actions and choose **Select messages** to favorite or delete several messages at once. The sidebar's **Favorites** opens saved messages in their original chats. Favorites stay on the device and are not included in history ZIP files.
- Streaming replies, deep thinking, search, link reading, and source citations.
- Attachments, voice input, and read-aloud replies.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- English and Simplified Chinese, light and dark themes, mobile layouts, and local history import/export.
- Deep thinking is off by default. Thinking content expands by default; set it to start collapsed in **Settings → Chat & AI**. Manual expansion survives streamed updates.
- **Settings → Appearance** contains the theme, background image crop, global font and text size with a live preview. Choose from 27 bundled fonts or follow system settings.
- Custom API base URL, key and model; test the connection, load model IDs or enter one manually.
- Search local and imported chat history from the sidebar, choose newest or oldest first, and jump to a matching message. Query the DeepSeek balance next to Fetch models in **Settings → Model API**.
- On mobile, Enter inserts a newline; only the send button submits a message.
- Type `/compact` in a chat to compress long history manually, or turn on automatic context compression in Chat & AI. Original messages remain on the device.
- History ZIP files import through a serial queue with a progress bar; imported chats are added separately while all existing history is kept.

Capabilities depend on the upstream API and account permissions. The default service is `https://api.deepseek.com`: chat uses Anthropic-compatible Messages / Files APIs, speech uses ASR / TTS, and search, link reading and titles require the default DeepSeek extensions. OpenAI-compatible mode uses `/v1/chat/completions` for text and `reasoning_content` streams. Unsupported attachment, search and speech actions are hidden. Switching providers sends the text of existing history while preserving the original local records. Provider-specific parameters and capabilities may differ.

The base URL can include a relay's path prefix and `/v1`. In OpenAI-compatible mode a full `/v1/chat/completions` or `/v1/models` URL also works. Connection testing and model discovery call `/v1/models` on the configured service without verifying credit or generation permissions. If the service exposes chat but no model listing, enter a model ID and save. Web usage requires the provider to allow cross-origin requests. On Android, third-party HTTPS requests use the native connection and require a valid certificate and direct endpoint.

## Data

The API key and settings are stored in the browser or app WebView's localStorage. Conversations and original attachments are stored in IndexedDB. Keys are not uploaded to a deepstay platform; model discovery and chats go directly to the configured provider, while default extension features use DeepSeek. localStorage is not an encrypted key vault.

Chat backgrounds use a separate local IndexedDB store and are excluded from history exports. Importing or clearing history leaves the background unchanged; reset it in **Settings → Appearance**.

**Settings → Diagnostics** keeps the latest 200 diagnostic events locally and can export them as a file. Android also opens the system share sheet, where you choose from compatible installed apps. The log omits chat contents, API addresses and credentials.

This version has no accounts, cloud sync, or cross-device sync. Browser and Android data are separate. Uninstalling, clearing storage, or changing browser profiles can remove local history.

Settings → Data can export, import, or clear history. After confirmation, imports **add separate chats and keep all existing history**, including when importing the same file again. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [archive format documentation (Chinese)](src/services/chat/history/README.md). Clearing local history does not delete files already uploaded to the upstream API.

## Development

See the [project structure and Android debug guide](docs/PROJECT_STRUCTURE.md). Install Node.js 24+ and pnpm:

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
pnpm test # Node.js 24+
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
