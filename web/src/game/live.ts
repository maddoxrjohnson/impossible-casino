// Live Qiskit runs on top of the exported results. The game must play the same with the service asleep, down or gone.
import {
  parseLiveChsh,
  parseLiveWiesner,
  type ChshResult,
  type ResultSource,
  type WiesnerResult,
} from './results';

/** A cold start imports Qiskit and builds the noise models before it can answer. */
const WARM_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_MS = 1_500;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 300_000;
/** Cloud Run may scale to zero about now. Past this, a run would only stall on a cold start. */
const IDLE_LIMIT_MS = 300_000;

export interface LiveClock {
  now(): number;
  /** Calls `fn` after `ms`. Returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
}

export type LiveFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface LiveOptions {
  readonly url: string | undefined;
  readonly fetch?: LiveFetch;
  readonly clock?: LiveClock;
}

export interface LiveSource extends ResultSource {
  /** Wakes the service. Never rejects, and retries with backoff until it answers. */
  warm(): Promise<void>;
}

const browserClock: LiveClock = {
  now: () => Date.now(),
  schedule(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => {
      clearTimeout(id);
    };
  },
};

export function createLiveSource(base: ResultSource, options: LiveOptions): LiveSource {
  const url = options.url?.replace(/\/+$/, '');
  const fetchFn: LiveFetch = options.fetch ?? ((target, init) => fetch(target, init));
  const clock = options.clock ?? browserClock;

  let awake = false;
  let lastContact = 0;
  let warming = false;
  let retryQueued = false;
  // Only a live run clears this, so a service that pings fine but fails runs still backs off.
  let failures = 0;

  /** Resolves with the parsed body, or null on any failure. A late answer is dropped. */
  const request = async <T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    parse: (body: unknown) => T,
  ): Promise<T | null> => {
    const controller = new AbortController();
    let cancel = (): void => undefined;
    const timedOut = new Promise<null>((resolve) => {
      cancel = clock.schedule(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const attempt = async (): Promise<T | null> => {
      try {
        const response = await fetchFn(`${url ?? ''}${path}`, {
          ...init,
          signal: controller.signal,
          credentials: 'omit',
        });
        return response.status === 200 ? parse(await response.json()) : null;
      } catch {
        return null;
      }
    };
    const value = await Promise.race([attempt(), timedOut]);
    cancel();
    return value;
  };

  const queueRetry = (): void => {
    if (retryQueued) return;
    retryQueued = true;
    const wait = Math.min(FIRST_RETRY_MS * 2 ** failures, MAX_RETRY_MS);
    failures += 1;
    clock.schedule(() => {
      retryQueued = false;
      void warm();
    }, wait);
  };

  const warm = async (): Promise<void> => {
    if (url === undefined || url === '' || awake || warming) return;
    warming = true;
    const answer = await request('/health', { method: 'GET' }, WARM_TIMEOUT_MS, (body) => {
      return (body as { status?: unknown } | null)?.status === 'ok' ? true : null;
    });
    warming = false;
    if (answer) {
      awake = true;
      lastContact = clock.now();
    } else {
      queueRetry();
    }
  };

  const tryLive = async <T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T | null> => {
    if (!awake) return null;
    if (clock.now() - lastContact > IDLE_LIMIT_MS) {
      awake = false;
      void warm();
      return null;
    }
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
    const value = await request(path, init, RUN_TIMEOUT_MS, parse);
    if (value === null) {
      awake = false;
      queueRetry();
    } else {
      failures = 0;
      lastContact = clock.now();
    }
    return value;
  };

  return {
    dials: base.dials,
    limits: base.limits,
    previewProvenance: base.previewProvenance,
    snapDial: (value) => base.snapDial(value),
    previewWinRate: (dial) => base.previewWinRate(dial),
    warm,
    async chsh(dial): Promise<ChshResult> {
      const prerun = await base.chsh(dial);
      const live = await tryLive('/v1/chsh', { dial: prerun.dial }, (raw) => parseLiveChsh(raw, prerun.dial));
      return live ? { ...prerun, ...live } : prerun;
    },
    async wiesner(length): Promise<WiesnerResult> {
      const prerun = await base.wiesner(length);
      const live = await tryLive('/v1/wiesner', { length }, (raw) => parseLiveWiesner(raw, length));
      return live ? { ...prerun, ...live } : prerun;
    },
  };
}
