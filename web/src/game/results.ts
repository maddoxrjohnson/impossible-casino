import { QUESTIONS, type Bit, type Rng } from './rules';

export type ProvenanceSource = 'pre-run-simulator' | 'live-simulator' | 'ibm-chip';

export interface NoiseModel {
  readonly name: string;
  readonly calibrated: string;
  readonly qubitSelection: string;
  readonly scope?: string;
}

interface ProvenanceBase {
  readonly backend: string;
  readonly qubits: readonly number[] | null;
  readonly shots: number;
  readonly qiskitVersion: string;
  readonly aerVersion: string;
  readonly runtimeVersion: string;
  readonly date: string;
}

export interface SimulatorProvenance extends ProvenanceBase {
  readonly source: Exclude<ProvenanceSource, 'ibm-chip'>;
  readonly noiseModel: NoiseModel | null;
  readonly jobId: null;
  /** A simulator's pick sits on its noise model. */
  readonly qubitSelection?: null;
}

export interface ChipProvenance extends ProvenanceBase {
  readonly source: 'ibm-chip';
  readonly noiseModel: null;
  readonly jobId: string;
  readonly qubitSelection: string;
}

export type Provenance = SimulatorProvenance | ChipProvenance;

export interface Limit {
  readonly value: number;
  readonly method: string;
}

/** Keys read "ba": the first character is b, the second is a. */
export const COUNT_KEYS = ['00', '01', '10', '11'] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Readonly<Record<CountKey, number>>;
export type OutcomeOrder = 'ba';

export interface ChshPair {
  readonly x: Bit;
  readonly y: Bit;
  readonly shots: number;
  readonly winRate: number;
  readonly counts: Counts;
}

export interface ChshCircuit {
  readonly x: Bit;
  readonly y: Bit;
  readonly qasm: string;
}

export interface ChshPoint {
  readonly dial: number;
  readonly seed: number;
  readonly winRate: number;
  readonly pairs: readonly ChshPair[];
}

export interface ChshRun {
  readonly id: string;
  readonly provenance: Provenance;
  readonly points: readonly ChshPoint[];
}

export interface ChshExport {
  readonly schemaVersion: 1;
  readonly experiment: 'chsh';
  readonly outcomeOrder: OutcomeOrder;
  readonly limits: { readonly classical: Limit; readonly quantum: Limit };
  readonly logicalCircuits: readonly {
    readonly dial: number;
    readonly pairs: readonly ChshCircuit[];
  }[];
  readonly runs: readonly ChshRun[];
}

export interface WiesnerTicket {
  readonly bits: readonly Bit[];
  readonly bases: readonly string[];
  readonly attackerBases: readonly string[];
}

export interface WiesnerPayout {
  readonly length: number;
  readonly pays: number;
  readonly fairPays: number;
  readonly breakEven: number;
  readonly houseEdge: number;
}

/** A chip run repeats a fixed set of tickets. A simulator forges a fresh ticket every shot and has neither field. */
export interface TicketShots {
  readonly ticketsPerPoint?: number;
  readonly shotsPerTicket?: number;
}

export interface WiesnerPoint {
  readonly length: number;
  readonly seed: number;
  readonly shots: number;
  readonly passes: number;
  readonly passRate: number;
  readonly qubits: readonly number[] | null;
}

export interface WiesnerRun extends TicketShots {
  readonly id: string;
  readonly provenance: Provenance;
  readonly points: readonly WiesnerPoint[];
}

export interface WiesnerExport {
  readonly schemaVersion: 1;
  readonly experiment: 'wiesner';
  readonly attack: string;
  readonly passRule: string;
  /** Tickets per shot in the simulator runs. A chip run carries its own split. */
  readonly simulatorTicketsPerShot: number;
  readonly limits: {
    readonly perQubit: Limit;
    readonly byLength: readonly { readonly length: number; readonly value: number }[];
    readonly byLengthMethod: string;
  };
  readonly payouts: {
    readonly status: string;
    readonly stake: number;
    readonly rule: string;
    readonly table: readonly WiesnerPayout[];
  };
  readonly logicalCircuits: readonly {
    readonly length: number;
    readonly ticket: WiesnerTicket;
    readonly qasm: string;
  }[];
  readonly logicalCircuitsNote: string;
  readonly runs: readonly WiesnerRun[];
}

export interface GameExports {
  readonly chsh: ChshExport;
  readonly wiesner: WiesnerExport;
}

/** Pockets on the roulette wheel: pocket n is the integer whose bit k is qubit k. */
export const ROULETTE_POCKETS = 32;

export type RouletteTurn = 'house' | 'player' | 'spin';

export interface RouletteCard {
  readonly id: string;
  readonly name: string;
  readonly ops: readonly { readonly gate: string; readonly qubits: readonly number[] }[];
}

interface RouletteNodeBase {
  /** Indexes into the deck, in the order they were drafted. */
  readonly draft: readonly number[];
  /** Index into `RouletteExport.wheels`. */
  readonly wheel: number;
  /** The best chance on one pocket the player can still force against the house. */
  readonly value: number;
}

export type RouletteNode =
  | (RouletteNodeBase & { readonly turn: 'house'; readonly houseCards: readonly number[] })
  | (RouletteNodeBase & { readonly turn: 'player' })
  | (RouletteNodeBase & { readonly turn: 'spin'; readonly limitPockets: readonly number[] });

export interface RoulettePoint {
  readonly draft: readonly number[];
  readonly seed: number;
  readonly shots: number;
  /** Shots per pocket, `ROULETTE_POCKETS` long. */
  readonly counts: readonly number[];
}

export interface RouletteRun {
  readonly id: string;
  readonly provenance: Provenance;
  readonly points: readonly RoulettePoint[];
}

export interface RoulettePayout {
  readonly bet: string;
  readonly pockets: number;
  readonly pays: number;
  readonly fairPays: number;
  readonly breakEven: number;
  readonly houseEdge: number;
}

export interface RouletteEdge {
  readonly run: string;
  readonly method: string;
  readonly bestReturn: number;
  readonly worstSpin: { readonly draft: readonly number[]; readonly return: number };
  readonly clearChance: number;
}

export interface RouletteExport {
  readonly schemaVersion: 1;
  readonly experiment: 'roulette';
  readonly pocketOrder: string;
  readonly opening: string;
  readonly houseRule: string;
  readonly bet: string;
  readonly stakeRule: string;
  readonly spin: string;
  readonly wheelsMethod: string;
  readonly turns: readonly Exclude<RouletteTurn, 'spin'>[];
  /** The run the game spins on. */
  readonly playRun: string;
  readonly deck: readonly RouletteCard[];
  readonly limits: {
    readonly fairWheel: Limit;
    readonly classicalWheel: Limit;
    readonly houseLimit: Limit;
    readonly playStyles: readonly { readonly style: string; readonly value: number; readonly rule: string }[];
    readonly legalDrafts: number;
    readonly reachableDrafts: number;
  };
  readonly payouts: {
    readonly status: string;
    readonly stake: number;
    readonly rule: string;
    readonly basis: string;
    readonly table: readonly RoulettePayout[];
  };
  readonly clear: { readonly rule: string; readonly basis: string; readonly chance: number };
  /** Each a probability per pocket, shared by every node that shows it. */
  readonly wheels: readonly (readonly number[])[];
  readonly nodes: readonly RouletteNode[];
  readonly logicalCircuits: readonly { readonly draft: readonly number[]; readonly qasm: string }[];
  readonly runs: readonly RouletteRun[];
  readonly edge: readonly RouletteEdge[];
}

/** A draft as a lookup key. */
export function draftKey(draft: readonly number[]): string {
  return draft.join(',');
}

export interface ChshResult {
  readonly experiment: 'chsh';
  readonly runId: string;
  readonly dial: number;
  readonly winRate: number;
  readonly outcomeOrder: OutcomeOrder;
  readonly pairs: readonly ChshPair[];
  readonly circuits: readonly ChshCircuit[];
  readonly provenance: Provenance;
}

export interface WiesnerResult extends TicketShots {
  readonly experiment: 'wiesner';
  readonly runId: string;
  readonly length: number;
  readonly shots: number;
  readonly passes: number;
  readonly passRate: number;
  readonly qubits: readonly number[] | null;
  readonly payout: WiesnerPayout;
  readonly circuit: { readonly ticket: WiesnerTicket; readonly qasm: string };
  readonly circuitNote: string;
  readonly provenance: Provenance;
}

export interface ResultSource {
  readonly dials: readonly number[];
  readonly limits: { readonly classical: number; readonly quantum: number };
  snapDial(value: number): number;
  /** Where `previewWinRate` reads from at this dial. A run reports its own provenance on its result. */
  previewProvenance(dial: number): Provenance;
  /** Synchronous lookup for live dial feedback. Snaps its input. */
  previewWinRate(dial: number): number;
  chsh(dial: number): Promise<ChshResult>;
  wiesner(length: number): Promise<WiesnerResult>;
}

const CHIP_BACKEND = /^ibm_[a-z0-9_]+$/;

function fail(path: string, why: string): never {
  throw new Error(`Bad export at ${path}: ${why}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value as unknown[];
}

function filled(value: unknown, path: string): unknown[] {
  const items = list(value, path);
  if (items.length === 0) fail(path, 'expected at least one entry');
  return items;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string');
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a number');
  return value;
}

function integer(value: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    fail(path, `expected an integer of at least ${min}`);
  }
  return value as number;
}

function rate(value: unknown, path: string): number {
  const n = finite(value, path);
  if (n < 0 || n > 1) fail(path, 'expected a rate between 0 and 1');
  return n;
}

function bit(value: unknown, path: string): Bit {
  if (value !== 0 && value !== 1) fail(path, 'expected 0 or 1');
  return value;
}

function qubitList(value: unknown, path: string): readonly number[] | null {
  if (value === null) return null;
  return list(value, path).map((q, i) => integer(q, `${path}[${i}]`, 0));
}

function limit(value: unknown, path: string): Limit {
  const raw = record(value, path);
  return { value: finite(raw.value, `${path}.value`), method: text(raw.method, `${path}.method`) };
}

function checkHeader(raw: Record<string, unknown>, experiment: string): void {
  if (raw.schemaVersion !== 1) fail(`${experiment}.schemaVersion`, 'expected 1');
  if (raw.experiment !== experiment) fail(`${experiment}.experiment`, `expected ${experiment}`);
}

function checkUnique(keys: readonly unknown[], path: string): void {
  if (new Set(keys).size !== keys.length) fail(path, 'has duplicates');
}

function checkFourPairs(pairs: readonly { x: Bit; y: Bit }[], path: string): void {
  const complete = QUESTIONS.every((q) => pairs.some((p) => p.x === q.x && p.y === q.y));
  if (pairs.length !== QUESTIONS.length || !complete) {
    fail(path, 'expected exactly the four question pairs');
  }
}

function parseSource(value: unknown, path: string): ProvenanceSource {
  if (value !== 'pre-run-simulator' && value !== 'live-simulator' && value !== 'ibm-chip') {
    fail(path, 'unknown source');
  }
  return value;
}

function parseNoiseModel(value: unknown, path: string): NoiseModel | null {
  if (value === null || value === undefined) return null;
  const raw = record(value, path);
  const model = {
    name: text(raw.name, `${path}.name`),
    calibrated: text(raw.calibrated, `${path}.calibrated`),
    qubitSelection: text(raw.qubitSelection, `${path}.qubitSelection`),
  };
  return raw.scope === undefined
    ? model
    : { ...model, scope: text(raw.scope, `${path}.scope`) };
}

/** Accepts every source, because a live source returns 'live-simulator' at runtime. */
export function parseProvenance(value: unknown, path = 'provenance'): Provenance {
  const raw = record(value, path);
  const source = parseSource(raw.source, `${path}.source`);
  const noiseModel = parseNoiseModel(raw.noiseModel, `${path}.noiseModel`);
  const backend = text(raw.backend, `${path}.backend`);
  const base = {
    backend,
    qubits: qubitList(raw.qubits, `${path}.qubits`),
    shots: integer(raw.shots, `${path}.shots`, 1),
    qiskitVersion: text(raw.qiskitVersion, `${path}.qiskitVersion`),
    aerVersion: text(raw.aerVersion, `${path}.aerVersion`),
    runtimeVersion: text(raw.runtimeVersion, `${path}.runtimeVersion`),
    date: text(raw.date, `${path}.date`),
  };
  const { jobId } = raw;
  if (source === 'ibm-chip') {
    if (typeof jobId !== 'string' || jobId.trim().length === 0) {
      fail(`${path}.jobId`, 'a chip run needs a job id');
    }
    if (noiseModel) fail(`${path}.noiseModel`, 'a chip run cannot have a noise model');
    if (!CHIP_BACKEND.test(backend)) fail(`${path}.backend`, 'not an IBM chip name');
    const qubitSelection = text(raw.qubitSelection, `${path}.qubitSelection`);
    return { ...base, source, noiseModel, jobId, qubitSelection };
  }
  if (jobId !== null) fail(`${path}.jobId`, 'a simulator run cannot have a job id');
  if (CHIP_BACKEND.test(backend)) fail(`${path}.backend`, 'a simulator cannot name a chip');
  if (raw.qubitSelection !== undefined && raw.qubitSelection !== null) {
    fail(`${path}.qubitSelection`, 'a simulator names its pick on the noise model');
  }
  return { ...base, source, noiseModel, jobId };
}

function parseExportedProvenance(value: unknown, path: string): Provenance {
  const provenance = parseProvenance(value, path);
  if (provenance.source === 'live-simulator') {
    fail(`${path}.source`, 'an export cannot hold a live result');
  }
  return provenance;
}

function parseCounts(value: unknown, shots: number, path: string): Counts {
  const raw = record(value, path);
  if (Object.keys(raw).length !== COUNT_KEYS.length) fail(path, 'expected exactly four counts');
  const [c00, c01, c10, c11] = COUNT_KEYS.map((key) => integer(raw[key], `${path}.${key}`, 0)) as [
    number,
    number,
    number,
    number,
  ];
  if (c00 + c01 + c10 + c11 !== shots) fail(path, `counts do not sum to shots (${shots})`);
  return { '00': c00, '01': c01, '10': c10, '11': c11 };
}

function parseChshPair(value: unknown, path: string): ChshPair {
  const raw = record(value, path);
  const shots = integer(raw.shots, `${path}.shots`, 1);
  return {
    x: bit(raw.x, `${path}.x`),
    y: bit(raw.y, `${path}.y`),
    shots,
    winRate: rate(raw.winRate, `${path}.winRate`),
    counts: parseCounts(raw.counts, shots, `${path}.counts`),
  };
}

function parseChshPoint(value: unknown, path: string): ChshPoint {
  const raw = record(value, path);
  const pairs = list(raw.pairs, `${path}.pairs`).map((p, i) =>
    parseChshPair(p, `${path}.pairs[${i}]`),
  );
  checkFourPairs(pairs, `${path}.pairs`);
  return {
    dial: rate(raw.dial, `${path}.dial`),
    seed: finite(raw.seed, `${path}.seed`),
    winRate: rate(raw.winRate, `${path}.winRate`),
    pairs,
  };
}

function parseChshRun(value: unknown, path: string): ChshRun {
  const raw = record(value, path);
  const points = filled(raw.points, `${path}.points`).map((p, i) =>
    parseChshPoint(p, `${path}.points[${i}]`),
  );
  checkUnique(
    points.map((p) => p.dial),
    `${path}.points`,
  );
  return {
    id: text(raw.id, `${path}.id`),
    provenance: parseExportedProvenance(raw.provenance, `${path}.provenance`),
    points,
  };
}

function parseChshCircuit(value: unknown, path: string): ChshCircuit {
  const raw = record(value, path);
  return {
    x: bit(raw.x, `${path}.x`),
    y: bit(raw.y, `${path}.y`),
    qasm: text(raw.qasm, `${path}.qasm`),
  };
}

export function parseChshExport(value: unknown): ChshExport {
  const raw = record(value, 'chsh');
  checkHeader(raw, 'chsh');
  if (raw.outcomeOrder !== 'ba') fail('chsh.outcomeOrder', 'expected ba');
  const limits = record(raw.limits, 'chsh.limits');
  const logicalCircuits = list(raw.logicalCircuits, 'chsh.logicalCircuits').map((entry, i) => {
    const path = `chsh.logicalCircuits[${i}]`;
    const circuit = record(entry, path);
    const pairs = list(circuit.pairs, `${path}.pairs`).map((p, j) =>
      parseChshCircuit(p, `${path}.pairs[${j}]`),
    );
    checkFourPairs(pairs, `${path}.pairs`);
    return { dial: rate(circuit.dial, `${path}.dial`), pairs };
  });
  const runs = filled(raw.runs, 'chsh.runs').map((r, i) => parseChshRun(r, `chsh.runs[${i}]`));
  checkUnique(
    runs.map((r) => r.id),
    'chsh.runs',
  );
  for (const run of runs) {
    for (const point of run.points) {
      if (!logicalCircuits.some((c) => c.dial === point.dial)) {
        fail(`chsh.runs.${run.id}`, `no logical circuit for dial ${point.dial}`);
      }
    }
  }
  return {
    schemaVersion: 1,
    experiment: 'chsh',
    outcomeOrder: 'ba',
    limits: {
      classical: limit(limits.classical, 'chsh.limits.classical'),
      quantum: limit(limits.quantum, 'chsh.limits.quantum'),
    },
    logicalCircuits,
    runs,
  };
}

function parseWiesnerPoint(value: unknown, path: string): WiesnerPoint {
  const raw = record(value, path);
  const shots = integer(raw.shots, `${path}.shots`, 1);
  const passes = integer(raw.passes, `${path}.passes`, 0);
  if (passes > shots) fail(`${path}.passes`, 'more passes than shots');
  return {
    length: integer(raw.length, `${path}.length`, 1),
    seed: finite(raw.seed, `${path}.seed`),
    shots,
    passes,
    passRate: rate(raw.passRate, `${path}.passRate`),
    qubits: qubitList(raw.qubits, `${path}.qubits`),
  };
}

function parseTicketShots(
  raw: Record<string, unknown>,
  provenance: Provenance,
  points: readonly WiesnerPoint[],
  path: string,
): TicketShots {
  const onChip = provenance.source === 'ibm-chip';
  if (!onChip && raw.ticketsPerPoint === undefined && raw.shotsPerTicket === undefined) return {};
  const ticketsPerPoint = integer(raw.ticketsPerPoint, `${path}.ticketsPerPoint`, 1);
  const shotsPerTicket = integer(raw.shotsPerTicket, `${path}.shotsPerTicket`, 1);
  if (points.some((p) => p.shots !== ticketsPerPoint * shotsPerTicket)) {
    fail(`${path}.points`, 'shots do not match tickets times shots per ticket');
  }
  return { ticketsPerPoint, shotsPerTicket };
}

function parseWiesnerRun(value: unknown, path: string): WiesnerRun {
  const raw = record(value, path);
  const points = filled(raw.points, `${path}.points`).map((p, i) =>
    parseWiesnerPoint(p, `${path}.points[${i}]`),
  );
  checkUnique(
    points.map((p) => p.length),
    `${path}.points`,
  );
  const provenance = parseExportedProvenance(raw.provenance, `${path}.provenance`);
  return {
    id: text(raw.id, `${path}.id`),
    provenance,
    points,
    ...parseTicketShots(raw, provenance, points, path),
  };
}

function parseWiesnerPayout(value: unknown, path: string): WiesnerPayout {
  const raw = record(value, path);
  return {
    length: integer(raw.length, `${path}.length`, 1),
    pays: finite(raw.pays, `${path}.pays`),
    fairPays: finite(raw.fairPays, `${path}.fairPays`),
    breakEven: rate(raw.breakEven, `${path}.breakEven`),
    houseEdge: finite(raw.houseEdge, `${path}.houseEdge`),
  };
}

function parseTicket(value: unknown, path: string): WiesnerTicket {
  const raw = record(value, path);
  return {
    bits: list(raw.bits, `${path}.bits`).map((b, i) => bit(b, `${path}.bits[${i}]`)),
    bases: list(raw.bases, `${path}.bases`).map((b, i) => text(b, `${path}.bases[${i}]`)),
    attackerBases: list(raw.attackerBases, `${path}.attackerBases`).map((b, i) =>
      text(b, `${path}.attackerBases[${i}]`),
    ),
  };
}

export function parseWiesnerExport(value: unknown): WiesnerExport {
  const raw = record(value, 'wiesner');
  checkHeader(raw, 'wiesner');
  const limits = record(raw.limits, 'wiesner.limits');
  const payouts = record(raw.payouts, 'wiesner.payouts');
  const table = list(payouts.table, 'wiesner.payouts.table').map((row, i) =>
    parseWiesnerPayout(row, `wiesner.payouts.table[${i}]`),
  );
  const logicalCircuits = list(raw.logicalCircuits, 'wiesner.logicalCircuits').map((entry, i) => {
    const path = `wiesner.logicalCircuits[${i}]`;
    const circuit = record(entry, path);
    return {
      length: integer(circuit.length, `${path}.length`, 1),
      ticket: parseTicket(circuit.ticket, `${path}.ticket`),
      qasm: text(circuit.qasm, `${path}.qasm`),
    };
  });
  const runs = filled(raw.runs, 'wiesner.runs').map((r, i) =>
    parseWiesnerRun(r, `wiesner.runs[${i}]`),
  );
  checkUnique(
    runs.map((r) => r.id),
    'wiesner.runs',
  );
  for (const run of runs) {
    for (const point of run.points) {
      if (!logicalCircuits.some((c) => c.length === point.length)) {
        fail(`wiesner.runs.${run.id}`, `no logical circuit for length ${point.length}`);
      }
      if (!table.some((row) => row.length === point.length)) {
        fail(`wiesner.runs.${run.id}`, `no payout for length ${point.length}`);
      }
    }
  }
  return {
    schemaVersion: 1,
    experiment: 'wiesner',
    attack: text(raw.attack, 'wiesner.attack'),
    passRule: text(raw.passRule, 'wiesner.passRule'),
    simulatorTicketsPerShot: integer(raw.simulatorTicketsPerShot, 'wiesner.simulatorTicketsPerShot', 1),
    limits: {
      perQubit: limit(limits.perQubit, 'wiesner.limits.perQubit'),
      byLength: list(limits.byLength, 'wiesner.limits.byLength').map((row, i) => {
        const path = `wiesner.limits.byLength[${i}]`;
        const entry = record(row, path);
        return {
          length: integer(entry.length, `${path}.length`, 1),
          value: rate(entry.value, `${path}.value`),
        };
      }),
      byLengthMethod: text(limits.byLengthMethod, 'wiesner.limits.byLengthMethod'),
    },
    payouts: {
      status: text(payouts.status, 'wiesner.payouts.status'),
      stake: finite(payouts.stake, 'wiesner.payouts.stake'),
      rule: text(payouts.rule, 'wiesner.payouts.rule'),
      table,
    },
    logicalCircuits,
    logicalCircuitsNote: text(raw.logicalCircuitsNote, 'wiesner.logicalCircuitsNote'),
    runs,
  };
}

function pocket(value: unknown, path: string): number {
  const n = integer(value, path, 0);
  if (n >= ROULETTE_POCKETS) fail(path, `expected a pocket below ${ROULETTE_POCKETS}`);
  return n;
}

function pocketList(value: unknown, path: string): readonly number[] {
  const pockets = list(value, path).map((p, i) => pocket(p, `${path}[${i}]`));
  checkUnique(pockets, path);
  return pockets;
}

function parseDraft(value: unknown, deckSize: number, path: string): readonly number[] {
  const draft = list(value, path).map((c, i) => {
    const card = integer(c, `${path}[${i}]`, 0);
    if (card >= deckSize) fail(`${path}[${i}]`, 'not a card in the deck');
    return card;
  });
  checkUnique(draft, path);
  return draft;
}

function parseRouletteCounts(value: unknown, shots: number, path: string): readonly number[] {
  const counts = list(value, path);
  if (counts.length !== ROULETTE_POCKETS) fail(path, `expected ${ROULETTE_POCKETS} counts`);
  const parsed = counts.map((c, i) => integer(c, `${path}[${i}]`, 0));
  if (parsed.reduce((sum, c) => sum + c, 0) !== shots) fail(path, `counts do not sum to shots (${shots})`);
  return parsed;
}

function parseRouletteNode(
  value: unknown,
  turns: readonly Exclude<RouletteTurn, 'spin'>[],
  deckSize: number,
  wheelCount: number,
  path: string,
): RouletteNode {
  const raw = record(value, path);
  const draft = parseDraft(raw.draft, deckSize, `${path}.draft`);
  if (draft.length > turns.length) fail(`${path}.draft`, `longer than ${turns.length} cards`);
  const turn: RouletteTurn = turns[draft.length] ?? 'spin';
  if (raw.turn !== turn) fail(`${path}.turn`, `expected ${turn}`);
  const wheel = integer(raw.wheel, `${path}.wheel`, 0);
  if (wheel >= wheelCount) fail(`${path}.wheel`, 'no such wheel');
  const base = { draft, wheel, value: rate(raw.value, `${path}.value`) };
  if (turn === 'spin') {
    return { ...base, turn, limitPockets: pocketList(raw.limitPockets, `${path}.limitPockets`) };
  }
  if (turn === 'player') return { ...base, turn };
  const houseCards = parseDraft(filled(raw.houseCards, `${path}.houseCards`), deckSize, `${path}.houseCards`);
  if (houseCards.some((card) => draft.includes(card))) {
    fail(`${path}.houseCards`, 'a card already drafted');
  }
  return { ...base, turn, houseCards };
}

function parseRouletteRun(value: unknown, deckSize: number, path: string): RouletteRun {
  const raw = record(value, path);
  const points = filled(raw.points, `${path}.points`).map((entry, i) => {
    const at = `${path}.points[${i}]`;
    const point = record(entry, at);
    const shots = integer(point.shots, `${at}.shots`, 1);
    return {
      draft: parseDraft(point.draft, deckSize, `${at}.draft`),
      seed: finite(point.seed, `${at}.seed`),
      shots,
      counts: parseRouletteCounts(point.counts, shots, `${at}.counts`),
    };
  });
  checkUnique(
    points.map((p) => draftKey(p.draft)),
    `${path}.points`,
  );
  return {
    id: text(raw.id, `${path}.id`),
    provenance: parseExportedProvenance(raw.provenance, `${path}.provenance`),
    points,
  };
}

function parseRouletteCard(value: unknown, path: string): RouletteCard {
  const raw = record(value, path);
  return {
    id: text(raw.id, `${path}.id`),
    name: text(raw.name, `${path}.name`),
    ops: filled(raw.ops, `${path}.ops`).map((entry, i) => {
      const op = record(entry, `${path}.ops[${i}]`);
      return {
        gate: text(op.gate, `${path}.ops[${i}].gate`),
        qubits: filled(op.qubits, `${path}.ops[${i}].qubits`).map((q, j) =>
          integer(q, `${path}.ops[${i}].qubits[${j}]`, 0),
        ),
      };
    }),
  };
}

function parseRoulettePayout(value: unknown, path: string): RoulettePayout {
  const raw = record(value, path);
  return {
    bet: text(raw.bet, `${path}.bet`),
    pockets: integer(raw.pockets, `${path}.pockets`, 1),
    pays: finite(raw.pays, `${path}.pays`),
    fairPays: finite(raw.fairPays, `${path}.fairPays`),
    breakEven: rate(raw.breakEven, `${path}.breakEven`),
    houseEdge: finite(raw.houseEdge, `${path}.houseEdge`),
  };
}

function parseRouletteEdge(value: unknown, deckSize: number, path: string): RouletteEdge {
  const raw = record(value, path);
  const worst = record(raw.worstSpin, `${path}.worstSpin`);
  return {
    run: text(raw.run, `${path}.run`),
    method: text(raw.method, `${path}.method`),
    bestReturn: finite(raw.bestReturn, `${path}.bestReturn`),
    worstSpin: {
      draft: parseDraft(worst.draft, deckSize, `${path}.worstSpin.draft`),
      return: finite(worst.return, `${path}.worstSpin.return`),
    },
    clearChance: rate(raw.clearChance, `${path}.clearChance`),
  };
}

export function parseRouletteExport(value: unknown): RouletteExport {
  const raw = record(value, 'roulette');
  checkHeader(raw, 'roulette');
  const turns = filled(raw.turns, 'roulette.turns').map((t, i) => {
    if (t !== 'house' && t !== 'player') fail(`roulette.turns[${i}]`, 'expected house or player');
    return t;
  });
  const deck = filled(raw.deck, 'roulette.deck').map((c, i) => parseRouletteCard(c, `roulette.deck[${i}]`));
  checkUnique(
    deck.map((c) => c.id),
    'roulette.deck',
  );
  const wheels = filled(raw.wheels, 'roulette.wheels').map((w, i) => {
    const path = `roulette.wheels[${i}]`;
    const wheel = list(w, path);
    if (wheel.length !== ROULETTE_POCKETS) fail(path, `expected ${ROULETTE_POCKETS} chances`);
    return wheel.map((p, j) => rate(p, `${path}[${j}]`));
  });
  const nodes = filled(raw.nodes, 'roulette.nodes').map((n, i) =>
    parseRouletteNode(n, turns, deck.length, wheels.length, `roulette.nodes[${i}]`),
  );
  const nodeKeys = nodes.map((n) => draftKey(n.draft));
  checkUnique(nodeKeys, 'roulette.nodes');
  // Every move the game can make has to land on a node.
  const known = new Set(nodeKeys);
  if (!known.has('')) fail('roulette.nodes', 'no node for the empty draft');
  for (const node of nodes) {
    const next =
      node.turn === 'house'
        ? node.houseCards
        : node.turn === 'player'
          ? deck.map((_c, card) => card).filter((card) => !node.draft.includes(card))
          : [];
    for (const card of next) {
      const key = draftKey([...node.draft, card]);
      if (!known.has(key)) fail('roulette.nodes', `no node for draft ${key}`);
    }
  }
  const logicalCircuits = filled(raw.logicalCircuits, 'roulette.logicalCircuits').map((entry, i) => {
    const path = `roulette.logicalCircuits[${i}]`;
    const circuit = record(entry, path);
    return { draft: parseDraft(circuit.draft, deck.length, `${path}.draft`), qasm: text(circuit.qasm, `${path}.qasm`) };
  });
  const runs = filled(raw.runs, 'roulette.runs').map((r, i) =>
    parseRouletteRun(r, deck.length, `roulette.runs[${i}]`),
  );
  checkUnique(
    runs.map((r) => r.id),
    'roulette.runs',
  );
  const playRun = text(raw.playRun, 'roulette.playRun');
  const play = runs.find((r) => r.id === playRun);
  if (!play) fail('roulette.playRun', `no run ${playRun}`);
  const circuitKeys = new Set(logicalCircuits.map((c) => draftKey(c.draft)));
  const pointKeys = new Set(play.points.map((p) => draftKey(p.draft)));
  for (const node of nodes) {
    if (node.turn !== 'spin') continue;
    const key = draftKey(node.draft);
    if (!pointKeys.has(key)) fail(`roulette.runs.${playRun}`, `no point for draft ${key}`);
    if (!circuitKeys.has(key)) fail('roulette.logicalCircuits', `no logical circuit for draft ${key}`);
  }
  const limits = record(raw.limits, 'roulette.limits');
  const payouts = record(raw.payouts, 'roulette.payouts');
  const table = filled(payouts.table, 'roulette.payouts.table').map((row, i) =>
    parseRoulettePayout(row, `roulette.payouts.table[${i}]`),
  );
  if (!table.some((row) => row.bet === 'straight')) fail('roulette.payouts.table', 'no straight bet');
  const clear = record(raw.clear, 'roulette.clear');
  const edge = filled(raw.edge, 'roulette.edge').map((e, i) =>
    parseRouletteEdge(e, deck.length, `roulette.edge[${i}]`),
  );
  if (!edge.some((e) => e.run === playRun)) fail('roulette.edge', `no entry for ${playRun}`);
  return {
    schemaVersion: 1,
    experiment: 'roulette',
    pocketOrder: text(raw.pocketOrder, 'roulette.pocketOrder'),
    opening: text(raw.opening, 'roulette.opening'),
    houseRule: text(raw.houseRule, 'roulette.houseRule'),
    bet: text(raw.bet, 'roulette.bet'),
    stakeRule: text(raw.stakeRule, 'roulette.stakeRule'),
    spin: text(raw.spin, 'roulette.spin'),
    wheelsMethod: text(raw.wheelsMethod, 'roulette.wheelsMethod'),
    turns,
    playRun,
    deck,
    limits: {
      fairWheel: limit(limits.fairWheel, 'roulette.limits.fairWheel'),
      classicalWheel: limit(limits.classicalWheel, 'roulette.limits.classicalWheel'),
      houseLimit: limit(limits.houseLimit, 'roulette.limits.houseLimit'),
      playStyles: list(limits.playStyles, 'roulette.limits.playStyles').map((entry, i) => {
        const path = `roulette.limits.playStyles[${i}]`;
        const style = record(entry, path);
        return {
          style: text(style.style, `${path}.style`),
          value: rate(style.value, `${path}.value`),
          rule: text(style.rule, `${path}.rule`),
        };
      }),
      legalDrafts: integer(limits.legalDrafts, 'roulette.limits.legalDrafts', 1),
      reachableDrafts: integer(limits.reachableDrafts, 'roulette.limits.reachableDrafts', 1),
    },
    payouts: {
      status: text(payouts.status, 'roulette.payouts.status'),
      stake: integer(payouts.stake, 'roulette.payouts.stake', 1),
      rule: text(payouts.rule, 'roulette.payouts.rule'),
      basis: text(payouts.basis, 'roulette.payouts.basis'),
      table,
    },
    clear: {
      rule: text(clear.rule, 'roulette.clear.rule'),
      basis: text(clear.basis, 'roulette.clear.basis'),
      chance: rate(clear.chance, 'roulette.clear.chance'),
    },
    wheels,
    nodes,
    logicalCircuits,
    runs,
    edge,
  };
}

/** A live run's own numbers. The circuits and payouts stay the exported ones. */
export type LiveChsh = Pick<ChshResult, 'runId' | 'winRate' | 'pairs' | 'provenance'>;
export type LiveWiesner = Pick<
  WiesnerResult,
  'runId' | 'shots' | 'passes' | 'passRate' | 'qubits' | 'provenance'
>;

/** Stricter than an export: a live result must say so, and name its noise model. */
function parseLiveProvenance(value: unknown, shots: number, path: string): Provenance {
  const provenance = parseProvenance(value, path);
  if (provenance.source !== 'live-simulator') fail(`${path}.source`, 'expected live-simulator');
  if (!provenance.noiseModel) fail(`${path}.noiseModel`, 'a live run names its noise model');
  if (provenance.shots !== shots) fail(`${path}.shots`, `expected ${shots}`);
  return provenance;
}

/** A pressed chip run must name a real chip and its job, and carry no noise model. */
function parseChipProvenance(value: unknown, shots: number, path: string): ChipProvenance {
  const provenance = parseProvenance(value, path);
  if (provenance.source !== 'ibm-chip') fail(`${path}.source`, 'expected ibm-chip');
  if (provenance.shots !== shots) fail(`${path}.shots`, `expected ${shots}`);
  return provenance;
}

function parseLiveChshBody<P extends Provenance>(
  value: unknown,
  dial: number,
  parseRunProvenance: (raw: unknown, shots: number, path: string) => P,
): LiveChsh & { readonly provenance: P } {
  const raw = record(value, 'live');
  if (raw.experiment !== 'chsh') fail('live.experiment', 'expected chsh');
  if (raw.dial !== dial) fail('live.dial', `expected ${dial}`);
  if (raw.outcomeOrder !== 'ba') fail('live.outcomeOrder', 'expected ba');
  const pairs = list(raw.pairs, 'live.pairs').map((p, i) => parseChshPair(p, `live.pairs[${i}]`));
  checkFourPairs(pairs, 'live.pairs');
  const shots = pairs[0]?.shots ?? 0;
  if (pairs.some((pair) => pair.shots !== shots)) fail('live.pairs', 'shots differ between pairs');
  return {
    runId: text(raw.runId, 'live.runId'),
    winRate: rate(raw.winRate, 'live.winRate'),
    pairs,
    provenance: parseRunProvenance(raw.provenance, shots, 'live.provenance'),
  };
}

export function parseLiveChsh(value: unknown, dial: number): LiveChsh {
  return parseLiveChshBody(value, dial, parseLiveProvenance);
}

/** A press's result from the service. Only a real chip label passes. */
export function parseLiveChipChsh(value: unknown, dial: number): LiveChsh & { readonly provenance: ChipProvenance } {
  return parseLiveChshBody(value, dial, parseChipProvenance);
}

export function parseLiveWiesner(value: unknown, length: number): LiveWiesner {
  const raw = record(value, 'live');
  if (raw.experiment !== 'wiesner') fail('live.experiment', 'expected wiesner');
  if (raw.length !== length) fail('live.length', `expected ${length}`);
  const point = parseWiesnerPoint(raw, 'live');
  if (point.passRate !== point.passes / point.shots) fail('live.passRate', 'does not match passes');
  if (point.qubits?.length !== length) fail('live.qubits', `expected ${length} qubits`);
  return {
    runId: text(raw.runId, 'live.runId'),
    shots: point.shots,
    passes: point.passes,
    passRate: point.passRate,
    qubits: point.qubits,
    provenance: parseLiveProvenance(raw.provenance, point.shots, 'live.provenance'),
  };
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

async function fetchJson(
  fetchFn: (url: string) => Promise<FetchResponse>,
  url: string,
): Promise<unknown> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  return response.json();
}

export async function loadExports(
  fetchFn: (url: string) => Promise<FetchResponse> = fetch,
  base: string = import.meta.env.BASE_URL,
): Promise<GameExports> {
  const [chsh, wiesner] = await Promise.all([
    fetchJson(fetchFn, `${base}data/chsh.v1.json`),
    fetchJson(fetchFn, `${base}data/wiesner.v1.json`),
  ]);
  return { chsh: parseChshExport(chsh), wiesner: parseWiesnerExport(wiesner) };
}

/** Loaded on its own, so the Tables and the Cage never wait on it. */
export async function loadRoulette(
  fetchFn: (url: string) => Promise<FetchResponse> = fetch,
  base: string = import.meta.env.BASE_URL,
): Promise<RouletteExport> {
  return parseRouletteExport(await fetchJson(fetchFn, `${base}data/roulette.v1.json`));
}

export function provenanceLabel(p: Provenance): string {
  switch (p.source) {
    case 'pre-run-simulator':
      return p.noiseModel
        ? `Pre-run Qiskit simulator, ${p.noiseModel.name} noise model`
        : 'Pre-run Qiskit simulator';
    case 'live-simulator':
      return p.noiseModel
        ? `Live Qiskit simulator, ${p.noiseModel.name} noise model`
        : 'Live Qiskit simulator';
    case 'ibm-chip':
      return `IBM chip ${p.backend}, job ${p.jobId}`;
  }
}

/** A chip rate's real sample size, as "32 tickets × 32 shots". Null for anything but a chip run. */
export function ticketSplit({ provenance, ticketsPerPoint: tickets, shotsPerTicket: shots }: TicketShots & { readonly provenance: Provenance }): string | null {
  if (provenance.source !== 'ibm-chip' || tickets === undefined || shots === undefined) return null;
  return `${tickets.toLocaleString('en-US')} ticket${tickets === 1 ? '' : 's'} × ${shots.toLocaleString('en-US')} shot${shots === 1 ? '' : 's'}`;
}

export function createPrerunSource(exports: GameExports, runId: string): ResultSource {
  const { chsh, wiesner } = exports;
  const chshRun = chsh.runs.find((run) => run.id === runId);
  const wiesnerRun = wiesner.runs.find((run) => run.id === runId);
  if (!chshRun || !wiesnerRun) throw new Error(`Unknown run id: ${runId}`);

  const dials = chshRun.points.map((point) => point.dial).sort((a, b) => a - b);

  const snapDial = (value: number): number => {
    let nearest = dials[0] as number;
    if (!Number.isFinite(value)) return nearest;
    const clamped = Math.min(1, Math.max(0, value));
    for (const dial of dials) {
      if (Math.abs(dial - clamped) < Math.abs(nearest - clamped)) nearest = dial;
    }
    return nearest;
  };

  const pointAt = (dial: number): ChshPoint => {
    const snapped = snapDial(dial);
    const point = chshRun.points.find((p) => p.dial === snapped);
    if (!point) throw new Error(`No point at dial ${snapped}`);
    return point;
  };

  return {
    dials,
    limits: { classical: chsh.limits.classical.value, quantum: chsh.limits.quantum.value },
    previewProvenance: () => chshRun.provenance,
    snapDial,
    previewWinRate: (dial) => pointAt(dial).winRate,
    chsh(dial) {
      const point = pointAt(dial);
      const circuits = chsh.logicalCircuits.find((c) => c.dial === point.dial);
      if (!circuits) return Promise.reject(new Error(`No circuits at dial ${point.dial}`));
      return Promise.resolve({
        experiment: 'chsh',
        runId,
        dial: point.dial,
        winRate: point.winRate,
        outcomeOrder: chsh.outcomeOrder,
        pairs: point.pairs,
        circuits: circuits.pairs,
        provenance: chshRun.provenance,
      });
    },
    wiesner(length) {
      const point = wiesnerRun.points.find((p) => p.length === length);
      const payout = wiesner.payouts.table.find((row) => row.length === length);
      const circuit = wiesner.logicalCircuits.find((c) => c.length === length);
      if (!point || !payout || !circuit) {
        return Promise.reject(new Error(`No Wiesner point at length ${length}`));
      }
      return Promise.resolve({
        experiment: 'wiesner',
        runId,
        length,
        shots: point.shots,
        passes: point.passes,
        passRate: point.passRate,
        qubits: point.qubits,
        payout,
        circuit: { ticket: circuit.ticket, qasm: circuit.qasm },
        circuitNote: wiesner.logicalCircuitsNote,
        provenance: wiesnerRun.provenance,
      });
    },
  };
}

/** One hand's answers, drawn from the exported counts. */
export function sampleOutcome(pair: ChshPair, rng: Rng): { a: Bit; b: Bit } {
  const total = COUNT_KEYS.reduce((sum, key) => sum + pair.counts[key], 0);
  const draw = rng() * total;
  let seen = 0;
  let picked: CountKey = '11';
  for (const key of COUNT_KEYS) {
    seen += pair.counts[key];
    if (draw < seen) {
      picked = key;
      break;
    }
  }
  return { a: picked[1] === '1' ? 1 : 0, b: picked[0] === '1' ? 1 : 0 };
}

export function drawPass(result: Pick<WiesnerResult, 'passes' | 'shots'>, rng: Rng): boolean {
  return rng() * result.shots < result.passes;
}
