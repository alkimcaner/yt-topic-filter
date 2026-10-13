# YT Topic Filter — Local AI (Brave extension)

Categorize YouTube videos by topic with your **local decision model** (`http://127.0.0.1:9931`, e.g. `LiquidAI/d1-3B-GGUF` via llama.cpp) and **hide / show video cards per topic**.

## How it works

1. Content script scans YouTube video cards (`ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer`, `ytd-grid-video-renderer`, Shorts, new `ytd-lockup-view-model`, …), extracting **title + channel + videoId**.
2. Background service worker sends one request per video to:
   ```
   POST {endpoint}/v1/systemone
   { "state": "YouTube video.\nTitle: …\nChannel: …",
     "questions": { "topic": { "type": "choice",
       "instructions": "What topic is this YouTube video about?…",
       "criteria": { "gaming": "…", "tech": "…", … } } } }
   ```
   The decision model answers in **one forward pass, zero output tokens** with `{ choice, confidence, probabilities }`.
3. A colored badge (`Topic · 87%`) is overlaid on the thumbnail; cards whose topic is unchecked are hidden.
4. Results are cached by `videoId` in `chrome.storage.local`. If the model is offline, cards show an `Offline` badge (nothing is cached; Rescan retries once the server is back).

## Install in Brave

1. Open `brave://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`yt-filter`, the one containing `manifest.json`).
3. Open YouTube. A `YTF` button sits in the top bar (masthead, left of the icons) — click it for all controls: enable toggle, check/uncheck topics to hide/show, badges toggle, confidence threshold, add/delete/reset topics, model endpoint + test, rescan.
4. Everything else is in the panel too: model endpoint + Test button, add/delete/reset topics, confidence, rescan, clear cache. No toolbar popup, no separate settings page.

## Configure

- **Endpoint** (default `http://127.0.0.1:9931`): must expose `POST /v1/systemone` and `GET /health`. Example server:
  ```bash
  llama serve -hf LiquidAI/d1-3B-GGUF:Q4_K_M --port 9931
  ```
- **Topics**: fully editable in the panel (Add / delete / Reset to defaults). The `description` is what the model reads — be specific, e.g. `"money, stocks, investing, crypto"` beats `"finance"`.
- **Min confidence**: below this, videos are labeled `Other` instead of the top choice.
- **Hiding**: unchecked topics get `display:none` via the `.ytf-hide` class.

## Files

```
manifest.json          MV3 (Brave/Chrome)
src/background.js      queue (3 concurrent), cache, /v1/systemone client (no guessing when offline)
src/content.js         YouTube DOM scan, badges, hide/show, MutationObserver + SPA handling
src/content.js         top-bar YTF button + panel (all controls), badges, hide/show
src/content.css        badge + hide + panel styles
src/options.html/js    full settings + topics JSON editor + reset
icons/                 extension icons
```

## Test the model manually

```bash
curl http://127.0.0.1:9931/v1/systemone -H "Content-Type: application/json" -d '{
  "state": "YouTube video. Title: I Built a HUGE LEGO City! Channel: BrickBuilder",
  "questions": { "topic": { "type": "choice",
    "instructions": "What topic is this YouTube video about? Pick the single best match.",
    "criteria": { "gaming": "video games, gameplay", "education": "tutorials, DIY, LEGO, how-to" } } }
}'
```

## Notes / limits

- `host_permissions` include `http://127.0.0.1/*` so the service worker can reach the model; page CORS is bypassed via the background worker.
- YouTube changes DOM often — selectors cover old + new (`ytd-lockup-view-model`) layouts and re-scan on `yt-navigate-finish` + `MutationObserver`.
- Classification is title+channel only (no thumbnails/transcripts) to stay fast (~8–60 ms/decision). Low-confidence → `Other`.
