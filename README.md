# deepstay

English | [简体中文](README.zh-CN.md)

Chat with your own DeepSeek or OpenAI-compatible API key. No registration, sign-in, or application backend is required. Available for Web and Android.

## Install and start

Download the APK from [GitHub Releases](https://github.com/Dingh0208/deepstay/releases/latest). On first launch, follow the guide to **Settings → Data**, enter the API base URL, protocol and key, then load and select a model and save. DeepSeek is the default; third-party services can use OpenAI-compatible mode. You can also enter a model ID manually.

An empty conversation shows the image logo with a transparent background and a welcome message. The sidebar's Plans entry currently displays an under-development notice; it has no payment, subscription, sign-in, or platform API calls.

For updates, download the latest APK from the same repository and install it over the existing app. **Do not uninstall the app or clear its storage first.** Updates must retain the same application ID and release signing key. Export important conversations before updating.

Settings → General includes **Check for updates**, with a 10-second timeout. On Android, download a newer APK within the app, verify its SHA-256, package ID and signing certificate, then confirm the update in the system installer. The first update requires permission to install apps. Closing and reopening Settings preserves download progress and the install action. Official Android builds check and download updates from `ds.herohao.top`, with official attachments also on GitHub. A COS / OSS source can also be configured at build time. See [update distribution](docs/UPDATES.md).

## Features

- Multiple conversations, automatic titles, renaming and deletion; edit prompts, regenerate replies, and switch message branches.
- Streaming replies, deep thinking, search, link reading, and source citations.
- Attachments, voice input, and read-aloud replies.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- English and Simplified Chinese, light and dark themes, mobile layouts, and local history import/export.
- Thinking is expanded by default, with a setting to collapse it initially; manual expansion survives streamed updates.
- Local chat background images with compression, persistence and a reset action.
- Custom API base URL, key and model; test the connection, load model IDs or enter one manually.
- Search local chat history from the sidebar; query the DeepSeek balance next to Fetch models in API settings.
- On mobile, Enter inserts a newline; only the send button submits a message.
- Optional long-conversation memory compression for requests; original chat records remain unchanged and compression is off by default.
- History ZIP files are parsed in a background worker with progress; you can keep chatting and confirm to add separate chats while keeping existing history.

Capabilities depend on the upstream API and account permissions. The default service is `https://api.deepseek.com`: chat uses Anthropic-compatible Messages / Files APIs, speech uses ASR / TTS, and search, link reading and titles require the default DeepSeek extensions. OpenAI-compatible mode uses `/v1/chat/completions` for text and `reasoning_content` streams. Unsupported attachment, search and speech actions are hidden. Switching providers sends the text of existing history while preserving the original local records. Provider-specific parameters and capabilities may differ.

The base URL can be a root URL or include `/v1`. Both connection testing and model discovery call `/v1/models` on the configured service without generating a reply. They do not verify credit or generation permissions. If model discovery is unavailable, enter a model ID and save. Web usage also requires the provider to allow cross-origin requests.

## Data

The API key and settings are stored in the browser or app WebView's localStorage. Conversations and original attachments are stored in IndexedDB. Keys are not uploaded to a deepstay platform; model discovery and chats go directly to the configured provider, while default extension features use DeepSeek. localStorage is not an encrypted key vault.

Chat backgrounds use a separate local IndexedDB store and are excluded from history exports. Importing or clearing history leaves the background unchanged; reset it in General settings.

This version has no accounts, cloud sync, or cross-device sync. Browser and Android data are separate. Uninstalling, clearing storage, or changing browser profiles can remove local history.

Settings → Data can export, import, or clear history. After confirmation, imports **add separate chats and keep all existing history**, including when importing the same file again. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [archive format documentation (Chinese)](src/services/chat/history/README.md). Clearing local history does not delete files already uploaded to the upstream API.

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
