import { clearsCage, settleForge, type ForgeAttempt } from './cage';
import { safeStorage, readSave, writeSave, type SaveData, type SaveStorage } from './save';
import { sampleOutcome, type ChshResult, type ResultSource } from './results';
import {
  BEYOND_MIN_HANDS,
  BREAK_EVEN,
  CLASSICAL_ANSWER,
  CLASSICAL_HANDS,
  CLASSICAL_STAKE,
  HAND_MS,
  HISTORY_CAP,
  QUESTIONS,
  RUN_HANDS,
  STAKES,
  START_BANKROLL,
  START_DIAL,
  chshWin,
  dealDeck,
  isForgeLength,
  isStake,
  winPayout,
  type Bit,
  type Question,
  type RoomId,
  type Rng,
} from './rules';

export type Phase = 'intro' | 'classical' | 'wall' | 'entangled' | 'beyond';
export type Mode = 'classical' | 'quantum';

export interface LastHand {
  readonly x: Bit;
  readonly y: Bit;
  readonly a: Bit;
  readonly b: Bit;
  readonly win: boolean;
  readonly delta: number;
}

export interface GameState {
  readonly phase: Phase;
  readonly mode: Mode;
  readonly dial: number;
  readonly bankroll: number;
  readonly rounds: number;
  readonly wins: number;
  readonly winRate: number;
  readonly target: number;
  readonly last: LastHand | null;
  /** Recent wins as 0/1, newest last, capped at HISTORY_CAP. */
  readonly history: readonly Bit[];
  readonly autoplaying: boolean;
  readonly stake: number;
  readonly cleared: readonly RoomId[];
  readonly broke: boolean;
  /** The current or last quantum run. Classical hands are not quantum results. */
  readonly result: ChshResult | null;
  /** A forge is waiting on its source. Nothing moves the bankroll or the stake until it settles. */
  readonly forging: boolean;
  /** The last settled forge. Not saved, so a reload starts without one. */
  readonly forge: ForgeAttempt | null;
}

export interface GameStoreOptions {
  source: ResultSource;
  rng?: Rng;
  storage?: SaveStorage | null;
  handMs?: number;
}

export interface GameStore {
  readonly state: GameState;
  subscribe(fn: (state: GameState) => void): () => void;
  onRound(fn: (last: LastHand, state: GameState) => void): () => void;
  deal(): void;
  entangle(): void;
  setDial(value: number): void;
  setStake(value: number): void;
  run(hands?: number): Promise<void>;
  /** `payoutStake` is the stake the exported pay table is quoted on. */
  forge(length: number, payoutStake: number): Promise<void>;
  restart(): void;
  clearRoom(room: RoomId): void;
  dispose(): void;
}

type Answer = (question: Question) => { a: Bit; b: Bit };

function pairTable(result: ChshResult) {
  const [p00, p01, p10, p11] = QUESTIONS.map(({ x, y }) =>
    result.pairs.find((p) => p.x === x && p.y === y),
  );
  return p00 && p01 && p10 && p11 ? ([[p00, p01], [p10, p11]] as const) : null;
}

export function createGameStore({
  source,
  rng = Math.random,
  storage = safeStorage(),
  handMs = HAND_MS,
}: GameStoreOptions): GameStore {
  const listeners = new Set<(state: GameState) => void>();
  const roundListeners = new Set<(last: LastHand, state: GameState) => void>();
  const history: Bit[] = [];
  const cleared: RoomId[] = [];

  const freshFields = () => ({
    phase: 'intro' as Phase,
    mode: 'classical' as Mode,
    dial: source.snapDial(START_DIAL),
    bankroll: START_BANKROLL as number,
    rounds: 0,
    wins: 0,
    winRate: 0,
    target: source.limits.classical,
    last: null as LastHand | null,
    autoplaying: false,
    stake: CLASSICAL_STAKE as number,
    broke: false,
    result: null as ChshResult | null,
    forging: false,
    forge: null as ForgeAttempt | null,
  });
  const state = { ...freshFields(), history, cleared };

  let timer: ReturnType<typeof setInterval> | null = null;
  let finishRun: (() => void) | null = null;
  // Bumped whenever a run ends, so a source call still in flight knows it was abandoned.
  let runToken = 0;
  // The same for a forge, so one abandoned by a restart or dispose never settles.
  let forgeToken = 0;
  let disposed = false;

  const emit = (): void => {
    listeners.forEach((fn) => {
      fn(state);
    });
  };

  const save = (): void => {
    // A save always describes a settled game, so hands in progress are never written.
    if (state.autoplaying || state.phase === 'classical') return;
    const { bankroll, phase, dial, stake } = state;
    const data: SaveData = { version: 1, bankroll, phase, dial, stake, cleared: [...cleared] };
    writeSave(storage, data);
  };

  const settleStake = (): void => {
    if (state.stake > state.bankroll) {
      const affordable = STAKES.filter((stake) => stake <= state.bankroll);
      state.stake = affordable[affordable.length - 1] ?? STAKES[0];
    }
    state.broke = state.bankroll < STAKES[0];
  };

  const stopRun = (): void => {
    runToken += 1;
    if (timer !== null) clearInterval(timer);
    timer = null;
    state.autoplaying = false;
    finishRun?.();
    finishRun = null;
  };

  const resetCounters = (): void => {
    state.rounds = 0;
    state.wins = 0;
    state.winRate = 0;
    history.length = 0;
  };

  const markCleared = (room: RoomId): void => {
    if (!cleared.includes(room)) cleared.push(room);
  };

  const endHands = (deckFinished: boolean): void => {
    stopRun();
    if (deckFinished && state.phase === 'classical') state.phase = 'wall';
    settleStake();
    save();
  };

  const playHand = (question: Question, answer: Answer): void => {
    const { x, y } = question;
    const { a, b } = answer(question);
    const win = chshWin(x, y, a, b);
    const delta = win ? winPayout(state.stake) : -state.stake;
    state.rounds += 1;
    state.wins += win ? 1 : 0;
    state.winRate = state.wins / state.rounds;
    state.bankroll += delta;
    state.last = { x, y, a, b, win, delta };
    history.push(win ? 1 : 0);
    if (history.length > HISTORY_CAP) history.shift();
    // Break-even rather than a fixed rate, so noisier chip data can still clear the
    // table; the target check stops a lucky streak on a mistuned dial from counting.
    if (
      state.phase === 'entangled' &&
      state.rounds >= BEYOND_MIN_HANDS &&
      state.target > BREAK_EVEN &&
      state.winRate > BREAK_EVEN
    ) {
      state.phase = 'beyond';
      markCleared('tables');
    }
  };

  /** Plays the deck on the timer. The stake stays fixed until the run stops. */
  const playHands = (deck: readonly Question[], answer: Answer): Promise<void> =>
    new Promise((resolve) => {
      finishRun = resolve;
      let dealt = 0;
      timer = setInterval(() => {
        const question = deck[dealt];
        if (!question) return;
        dealt += 1;
        playHand(question, answer);
        const deckFinished = dealt >= deck.length;
        if (deckFinished || state.bankroll < state.stake) endHands(deckFinished);
        const { last } = state;
        if (last) {
          roundListeners.forEach((fn) => {
            fn(last, state);
          });
        }
        emit();
      }, handMs);
    });

  /** A failed call and an unusable result end a run the same way, before any hand. */
  const fetchRun = async (dial: number) => {
    try {
      const result = await source.chsh(dial);
      const pairs = pairTable(result);
      return pairs && result.dial === dial ? { result, pairs } : null;
    } catch {
      return null;
    }
  };

  const fetchForge = async (length: number) => {
    try {
      const result = await source.wiesner(length);
      return result.length === length && result.shots > 0 ? result : null;
    } catch {
      return null;
    }
  };

  const restore = (data: SaveData): void => {
    const quantum = data.phase === 'entangled' || data.phase === 'beyond';
    state.phase = data.phase;
    state.mode = quantum ? 'quantum' : 'classical';
    state.dial = source.snapDial(data.dial);
    state.bankroll = data.bankroll;
    state.stake = data.stake;
    state.target = quantum ? source.previewWinRate(state.dial) : source.limits.classical;
    cleared.push(...data.cleared);
    if (data.phase === 'beyond') markCleared('tables');
    settleStake();
  };

  const saved = readSave(storage);
  if (saved) restore(saved);

  return {
    state,
    subscribe(fn) {
      if (disposed) return () => undefined;
      listeners.add(fn);
      fn(state);
      return () => {
        listeners.delete(fn);
      };
    },
    onRound(fn) {
      if (disposed) return () => undefined;
      roundListeners.add(fn);
      return () => {
        roundListeners.delete(fn);
      };
    },
    deal() {
      if (disposed || state.phase !== 'intro' || state.broke || state.forging) return;
      state.phase = 'classical';
      state.stake = CLASSICAL_STAKE;
      state.autoplaying = true;
      resetCounters();
      void playHands(dealDeck(CLASSICAL_HANDS, rng), () => ({
        a: CLASSICAL_ANSWER,
        b: CLASSICAL_ANSWER,
      }));
      emit();
    },
    entangle() {
      if (disposed || state.phase !== 'wall' || state.broke || state.forging) return;
      state.phase = 'entangled';
      state.mode = 'quantum';
      resetCounters();
      state.target = source.previewWinRate(state.dial);
      save();
      emit();
    },
    setDial(value) {
      if (disposed || state.autoplaying || state.mode !== 'quantum' || state.broke) return;
      const dial = source.snapDial(value);
      if (dial === state.dial) return;
      state.dial = dial;
      state.target = source.previewWinRate(dial);
      save();
      emit();
    },
    setStake(value) {
      if (disposed || state.autoplaying || state.forging || !isStake(value)) return;
      if (value > state.bankroll || value === state.stake) return;
      state.stake = value;
      save();
      emit();
    },
    async run(hands = RUN_HANDS) {
      if (disposed || state.mode !== 'quantum' || state.autoplaying || state.broke) return;
      if (state.forging) return;
      if (!Number.isFinite(hands) || hands < 1) return;
      state.autoplaying = true;
      state.result = null;
      state.last = null;
      resetCounters();
      runToken += 1;
      const token = runToken;
      emit();
      const usable = await fetchRun(state.dial);
      if (token !== runToken) return;
      if (!usable) {
        endHands(false);
        emit();
        return;
      }
      const { result, pairs } = usable;
      state.result = result;
      state.target = result.winRate;
      emit();
      if (token !== runToken) return;
      await playHands(dealDeck(hands, rng), ({ x, y }) => sampleOutcome(pairs[x][y], rng));
    },
    async forge(length, payoutStake) {
      if (disposed || state.forging || state.autoplaying || state.broke) return;
      if (!isForgeLength(length) || !(payoutStake > 0) || state.stake > state.bankroll) return;
      const { stake } = state;
      state.forging = true;
      forgeToken += 1;
      const token = forgeToken;
      emit();
      const result = await fetchForge(length);
      if (token !== forgeToken) return;
      state.forging = false;
      if (result) {
        const attempt = settleForge(result, stake, payoutStake, rng);
        state.forge = attempt;
        state.bankroll += attempt.delta;
        // Marked directly: clearRoom is a no-op while broke, and it saves and emits on its own.
        if (clearsCage(attempt)) markCleared('cage');
        settleStake();
        save();
      }
      emit();
    },
    restart() {
      if (disposed) return;
      forgeToken += 1;
      stopRun();
      Object.assign(state, freshFields());
      history.length = 0;
      cleared.length = 0;
      save();
      emit();
    },
    clearRoom(room) {
      if (disposed || state.broke || room === 'tables' || cleared.includes(room)) return;
      cleared.push(room);
      save();
      emit();
    },
    dispose() {
      disposed = true;
      forgeToken += 1;
      stopRun();
      listeners.clear();
      roundListeners.clear();
    },
  };
}
