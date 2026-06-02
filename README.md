# SubDL Arabic Subtitles Addon

This is a tiny Stremio-compatible subtitles addon for Nuvio.

It uses the official SubDL API at `https://api.subdl.com/api/v1/subtitles` and returns Arabic subtitle results.
When a subtitle download is zipped, the addon extracts the first supported subtitle file and serves it directly to Stremio/Nuvio.

## SubDL ZIP Fix

SubDL sometimes stores subtitles inside ZIP packs. Those results may not appear or may fail in Stremio/Nuvio if the app receives the ZIP file directly.

Create a SubDL API key from `https://subdl.com/` and set:

```text
SUBDL_API_KEY=your-subdl-api-key
SUBDL_LANGUAGES=ar
```

The addon requests SubDL with `full_season=1` and `unpack=1`, so full-season packs can expose their saved episode subtitle files. If SubDL still returns a ZIP download link, this addon proxies the link and extracts `.srt`, `.vtt`, `.ass`, `.ssa`, or `.sub` files before sending them to the player.

## Install URL

After hosting it, add this URL in Nuvio:

```text
https://YOUR-DOMAIN/manifest.json
```

For example, if Render gives you `https://nuvio-arabic-subtitles-addon.onrender.com`, use:

```text
https://nuvio-arabic-subtitles-addon.onrender.com/manifest.json
```

## Run locally

```powershell
cd "C:\Users\alblushi02\Documents\New project\nuvio-arabic-subtitles-addon"
npm start
```

Then add this manifest URL in Nuvio:

```text
http://localhost:7000/manifest.json
```

If Nuvio runs on another device, replace `localhost` with your computer IP address and allow the port through Windows Firewall.

## Deploy Publicly

The addon is a plain Node.js server, so it can be hosted on services like Render, Railway, Fly.io, or a small VPS.

### Render

1. Push this folder to a GitHub repo.
2. In Render, create a new Web Service from the repo.
3. Use:

```text
Build Command: 
Start Command: npm start
Health Check Path: /health
```

Render also supports the included `render.yaml`.

Required start command:

```text
npm start
```

Optional environment variables:

```text
PORT=7000
SUBDL_API_KEY=
SUBDL_LANGUAGES=ar
MAX_SUBTITLES=0
USE_CUSTOM_LANGUAGE_LABELS=false
DEBUG_REQUESTS=false
SUBTITLE_PROXY_SECRET=
SUBDL_TIMEOUT_MS=10000
SUBTITLE_DOWNLOAD_TIMEOUT_MS=15000
MAX_ARCHIVE_BYTES=15728640
MAX_EXTRACTED_SUBTITLE_BYTES=4194304
```

`MAX_SUBTITLES=0` means no limit. You can set it to `1`, `3`, or any other number if you want fewer Arabic results.

Set `DEBUG_REQUESTS=true` temporarily on Render to see whether Nuvio sends the selected stream filename in subtitle requests.

Set `SUBTITLE_PROXY_SECRET` on hosted deployments if you want subtitle proxy links to stay valid across restarts.

## Troubleshooting

First open:

```text
https://YOUR-DOMAIN/health
```

It should show:

```json
{
  "ok": true,
  "source": "subdl",
  "subdlApiKeyConfigured": true,
  "subdlLanguages": "ar"
}
```

If `subdlApiKeyConfigured` is `false`, set `SUBDL_API_KEY` in Render and redeploy.

To test a movie directly:

```text
https://YOUR-DOMAIN/debug/subdl/movie/tt1375666.json
```

To test a series episode directly:

```text
https://YOUR-DOMAIN/debug/subdl/series/tt0944947:1:1.json
```

Check `subtitleCount`, `unpackFileCount`, and `mappedSubtitleCount`.

- `mappedSubtitleCount > 0`: the addon found subtitles and Stremio should show them.
- `subtitleCount > 0` but `mappedSubtitleCount = 0`: SubDL returned records, but none had usable download URLs for this request.
- `subtitleCount = 0`: SubDL did not return Arabic subtitles for that IMDb/episode.
- `ok = false`: read the `error` field. It usually means the API key is missing, invalid, rate-limited, or the request timed out.

Render free services can sleep. The first request after sleep may be slow while Render wakes the service. After it wakes, subtitle requests should be faster. If Stremio times out often, use a paid always-on service or keep the `/health` endpoint warm.
