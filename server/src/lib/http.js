// Shared fetch with timeout, retries and exponential backoff.
export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = 10000,
    retries = 2,
    backoffMs = 800,
    headers = {},
    limiter, // optional: a scheduler from createLimiter()
  } = options;

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', ...headers },
      });
      if (res.status === 429) throw new Error('429 rate-limited');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const exec = limiter ? () => limiter(attempt) : attempt;

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await exec();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        const wait = backoffMs * Math.pow(2, i) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
