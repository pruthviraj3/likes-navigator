# Instagram Likes Navigator

Chrome extension prototype for `https://www.instagram.com/your_activity/interactions/likes/`.

Code layout:

- TypeScript source lives in `src/`.
- Compiled extension files are emitted to `build/`.
- `manifest.json` loads the compiled files from `build/`.

What it does now:

- Injects a page-context `fetch` interceptor on Instagram.
- Captures liked-post payloads from:
  - `com.instagram.privacy.activity_center.liked_media_screen`
  - `com.instagram.privacy.activity_center.liked_next`
  - `com.instagram.privacy.activity_center.liked_refresh`
- Extracts `media_id`, `media_code`, thumbnail URL metadata, and a canonical `https://www.instagram.com/p/<code>/` URL.
- Stores the normalized cache in IndexedDB.
- Overrides clicks on liked-page thumbnails with `history.pushState` plus `popstate` routing so Instagram can switch posts in-page without a full site reload.
- Adds `Up` and `Down` controls in the saved-results detail view, plus `ArrowUp` and `ArrowDown` keyboard navigation across the active thumbnail set.
- Captures a fresh in-memory request template from the live Instagram page and reuses it to extract liked posts through Instagram's internal `async/wbloks/fetch` endpoints.
- Saves month results in IndexedDB under keys like `instagram_liked_posts_2026_04`.
- Shows a dark Instagram-style in-page overlay with one month-level fetch action. The extension still fetches smaller date ranges internally so a failed/rate-limited range does not discard already saved ranges.

How the monthly extractor works:

1. Open Instagram and navigate to `https://www.instagram.com/your_activity/interactions/likes/`.
2. Let the page load once so the extension can capture a fresh `liked_refresh` request template from your current authenticated session.
3. Use the in-page `Likes` overlay to fetch the visible month.
4. The extractor runs in the Instagram page context, paginates via `liked_next`, deduplicates by `media_id`, stores each date range locally, and stores thumbnail image blobs in extension IndexedDB.

Storage notes:

- Auth-bearing request fields such as `fb_dtsg`, `lsd`, and other form tokens are kept only in page memory and are not persisted to extension storage.
- Cookies are never stored or manually attached. Requests use the browser's existing Instagram session with `credentials: "include"`.
- Month result objects are stored separately from the click-navigation cache and include:
  - `source`
  - `year`
  - `month`
  - `sort`
  - `time_zone`
  - `extracted_at`
  - `page_count`
  - `count`
  - `items`

How to load it:

1. Run `npm install`.
2. Run `npm run build`.
3. Open `chrome://extensions`.
4. Enable Developer Mode.
5. Click `Load unpacked`.
6. Select this folder: `/Users/codetorso/Desktop/insta-extension`

Development:

- Rebuild after changes with `npm run build`.
- For continuous compilation, use `npm run watch`.

Notes:

- Large cache and extraction payloads are stored in IndexedDB to avoid the `chrome.storage.local` quota ceiling.
- If you previously used an older build, reload the extension once so the background worker can migrate any legacy `chrome.storage.local` data.
- Matching is currently based on `ig_cache_key` and image pathname extracted from the thumbnail URL.
- Instagram changes their payloads and DOM often. The extractor is built around live template capture rather than hardcoded request tokens, but it is still tied to the current liked-page response shape.
