# Nuvio Arabic Subtitles Addon

This is a tiny Stremio-compatible subtitles addon for Nuvio.

It proxies OpenSubtitles v3 and returns only Arabic subtitle results.
It can also query SubDL directly, including subtitle packs that are returned as `.zip` files.
When a subtitle download is zipped, the addon extracts the first supported subtitle file and serves it directly to Stremio/Nuvio.

## SubDL ZIP Fix

SubDL sometimes stores subtitles inside ZIP packs. Those results may not appear or may fail in Stremio/Nuvio if the app receives the ZIP file directly.

To include those results, create a SubDL API key and set:

```text
SUBDL_API_KEY=your-subdl-api-key
SUBDL_LANGUAGES=ar
```

The addon requests SubDL with `unpack=1`, so full-season packs can expose their saved episode subtitle files. If SubDL still returns a ZIP download link, this addon proxies the link and extracts `.srt`, `.vtt`, `.ass`, `.ssa`, or `.sub` files before sending them to the player.

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
UPSTREAM_BASE=https://opensubtitles-v3.strem.io
SUBDL_API_KEY=
SUBDL_LANGUAGES=ar
MAX_SUBTITLES=0
USE_CUSTOM_LANGUAGE_LABELS=false
DEBUG_REQUESTS=false
PROXY_SUBTITLE_DOWNLOADS=true
SUBTITLE_PROXY_SECRET=
MAX_ARCHIVE_BYTES=15728640
MAX_EXTRACTED_SUBTITLE_BYTES=4194304
```

`MAX_SUBTITLES=0` means no limit. You can set it to `1`, `3`, or any other number if you want fewer Arabic results.

Set `DEBUG_REQUESTS=true` temporarily on Render to see whether Nuvio sends the selected stream filename in subtitle requests.

Set `SUBTITLE_PROXY_SECRET` on hosted deployments if you want subtitle proxy links to stay valid across restarts.
