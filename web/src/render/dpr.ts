/** Spec limit: the world never renders above this device pixel ratio. */
export const DPR_CAP = 1.75;
export const DPR_FLOOR = 0.75;
export const DPR_STEP = 0.15;
/** Frames averaged before a decision is made. */
export const SAMPLE_FRAMES = 50;
/** Average frame time that counts as too slow: about 46 fps, which leaves 60 Hz screens alone. */
export const SLOW_FRAME_SECONDS = 0.0215;
/** A frame longer than this is a stall, such as a shader compile. */
export const STALL_SECONDS = 0.25;
/** Stalls in a row that are forgiven. Beyond this the device is simply that slow, so they count. */
export const ISOLATED_STALLS = 3;
/**
 * What a counted stall adds to the window: just over the slow line, whatever its
 * real length. A window of nothing but stalls still reads as slow, while a few
 * multi-second hitches among fast frames cannot drag the average over the line.
 */
const COUNTED_STALL_SECONDS = SLOW_FRAME_SECONDS * 1.1;

export interface DprController {
  /** Ratio to render at now. */
  readonly dpr: number;
  /** How many times the ratio has been lowered. Heavier effects can key off this. */
  readonly tier: number;
  /** Records one frame's duration. Returns true when the ratio changed. */
  sample(seconds: number): boolean;
  /** Drops the current window, for use after the render loop has been paused. */
  reset(): void;
}

/**
 * Lowers resolution under sustained load. It never raises it again, because
 * stepping back up on a borderline GPU makes the picture pulse.
 */
export function createDprController(deviceRatio: number): DprController {
  let dpr = Math.min(deviceRatio > 0 ? deviceRatio : 1, DPR_CAP);
  let tier = 0;
  let total = 0;
  let frames = 0;
  let stalls = 0;

  const reset = (): void => {
    total = 0;
    frames = 0;
    stalls = 0;
  };

  return {
    get dpr() {
      return dpr;
    },
    get tier() {
      return tier;
    },
    reset,
    sample(seconds) {
      if (seconds > STALL_SECONDS) {
        stalls += 1;
        if (stalls <= ISOLATED_STALLS) return false;
        total += COUNTED_STALL_SECONDS;
      } else {
        stalls = 0;
        total += seconds;
      }
      frames += 1;
      if (frames < SAMPLE_FRAMES) return false;
      const average = total / frames;
      total = 0;
      frames = 0;
      if (average <= SLOW_FRAME_SECONDS || dpr <= DPR_FLOOR) return false;
      dpr = Math.max(DPR_FLOOR, dpr - DPR_STEP);
      tier += 1;
      return true;
    },
  };
}
