/** Anonymous same-origin proxy for bounded, public Lichess game exports.
 * GET ?username=sampleplayer&speed=bullet&max=20
 * No request body, cookies, authorization, arbitrary upstream URL, retry,
 * logging or storage. Native Node req/res, compatible with Vercel functions.
 */
export const MAX_BYTES = 4 * 1024 * 1024;
export const DEADLINE_MS = 20_000;
const SPEEDS = new Set(['bullet', 'blitz', 'rapid', 'classical']);
const KEYS = new Set(['username', 'speed', 'max']);

function error(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: code, message }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    error(res, 405, 'method_not_allowed', 'Only GET is supported.');
    return;
  }
  let username, speed, max;
  try {
    const params = new URL(req.url ?? '/api/lichess-games', 'http://localhost').searchParams;
    for (const key of params.keys()) {
      if (!KEYS.has(key) || params.getAll(key).length !== 1) throw new Error('Unknown or repeated query parameter.');
    }
    username = params.get('username');
    speed = params.get('speed');
    const rawMax = params.get('max');
    if (!username || !/^[a-zA-Z0-9_-]{2,30}$/.test(username)) throw new Error('username must be 2–30 letters, digits, underscores or hyphens.');
    if (!SPEEDS.has(speed)) throw new Error('speed must be bullet, blitz, rapid or classical.');
    if (rawMax !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(rawMax)) throw new Error('max must be an integer from 1 to 20.');
    max = rawMax ?? '20';
  } catch (e) {
    error(res, 400, 'invalid_query', e instanceof Error ? e.message : 'Invalid query.');
    return;
  }

  const query = new URLSearchParams({ perfType: speed, max, ongoing: 'false', finished: 'true',
    evals: 'true', clocks: 'true', opening: 'true', pgnInJson: 'true', moves: 'true', sort: 'dateDesc' });
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username.toLowerCase())}?${query}`;
  const controller = new AbortController();
  let timer, reader, timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('Lichess export exceeded the 20-second deadline.'));
    }, DEADLINE_MS);
  });
  try {
    const work = (async () => {
      const upstream = await fetch(url, {
        method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/x-ndjson', 'User-Agent': 'QueenCoach-PublicLichessImport/1.0' },
      });
      reader = upstream.body?.getReader();
      if (upstream.status === 429) return { status: 429 };
      if (!upstream.ok) return { status: 502, upstreamStatus: upstream.status };
      const declared = upstream.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new RangeError('Lichess export exceeds the 4 MB response limit.');
      if (!reader) throw new Error('Lichess returned no export stream.');
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new RangeError('Lichess export exceeds the 4 MB response limit.');
        chunks.push(Buffer.from(value));
      }
      return { status: 200, body: Buffer.concat(chunks, bytes) };
    })();
    const result = await Promise.race([work, deadline]);
    if (result.status === 429) {
      res.setHeader('Retry-After', '60');
      error(res, 429, 'lichess_rate_limit', 'Lichess rate limit reached. Wait at least 60 seconds; no retry was submitted.');
    } else if (result.status !== 200) {
      error(res, 502, 'lichess_upstream_error', `Lichess returned HTTP ${result.upstreamStatus}.`);
    } else {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(result.body);
    }
  } catch (e) {
    controller.abort();
    error(res, timedOut ? 504 : 502, timedOut ? 'lichess_timeout' : e instanceof RangeError ? 'lichess_response_too_large' : 'lichess_fetch_failed',
      timedOut ? 'Lichess export exceeded the 20-second deadline.' : e instanceof RangeError ? e.message : 'Could not retrieve the public Lichess export.');
  } finally {
    clearTimeout(timer);
    // Do not let a stalled upstream cancellation extend the hard deadline.
    if (reader) void reader.cancel().catch(() => {});
  }
}
