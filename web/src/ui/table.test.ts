import { describe, expect, it } from 'vitest';
import { RUN_HANDS, STAKES } from '../game/rules';
import { createPrerunSource, parseChshExport, parseWiesnerExport, provenanceLabel, type ChipProvenance, type ChshResult } from '../game/results';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { withChipRuns } from '../game/chip';
import { chipDials, dialFractions, dialNote, dialValueText, flatFloor, flatHand, flatRate, settledLine, sourceLine, stakeChoices, tableButtons } from './table';

const limits = { classical: 0.75, quantum: 0.8535533905932737 };
const idle = { locked: false, inRoom: false };
const base = { phase: 'entangled', autoplaying: false, broke: false, forging: false } as const;

describe('tableButtons', () => {
  it('offers the next step of the table in each phase', () => {
    expect(tableButtons({ ...base, phase: 'intro' }, idle).main).toMatchObject({ label: 'Deal', act: 'deal' });
    expect(tableButtons({ ...base, phase: 'wall' }, idle).main).toMatchObject({ act: 'entangle', brass: true });
    expect(tableButtons({ ...base, phase: 'entangled' }, idle).main).toMatchObject({ label: 'Run', act: 'run' });
    expect(tableButtons({ ...base, phase: 'entangled' }, idle).main.disabled).toBeFalsy();
  });

  it('holds the button while the classical hands deal', () => {
    const { main } = tableButtons({ ...base, phase: 'classical', autoplaying: true }, idle);
    expect(main.disabled).toBe(true);
  });

  it('offers restart only once the table is cleared, unless the player is broke', () => {
    expect(tableButtons(base, idle).alt).toBeUndefined();
    expect(tableButtons({ ...base, phase: 'beyond' }, idle).alt).toMatchObject({ act: 'restart' });
  });

  it('holds every table action while a forge waits, keeping the buttons in place', () => {
    for (const phase of ['intro', 'wall', 'entangled', 'beyond'] as const) {
      const { main } = tableButtons({ ...base, phase, forging: true }, idle);
      expect(main.disabled).toBe(true);
      expect(main.act).toBeDefined();
    }
    expect(tableButtons({ ...base, forging: true }, idle).main.label).toBe('Run');
    expect(tableButtons({ ...base, phase: 'beyond', forging: true }, idle).alt?.disabled).toBe(true);
  });

  it('stops Run during a run, a story beat, and a visit to a side room', () => {
    expect(tableButtons({ ...base, autoplaying: true }, idle).main).toMatchObject({ label: 'Running', disabled: true });
    expect(tableButtons(base, { locked: true, inRoom: false }).main.disabled).toBe(true);
    expect(tableButtons(base, { locked: false, inRoom: true }).main.disabled).toBe(true);
  });

  it('stops restart while a run or a story beat is playing', () => {
    const beyond = { ...base, phase: 'beyond' } as const;
    expect(tableButtons({ ...beyond, autoplaying: true }, idle).alt?.disabled).toBe(true);
    expect(tableButtons(beyond, { locked: true, inRoom: false }).alt?.disabled).toBe(true);
    expect(tableButtons(beyond, { locked: false, inRoom: true }).alt?.disabled).toBeFalsy();
  });

  it('makes restart the only way forward when broke, in every phase', () => {
    for (const phase of ['intro', 'classical', 'wall', 'entangled', 'beyond'] as const) {
      const { main, alt } = tableButtons({ ...base, phase, broke: true }, idle);
      expect(main).toMatchObject({ act: 'restart' });
      expect(main.disabled).toBeFalsy();
      expect(alt).toBeUndefined();
    }
  });

  it('lets the last hand finish before a broke player can restart', () => {
    expect(tableButtons({ ...base, broke: true, autoplaying: true }, idle).main.act).toBe('run');
  });
});

describe('stakeChoices', () => {
  const values = (choices: ReturnType<typeof stakeChoices>) =>
    choices.filter((c) => !c.disabled).map((c) => c.value);

  it('lists every stake', () => {
    const choices = stakeChoices({ bankroll: 10000, autoplaying: false }, false);
    expect(choices.map((c) => c.value)).toEqual([...STAKES]);
    expect(values(choices)).toEqual([...STAKES]);
  });

  it('turns off what the bankroll cannot cover, and allows an exact match', () => {
    expect(values(stakeChoices({ bankroll: 500, autoplaying: false }, false))).toEqual([100, 200, 500]);
    expect(values(stakeChoices({ bankroll: 499, autoplaying: false }, false))).toEqual([100, 200]);
    expect(values(stakeChoices({ bankroll: 99, autoplaying: false }, false))).toEqual([]);
  });

  it('locks every stake during a run and a story beat', () => {
    expect(values(stakeChoices({ bankroll: 10000, autoplaying: true }, false))).toEqual([]);
    expect(values(stakeChoices({ bankroll: 10000, autoplaying: false }, true))).toEqual([]);
  });
});

describe('settledLine', () => {
  const entangled = { phase: 'entangled', broke: false, rounds: RUN_HANDS, target: 0.848 } as const;

  it('reads the dial when no run just ended', () => {
    expect(settledLine({ ...entangled, target: 0.6 }, false, limits)).toBe('low');
    expect(settledLine({ ...entangled, target: 0.848 }, false, limits)).toBe('best');
  });

  it('blames the dial only when the dial was the problem', () => {
    expect(settledLine({ ...entangled, target: 0.79 }, true, limits)).toBe('short');
    expect(settledLine({ ...entangled, target: 0.8 }, true, limits)).toBe('short');
  });

  it('blames the deck when the dial was good and the run fell short', () => {
    expect(settledLine({ ...entangled, target: 0.848 }, true, limits)).toBe('cold');
  });

  it('says so when no hand was dealt', () => {
    expect(settledLine({ ...entangled, rounds: 0 }, true, limits)).toBe('misdeal');
    expect(settledLine({ ...entangled, phase: 'beyond', rounds: 0 }, true, limits)).toBe('misdeal');
  });

  it('says so when the player could no longer cover the stake', () => {
    expect(settledLine({ ...entangled, rounds: RUN_HANDS - 1 }, true, limits)).toBe('covered');
    expect(settledLine({ ...entangled, phase: 'beyond', rounds: 3 }, true, limits)).toBe('covered');
  });

  it('puts broke ahead of everything, with or without a run', () => {
    expect(settledLine({ ...entangled, broke: true }, true, limits)).toBe('broke');
    expect(settledLine({ ...entangled, broke: true, rounds: 0 }, false, limits)).toBe('broke');
    expect(settledLine({ ...entangled, phase: 'wall', broke: true }, false, limits)).toBe('broke');
  });

  it('moves on from a stale line after a full run past the wall', () => {
    expect(settledLine({ ...entangled, phase: 'beyond' }, true, limits, 'covered')).toBe('past');
    expect(settledLine({ ...entangled, phase: 'beyond' }, true, limits, 'misdeal')).toBe('past');
  });

  it('leaves the payoff line up when the clearing run ends', () => {
    expect(settledLine({ ...entangled, phase: 'beyond' }, true, limits, '')).toBeNull();
  });

  it('otherwise keeps the line showing', () => {
    expect(settledLine({ ...entangled, phase: 'beyond' }, false, limits)).toBeNull();
    expect(settledLine({ ...entangled, phase: 'wall' }, false, limits)).toBeNull();
  });
});

describe('sourceLine', () => {
  const source = createPrerunSource({ chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(wiesnerJson) }, 'ibm-noise-model');
  const preview = source.previewProvenance(0.5);

  it('stays off while the table plays classical hands', () => {
    for (const phase of ['intro', 'classical', 'wall'] as const) {
      expect(sourceLine({ phase, dial: 0.5, target: 0.8, result: null, rounds: 0 }, preview)).toBeNull();
    }
  });

  it('labels the dial preview before a run, because those rates are quantum results', () => {
    for (const phase of ['entangled', 'beyond'] as const) {
      expect(sourceLine({ phase, dial: 0.5, target: 0.8, result: null, rounds: 0 }, preview)).toBe(`Source: ${provenanceLabel(preview)}`);
    }
  });

  it("follows the run's own source over the preview", async () => {
    const chip: ChipProvenance = { ...preview, source: 'ibm-chip', noiseModel: null, backend: 'ibm_kingston', jobId: 'd4example', qubitSelection: 'best-case pick' };
    const result: ChshResult = { ...(await source.chsh(0.5)), provenance: chip };
    const ran = { phase: 'entangled', dial: 0.5, target: result.winRate, result, rounds: 0 } as const;
    expect(sourceLine(ran, preview)).toBe('Source: IBM chip ibm_kingston, job d4example');
    const previewLabel = `Source: ${provenanceLabel(preview)}`;
    expect(sourceLine({ ...ran, dial: 0.25, target: source.previewWinRate(0.25) }, preview)).toBe(previewLabel);
    // Turned away and back: same dial, but the rate on screen is the preview again.
    expect(sourceLine({ ...ran, target: 0.7 }, preview)).toBe(previewLabel);
  });

  it('names both sources while the plaque holds hands from somewhere else', async () => {
    const chip: ChipProvenance = { ...preview, source: 'ibm-chip', noiseModel: null, backend: 'ibm_kingston', jobId: 'd4example', qubitSelection: 'best-case pick' };
    const result: ChshResult = { ...(await source.chsh(0.5)), provenance: chip };
    const turned = { phase: 'entangled', dial: 0.25, target: source.previewWinRate(0.25), result, rounds: 100 } as const;
    expect(sourceLine(turned, preview)).toBe(`Odds source: ${provenanceLabel(preview)} · Last run source: IBM chip ibm_kingston, job d4example`);
    expect(sourceLine({ ...turned, dial: 0.5, target: result.winRate }, preview)).toBe('Source: IBM chip ibm_kingston, job d4example');
  });

  it('stays one source when the hands and the odds read the same', async () => {
    const result = await source.chsh(0.5);
    const turned = { phase: 'entangled', dial: 0.25, target: source.previewWinRate(0.25), result, rounds: 100 } as const;
    expect(sourceLine(turned, preview)).toBe(`Source: ${provenanceLabel(preview)}`);
  });
});

describe('the flat table', () => {
  const limits2 = { classical: 0.75, quantum: 0.8535533905932737 };
  const hand = { x: 1, y: 0, a: 0, b: 1, win: false, delta: -100 } as const;

  it('stands at the top of the stack before the deal, then at the table', () => {
    expect(flatFloor('intro', 5)).toBe(0);
    for (const phase of ['classical', 'wall', 'entangled', 'beyond'] as const) expect(flatFloor(phase, 5)).toBe(4);
  });

  it('reads the win rate against the limit, and only claims the limit past it at print precision', () => {
    expect(flatRate({ rounds: 0, winRate: 0 }, limits2)).toEqual({ text: 'No hands', hands: 'dealt yet', fill: 0, past: false });
    expect(flatRate({ rounds: 1, winRate: 1 }, limits2)).toMatchObject({ text: '100.0%', hands: 'over 1 hand', fill: 100, past: true });
    expect(flatRate({ rounds: 36, winRate: 0.75 }, limits2)).toMatchObject({ text: '75.0%', past: false });
    expect(flatRate({ rounds: 1000, winRate: 0.7504 }, limits2).past).toBe(false);
    expect(flatRate({ rounds: 36, winRate: 29 / 36 }, limits2)).toMatchObject({ hands: 'over 36 hands', past: true });
  });

  it('shows the latest hand as the two seats saw it', () => {
    expect(flatHand({ phase: 'classical', rounds: 12, last: hand }, null)).toEqual({ title: 'Hand 12', x: '1', y: '0', a: '0', b: '1', result: 'Lost −100', win: false });
  });

  it('shows nothing before a hand, and clears on a new game', () => {
    expect(flatHand({ phase: 'intro', rounds: 0, last: null }, null)).toBeNull();
    const held = flatHand({ phase: 'beyond', rounds: 36, last: { ...hand, win: true, delta: 25 } }, null);
    expect(flatHand({ phase: 'intro', rounds: 0, last: null }, held)).toBeNull();
  });

  it('holds the last hand while a run clears it, and says it is no longer the current one', () => {
    const held = flatHand({ phase: 'entangled', rounds: 36, last: { ...hand, win: true, delta: 25 } }, null);
    expect(flatHand({ phase: 'entangled', rounds: 0, last: null }, held)).toEqual({ title: 'Last hand', x: '1', y: '0', a: '0', b: '1', result: 'Won +25', win: true });
  });

  it('labels a hand kept across Entangle as the last one', () => {
    expect(flatHand({ phase: 'entangled', rounds: 0, last: hand }, null)?.title).toBe('Last hand');
  });
});

describe('chip dials', () => {
  const exports = { chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(wiesnerJson) };
  const sim = createPrerunSource(exports, 'ibm-noise-model');
  const chip = withChipRuns(sim, exports);

  it('lists none when the source has no chip data', () => {
    expect(chipDials(sim)).toEqual([]);
  });

  it('lists exactly the dials whose odds come from the chip run, in dial order', () => {
    const found = chipDials(chip);
    expect(found).toEqual(chip.dials.filter((d) => chip.previewProvenance(d).source === 'ibm-chip'));
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(chip.dials.length);
    expect(found).toEqual([...found].sort((a, b) => a - b));
  });

  it('follows a source that makes one more dial chip data', () => {
    const chipProv = chip.previewProvenance(chipDials(chip)[0] as number);
    const pressed = { ...chip, previewProvenance: (d: number) => (chip.snapDial(d) === 0.5 ? chipProv : chip.previewProvenance(d)) };
    expect(chipDials(pressed)).toContain(0.5);
    expect(chipDials(sim)).not.toContain(0.5);
  });

  it('places dials along the slider from 0 to 1', () => {
    const at = dialFractions([0, 0.25, 0.5, 1], chip.dials);
    expect(at).toEqual([0, 0.25, 0.5, 1]);
    expect(dialFractions([0.5], [0.5, 0.5])).toEqual([0]);
    expect(dialFractions([0.25, 0.75], [0, 0.5, 1])).toEqual([0.25, 0.75]);
    // The grid's own spacing: 33 dials, each 1/32 along.
    expect(dialFractions([chip.dials[8] as number], chip.dials)).toEqual([8 / (chip.dials.length - 1)]);
  });

  it('labels a dial by its real provenance, never calling a simulator dial chip', () => {
    const [chipDial] = chipDials(chip) as [number];
    const simDial = chip.dials.find((d) => !chipDials(chip).includes(d)) as number;
    expect(dialNote(chip.previewProvenance(chipDial))).toEqual({ text: 'Measured on IBM chip', chip: true });
    expect(dialNote(chip.previewProvenance(simDial))).toEqual({ text: 'Simulator at this angle', chip: false });
    expect(dialValueText('81.0% at this angle', chip.previewProvenance(chipDial))).toBe('81.0% at this angle, measured on IBM chip');
    expect(dialValueText('81.0% at this angle', chip.previewProvenance(simDial))).toBe('81.0% at this angle, simulator');
  });
});
