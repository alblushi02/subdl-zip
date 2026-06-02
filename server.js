const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || "0.0.0.0";
const USE_CUSTOM_LANGUAGE_LABELS = process.env.USE_CUSTOM_LANGUAGE_LABELS === "true";
const DEBUG_REQUESTS = process.env.DEBUG_REQUESTS === "true";
const SUBTITLE_PROXY_SECRET = process.env.SUBTITLE_PROXY_SECRET || crypto.randomBytes(32).toString("hex");
const SUBDL_API_KEY = String(process.env.SUBDL_API_KEY || "").trim();
const SUBDL_LANGUAGES = String(process.env.SUBDL_LANGUAGES || "ar").trim();
const SUBDL_API_BASE = (process.env.SUBDL_API_BASE || "https://api.subdl.com/api/v1").replace(/\/+$/, "");
const SUBDL_DOWNLOAD_BASE = (process.env.SUBDL_DOWNLOAD_BASE || "https://dl.subdl.com").replace(/\/+$/, "");
const parsedMaxSubtitles = Number(process.env.MAX_SUBTITLES || 0);
const MAX_SUBTITLES = Number.isFinite(parsedMaxSubtitles) && parsedMaxSubtitles > 0 ? Math.floor(parsedMaxSubtitles) : 0;
const parsedMaxArchiveBytes = Number(process.env.MAX_ARCHIVE_BYTES || 15 * 1024 * 1024);
const MAX_ARCHIVE_BYTES = Number.isFinite(parsedMaxArchiveBytes) && parsedMaxArchiveBytes > 0 ? Math.floor(parsedMaxArchiveBytes) : 15 * 1024 * 1024;
const parsedMaxExtractedSubtitleBytes = Number(process.env.MAX_EXTRACTED_SUBTITLE_BYTES || 4 * 1024 * 1024);
const MAX_EXTRACTED_SUBTITLE_BYTES =
  Number.isFinite(parsedMaxExtractedSubtitleBytes) && parsedMaxExtractedSubtitleBytes > 0
    ? Math.floor(parsedMaxExtractedSubtitleBytes)
    : 4 * 1024 * 1024;
const parsedSubdlTimeoutMs = Number(process.env.SUBDL_TIMEOUT_MS || 10000);
const SUBDL_TIMEOUT_MS =
  Number.isFinite(parsedSubdlTimeoutMs) && parsedSubdlTimeoutMs > 0 ? Math.floor(parsedSubdlTimeoutMs) : 10000;
const parsedSubtitleDownloadTimeoutMs = Number(process.env.SUBTITLE_DOWNLOAD_TIMEOUT_MS || 15000);
const SUBTITLE_DOWNLOAD_TIMEOUT_MS =
  Number.isFinite(parsedSubtitleDownloadTimeoutMs) && parsedSubtitleDownloadTimeoutMs > 0
    ? Math.floor(parsedSubtitleDownloadTimeoutMs)
    : 15000;

const MANIFEST = {
  id: "community.subdl.arabic-zip",
  version: "1.0.5",
  name: "SubDL Arabic Subtitles",
  description: "Arabic subtitles from the official SubDL API with ZIP archive extraction support.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, OPTIONS"
};

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  res.end(json);
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...extraHeaders,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function sendBuffer(res, status, buffer, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...extraHeaders,
    "content-type": contentType,
    "content-length": buffer.length
  });
  res.end(buffer);
}

function safeHeaderValue(value, maxLength = 200) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, maxLength);
}

function firstText(values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", SUBTITLE_PROXY_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 32);
}

function resolveSubtitleUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch (error) {
    return null;
  }
}

function sanitizeSubtitleFileName(value) {
  const cleanName = String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-z0-9._ -]/gi, "_")
    .replace(/_+/g, "_")
    .trim();

  return cleanName || "subtitle.srt";
}

function createSubtitleProxyUrl(req, subtitleUrl, fileName = "subtitle.srt") {
  const payload = toBase64Url(subtitleUrl);
  const signature = signPayload(payload);
  return `${getBaseUrl(req)}/subtitle-proxy/${payload}.${signature}/${encodeURIComponent(sanitizeSubtitleFileName(fileName))}`;
}

function getTextForReleaseDetection(values) {
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).toLowerCase())
    .join(" ");
}

function detectReleaseType(text) {
  const value = String(text || "").toLowerCase();

  if (/\b(blu[ ._-]?ray|bdrip|br[ ._-]?rip|brrip|bdremux|remux)\b/.test(value)) {
    return "bluray";
  }

  if (/\b(web[ ._-]?dl|web[ ._-]?rip|webrip|webdl|web|amzn|nf|netflix|dsnp|hulu|atvp|max)\b/.test(value)) {
    return "web";
  }

  if (/\b(hdtv|pdtv|dsr)\b/.test(value)) {
    return "hdtv";
  }

  return null;
}

function getSubtitleReleaseText(subtitle) {
  return getTextForReleaseDetection([
    subtitle.name,
    subtitle.title,
    subtitle.label,
    subtitle.filename,
    subtitle.fileName,
    subtitle.MovieReleaseName,
    subtitle.release,
    subtitle.releaseName,
    subtitle.release_name,
    subtitle.id
  ]);
}

function sortByRequestRelease(req, subtitles) {
  const requestRelease = detectReleaseType(decodeURIComponent(req.url));
  if (!requestRelease) {
    return subtitles;
  }

  return [...subtitles].sort((left, right) => {
    const leftMatches = detectReleaseType(getSubtitleReleaseText(left)) === requestRelease ? 1 : 0;
    const rightMatches = detectReleaseType(getSubtitleReleaseText(right)) === requestRelease ? 1 : 0;
    return rightMatches - leftMatches;
  });
}

function logSubtitleRequest(req, subtitles) {
  if (!DEBUG_REQUESTS) {
    return;
  }

  const decodedUrl = decodeURIComponent(req.url);
  const requestRelease = detectReleaseType(decodedUrl) || "unknown";
  const sampleSubtitleKeys = subtitles[0] ? Object.keys(subtitles[0]).sort() : [];

  console.log(
    JSON.stringify({
      event: "subtitle-request",
      url: decodedUrl,
      detectedRequestRelease: requestRelease,
      subtitleCount: subtitles.length,
      sampleSubtitleKeys
    })
  );
}

function applySubtitleLimit(subtitles) {
  if (MAX_SUBTITLES <= 0) {
    return subtitles;
  }

  return subtitles.slice(0, MAX_SUBTITLES);
}

function getSubtitleRequestInfo(req) {
  const path = req.url.split("?")[0];
  const match = /^\/subtitles\/([^/]+)\/(.+)\.json$/i.exec(path);
  if (!match) {
    return null;
  }

  const stremioType = decodeURIComponent(match[1]);
  const id = decodeURIComponent(match[2].split("/")[0]);
  const idParts = id.split(":");
  const imdbId = idParts.find((part) => /^tt\d+$/i.test(part));
  if (!imdbId) {
    return null;
  }

  const season = Number(idParts[1]);
  const episode = Number(idParts[2]);

  return {
    stremioType,
    id,
    imdbId,
    subdlType: stremioType === "series" ? "tv" : "movie",
    season: Number.isInteger(season) && season > 0 ? season : null,
    episode: Number.isInteger(episode) && episode > 0 ? episode : null
  };
}

function buildSubdlSearchUrl(requestInfo) {
  const url = new URL(`${SUBDL_API_BASE}/subtitles`);
  url.searchParams.set("api_key", SUBDL_API_KEY);
  url.searchParams.set("imdb_id", requestInfo.imdbId);
  url.searchParams.set("type", requestInfo.subdlType);
  url.searchParams.set("languages", SUBDL_LANGUAGES);
  url.searchParams.set("subs_per_page", "30");
  url.searchParams.set("releases", "1");
  url.searchParams.set("hi", "1");
  url.searchParams.set("full_season", "1");
  url.searchParams.set("unpack", "1");

  if (requestInfo.season !== null) {
    url.searchParams.set("season_number", String(requestInfo.season));
  }
  if (requestInfo.episode !== null) {
    url.searchParams.set("episode_number", String(requestInfo.episode));
  }

  return url.href;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function redactSubdlUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("api_key")) {
      url.searchParams.set("api_key", SUBDL_API_KEY ? "[configured]" : "[missing]");
    }
    return url.href;
  } catch (error) {
    return String(value || "");
  }
}

function resolveSubdlDownloadUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return new URL(value.trim(), SUBDL_DOWNLOAD_BASE).href;
  } catch (error) {
    return null;
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isMatchingSubdlEpisode(file, requestInfo) {
  if (requestInfo.season === null && requestInfo.episode === null) {
    return true;
  }

  const fileSeason = numberOrNull(file.season);
  const fileEpisode = numberOrNull(file.episode);

  if (requestInfo.season !== null && fileSeason !== null && fileSeason !== requestInfo.season) {
    return false;
  }
  if (requestInfo.episode !== null && fileEpisode !== null && fileEpisode !== requestInfo.episode) {
    return false;
  }

  return fileEpisode === requestInfo.episode || fileSeason === requestInfo.season;
}

function getSubdlReleaseName(subtitle, unpackedFile) {
  return firstText([
    unpackedFile && unpackedFile.release_name,
    unpackedFile && unpackedFile.name,
    subtitle.release_name,
    subtitle.name,
    subtitle.filename
  ]);
}

function getSubdlSubtitleFileName(subtitle, unpackedFile) {
  const name = firstText([
    unpackedFile && unpackedFile.name,
    unpackedFile && unpackedFile.release_name,
    subtitle.name,
    subtitle.release_name,
    subtitle.filename
  ]);
  const format = firstText([unpackedFile && unpackedFile.format, subtitle.format]);
  const fallback = format ? `subtitle.${String(format).replace(/^\./, "")}` : "subtitle.srt";
  const fileName = sanitizeSubtitleFileName(name || fallback);

  if (/\.(srt|vtt|ass|ssa|sub)$/i.test(fileName)) {
    return fileName;
  }

  return `${fileName}.${String(format || "srt").replace(/^\./, "")}`;
}

function createSubdlSubtitle(req, subtitle, index, requestInfo, unpackedFile = null) {
  const url = resolveSubdlDownloadUrl(unpackedFile ? unpackedFile.url : subtitle.url);
  if (!url) {
    return null;
  }

  const episodeLabel =
    unpackedFile && numberOrNull(unpackedFile.season) && numberOrNull(unpackedFile.episode)
      ? ` S${String(numberOrNull(unpackedFile.season)).padStart(2, "0")}E${String(numberOrNull(unpackedFile.episode)).padStart(2, "0")}`
      : "";
  const releaseName = getSubdlReleaseName(subtitle, unpackedFile);
  const name = [`Arabic #${index + 1} - SubDL${episodeLabel}`, releaseName].filter(Boolean).join(" - ");

  return {
    id: `subdl:${requestInfo.id}:${index}`,
    lang: USE_CUSTOM_LANGUAGE_LABELS ? name : "ara",
    language: "Arabic",
    languageCode: "ara",
    iso_639_2: "ara",
    name,
    title: name,
    url: createSubtitleProxyUrl(req, url, getSubdlSubtitleFileName(subtitle, unpackedFile))
  };
}

function mapSubdlResponseToSubtitles(req, requestInfo, payload) {
  const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  const mapped = [];

  for (const subtitle of subtitles) {
    const unpackedFiles = Array.isArray(subtitle.unpack_files)
      ? subtitle.unpack_files.filter((file) => isMatchingSubdlEpisode(file, requestInfo))
      : [];

    if (unpackedFiles.length > 0) {
      for (const unpackedFile of unpackedFiles) {
        const mappedSubtitle = createSubdlSubtitle(req, subtitle, mapped.length, requestInfo, unpackedFile);
        if (mappedSubtitle) {
          mapped.push(mappedSubtitle);
        }
      }
      continue;
    }

    const mappedSubtitle = createSubdlSubtitle(req, subtitle, mapped.length, requestInfo);
    if (mappedSubtitle) {
      mapped.push(mappedSubtitle);
    }
  }

  return mapped;
}

async function fetchSubdlSubtitles(req) {
  if (!SUBDL_API_KEY) {
    throw new Error("SUBDL_API_KEY is not configured.");
  }

  if (!SUBDL_LANGUAGES) {
    throw new Error("SUBDL_LANGUAGES is not configured.");
  }

  const requestInfo = getSubtitleRequestInfo(req);
  if (!requestInfo) {
    throw new Error("Could not parse a Stremio IMDb id from the subtitles request.");
  }

  const response = await fetchWithTimeout(buildSubdlSearchUrl(requestInfo), {
    headers: {
      "accept": "application/json",
      "user-agent": "nuvio-arabic-subtitles-addon/1.0"
    }
  }, SUBDL_TIMEOUT_MS);

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SubDL returned ${response.status}: ${text.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error("SubDL response was not JSON.");
  }

  if (payload && payload.status === false) {
    throw new Error(`SubDL error: ${payload.error || "unknown error"}`);
  }

  return mapSubdlResponseToSubtitles(req, requestInfo, payload);
}

async function getSubdlDebugInfo(req, subtitlePath) {
  const debugReq = {
    ...req,
    url: subtitlePath
  };
  const requestInfo = getSubtitleRequestInfo(debugReq);
  if (!requestInfo) {
    throw new Error("Could not parse the debug subtitles path.");
  }
  if (!SUBDL_API_KEY) {
    throw new Error("SUBDL_API_KEY is not configured in this service.");
  }

  const url = buildSubdlSearchUrl(requestInfo);
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "nuvio-arabic-subtitles-addon/1.0"
    }
  }, SUBDL_TIMEOUT_MS);
  const text = await response.text();
  const durationMs = Date.now() - startedAt;
  let payload = null;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`SubDL response was not JSON: ${text.slice(0, 200)}`);
  }

  const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  const mapped = mapSubdlResponseToSubtitles(debugReq, requestInfo, payload);
  const unpackFileCount = subtitles.reduce(
    (count, subtitle) => count + (Array.isArray(subtitle.unpack_files) ? subtitle.unpack_files.length : 0),
    0
  );

  return {
    ok: response.ok && payload.status !== false,
    requestInfo,
    subdlRequestUrl: redactSubdlUrl(url),
    subdlStatusCode: response.status,
    subdlDurationMs: durationMs,
    subdlPayloadStatus: payload.status,
    subdlError: payload.error || null,
    resultCount: Array.isArray(payload.results) ? payload.results.length : 0,
    subtitleCount: subtitles.length,
    unpackFileCount,
    mappedSubtitleCount: mapped.length,
    sampleMappedSubtitles: mapped.slice(0, 5).map((subtitle) => ({
      id: subtitle.id,
      lang: subtitle.lang,
      name: subtitle.name,
      hasProxyUrl: Boolean(subtitle.url)
    })),
    sampleRawSubtitles: subtitles.slice(0, 3).map((subtitle) => ({
      name: subtitle.name || null,
      release_name: subtitle.release_name || null,
      season: subtitle.season || null,
      episode: subtitle.episode || null,
      url: subtitle.url || null,
      unpack_files: Array.isArray(subtitle.unpack_files) ? subtitle.unpack_files.length : 0
    }))
  };
}

function isZipBuffer(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function isZipResponse(url, contentType, buffer) {
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch (error) {
      return "";
    }
  })();

  return contentType.includes("zip") || pathname.endsWith(".zip") || isZipBuffer(buffer);
}

function getSubtitleContentType(fileName) {
  const lowerName = String(fileName || "").toLowerCase();
  if (lowerName.endsWith(".vtt")) {
    return "text/vtt";
  }
  if (lowerName.endsWith(".ass") || lowerName.endsWith(".ssa")) {
    return "text/plain";
  }
  return "application/x-subrip";
}

function getSubtitleContentTypeFromUrl(url) {
  try {
    return getSubtitleContentType(new URL(url).pathname);
  } catch (error) {
    return "application/x-subrip";
  }
}

function getSubtitleExtensionPriority(fileName) {
  const lowerName = String(fileName || "").toLowerCase();
  if (lowerName.endsWith(".srt")) {
    return 0;
  }
  if (lowerName.endsWith(".vtt")) {
    return 1;
  }
  if (lowerName.endsWith(".ass")) {
    return 2;
  }
  if (lowerName.endsWith(".ssa")) {
    return 3;
  }
  if (lowerName.endsWith(".sub")) {
    return 4;
  }
  return 99;
}

function isSubtitleFile(fileName) {
  return getSubtitleExtensionPriority(fileName) < 99;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

function decodeZipFileName(buffer, useUtf8) {
  return buffer.toString(useUtf8 ? "utf8" : "latin1");
}

function inflateZipEntry(entry) {
  if (entry.compressionMethod === 0) {
    return entry.compressedData;
  }

  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(entry.compressedData);
  }

  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}.`);
}

function extractSubtitleFromZip(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error("ZIP central directory was not found.");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const candidates = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd > buffer.length) {
      break;
    }

    const fileName = decodeZipFileName(buffer.subarray(nameStart, nameEnd), Boolean(flags & 0x0800));
    const nextOffset = nameEnd + extraLength + commentLength;
    const isEncrypted = Boolean(flags & 0x0001);
    const isDirectory = fileName.endsWith("/") || fileName.endsWith("\\");
    const isMacOsMetadata = fileName.startsWith("__MACOSX/") || fileName.includes("/__MACOSX/");

    if (!isEncrypted && !isDirectory && !isMacOsMetadata && isSubtitleFile(fileName)) {
      if (uncompressedSize > MAX_EXTRACTED_SUBTITLE_BYTES) {
        throw new Error(`Subtitle inside ZIP is too large: ${fileName}.`);
      }

      if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        offset = nextOffset;
        continue;
      }

      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;

      if (dataStart <= buffer.length && dataEnd <= buffer.length) {
        candidates.push({
          fileName,
          compressionMethod,
          compressedData: buffer.subarray(dataStart, dataEnd),
          priority: getSubtitleExtensionPriority(fileName)
        });
      }
    }

    offset = nextOffset;
  }

  candidates.sort((left, right) => left.priority - right.priority || left.fileName.length - right.fileName.length);
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error("No supported subtitle file was found inside the ZIP archive.");
  }

  const subtitleBuffer = inflateZipEntry(candidate);
  if (subtitleBuffer.length > MAX_EXTRACTED_SUBTITLE_BYTES) {
    throw new Error(`Extracted subtitle is too large: ${candidate.fileName}.`);
  }

  return {
    fileName: candidate.fileName,
    buffer: subtitleBuffer,
    contentType: getSubtitleContentType(candidate.fileName)
  };
}

function parseProxyPath(path) {
  const token = decodeURIComponent(path.slice("/subtitle-proxy/".length).split("/")[0]);
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex < 1) {
    return null;
  }

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = signPayload(payload);

  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    return null;
  }

  return fromBase64Url(payload);
}

async function readResponseBuffer(response) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Subtitle download is too large: ${contentLength} bytes.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Subtitle download is too large: ${buffer.length} bytes.`);
  }
  return buffer;
}

async function handleSubtitleProxy(req, res, path) {
  const subtitleUrl = resolveSubtitleUrl(parseProxyPath(path));
  if (!subtitleUrl) {
    sendJson(res, 400, { error: "Invalid subtitle proxy URL." });
    return;
  }

  const upstream = await fetchWithTimeout(subtitleUrl, {
    headers: {
      "accept": "application/zip,text/vtt,text/plain,*/*",
      "user-agent": "nuvio-arabic-subtitles-addon/1.0"
    }
  }, SUBTITLE_DOWNLOAD_TIMEOUT_MS);

  const buffer = await readResponseBuffer(upstream);
  if (!upstream.ok) {
    sendBuffer(res, upstream.status, buffer, upstream.headers.get("content-type") || "text/plain");
    return;
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  if (!isZipResponse(subtitleUrl, contentType.toLowerCase(), buffer)) {
    const playerContentType = contentType === "application/octet-stream" ? getSubtitleContentTypeFromUrl(subtitleUrl) : contentType;
    sendBuffer(res, 200, buffer, playerContentType, { "cache-control": "public, max-age=86400" });
    return;
  }

  const extracted = extractSubtitleFromZip(buffer);
  sendBuffer(res, 200, extracted.buffer, extracted.contentType, {
    "cache-control": "public, max-age=86400",
    "x-extracted-from-zip": "true",
    "x-subtitle-filename": extracted.fileName
  });
}

async function handleSubtitles(req, res) {
  let subdlSubtitles = [];
  let subdlError = "";

  try {
    subdlSubtitles = await fetchSubdlSubtitles(req);
  } catch (error) {
    subdlError = error instanceof Error ? error.message : String(error);
    if (DEBUG_REQUESTS) {
      console.log(
        JSON.stringify({
          event: "subdl-error",
          url: decodeURIComponent(req.url),
          error: subdlError
        })
      );
    }
  }

  logSubtitleRequest(req, subdlSubtitles);
  const arabicSubtitles = applySubtitleLimit(sortByRequestRelease(req, subdlSubtitles));

  sendJson(
    res,
    200,
    {
      subtitles: arabicSubtitles
    },
    {
      "cache-control": "public, max-age=300",
      "x-subtitle-source": "subdl",
      "x-subdl-subtitles": String(subdlSubtitles.length),
      "x-arabic-subtitles": String(arabicSubtitles.length),
      "x-max-subtitles": String(MAX_SUBTITLES),
      "x-subdl-enabled": String(Boolean(SUBDL_API_KEY)),
      "x-subdl-error": safeHeaderValue(subdlError)
    }
  );
}

async function handleDebugSubdl(req, res, path) {
  const subtitlePath = path.replace(/^\/debug\/subdl/i, "/subtitles").replace(/\.json$/i, "");
  const normalizedPath = `${subtitlePath}.json`;

  try {
    const info = await getSubdlDebugInfo(req, normalizedPath);
    sendJson(res, 200, {
      ...info,
      subdlApiKeyConfigured: Boolean(SUBDL_API_KEY),
      subdlLanguages: SUBDL_LANGUAGES
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      subdlApiKeyConfigured: Boolean(SUBDL_API_KEY),
      subdlLanguages: SUBDL_LANGUAGES,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const path = req.url.split("?")[0];

    if (path === "/" || path === "/configure") {
      sendText(res, 200, `Install URL: ${getBaseUrl(req)}/manifest.json`);
      return;
    }

    if (path === "/health") {
      sendJson(res, 200, {
        ok: true,
        source: "subdl",
        subdlApiKeyConfigured: Boolean(SUBDL_API_KEY),
        subdlLanguages: SUBDL_LANGUAGES
      });
      return;
    }

    if (path === "/manifest.json") {
      sendJson(res, 200, MANIFEST, { "cache-control": "public, max-age=3600" });
      return;
    }

    if (path.startsWith("/subtitles/")) {
      await handleSubtitles(req, res);
      return;
    }

    if (path.startsWith("/debug/subdl/")) {
      await handleDebugSubdl(req, res, path);
      return;
    }

    if (path.startsWith("/subtitle-proxy/")) {
      await handleSubtitleProxy(req, res, path);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, 500, {
      subtitles: [],
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Arabic subtitles addon listening on http://localhost:${PORT}/manifest.json`);
  console.log(`Using official SubDL API from ${SUBDL_API_BASE}`);
});
