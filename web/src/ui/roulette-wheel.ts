// Where the Roulette panel draws its pockets and its ball. Geometry and timing only: the landed pocket always comes from the store's spin. No DOM.

/** How long the ball rolls before it rests in the landed pocket. */
export const ROLL_MS = 3400;
/** Whole turns the ball makes, at least, before it rests. */
export const ROLL_TURNS = 3;
/** The ball's track on the rim, and where it rests in a pocket, in wheel units (the wheel is 200 across). */
export const TRACK_R = 91.5;
export const REST_R = 84.6;

export interface RollPlan {
  /** Degrees clockwise from the top. The ball runs anticlockwise, so `to` is below `from`. */
  readonly from: number;
  readonly to: number;
  readonly ms: number;
}

export interface BallPoint {
  readonly deg: number;
  readonly r: number;
  readonly done: boolean;
}

/** The centre of a pocket, in degrees clockwise from the top. Pocket 0 sits at the top. */
export function pocketAngle(pocket: number, count: number): number {
  return (pocket * 360) / count;
}

/** A point on the wheel at `deg` clockwise from the top, with y pointing down. */
export function wheelPoint(deg: number, r: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

const fixed = (n: number): string => (Math.abs(n) < 5e-4 ? '0' : n.toFixed(3).replace(/\.?0+$/, ''));

/** The ring slice of one pocket between radii `inner` and `outer`, as an SVG path. */
export function pocketPath(pocket: number, count: number, inner: number, outer: number): string {
  const half = 180 / count, mid = pocketAngle(pocket, count);
  const a = wheelPoint(mid - half, outer), b = wheelPoint(mid + half, outer);
  const c = wheelPoint(mid + half, inner), d = wheelPoint(mid - half, inner);
  return `M${fixed(a.x)} ${fixed(a.y)}A${outer} ${outer} 0 0 1 ${fixed(b.x)} ${fixed(b.y)}L${fixed(c.x)} ${fixed(c.y)}A${inner} ${inner} 0 0 0 ${fixed(d.x)} ${fixed(d.y)}Z`;
}

/** Turns a label at `deg` so it reads along the radius without ever standing upside down. */
export function radialTurn(deg: number): number {
  const along = deg - 90;
  const norm = ((deg % 360) + 360) % 360;
  return norm > 180 ? along + 180 : along;
}

/**
 * The ball's roll from where it last rested to the pocket the spin already landed on.
 * With reduced motion it does not roll: it is in the pocket at once.
 */
export function rollPlan(landed: number, count: number, from: number, reduced: boolean): RollPlan {
  const rest = pocketAngle(landed, count);
  if (reduced) return { from: rest, to: rest, ms: 0 };
  const travel = ROLL_TURNS * 360 + (((from - rest) % 360) + 360) % 360;
  return { from, to: from - travel, ms: ROLL_MS };
}

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** Where the ball is `elapsed` ms into a roll: fast on the rim, slowing, then dropping into the pocket. */
export function ballAt(plan: RollPlan, elapsed: number): BallPoint {
  const t = plan.ms > 0 ? clamp01(elapsed / plan.ms) : 1;
  const ease = 1 - (1 - t) ** 3;
  const drop = clamp01((t - 0.68) / 0.24);
  const fall = drop * drop * (3 - 2 * drop);
  return { deg: t >= 1 ? plan.to : plan.from + (plan.to - plan.from) * ease, r: TRACK_R + (REST_R - TRACK_R) * fall, done: t >= 1 };
}

/** How much faster than usual a decorative wheel turns `elapsed` ms into a roll: quick at the start, back to normal as the ball rests. */
export function rollBoost(elapsed: number): number {
  const t = clamp01(elapsed / ROLL_MS);
  return (1 - t) ** 2;
}
