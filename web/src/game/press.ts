// The owner's live chip press. One press sends a CHSH job at the middle dial to IBM, then this polls until the chip answers.
// Queues have run from 2 to 35 minutes, so nothing here holds the table up.
import type { LiveClock, LiveFetch } from './live';
import {
  parseLiveChipChsh,
  type ChipProvenance,
  type ChshResult,
  type GameExports,
  type LiveChsh,
  type ResultSource,
} from './results';

/** The dial the service runs a press at. */
export const PRESS_DIAL = 0.5;
export const PRESS_JOB_KEY = 'impossible-casino.chip-job.v1';

/** The service's own request timeout. It reads the chip's calibration and compiles before it answers. */
const PRESS_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 20_000;
const FIRST_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const POLL_GROWTH = 1.5;
const MAX_MESSAGE_CHARS = 160;
const JOB_ID = /^[a-z0-9]{16,40}$/;
/** The service may have submitted before the answer was lost. A second press is handed that job. */
const MAYBE_SENT = 'No answer from the service. The run may have been sent: press again to pick it up.';

export type PressedRun = LiveChsh & { readonly provenance: ChipProvenance };

export type PressState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'queued' | 'running'; readonly jobId: string; readonly backend: string | null }
  | { readonly kind: 'done'; readonly jobId: string; readonly result: PressedRun }
  | { readonly kind: 'ended'; readonly jobId: string; readonly outcome: 'error' | 'cancelled' | 'gone' }
  | { readonly kind: 'refused'; readonly message: string };

export type PressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PressOptions {
  readonly url: string | undefined;
  readonly fetch?: LiveFetch;
  readonly clock?: LiveClock;
  /** Holds the job id only, so a reload picks the job back up. */
  readonly storage: PressStorage | null;
}

export interface ChipPress {
  readonly available: boolean;
  readonly state: PressState;
  /** The passphrase goes in this one request body and is not kept. */
  press(passphrase: string): Promise<void>;
  /** Starts polling a job left in storage by an earlier visit. */
  resume(): void;
  /** The pressed chip result, once the chip has answered. */
  result(): PressedRun | null;
  subscribe(fn: (state: PressState) => void): () => void;
  dispose(): void;
}

/** 5 s, growing by half each poll, to 30 s. */
export function pollDelay(attempt: number): number {
  return Math.min(Math.round(FIRST_POLL_MS * POLL_GROWTH ** attempt), MAX_POLL_MS);
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

function detail(body: unknown): string | null {
  const text = (body as { detail?: unknown } | null)?.detail;
  return typeof text === 'string' && text.length > 0 ? text.slice(0, MAX_MESSAGE_CHARS) : null;
}

export function createChipPress(options: PressOptions): ChipPress {
  const url = options.url?.replace(/\/+$/, '') ?? '';
  const available = url !== '';
  const fetchFn: LiveFetch = options.fetch ?? ((target, init) => fetch(target, init));
  const clock = options.clock ?? browserClock;
  const { storage } = options;
  const listeners = new Set<(state: PressState) => void>();

  let state: PressState = { kind: 'idle' };
  // The last chip result keeps playing until IBM accepts another job.
  let played: PressedRun | null = null;
  let attempt = 0;
  let cancelPoll = (): void => undefined;
  let disposed = false;

  const store = (jobId: string | null): void => {
    try {
      if (jobId === null) storage?.removeItem(PRESS_JOB_KEY);
      else storage?.setItem(PRESS_JOB_KEY, jobId);
    } catch {
      // A blocked store only loses the resume.
    }
  };

  const set = (next: PressState): void => {
    if (disposed) return;
    state = next;
    for (const fn of listeners) fn(next);
  };

  /** The status and body, or null if the service could not be reached in time. */
  const request = async (path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown } | null> => {
    const controller = new AbortController();
    let cancel = (): void => undefined;
    const timedOut = new Promise<null>((resolve) => {
      cancel = clock.schedule(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const attemptFetch = async (): Promise<{ status: number; body: unknown } | null> => {
      try {
        const response = await fetchFn(`${url}${path}`, { ...init, signal: controller.signal, credentials: 'omit' });
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // A body that is not JSON still has a status.
        }
        return { status: response.status, body };
      } catch {
        return null;
      }
    };
    const answer = await Promise.race([attemptFetch(), timedOut]);
    cancel();
    return answer;
  };

  const schedulePoll = (jobId: string, backend: string | null, ms: number): void => {
    cancelPoll();
    cancelPoll = clock.schedule(() => {
      void poll(jobId, backend);
    }, ms);
  };

  const end = (jobId: string, outcome: 'error' | 'cancelled' | 'gone'): void => {
    store(null);
    set({ kind: 'ended', jobId, outcome });
  };

  const poll = async (jobId: string, backend: string | null): Promise<void> => {
    const answer = await request(`/v1/chip/run/${jobId}`, { method: 'GET' }, POLL_TIMEOUT_MS);
    if (disposed) return;
    const next = pollDelay(attempt);
    attempt += 1;
    if (answer === null || answer.status !== 200) {
      // 404 means the job is not ours or is gone; 403 means presses were switched off. Anything else may pass.
      if (answer?.status === 404 || answer?.status === 403) end(jobId, 'gone');
      else schedulePoll(jobId, backend, next);
      return;
    }
    const status = (answer.body as { status?: unknown } | null)?.status;
    if (status === 'queued' || status === 'running') {
      if (state.kind !== status) set({ kind: status, jobId, backend });
      schedulePoll(jobId, backend, next);
    } else if (status === 'done') {
      try {
        const result = parseLiveChipChsh((answer.body as { result?: unknown }).result, PRESS_DIAL);
        if (result.provenance.jobId !== jobId) throw new Error('the result names another job');
        played = result;
        set({ kind: 'done', jobId, result });
      } catch {
        end(jobId, 'error');
      }
    } else if (status === 'cancelled') {
      end(jobId, 'cancelled');
    } else {
      end(jobId, 'error');
    }
  };

  const follow = (jobId: string, backend: string | null, firstMs: number): void => {
    attempt = 0;
    played = null;
    set({ kind: 'queued', jobId, backend });
    schedulePoll(jobId, backend, firstMs);
  };

  // An id left by an earlier visit. Anything that is not one is dropped.
  let stored: string | null;
  try {
    stored = available ? (storage?.getItem(PRESS_JOB_KEY) ?? null) : null;
  } catch {
    stored = null;
  }
  if (stored !== null && JOB_ID.test(stored)) state = { kind: 'queued', jobId: stored, backend: null };
  else if (stored !== null) store(null);

  const busy = (): boolean => state.kind === 'sending' || state.kind === 'queued' || state.kind === 'running';

  return {
    available,
    get state() {
      return state;
    },
    async press(passphrase) {
      if (!available || disposed || busy()) return;
      set({ kind: 'sending' });
      const answer = await request(
        '/v1/chip/run',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase }) },
        PRESS_TIMEOUT_MS,
      );
      if (disposed) return;
      if (answer === null || answer.status >= 500) {
        set({ kind: 'refused', message: MAYBE_SENT });
        return;
      }
      const body = answer.body as { status?: unknown; jobId?: unknown; backend?: unknown } | null;
      const jobId = typeof body?.jobId === 'string' && JOB_ID.test(body.jobId) ? body.jobId : null;
      // A 409 with a job id is our own run still waiting, so follow it rather than refuse.
      const accepted = (answer.status === 200 && body?.status === 'queued') || answer.status === 409;
      if (!accepted || jobId === null) {
        set({ kind: 'refused', message: (answer.status === 200 ? null : detail(answer.body)) ?? 'The chip run was not accepted.' });
        return;
      }
      const backend = typeof body?.backend === 'string' ? body.backend : null;
      store(jobId);
      follow(jobId, backend, answer.status === 409 ? 0 : FIRST_POLL_MS);
    },
    resume() {
      if (!available || disposed || state.kind !== 'queued') return;
      follow(state.jobId, state.backend, 0);
    },
    result: () => played,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      cancelPoll();
      listeners.clear();
    },
  };
}

/** The pressed chip result at its dial, over any other source. Every other dial and the Cage stay with the source underneath. */
export function withPressedRun(base: ResultSource, exports: GameExports, pressed: () => PressedRun | null): ResultSource {
  const at = (dial: number): PressedRun | null => (base.snapDial(dial) === PRESS_DIAL ? pressed() : null);
  return {
    dials: base.dials,
    limits: base.limits,
    snapDial: (value) => base.snapDial(value),
    previewProvenance: (dial) => at(dial)?.provenance ?? base.previewProvenance(dial),
    previewWinRate: (dial) => at(dial)?.winRate ?? base.previewWinRate(dial),
    async chsh(dial): Promise<ChshResult> {
      const run = at(dial);
      if (!run) return base.chsh(dial);
      const circuits = exports.chsh.logicalCircuits.find((c) => c.dial === PRESS_DIAL);
      if (!circuits) throw new Error(`No circuits at dial ${String(PRESS_DIAL)}`);
      return {
        experiment: 'chsh',
        runId: run.runId,
        dial: PRESS_DIAL,
        winRate: run.winRate,
        outcomeOrder: exports.chsh.outcomeOrder,
        pairs: run.pairs,
        circuits: circuits.pairs,
        provenance: run.provenance,
      };
    },
    wiesner: (length) => base.wiesner(length),
  };
}

/** Reaching localStorage can itself throw a SecurityError. */
export function pressStorage(): PressStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
