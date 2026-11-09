# Third-party software and services

Takt's own code is MIT (see [LICENSE](LICENSE)). This repository contains **no third-party source files**; everything below is installed from npm (`package.json`) or loaded at runtime, and keeps its own licence.

## Bryntum Scheduler Pro (commercial, trial)

| Package | Version | Licence |
|---|---|---|
| `@bryntum/schedulerpro` → `npm:@bryntum/schedulerpro-trial` | 7.3.8 | Commercial (Bryntum trial terms) |
| `@bryntum/schedulerpro-react` | 7.3.8 | Commercial (Bryntum) |

- Installed from the public npm registry as an alias (`"@bryntum/schedulerpro": "npm:@bryntum/schedulerpro-trial@7.3.8"`), no Bryntum account or private registry needed. Its install script writes the trial key into the package inside `node_modules/`.
- **Not included in this repository** and not redistributed by it: `node_modules/` and the build output (`web/dist/`) are gitignored. A hosted demo serves the trial build, which shows Bryntum's trial watermark.
- The trial is for evaluation (45 days per browser). Using Takt's board beyond that, or in production, needs a Bryntum licence: https://bryntum.com/products/schedulerpro/license/
- Bryntum bundles Font Awesome Free (icons and fonts; Font Awesome Free licence) inside its package; Takt imports it from there.

## Other npm dependencies

| Package | Licence | Used for |
|---|---|---|
| `express` | MIT | HTTP server |
| `@anthropic-ai/sdk` | Apache-2.0 | Claude Messages API |
| `dotenv` | BSD-2-Clause | `.env` loading |
| `tsx` | MIT | Running TypeScript (server, scripts) |
| `react`, `react-dom` | MIT | UI |
| `vite`, `@vitejs/plugin-react` | MIT | Dev server and build |
| `typescript` | Apache-2.0 | Type checking |
| `concurrently` | MIT | `npm run dev` |
| `playwright` | Apache-2.0 | Screenshot / demo-path script, demo video recording |
| `ffmpeg-static` | GPL-3.0-or-later (FFmpeg binary) | Cutting the demo video (`scripts/record-video.ts`); dev tool only, not part of the app or the build |

## Services (called at runtime, not bundled)

- **PayPal REST APIs and JS SDK v6** (sandbox): loaded from `https://www.sandbox.paypal.com/web-sdk/v6/core`, under PayPal's developer terms.
- **Anthropic Claude API** (Claude Haiku 5.5), under Anthropic's commercial terms. Recorded responses for the scripted demo inputs live in `server/agent/llm-cache/`.

## Demo video audio

- **Voice-over:** synthetic voice generated locally with **Kokoro-82M** TTS (Apache-2.0, voice `am_fenrir`, via `kokoro-onnx`, MIT). Script written by us.
- **Music and UI sounds:** synthesised in code by us (numpy); no third-party audio.

All companies, people and jobs in the demo data are fictional.
