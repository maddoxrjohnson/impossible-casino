import { describe, expect, it } from 'vitest';
import { ballAt, pocketAngle, pocketPath, radialTurn, REST_R, ROLL_MS, ROLL_TURNS, rollBoost, rollPlan, TRACK_R, wheelPoint } from './roulette-wheel';

const mod360 = (deg: number): number => ((deg % 360) + 360) % 360;

describe('pocketAngle', () => {
  it('puts pocket 0 at the top and spaces the rest evenly clockwise', () => {
    expect(pocketAngle(0, 32)).toBe(0);
    expect(pocketAngle(8, 32)).toBe(90);
    expect(pocketAngle(16, 32)).toBe(180);
    expect(pocketAngle(31, 32)).toBeCloseTo(348.75);
  });
});

describe('wheelPoint', () => {
  it('measures clockwise from the top with y down', () => {
    const top = wheelPoint(0, 10), right = wheelPoint(90, 10);
    expect(top.x).toBeCloseTo(0); expect(top.y).toBeCloseTo(-10);
    expect(right.x).toBeCloseTo(10); expect(right.y).toBeCloseTo(0);
  });
});

describe('pocketPath', () => {
  it('draws a closed ring slice with two arcs', () => {
    const d = pocketPath(0, 32, 50, 88);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.match(/A/g)).toHaveLength(2);
  });
});

describe('radialTurn', () => {
  it('keeps labels on the left half from reading upside down', () => {
    expect(radialTurn(90)).toBe(0);
    expect(mod360(radialTurn(270))).toBe(0);
    expect(radialTurn(0)).toBe(-90);
    expect(radialTurn(180)).toBe(90);
  });
});

describe('rollPlan', () => {
  it('ends on the landed pocket after at least the set turns, anticlockwise', () => {
    for (const from of [0, 37, 200, -500, 1234]) {
      for (const landed of [0, 5, 17, 31]) {
        const plan = rollPlan(landed, 32, from, false);
        const travel = plan.from - plan.to;
        expect(plan.from).toBe(from);
        expect(mod360(plan.to)).toBeCloseTo(pocketAngle(landed, 32));
        expect(travel).toBeGreaterThanOrEqual(ROLL_TURNS * 360);
        expect(travel).toBeLessThan((ROLL_TURNS + 1) * 360);
        expect(plan.ms).toBe(ROLL_MS);
      }
    }
  });

  it('does not roll with reduced motion', () => {
    const plan = rollPlan(9, 32, 120, true);
    expect(plan.ms).toBe(0);
    const at = ballAt(plan, 0);
    expect(at.done).toBe(true);
    expect(mod360(at.deg)).toBeCloseTo(pocketAngle(9, 32));
    expect(at.r).toBe(REST_R);
  });
});

describe('ballAt', () => {
  const plan = rollPlan(12, 32, 0, false);

  it('starts on the rim and rests in the landed pocket', () => {
    expect(ballAt(plan, 0)).toEqual({ deg: 0, r: TRACK_R, done: false });
    const end = ballAt(plan, ROLL_MS);
    expect(end.done).toBe(true);
    expect(end.deg).toBe(plan.to);
    expect(mod360(end.deg)).toBeCloseTo(pocketAngle(12, 32));
    expect(end.r).toBe(REST_R);
    expect(ballAt(plan, ROLL_MS * 5)).toEqual(end);
  });

  it('only ever runs one way and slows down', () => {
    let last = ballAt(plan, 0), lastStep = Infinity;
    for (let ms = 100; ms <= ROLL_MS; ms += 100) {
      const at = ballAt(plan, ms), step = last.deg - at.deg;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(lastStep + 1e-9);
      expect(at.r).toBeLessThanOrEqual(last.r + 1e-9);
      last = at; lastStep = step;
    }
  });
});

describe('rollBoost', () => {
  it('fades from full to nothing over the roll', () => {
    expect(rollBoost(0)).toBe(1);
    expect(rollBoost(ROLL_MS / 2)).toBeGreaterThan(0);
    expect(rollBoost(ROLL_MS / 2)).toBeLessThan(1);
    expect(rollBoost(ROLL_MS)).toBe(0);
    expect(rollBoost(ROLL_MS * 2)).toBe(0);
  });
});
