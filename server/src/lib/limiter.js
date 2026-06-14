// Tiny throttle: guarantees a minimum gap between calls and caps concurrency,
// so we never hammer an external API. One limiter instance per provider.
export function createLimiter({ minGapMs = 1200, maxConcurrent = 2 } = {}) {
  let lastStart = 0;
  let active = 0;
  const queue = [];

  function next() {
    if (active >= maxConcurrent || queue.length === 0) return;
    const wait = Math.max(0, lastStart + minGapMs - Date.now());
    const run = () => {
      lastStart = Date.now();
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    };
    if (wait === 0) run();
    else setTimeout(run, wait);
  }

  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
