import { describe, expect, it } from 'vitest';
import {
  DPR_CAP,
  DPR_FLOOR,
  DPR_STEP,
  ISOLATED_STALLS,
  MIN_STEP_GAIN,
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
    for (let i = 0; i < 20; i += 1) feedWindow(c, 0.2 * 0.9 ** i);
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

  describe('when lowering the ratio does not help', () => {
    const CAPPED = 1 / 30;

    it('restores the ratio and tier after two flat steps, then never steps again', () => {
      const c = createDprController(2);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.tier).toBe(1);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.tier).toBe(2);
      expect(c.latched).toBe(false);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.dpr).toBe(DPR_CAP);
      expect(c.tier).toBe(0);
      expect(c.latched).toBe(true);
      for (let i = 0; i < 20; i += 1) expect(feedWindow(c, CAPPED)).toBe(false);
      expect(c.dpr).toBe(DPR_CAP);
    });

    it('keeps the steps that helped and undoes only the flat ones', () => {
      const c = createDprController(2);
      feedWindow(c, 0.05);
      feedWindow(c, 0.04);
      const kept = c.dpr;
      feedWindow(c, 0.03);
      feedWindow(c, 0.03);
      expect(c.tier).toBe(4);
      feedWindow(c, 0.03);
      expect(c.dpr).toBe(kept);
      expect(c.tier).toBe(2);
      expect(c.latched).toBe(true);
    });

    it('treats a single flat step as vsync quantising, and carries on', () => {
      const c = createDprController(2);
      feedWindow(c, 0.05);
      feedWindow(c, 0.05);
      expect(c.tier).toBe(2);
      feedWindow(c, 0.033);
      expect(c.latched).toBe(false);
      expect(c.tier).toBe(3);
    });

    it('needs the two flat steps in a row: a step that helps clears the count', () => {
      const c = createDprController(2);
      feedWindow(c, 0.05); // step 1
      feedWindow(c, 0.05); // flat, step 2
      feedWindow(c, 0.04); // helped, step 3
      feedWindow(c, 0.04); // flat, step 4
      expect(c.latched).toBe(false);
      expect(c.tier).toBe(4);
    });

    it('credits two small gains that add up', () => {
      const small = 0.05 * (1 - MIN_STEP_GAIN * 0.8);
      const c = createDprController(2);
      feedWindow(c, 0.05);
      feedWindow(c, small);
      feedWindow(c, small * (1 - MIN_STEP_GAIN * 0.8));
      expect(c.latched).toBe(false);
      expect(c.tier).toBe(3);
    });

    it('counts a gain just under the threshold as flat', () => {
      const flat = 0.05 * (1 - MIN_STEP_GAIN * 0.5);
      const c = createDprController(2);
      feedWindow(c, 0.05);
      feedWindow(c, flat);
      feedWindow(c, flat);
      expect(c.latched).toBe(true);
      expect(c.dpr).toBe(DPR_CAP);
    });

    it('does not count a flat window that ends the stepping', () => {
      const c = createDprController(2);
      const justSlow = SLOW_FRAME_SECONDS * 1.005;
      feedWindow(c, justSlow);
      feedWindow(c, SLOW_FRAME_SECONDS * 0.999); // flat, but back under the line
      feedWindow(c, justSlow); // a later load spike starts fresh
      feedWindow(c, justSlow);
      expect(c.latched).toBe(false);
      expect(c.tier).toBe(3);
    });

    it('restores and latches when a single flat step lands on the floor', () => {
      const c = createDprController(0.9);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.dpr).toBe(DPR_FLOOR);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.dpr).toBe(0.9);
      expect(c.tier).toBe(0);
      expect(c.latched).toBe(true);
    });

    it('keeps a flat step onto the floor that ends the stepping', () => {
      const c = createDprController(0.9);
      feedWindow(c, 0.022);
      expect(c.dpr).toBe(DPR_FLOOR);
      expect(feedWindow(c, 0.0214)).toBe(false);
      expect(c.dpr).toBe(DPR_FLOOR);
      expect(c.latched).toBe(false);
    });

    it('restores from the floor when the second flat step landed on it', () => {
      const c = createDprController(1);
      feedWindow(c, CAPPED);
      feedWindow(c, CAPPED);
      expect(c.dpr).toBe(DPR_FLOOR);
      expect(feedWindow(c, CAPPED)).toBe(true);
      expect(c.dpr).toBe(1);
      expect(c.tier).toBe(0);
      expect(c.latched).toBe(true);
    });

    it('survives reset between steps, since the render loop can pause mid-test', () => {
      const c = createDprController(2);
      feedWindow(c, CAPPED);
      c.reset();
      feedWindow(c, CAPPED);
      c.reset();
      feedWindow(c, CAPPED);
      expect(c.latched).toBe(true);
      expect(c.dpr).toBe(DPR_CAP);
    });

    it('stays latched through reset', () => {
      const c = createDprController(2);
      for (let i = 0; i < 3; i += 1) feedWindow(c, CAPPED);
      c.reset();
      expect(feedWindow(c, CAPPED)).toBe(false);
      expect(c.latched).toBe(true);
    });

    it('never latches on stall windows, whose capped average cannot show a gain', () => {
      const c = createDprController(2);
      for (let i = 0; i < ISOLATED_STALLS; i += 1) c.sample(STALL_SECONDS + 0.1);
      for (let i = 0; i < 20; i += 1) feedWindow(c, STALL_SECONDS + 0.1);
      expect(c.latched).toBe(false);
      expect(c.dpr).toBe(DPR_FLOOR);
    });
  });

  describe('setDeviceRatio', () => {
    it('follows the screen when no steps have been taken', () => {
      const c = createDprController(1);
      expect(c.setDeviceRatio(1.5)).toBe(true);
      expect(c.dpr).toBe(1.5);
    });

    it('stays under the cap, and reports no change when the cap hides the move', () => {
      const c = createDprController(2);
      expect(c.setDeviceRatio(3)).toBe(false);
      expect(c.dpr).toBe(DPR_CAP);
    });

    it('reports no change for the same ratio after steps', () => {
      const c = createDprController(1.75);
      feedWindow(c, SLOW);
      feedWindow(c, 0.01 + SLOW);
      expect(c.setDeviceRatio(1.75)).toBe(false);
    });

    it('keeps the steps already taken', () => {
      const c = createDprController(1);
      feedWindow(c, SLOW);
      expect(c.setDeviceRatio(1.5)).toBe(true);
      expect(c.dpr).toBeCloseTo(1.5 - DPR_STEP, 10);
      expect(c.tier).toBe(1);
    });

    it('respects the floor', () => {
      const c = createDprController(2);
      for (let i = 0; i < 4; i += 1) feedWindow(c, 0.1 - i * 0.02);
      expect(c.tier).toBe(4);
      expect(c.setDeviceRatio(1)).toBe(true);
      expect(c.dpr).toBe(DPR_FLOOR);
      expect(c.tier).toBe(4);
    });

    it('never renders above a screen that is already below the floor', () => {
      const c = createDprController(2);
      expect(c.setDeviceRatio(0.5)).toBe(true);
      expect(c.dpr).toBe(0.5);
    });

    it('falls back to 1 for an unusable ratio', () => {
      const c = createDprController(1.5);
      expect(c.setDeviceRatio(0)).toBe(true);
      expect(c.dpr).toBe(1);
    });

    it('clears the current window', () => {
      const c = createDprController(1);
      for (let i = 0; i < SAMPLE_FRAMES - 1; i += 1) c.sample(SLOW);
      c.setDeviceRatio(1.5);
      expect(c.sample(SLOW)).toBe(false);
    });

    it('drops a flat step, since its window was at another pixel count', () => {
      const c = createDprController(2);
      feedWindow(c, 1 / 30);
      feedWindow(c, 1 / 30);
      c.setDeviceRatio(1.5);
      feedWindow(c, 1 / 30);
      expect(c.latched).toBe(false);
      expect(c.tier).toBe(3);
    });

    it('keeps the latch', () => {
      const c = createDprController(2);
      for (let i = 0; i < 3; i += 1) feedWindow(c, 1 / 30);
      expect(c.setDeviceRatio(1.5)).toBe(true);
      expect(c.dpr).toBe(1.5);
      expect(c.latched).toBe(true);
      expect(feedWindow(c, 1 / 30)).toBe(false);
    });
  });
});
