import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UrlPreview } from '@/models';

const CACHE_PREFIX = 'link_preview:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 256 * 1024; // 256KB - enough for OG tags

const URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/gi;

const inflightFetches = new Map<string, Promise<UrlPreview>>();

interface CacheEntry {
  preview: UrlPreview;
  fetchedAt: number;
}

/** Find the first http(s) URL in a string. Returns null if none. */
export const extractFirstUrl = (text?: string): string | null => {
  if (!text) return null;
  URL_REGEX.lastIndex = 0;
  const match = URL_REGEX.exec(text);
  if (!match) return null;
  // Strip common trailing punctuation that's almost never part of the URL.
  return match[0].replace(/[.,;:!?)\]}'"]+$/, '');
};

const cacheKey = (url: string) => `${CACHE_PREFIX}${url}`;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const matchMeta = (html: string, names: string[]): string | undefined => {
  for (const name of names) {
    // og:image / twitter:image style — property OR name attribute, content can come before or after.
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i',
    );
    const re2 = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
      'i',
    );
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return undefined;
};

const matchTitle = (html: string): string | undefined => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : undefined;
};

const resolveUrl = (base: string, maybeRelative: string): string => {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
};

const parseHtml = (url: string, html: string): UrlPreview => {
  const title =
    matchMeta(html, ['og:title', 'twitter:title']) ?? matchTitle(html);
  const description = matchMeta(html, [
    'og:description',
    'twitter:description',
    'description',
  ]);
  const rawImage = matchMeta(html, ['og:image', 'twitter:image', 'twitter:image:src']);
  const siteName = matchMeta(html, ['og:site_name', 'application-name']);
  const imageUrl = rawImage ? resolveUrl(url, rawImage) : undefined;

  return {
    url,
    title,
    description,
    imageUrl,
    siteName,
    failed: !title && !description && !imageUrl,
  };
};

const fetchWithTimeout = async (url: string): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some sites serve different markup to bot vs browser UAs; use a
        // browser-like UA to maximize the chance of getting OG tags.
        'User-Agent':
          'Mozilla/5.0 (compatible; SplitCircle/1.0; +https://splitcircle.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
};

const readCache = async (url: string): Promise<UrlPreview | null> => {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
      return null;
    }
    return entry.preview;
  } catch {
    return null;
  }
};

const writeCache = async (url: string, preview: UrlPreview): Promise<void> => {
  try {
    const entry: CacheEntry = { preview, fetchedAt: Date.now() };
    await AsyncStorage.setItem(cacheKey(url), JSON.stringify(entry));
  } catch (error) {
    console.warn('linkPreview: cache write failed', error);
  }
};

export const fetchLinkPreview = async (url: string): Promise<UrlPreview> => {
  const cached = await readCache(url);
  if (cached) return cached;

  const inflight = inflightFetches.get(url);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const html = await fetchWithTimeout(url);
      const preview = parseHtml(url, html);
      await writeCache(url, preview);
      return preview;
    } catch (error) {
      const fallback: UrlPreview = { url, failed: true };
      await writeCache(url, fallback);
      return fallback;
    } finally {
      inflightFetches.delete(url);
    }
  })();

  inflightFetches.set(url, promise);
  return promise;
};

export const getDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
