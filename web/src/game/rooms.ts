// The rooms the elevator reaches, the path it suggests through them, and how much colour the clears have let in.
import { ROOMS, type RoomId } from './rules';

export interface RoomInfo {
  readonly id: RoomId;
  readonly name: string;
  /** The stage of the fridge it sits on, as printed on the elevator. */
  readonly stage: string;
  /** The same stage in kelvin, which orders the elevator top to bottom. */
  readonly kelvin: number;
  /** Built and playable. A closed room is still listed, so the elevator can say so. */
  readonly open: boolean;
}

/** In the suggested order: the headline first. */
export const ROOM_LIST: readonly RoomInfo[] = [
  { id: 'tables', name: 'The Impossible Tables', stage: '15 mK', kelvin: 0.015, open: true },
  { id: 'cage', name: "The Cashier's Cage", stage: '4 K', kelvin: 4, open: true },
  { id: 'roulette', name: 'The Roulette Wheel', stage: '800 mK', kelvin: 0.8, open: false },
];

/** How much colour the whole casino shows, by the number of rooms cleared. None until the first. */
export const COLOUR_LEVELS: readonly number[] = [0, 0.45, 0.75, 1];

export function roomInfo(id: RoomId): RoomInfo {
  const room = ROOM_LIST.find((r) => r.id === id);
  if (!room) throw new Error(`Unknown room ${id}`);
  return room;
}

/** The elevator's stops, top of the fridge first. */
export function elevatorStops(rooms: readonly RoomInfo[] = ROOM_LIST): RoomInfo[] {
  return [...rooms].sort((a, b) => b.kelvin - a.kelvin);
}

/** The first open room on the suggested path not yet cleared, or null once there is none. A hint, never a rule. */
export function nextStop(
  cleared: readonly RoomId[],
  rooms: readonly RoomInfo[] = ROOM_LIST,
  reachable: (room: RoomId) => boolean = () => true,
): RoomId | null {
  return rooms.find((room) => room.open && reachable(room.id) && !cleared.includes(room.id))?.id ?? null;
}

/** How many rooms are cleared, counting each room once. */
export function colourStep(cleared: readonly RoomId[]): number {
  return ROOMS.filter((room) => cleared.includes(room)).length;
}

/** From 0, strict black, white and gold, to 1, every dye the building has. */
export function colourLevel(cleared: readonly RoomId[]): number {
  return COLOUR_LEVELS[Math.min(colourStep(cleared), COLOUR_LEVELS.length - 1)] ?? 0;
}
