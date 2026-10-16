# Orbit LinkedIn Lead Collector

This Manifest V3 Chrome extension collects people from LinkedIn post reactions and comments into Orbit. Collection starts only when the user asks for it. Orbit opens and progressively loads LinkedIn's reaction list and available comment pagination in the active tab, then shows the captured people in the side panel for review.

## Configure and install

Generate an unpacked extension for your deployment from the repository root:

```sh
vp run extension:configure .env.cloudflare
```

The optional filename defaults to `.env`. `APP_ORIGIN` selects your Orbit app and `ORBIT_EXTENSION_API_ORIGIN` selects its API when hosted separately. The API defaults to the app origin. For local Vite development, set `APP_ORIGIN=http://localhost:5173` and `ORBIT_EXTENSION_API_ORIGIN=http://localhost:8787`.

To use environment variables without reading an environment file:

```sh
APP_ORIGIN=https://orbit.example.com vp run extension:configure --env-only
```

The command writes `.release/extension/` with your public app/API origins and host permissions restricted to those origins and LinkedIn. No credentials or environment files are copied. The checked-in source manifest is unchanged. Without configuration, the source extension defaults to `http://localhost:8787`.

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select the generated `.release/extension` directory.
3. Reload LinkedIn. The extension connects automatically when you already have an active session at your configured Orbit app.
4. If you are signed out, open the Orbit side panel and choose **Log in to Orbit**. There is no API address or token to paste.

Regenerate and reload the extension after changing deployment origins. Share only the generated directory with your team. Each person signs in using their own Orbit account.

## Capture a post

1. Find a post in the LinkedIn feed or open its permalink and choose **Find leads** beneath it. Chrome opens the Orbit side panel and starts collecting from that post.
2. Orbit attempts to open LinkedIn's reactions list from that user gesture, progressively loads available reactors, expands available comment pagination, and displays the collected people in the panel. If LinkedIn suppresses the reactions dialog on a search/feed result, open the post permalink or its reactions once and choose **Collect engagement** to retry.
3. Confirm the competitor/source label, filter and select the people, then export CSV or choose **Save selected to Orbit**. Re-running collection for the same post adds only new signals; the scan menu can narrow a retry to one signal type.

The extension toolbar icon opens the same side panel. When it is opened without using a post’s **Find leads** button first, Orbit targets the first suitable post visible in the active LinkedIn tab. **Collect engagement** scans commenters and reactors together; the scan menu can narrow a retry to one signal type.

The extension does not receive your Orbit password or session cookie. It gets a revocable, user-scoped token through a short-lived PKCE authorization code.

The extension does not message, follow, invite, react, or create CRM contacts. It clicks only the selected post's read-only engagement controls and scrolls only the reactions dialog after an explicit collection request. Captures enter the Social leads review queue and remain separate from accounts and contacts until a person is manually qualified. The app tracks source-post scan history, deduplicates repeat captures, and preserves one accountable source owner. LinkedIn changes its page markup periodically; reload the extension after updating selector logic.
