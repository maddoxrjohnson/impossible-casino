import { ROOMS, isStake, type RoomId } from './rules';

export const SAVE_KEY = 'impossible-casino.save.v1';

const SAVE_PHASES = ['intro', 'wall', 'entangled', 'beyond'] as const;
export type SavePhase = (typeof SAVE_PHASES)[number];

export interface SaveData {
  version: 1;
  bankroll: number;
  phase: SavePhase;
  dial: number;
  stake: number;
  cleared: RoomId[];
}

export type SaveStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Reaching localStorage can itself throw a SecurityError. */
export function safeStorage(): SaveStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function isSavePhase(value: unknown): value is SavePhase {
  return SAVE_PHASES.some((phase) => phase === value);
}

function isRoom(value: unknown): value is RoomId {
  return ROOMS.some((room) => room === value);
}

function parse(text: string): SaveData | null {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, bankroll, phase, dial, stake, cleared } = raw as Record<string, unknown>;
  if (version !== 1) return null;
  if (!Number.isSafeInteger(bankroll) || (bankroll as number) < 0) return null;
  if (!isSavePhase(phase)) return null;
  if (typeof dial !== 'number' || !(dial >= 0 && dial <= 1)) return null;
  if (!isStake(stake)) return null;
  if (!Array.isArray(cleared) || !cleared.every(isRoom)) return null;
  if (new Set(cleared).size !== cleared.length) return null;
  if (cleared.includes('tables') && phase !== 'beyond') return null;
  return { version, bankroll: bankroll as number, phase, dial, stake, cleared: [...cleared] };
}

/** All or nothing: anything off in the save means a fresh game. */
export function readSave(storage: SaveStorage | null): SaveData | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(SAVE_KEY);
    return text === null ? null : parse(text);
  } catch {
    return null;
  }
}

export function writeSave(storage: SaveStorage | null, data: SaveData): void {
  if (!storage) return;
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // Quota or private mode: the game plays on unsaved.
  }
}
