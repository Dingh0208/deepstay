# Bundled fonts

The app bundles Regular 400 WOFF2 fonts for offline use. Each file has its matching license in `licenses/<file-name>.txt`; the production build copies these notices to `static/fonts/licenses/`.

The fonts come from [Google Fonts](https://github.com/google/fonts) and its [Fontsource](https://fontsource.org/) distributions. Ubuntu uses the [Ubuntu Font Licence 1.0](https://github.com/google/fonts/blob/main/ufl/ubuntu/UFL.txt). The other fonts use SIL OFL 1.1. Existing copyright and family metadata remain embedded in the files.

| Files | Source and coverage |
| --- | --- |
| `noto-sans-sc.woff2`, `noto-serif-sc.woff2` | [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) and [Noto Serif SC](https://github.com/google/fonts/tree/main/ofl/notoserifsc), downloaded as complete Regular 400 TTFs from the official Google Fonts CSS service, then compressed with fontTools without removing characters. These provide the Chinese body fonts. |
| `ma-shan-zheng.woff2` | [Ma Shan Zheng](https://github.com/google/fonts/tree/main/ofl/mashanzheng), compressed from the official Regular TTF with fontTools. Its 7,015-character cmap covers common Chinese text, but is not a complete CJK font. Missing characters fall back to bundled Noto Sans SC. |
| The other 24 WOFF2 files | Latin glyphs only. Their names are shown with a Latin label in settings; Chinese text falls back to bundled Noto Sans SC. |

The “System” choice continues to use the device font. Code uses the existing monospace stack. Font and text size preferences apply throughout the app, with a live preview in appearance settings.
