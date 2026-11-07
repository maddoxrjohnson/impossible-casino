import { afterEach, describe, expect, it } from 'vitest';
import { SAVE_KEY, readSave, safeStorage, writeSave, type SaveData } from './save';

const GOOD: SaveData = {
  version: 1,
  bankroll: 9700,
  phase: 'entangled',
  dial: 0.5,
  stake: 200,
  cleared: ['cage'],
};

function storageWith(text: string | null): Pick<Storage, 'getItem' | 'setItem'> {
  let value = text;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

function withField(field: string, value: unknown): ReturnType<typeof storageWith> {
  return storageWith(JSON.stringify({ ...GOOD, [field]: value }));
}

describe('readSave and writeSave', () => {
  it('round trips', () => {
    const storage = storageWith(null);
    writeSave(storage, GOOD);
    expect(readSave(storage)).toEqual(GOOD);
  });

  it('writes under the versioned key', () => {
    let key = '';
    writeSave(
      {
        getItem: () => null,
        setItem: (k) => {
          key = k;
        },
      },
      GOOD,
    );
    expect(key).toBe('impossible-casino.save.v1');
    expect(SAVE_KEY).toBe(key);
  });

  it('returns null when nothing is stored', () => {
    expect(readSave(storageWith(null))).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    expect(readSave(storageWith('{"version":1,'))).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    for (const text of ['null', '12', '[]', '"save"']) {
      expect(readSave(storageWith(text))).toBeNull();
    }
  });

  it.each<[string, unknown]>([
    ['version', 2],
    ['version', '1'],
    ['bankroll', '9700'],
    ['bankroll', -1],
    ['bankroll', 12.5],
    ['bankroll', Number.MAX_SAFE_INTEGER + 1],
    ['bankroll', null],
    ['phase', 'classical'],
    ['phase', 'lobby'],
    ['phase', 3],
    ['dial', '0.5'],
    ['dial', null],
    ['dial', -0.01],
    ['dial', 1.01],
    ['stake', 150],
    ['stake', '100'],
    ['cleared', 'tables'],
    ['cleared', ['vault']],
    ['cleared', ['cage', 'cage']],
    ['cleared', ['tables']],
    ['cleared', [1]],
  ])('rejects the whole save when %s is %j', (field, value) => {
    expect(readSave(withField(field, value))).toBeNull();
  });

  it('rejects a save with a missing field', () => {
    const partial: Partial<SaveData> = { ...GOOD };
    delete partial.stake;
    expect(readSave(storageWith(JSON.stringify(partial)))).toBeNull();
  });

  it('keeps only the known fields', () => {
    expect(readSave(withField('extra', true))).toEqual(GOOD);
  });

  it.each(['intro', 'wall', 'entangled'])('rejects tables cleared in phase %s', (phase) => {
    const text = JSON.stringify({ ...GOOD, phase, cleared: ['tables'] });
    expect(readSave(storageWith(text))).toBeNull();
  });

  it('accepts tables cleared in phase beyond, with or without other rooms', () => {
    for (const cleared of [['tables'], ['tables', 'cage']]) {
      const text = JSON.stringify({ ...GOOD, phase: 'beyond', cleared });
      expect(readSave(storageWith(text))?.cleared).toEqual(cleared);
    }
  });

  it('accepts the ends of the dial', () => {
    expect(readSave(withField('dial', 0))?.dial).toBe(0);
    expect(readSave(withField('dial', 1))?.dial).toBe(1);
  });

  it('accepts a bankroll of zero', () => {
    expect(readSave(withField('bankroll', 0))?.bankroll).toBe(0);
  });

  it('survives getItem throwing', () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(readSave(storage)).toBeNull();
  });

  it('survives setItem throwing', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => {
      writeSave(storage, GOOD);
    }).not.toThrow();
  });

  it('treats null storage as a no-op', () => {
    expect(readSave(null)).toBeNull();
    expect(() => {
      writeSave(null, GOOD);
    }).not.toThrow();
  });
});

describe('safeStorage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('returns localStorage when it can be reached', () => {
    const storage = storageWith(null);
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    expect(safeStorage()).toBe(storage);
  });

  it('returns null when merely touching localStorage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(safeStorage()).toBeNull();
  });
});
