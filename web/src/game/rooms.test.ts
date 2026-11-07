import { describe, expect, it } from 'vitest';
import { COLOUR_LEVELS, ROOM_LIST, colourLevel, colourStep, elevatorStops, nextStop, roomInfo } from './rooms';
import { ROOMS, type RoomId } from './rules';

describe('the room list', () => {
  it('lists every room once, in the suggested order', () => {
    expect(ROOM_LIST.map((room) => room.id)).toEqual([...ROOMS]);
    expect(ROOM_LIST.map((room) => room.id)).toEqual(['tables', 'cage', 'roulette']);
  });

  it('names each room with its stage of the fridge', () => {
    expect(ROOM_LIST.map(({ name, stage }) => [name, stage])).toEqual([
      ['The Impossible Tables', '15 mK'],
      ["The Cashier's Cage", '4 K'],
      ['The Roulette Wheel', '800 mK'],
    ]);
  });

  it('has every room open', () => {
    expect(roomInfo('tables').open).toBe(true);
    expect(roomInfo('cage').open).toBe(true);
    expect(roomInfo('roulette').open).toBe(true);
  });

  it('puts the elevator stops top to bottom of the fridge, warmest first', () => {
    expect(elevatorStops().map((room) => room.id)).toEqual(['cage', 'roulette', 'tables']);
    const kelvin = elevatorStops().map((room) => room.kelvin);
    expect([...kelvin].sort((a, b) => b - a)).toEqual(kelvin);
  });
});

describe('the suggested next stop', () => {
  it('starts at the Tables', () => {
    expect(nextStop([])).toBe('tables');
  });

  it('goes on to the Cage once the Tables are cleared', () => {
    expect(nextStop(['tables'])).toBe('cage');
  });

  it('still points at the Tables when only the Cage is cleared', () => {
    expect(nextStop(['cage'])).toBe('tables');
  });

  it('goes on to the Roulette Wheel, and has nothing left once every room is cleared', () => {
    expect(nextStop(['tables', 'cage'])).toBe('roulette');
    expect(nextStop(['cage', 'tables', 'roulette'])).toBeNull();
  });

  it('skips a room that is not open', () => {
    const shut = ROOM_LIST.map((room) => (room.id === 'roulette' ? { ...room, open: false } : room));
    expect(nextStop(['tables', 'cage'], shut)).toBeNull();
  });

  it('can be limited to the rooms a surface can reach', () => {
    expect(nextStop(['tables'], ROOM_LIST, (room) => room !== 'cage')).toBe('roulette');
    expect(nextStop(['tables'], ROOM_LIST, (room) => room === 'tables')).toBeNull();
  });
});

describe('the colour level', () => {
  it('is strict black, white and gold before any room is cleared', () => {
    expect(colourStep([])).toBe(0);
    expect(colourLevel([])).toBe(0);
  });

  it('rises with each room cleared, in any order', () => {
    expect(colourStep(['cage'])).toBe(1);
    expect(colourStep(['tables'])).toBe(1);
    expect(colourStep(['tables', 'cage'])).toBe(2);
    expect(colourStep(['cage', 'tables', 'roulette'])).toBe(3);
    expect(colourLevel(['cage'])).toBe(colourLevel(['tables']));
    expect(colourLevel(['tables', 'cage'])).toBeGreaterThan(colourLevel(['tables']));
    expect(colourLevel(['tables', 'cage', 'roulette'])).toBe(1);
  });

  it('has one level per number of rooms cleared, rising from none to full', () => {
    expect(COLOUR_LEVELS).toHaveLength(ROOM_LIST.length + 1);
    expect(COLOUR_LEVELS[0]).toBe(0);
    expect(COLOUR_LEVELS[COLOUR_LEVELS.length - 1]).toBe(1);
    for (let i = 1; i < COLOUR_LEVELS.length; i += 1) {
      expect(COLOUR_LEVELS[i]).toBeGreaterThan(COLOUR_LEVELS[i - 1] as number);
    }
  });

  it('counts a room once and ignores anything that is not a room', () => {
    expect(colourStep(['cage', 'cage'])).toBe(1);
    expect(colourStep(['lobby' as RoomId])).toBe(0);
  });
});
