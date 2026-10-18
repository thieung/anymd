import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { ConvertContext } from '../src/convert/types';
import { youtubeAdapter, youtubeFallback } from '../src/convert/youtube';

const VIDEO_URL = new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
const caption = (text: string) => Response.json({ status: 1, data: { sourceId: 'dQw4w9WgXcQ', content: `[at 1.5 seconds] ${text}.`, ext: 'json3' } });

function stubFetch(routes: { rapid?: () => Response; vidcap?: () => Response; fallback?: () => Response }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.startsWith('https://www.youtube.com/oembed')) return Response.json({ title: 'A video', author_name: 'Channel', author_url: 'https://www.youtube.com/@c', thumbnail_url: '' });
    if (url.startsWith('https://youtube-transcript3.p.rapidapi.com/')) return routes.rapid?.() ?? new Response('unexpected', { status: 500 });
    if (url.startsWith('https://vidcap.xyz/api/v1/youtube/caption?')) return routes.vidcap?.() ?? new Response('unexpected', { status: 500 });
    if (url.startsWith('https://ytdlp.example.test/youtube/caption?')) return routes.fallback?.() ?? new Response('unexpected', { status: 500 });
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const context = (env: Partial<Env>) => ({
  env,
  language: 'en',
  tracer: { span: async (_name: string, fn: () => Promise<unknown>) => fn(), note: () => undefined },
} as unknown as ConvertContext);

const FALLBACK = { YOUTUBE_FALLBACK_URL: 'https://ytdlp.example.test/', YOUTUBE_FALLBACK_API_KEY: 'fallback-key' };

afterEach(() => vi.unstubAllGlobals());

describe('youtube transcript providers', () => {
  it('needs both the fallback URL and key, and trims a trailing slash', () => {
    expect(youtubeFallback({ YOUTUBE_FALLBACK_URL: 'https://ytdlp.example.test' } as Env)).toBeNull();
    expect(youtubeFallback({ YOUTUBE_FALLBACK_API_KEY: 'k' } as Env)).toBeNull();
    expect(youtubeFallback(FALLBACK as Env)).toEqual({ base: 'https://ytdlp.example.test', key: 'fallback-key' });
  });

  it('tries RapidAPI, then VidCap, then the self-hosted fallback', async () => {
    const calls = stubFetch({ rapid: () => new Response('quota', { status: 429 }), vidcap: () => new Response('quota', { status: 429 }), fallback: () => caption('From the fallback') });
    const result = await youtubeAdapter.convert(VIDEO_URL, context({ RAPIDAPI_KEY: 'rapid-key', VIDCAP_API_KEY: 'vidcap-key', ...FALLBACK }));
    expect(result.content).toContain('From the fallback.');
    const order = calls.map((c) => new URL(c.url).hostname).filter((h) => h !== 'www.youtube.com');
    expect(order).toEqual(['youtube-transcript3.p.rapidapi.com', 'vidcap.xyz', 'ytdlp.example.test']);
    const fallbackCall = calls.find((c) => c.url.includes('ytdlp.example.test'))!;
    expect(fallbackCall.headers).toMatchObject({ 'X-API-Key': 'fallback-key' });
    expect(new URL(fallbackCall.url).searchParams.get('url')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('does not call the fallback when a hosted provider answers', async () => {
    const calls = stubFetch({ vidcap: () => caption('From VidCap') });
    const result = await youtubeAdapter.convert(VIDEO_URL, context({ VIDCAP_API_KEY: 'vidcap-key', ...FALLBACK }));
    expect(result.content).toContain('From VidCap.');
    expect(calls.some((c) => c.url.includes('ytdlp.example.test'))).toBe(false);
  });

  it('works with only the self-hosted fallback configured', async () => {
    stubFetch({ fallback: () => caption('Only the fallback') });
    const result = await youtubeAdapter.convert(VIDEO_URL, context(FALLBACK));
    expect(result.content).toContain('Only the fallback.');
  });
});
