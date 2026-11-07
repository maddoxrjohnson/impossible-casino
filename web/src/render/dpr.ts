/** Spec limit: the world never renders above this device pixel ratio. */
export const DPR_CAP = 1.75;
export const DPR_FLOOR = 0.75;
export const DPR_STEP = 0.15;
/** Frames averaged before a decision is made: about two seconds, so a short busy moment does not cost sharpness for good. */
export const SAMPLE_FRAMES = 100;
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
/** A step down must shorten the window average by this share to count as helping. */
export const MIN_STEP_GAIN = 0.03;
/**
 * Steps in a row that may show no gain before resolution is ruled out. One is
 * not enough: vsync quantises frame times, so a slow GPU can gain nothing from
 * a single step and still gain from the next.
 */
const FLAT_STEP_LIMIT = 2;

export interface DprController {
  /** Ratio to render at now. */
  readonly dpr: number;
  /** How many times the ratio has been lowered. Heavier effects can key off this. */
  readonly tier: number;
  /** True once lowering the ratio was found not to help, and stepping has stopped for good. */
  readonly latched: boolean;
  /** Records one frame's duration. Returns true when the ratio changed. */
  sample(seconds: number): boolean;
  /** Drops the current window, for use after the render loop has been paused. */
  reset(): void;
  /** Follows the screen's own ratio, keeping the steps taken. Returns true when the ratio changed. */
  setDeviceRatio(ratio: number): boolean;
}

/**
 * Lowers resolution under sustained load. It never raises it again, because
 * stepping back up on a borderline GPU makes the picture pulse. The one
 * exception is a slowness that resolution cannot fix, such as a 30 fps cap from
 * Low Power Mode: frame interval is all it can see, so when steps stop paying
 * it takes back the ones that did nothing and stops.
 */
export function createDprController(deviceRatio: number): DprController {
  const usable = (ratio: number): number => Math.min(ratio > 0 ? ratio : 1, DPR_CAP);
  // A screen already below the floor keeps its own ratio; it is never raised to meet it.
  const ratioAt = (steps: number): number =>
    Math.min(top, Math.max(DPR_FLOOR, top - steps * DPR_STEP));

  let top = usable(deviceRatio);
  let dpr = top;
  let tier = 0;
  let total = 0;
  let frames = 0;
  let stalls = 0;
  /** A counted stall hides real time, so this window says nothing about whether a step helped. */
  let capped = false;
  /** Where the current run of unproven steps began, with the average they have to beat. */
  let start: { average: number; tier: number } | null = null;
  let flatSteps = 0;
  let latched = false;

  const reset = (): void => {
    total = 0;
    frames = 0;
    stalls = 0;
    capped = false;
  };
  const forgetSteps = (): void => {
    start = null;
    flatSteps = 0;
  };

  return {
    get dpr() {
      return dpr;
    },
    get tier() {
      return tier;
    },
    get latched() {
      return latched;
    },
    reset,
    sample(seconds) {
      if (latched) return false;
      if (seconds > STALL_SECONDS) {
        stalls += 1;
        if (stalls <= ISOLATED_STALLS) return false;
        total += COUNTED_STALL_SECONDS;
        capped = true;
      } else {
        stalls = 0;
        total += seconds;
      }
      frames += 1;
      if (frames < SAMPLE_FRAMES) return false;
      const average = total / frames;
      const measured = !capped;
      total = 0;
      frames = 0;
      capped = false;
      if (!measured) {
        forgetSteps();
      } else if (start) {
        if (average > start.average * (1 - MIN_STEP_GAIN)) {
          flatSteps += 1;
          // The floor leaves no further step to test with, so one flat step has to settle it.
          if (average > SLOW_FRAME_SECONDS && (flatSteps >= FLAT_STEP_LIMIT || dpr <= DPR_FLOOR)) {
            tier = start.tier;
            dpr = ratioAt(tier);
            latched = true;
            forgetSteps();
            return true;
          }
        } else {
          forgetSteps();
        }
      }
      if (average <= SLOW_FRAME_SECONDS || dpr <= DPR_FLOOR) {
        forgetSteps();
        return false;
      }
      if (measured) start ??= { average, tier };
      tier += 1;
      dpr = ratioAt(tier);
      return true;
    },
    setDeviceRatio(ratio) {
      const previous = dpr;
      top = usable(ratio);
      dpr = ratioAt(tier);
      reset();
      // Those windows were drawn at another pixel count, so they prove nothing here.
      forgetSteps();
      return dpr !== previous;
    },
  };
}
