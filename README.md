# Instagram Likes Navigator

A Chrome extension for browsing and saving your liked Instagram posts from the Activity page.

It runs locally in your browser, uses your existing Instagram session, and stores extracted results in IndexedDB.

## Features

- Fetch liked posts by month from Instagram's liked activity page
- Save post metadata, thumbnails, and canonical post URLs locally
- Navigate saved liked posts with in-page controls
- Use `ArrowUp` and `ArrowDown` to move through the active thumbnail set
- Keep large extraction results out of `chrome.storage.local` by using IndexedDB

## Install

```bash
npm install
npm run build
```

Then load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the project folder

## Usage

1. Sign in to Instagram in Chrome.
2. Open `https://www.instagram.com/your_activity/interactions/likes/`.
3. Wait for the page to finish loading.
4. Use the in-page **Likes** overlay to fetch the visible month.
5. Open saved items and move through them with the on-page controls or arrow keys.

## Development

Build once:

```bash
npm run build
```

Watch TypeScript files while developing:

```bash
npm run watch
```

The extension source lives in `src/`. Compiled files are written to `build/`, which is intentionally ignored by Git.

## Notes

- Request tokens are captured from the live Instagram page and kept in page memory only.
- Cookies are not stored manually. Requests use the browser's active Instagram session.
- Instagram changes its internal payloads and DOM often, so this extension may need updates over time.

If this project helps you, please consider leaving a star.
