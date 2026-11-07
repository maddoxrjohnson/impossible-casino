import { describe, expect, it } from 'vitest';
import {
  DPR_CAP,
  DPR_FLOOR,
  DPR_STEP,
  ISOLATED_STALLS,
  SAMPLE_FRAMES,
  SLOW_FRAME_SECONDS,
  STALL_SECONDS,
  createDprController,
} from './dpr';

const FAST = 1 / 60;
const SLOW = SLOW_FRAME_SECONDS + 0.005;

/** Feeds a full sample window and reports whether its last frame changed the ratio. */
function feedWindow(c: ReturnType<typeof createDprController>, seconds: number): boolean {
  let changed = false;
  for (let i = 0; i < SAMPLE_FRAMES; i += 1) changed = c.sample(seconds);
  return changed;
}

describe('createDprController', () => {
  it('caps a high density screen at the spec cap', () => {
    expect(createDprController(3).dpr).toBe(1.75);
    expect(DPR_CAP).toBe(1.75);
  });

  it('keeps a low density screen at its own ratio', () => {
    expect(createDprController(1).dpr).toBe(1);
  });

  it('falls back to 1 when the browser reports no usable ratio', () => {
    expect(createDprController(0).dpr).toBe(1);
    expect(createDprController(Number.NaN).dpr).toBe(1);
  });

  it('holds steady while frames are fast', () => {
    const c = createDprController(2);
    expect(feedWindow(c, FAST)).toBe(false);
    expect(c.dpr).toBe(DPR_CAP);
    expect(c.tier).toBe(0);
  });

  it('steps down one notch and raises the tier after a slow window', () => {
    const c = createDprController(2);
    expect(feedWindow(c, SLOW)).toBe(true);
    expect(c.dpr).toBeCloseTo(DPR_CAP - DPR_STEP, 10);
    expect(c.tier).toBe(1);
  });

  it('only decides at the end of a window', () => {
    const c = createDprController(2);
    for (let i = 0; i < SAMPLE_FRAMES - 1; i += 1) expect(c.sample(SLOW)).toBe(false);
    expect(c.sample(SLOW)).toBe(true);
  });

  it('never goes below the floor, and stops counting tiers there', () => {
    const c = createDprController(1);
    for (let i = 0; i < 20; i += 1) feedWindow(c, SLOW);
    expect(c.dpr).toBe(DPR_FLOOR);
    expect(c.tier).toBe(2);
    expect(feedWindow(c, SLOW)).toBe(false);
  });

  it('never raises a ratio already below the floor', () => {
    const c = createDprController(0.5);
    expect(feedWindow(c, SLOW)).toBe(false);
    expect(c.dpr).toBe(0.5);
  });

  it('ignores a one-off stall such as a shader compile', () => {
    const c = createDprController(2);
    c.sample(STALL_SECONDS + 1.75);
    expect(feedWindow(c, FAST)).toBe(false);
    expect(c.dpr).toBe(DPR_CAP);
  });

  it('lowers the ratio on a device too slow to ever finish a frame on time', () => {
    const c = createDprController(2);
    for (let i = 0; i < ISOLATED_STALLS; i += 1) expect(c.sample(STALL_SECONDS + 0.1)).toBe(false);
    expect(feedWindow(c, STALL_SECONDS + 0.1)).toBe(true);
    expect(c.dpr).toBeCloseTo(DPR_CAP - DPR_STEP, 10);
  });

  it('keeps ignoring short bursts of stalls separated by normal frames', () => {
    const c = createDprController(2);
    for (let burst = 0; burst < 100; burst += 1) {
      for (let i = 0; i < ISOLATED_STALLS; i += 1) c.sample(STALL_SECONDS + 1);
      c.sample(FAST);
    }
    expect(c.dpr).toBe(DPR_CAP);
  });

  it('survives a short run of stalls past the forgiven count on a fast device', () => {
    const c = createDprController(2);
    for (let i = 0; i < ISOLATED_STALLS + 10; i += 1) c.sample(STALL_SECONDS + 2);
    expect(feedWindow(c, FAST)).toBe(false);
    expect(feedWindow(c, FAST)).toBe(false);
    expect(c.dpr).toBe(DPR_CAP);
  });

  it('forgets a partial window on reset', () => {
    const c = createDprController(2);
    for (let i = 0; i < SAMPLE_FRAMES - 1; i += 1) c.sample(SLOW);
    c.reset();
    expect(c.sample(SLOW)).toBe(false);
    expect(c.dpr).toBe(DPR_CAP);
  });
});
