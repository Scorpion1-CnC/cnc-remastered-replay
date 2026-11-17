import type { BldgKind, EntityKind, UnitKind, Theater } from "./types";
import { BLDG_SIZE } from "./footprint";
export { BLDG_SIZE, BLDG_OCCUPY, KIND_BY_ASSET, bldgCenterCell, bldgOccupies, occupiedCells } from "./footprint";
import { UNIT_DEFS, bldgRot, isBuilding, isUnit, unitRot } from "./types";
import { decodeShp, type ShpFile } from "./shp";
import { fetchShpBytes } from "./assets";
import { COMBAT_EFFECTS } from "./types";
import type { CombatEffect } from "./types";

/**
 * Real SHP filenames (bundled under public/assets/td/sprites/general/)
 * backing each unit/building kind, plus the frame-layout conventions the
 * original game uses to index into them.
 *
 * These are the actual Westwood codenames from a real C&C95 install — E1 is
 * the minigunner, FACT the Construction Yard, and (importantly) **NUKE is
 * the Power Plant and NUK2 the Advanced Power Plant**. An earlier version
 * of this file mapped both power plants to `power.shp`, which is a 64-byte
 * 8x3 stub, and documented APWR as "missing from this asset subset" — it
 * isn't missing, it was just being looked up under the wrong codename.
 *
 * ## Frame layouts (all empirically confirmed by rendering real frames)
 *
 * **Structures** pack their states into one file as `2k + 1` frames:
 * `[0, k)` healthy idle animation, `[k, 2k)` the same animation for the
 * damaged state, and frame `2k` the destroyed rubble. Confirmed on FACT
 * (49 = 24/24/1, crane sweep) and PROC (61 = 30/30/1, harvester docking).
 * Selecting the *last* frame for a healthy building — as this module used
 * to — renders every finished structure as its own rubble pile, which is
 * exactly what made completed bases look wrong.
 *
 * **Vehicles** store 32 hull facings in `[0, 32)`, starting due north and
 * advancing clockwise in 11.25-degree steps. Files with >= 64 frames carry
 * an independent turret layer in `[32, 64)` using the same facing order;
 * the hull frames carry the shadow sentinel and the turret frames don't,
 * which is how the split was confirmed (MTNK, HTNK, LTNK, JEEP, BGGY,
 * MLRS). Files with only 32 frames have no turret layer, so `turretFrame`
 * returns null for them regardless of what the unit definition claims.
 *
 * **Infantry** store 8 facings per pose: `[0, 8)` is the standing/ready
 * pose and `[8, 56)` is a six-step walk cycle laid out as
 * `8 + step * 8 + facing`.
 *
 * **Defensive turret structures** (GUN, SAM) are facing-indexed rather than
 * animated: 32 aim facings from the state's base frame.
 */

export const UNIT_FILE: Record<UnitKind, string> = {
  e1: "e1",
  e2: "e2",
  e3: "e3",
  e4: "e4",
  e6: "e6",
  c1: "c1",
  c7: "c7",
  jeep: "jeep",
  apc: "apc",
  ltnk: "ltnk",
  mtnk: "mtnk",
  htnk: "htnk",
  stnk: "stnk",
  ftnk: "ftnk",
  arty: "arty",
  mlrs: "mlrs",
  bike: "bike",
  buggy: "bggy",
  harv: "harv",
  mcv: "mcv",
  orca: "orca",
  heli: "heli",
  tran: "tran",
  a10: "a10",
};

export const BLDG_FILE: Record<BldgKind, string> = {
  fact: "fact",
  proc: "proc",
  powr: "nuke", // real Power Plant art (power.shp is an 8x3 stub)
  apwr: "nuk2", // real Advanced Power Plant art
  pyle: "pyle",
  hand: "hand",
  // WEAP.SHP is only the foundation — it has a solid black void where the
  // roof belongs, because the original draws WEAP2 over it. WEAP2 is the
  // complete building (roof, doors and all), so it is used directly.
  weap: "weap2",
  afld: "afld",
  hq: "hq",
  hpad: "hpad",
  fix: "fix",
  silo: "silo",
  gtwr: "gtwr",
  atwr: "atwr",
  gun: "gun",
  obli: "obli",
  sam: "sam",
  tmpl: "tmpl",
  eye: "eye",
  bio: "bio",
  hosp: "hosp",
  miss: "miss",
};

export const BLDG_MAKE_FILE: Partial<Record<BldgKind, string>> = {
  fact: "factmake",
  proc: "procmake",
  powr: "nukemake",
  apwr: "nuk2make",
  pyle: "pylemake",
  hand: "handmake",
  weap: "weapmake",
  afld: "afldmake",
  hq: "hqmake",
  hpad: "hpadmake",
  fix: "fixmake",
  silo: "silomake",
  gtwr: "gtwrmake",
  atwr: "atwrmake",
  gun: "gunmake",
  obli: "oblimake",
  sam: "sammake",
  tmpl: "tmplmake",
  eye: "eyemake",
  // no MISSMAKE in the asset set; falls back to the finished sprite
};

export const INFANTRY: ReadonlySet<string> = new Set(["e1", "e2", "e3", "e4", "e6", "c1", "c7"]);

/**
 * Each structure's `Size` box, from its constructor in BDATA.CPP.
 *
 * This is not the same as the cells it stands on. A building has two
 * footprints: `Size`, a plain rectangle, and an occupy list of the squares
 * within it that are actually solid. The Refinery is BSIZE_33 but occupies
 * `{1, MCW, MCW+1, MCW+2}` — one square of the top row and all of the middle,
 * with the bottom row free. The Barracks is BSIZE_22 occupying `{0, 1}`, its
 * bottom row free as well. That free row is where the bib goes.
 *
 * `Size` is what the drawing hangs off. `Render_Coord` is `Center_Coord`,
 * which is `Coord + CenterOffset[Size]` — half the box, to the lepton — and
 * the shape is drawn SHAPE_CENTER on it. The art is cut to match: every
 * structure sprite is exactly its box in pixels, the Refinery's 72x72 for
 * three cells by three, the Barracks' 48x48 for two by two.
 *
 * Taking the occupied rows for the box instead drew both of those a whole
 * cell high, because their art is a row taller than the ground they stand on.
 */


/**
 * Structures that sit on a dirt apron, from "Requires a bib dirt patch?" in
 * each type's constructor. Defences get none: no turret, obelisk, SAM site or
 * guard tower.
 */
export const BIBBED: ReadonlySet<string> = new Set([
  "fact", "proc", "powr", "apwr", "pyle", "hand", "weap", "afld",
  "hq", "hpad", "fix", "silo", "tmpl", "eye", "hosp", "bio",
]);

/**
 * How far a structure's recorded cell sits from its top-left, in cells.
 *
 * The stream does not report where a building stands; it reports where it is
 * drawn. `CNCObjectStruct.CellX` is `Cell_X(Coord_Cell(Render_Coord()))`, and
 * a building's `Render_Coord` is its `Center_Coord` — `Coord +
 * CenterOffset[Size]`. So the cell in the recording is the one the *centre*
 * falls in, and the origin is that cell less this.
 *
 * The offsets come from `CenterOffset[]` in BUILDING.CPP, divided down into
 * whole cells. Half of them are zero because the table uses 0xFF rather than
 * 0x100 for a whole cell, which keeps the centre of an even-sided building
 * inside its top-left quadrant — which is why the 2x2s always looked right and
 * everything larger sat down and to the right of where it belonged.
 */


/**
 * Which bib a building's width takes, from `Bib_And_Offset`: the widest takes
 * BIB1, so the file number runs opposite to the width.
 */
export const BIB_FILE: Readonly<Record<number, number>> = { 4: 1, 3: 2, 2: 3 };

/**
 * The ground a structure takes up, bib included.
 *
 * This is `Occupy_List(true)` — the list `Legal_Placement` checks against.
 * That argument makes the engine copy the bib's own cells in before the
 * building's, so a bibbed structure holds its solid squares *and* its apron,
 * and nothing can be put down where another building's bib will go.
 *
 * The apron is two rows starting at the Size box's last one, so it reaches
 * exactly one row past the box. Everything else is the box as it stands.
 */
export function bldgFootprint(kind: string): readonly [number, number] {
  const box = BLDG_SIZE[kind];
  if (!box) return [1, 1];
  return [box[0], box[1] + (BIBBED.has(kind) ? 1 : 0)];
}

/** Facing-indexed defensive structures rather than idle-animated ones. */
const TURRET_BLDG: ReadonlySet<string> = new Set(["gun", "sam"]);

/**
 * How a structure animates.
 *
 * `always` — genuinely idles in the original: rotating radar dishes,
 *   coolant and light cycles. These run whenever the building stands.
 * `active` — the animation *is* an activity, so running it constantly is
 *   wrong. A Construction Yard's crane only swings while it is building
 *   something; a Refinery's cycle is a harvester docking and unloading, so
 *   playing it on a timer shows a phantom harvester docking forever; a
 *   Weapons Factory's door opens to let a vehicle out.
 * anything absent — holds its first frame. SILO's extra frames are
 *   Tiberium fill levels and OBLI's are a firing charge-up; cycling those
 *   would animate something the original never animates at rest.
 */
/** One animation state: a frame range and its rate in ticks per frame. */
interface AnimRange {
  /** First frame of the range, relative to the state's base frame. */
  start: number;
  /** Number of frames. A count of 0 or 1 means the state is static. */
  count: number;
  /**
   * Game frames per frame of animation, from the table. 0 means static.
   *
   * These are the engine's own frames, not this simulation's ticks — three of
   * them to a tick. Reading them as ticks is what made every structure
   * animate at a third of its speed.
   */
  rate: number;
  /**
   * Play through once and hold the last frame, instead of looping.
   *
   * Nothing in `_anims[]` does this — every state the engine runs loops, and
   * the loop at the bottom of `BuildingClass::AI` is what ends it, by letting
   * a mission change take effect on the last frame. Kept for a state that has
   * to stop somewhere with nothing to end it.
   */
  once?: boolean;
}

interface AnimSpec {
  /** The resting loop, played whenever the structure has nothing to do. */
  idle?: AnimRange;
  /** Played while the structure is doing its job. */
  active?: AnimRange;
  /** Refinery only: flashing lights while a harvester is inbound. */
  full?: AnimRange;
  /** Refinery only: siphoning, one pass per bail of Tiberium. */
  aux1?: AnimRange;
  /** Refinery only: undocking, once the harvester is empty. */
  aux2?: AnimRange;
  /**
   * `IsRegulated` from the type's constructor in BDATA.CPP — "animation rate
   * is regulated for constant speed". Those types have their rate put through
   * {@link normalizeDelay} first; the rest use the table's rate as written.
   */
  regulated?: true;
}

/**
 * Game speed, on the engine's 0-7 scale.
 *
 * Not inferred — this is what the installed game is set to. `CONQUER.INI` in
 * the Remastered's own folder carries `[Options] GameSpeed=3`, which is the
 * value `OptionsClass` loads and `Normalize_Delay` indexes by. Quickmatch
 * plays on "fast", and that is this.
 *
 * (Which way the scale runs is easy to get backwards:
 * `FrameTimer.Set(Options.GameSpeed)` makes the setting a per-frame delay in
 * sixtieths, so 0 is the fastest and 7 the slowest, and `Normalize_Delay`
 * compensates by handing out its longest delays at 0.)
 */
const GAME_SPEED = 3;

/**
 * One game frame, in milliseconds.
 *
 * Every animation rate in the game's tables is counted in these, so this is
 * the constant the whole of the timing hangs off. It follows from the game
 * speed above and two structures that are sampled densely enough to read
 * directly. The Airstrip advances a frame every 65.8ms — shape
 * 1,3,5,8,10,12,14,0,3,5,7,9, twenty-four frames in 1.58 seconds — and the
 * Power Plant every ~660ms. Both are regulated and their table rates are 3 and
 * 15, so at speed 3 they are held for `Normalize_Delay(3) = 3` and
 * `Normalize_Delay(15) = 30` frames. Both divide out to 22ms.
 *
 * Sightings of a live object arrive at multiples of the same 22ms — 22, 44,
 * 66, 88 and so on, never between — which is the host advancing the DLL once
 * a frame and the stream writing a record each time.
 */
export const GAME_FRAME_MS = 22;

/** This simulation's own tick, in milliseconds. */
const TICK_MS = 1000 / 15;

/**
 * `OptionsClass::Normalize_Delay` from OPTIONS.CPP, verbatim.
 *
 * The engine keeps animations at a constant wall-clock speed while the game
 * speed setting changes how many frames a second run, by scaling the delay to
 * match. Short delays come from a hand-written table because the arithmetic
 * would round them all to the same one or two ticks.
 */
function normalizeDelay(delay: number): number {
  const adjust = [
    [2, 2, 1, 1, 1, 1, 1, 1],
    [3, 3, 3, 2, 2, 2, 1, 1],
    [5, 4, 4, 3, 3, 2, 2, 1],
    [7, 6, 5, 4, 4, 4, 3, 2],
  ];
  if (delay <= 0) return delay;
  if (delay < 5) return adjust[delay - 1]![GAME_SPEED]!;
  return Math.trunc((delay * 8) / (GAME_SPEED + 1));
}

/**
 * Per-structure animation layout, transcribed from the game.
 *
 * These are not measurements or guesses: they are the `_anims[]` table in
 * `BuildingTypeClass::One_Time()` (TIBERIANDAWN/BDATA.CPP in EA's GPL
 * release), which is what the real game feeds to `Init_Anim`. Each entry
 * is a start frame, a frame count and a rate in ticks-per-frame, per
 * animation state. An earlier version of this table inferred the ranges by
 * diffing sprite frames, which got the ranges roughly right but flattened
 * every rate to 3 — so power plants blinked five times too fast and radar
 * dishes span a third too quickly.
 *
 * A structure absent from this table holds frame 0, exactly as the game
 * does for anything without an `_anims[]` row (Hand of Nod, silo, Tiberium
 * refinery silos are fill levels, not animation).
 */
const ANIM: Readonly<Record<string, AnimSpec>> = {
  // {STRUCT_CONST, BSTATE_IDLE, 0, 4, 3} / {STRUCT_CONST, BSTATE_ACTIVE, 4, 20, 3}
  //
  // The two are alternatives, not layers: the yard shows 0..3 at rest and
  // 4..23 while it is building, never both. The crane loops for as long as
  // that lasts — a placed structure sends RADIO_BUILDING as its buildup
  // starts, which puts the yard on MISSION_REPAIR and BSTATE_ACTIVE, and
  // RADIO_COMPLETE when the buildup ends, which sends it back to MISSION_GUARD
  // and BSTATE_IDLE. Playing the swing once and freezing on its last frame was
  // our own invention.
  fact: {
    idle: { start: 0, count: 4, rate: 3 },
    active: { start: 4, count: 20, rate: 3 },
  },
  // Five states, and the engine walks them in order rather than running one
  // long sequence. `Mission_Harvest` is the whole of it: ACTIVE to dock, then
  // AUX1 on the first `IsReadyToCommence`, which repeats for as long as the
  // harvester has Tiberium left — one bail a pass — then AUX2 to undock and
  // MISSION_GUARD, which is IDLE. FULL is separate, flashing the lights from
  // RADIO_DOCKING until the harvester actually arrives.
  //
  // Running 12..29 as one eighteen-frame loop, as this used to, plays docking,
  // siphoning and undocking over and over at whatever the dwell happens to be.
  proc: {
    idle: { start: 0, count: 6, rate: 4 },
    full: { start: 6, count: 6, rate: 4 },
    active: { start: 12, count: 7, rate: 4 },
    aux1: { start: 19, count: 5, rate: 4 },
    aux2: { start: 24, count: 6, rate: 4 },
  },
  // {STRUCT_AIRSTRIP, BSTATE_IDLE, 0, 16, 3}
  afld: { idle: { start: 0, count: 16, rate: 3 }, regulated: true },
  // {STRUCT_BARRACKS, BSTATE_IDLE / BSTATE_ACTIVE, 0, 10, 3} - same range both ways.
  pyle: { idle: { start: 0, count: 10, rate: 3 }, regulated: true },
  // {STRUCT_RADAR, BSTATE_IDLE, 0, 16, 4} and {STRUCT_EYE, BSTATE_IDLE, 0, 16, 4}
  hq: { idle: { start: 0, count: 16, rate: 4 }, regulated: true },
  eye: { idle: { start: 0, count: 16, rate: 4 }, regulated: true },
  // {STRUCT_POWER / STRUCT_ADVANCED_POWER, BSTATE_IDLE, 0, 4, 15} - one
  // frame per second, a slow pulse rather than a blink.
  powr: { idle: { start: 0, count: 4, rate: 15 }, regulated: true },
  apwr: { idle: { start: 0, count: 4, rate: 15 }, regulated: true },
  // {STRUCT_HELIPAD, BSTATE_IDLE, 0, 0, 0} - static at rest, unlike the
  // other production structures; ACTIVE 0,7,4 services a helicopter.
  hpad: { active: { start: 0, count: 7, rate: 4 } },
  // {STRUCT_REPAIR, BSTATE_IDLE, 0, 1, 0} / {STRUCT_REPAIR, BSTATE_ACTIVE, 0, 7, 2}
  fix: { active: { start: 0, count: 7, rate: 2 }, regulated: true },
  // {STRUCT_HOSPITAL, BSTATE_IDLE, 0, 4, 3}
  hosp: { idle: { start: 0, count: 4, rate: 3 }, regulated: true },
  // {STRUCT_TEMPLE, BSTATE_IDLE, 0, 1, 0} / {STRUCT_TEMPLE, BSTATE_ACTIVE, 0, 5, 1}
  tmpl: { active: { start: 0, count: 5, rate: 1 } },
  // STRUCT_WEAP is {0,1,0} in both states - the base building is static and
  // the door is a separate WEAP2 overlay the game animates on its own. We
  // draw weap2 as the building, so the door range lives here instead.
  weap: { active: { start: 0, count: 9, rate: 3 } },
};

/**
 * How long a buildup runs, in game frames.
 *
 * BDATA.CPP hands `Init_Anim` a rate of `(5 * TICKS_PER_SECOND) / count` for
 * BSTATE_CONSTRUCTION, so the whole sequence takes `5 * TICKS_PER_SECOND`
 * frames whatever its frame count. That is 75, and the constant is named for
 * five seconds because the DOS game ran fifteen frames a second — but this is
 * a `StageClass` rate like every other, counted in frames, and a frame here is
 * {@link GAME_FRAME_MS}. Seventy-five of those is 1.65 seconds.
 *
 * Read as this simulation's own ticks it came to five whole seconds, which is
 * three times too long to watch a structure rise.
 */
/** The engine's BStateType, for the states this models. */
export type BState = "idle" | "full" | "active" | "aux1" | "aux2";

/**
 * The Refinery's unload, phase by phase, in simulation ticks.
 *
 * `Mission_Harvest` walks BSTATE_ACTIVE to dock, BSTATE_AUX1 once per *step*
 * of Tiberium, then BSTATE_AUX2 to undock. Each phase ends when its own range
 * reaches its last frame, so the dwell is not a number to pick — it is the
 * length of the animation, and the animation is the length of the dwell.
 *
 * A step is not a pip. `UnitTypeClass::STEP_COUNT` is 28 (TYPE.H:863) and
 * `Offload_Tiberium_Bail` gives up one of them per pass, worth
 * `TIBERIUM_STEP` = 25 credits — 700 for a full load. The seven green squares
 * under a harvester are `Pip_Count`'s display of those 28 steps, four to a
 * pip, and reading them as the number of passes made this four times too
 * short: 180 game frames against the game's 600.
 *
 * `IsReadyToCommence`, which is what ends a pass, is set inside
 * `if (stagechange)` (BUILDING.CPP:908) — so once per loop of the range, not
 * once per frame the last frame is held for.
 *
 * And it is set the moment the last frame is *reached*, not once it has been
 * shown for its dwell. `Begin_Mode` and the loop both reset the stage timer
 * (`Set_Rate`, STAGE.H:69), so a range entered fresh signals after
 * `(count - 1) * rate` frames and only a repeat of it costs the whole
 * `count * rate`. ACTIVE hands over to AUX1 on the frame frame 18 is reached,
 * in the same `AI()`, so frame 18 is never drawn at all; AUX2's frame 29 is
 * the same. A full load is 24 + (16 + 27 × 20) + 20 = 600 game frames, not the
 * 612 that counting every pass whole gives.
 *
 * Measured, not just read. The Refinery's own recorded frames put a whole
 * unload at 600 game frames, and lined up on 119 docks its docking frames
 * begin 7 frames after the harvester's last sighting and its idle frame
 * returns 607 frames after it. In footage of a ladder game at ladder speed its
 * sprite steps every 88.1ms on two separate Refineries — rate 4 at 22ms — and
 * repeats every five steps while siphoning and every six while idle, which is
 * AUX1 and IDLE exactly.
 */
/**
 * The frame range a structure plays in one of its animation states.
 *
 * Exported so the tables can be checked against BDATA.CPP's own without
 * loading any art: these numbers are the game's, and a typo in them is a
 * building animating the wrong part of its sprite.
 */
export function animRange(kind: string, state: BState): AnimRange | null {
  return ANIM[kind]?.[state] ?? null;
}

export function refineryUnload(steps: number): {
  dock: number;
  siphon: number;
  undock: number;
  total: number;
} {
  const spec = ANIM.proc!;
  const ticks = (frames: number) => (frames * GAME_FRAME_MS) / TICK_MS;
  // Entered fresh, a range signals as its last frame arrives; looped, it has
  // to come all the way round.
  const first = (r: { count: number; rate: number }) => (r.count - 1) * r.rate;
  const again = (r: { count: number; rate: number }) => r.count * r.rate;
  const dock = ticks(first(spec.active!));
  // A harvester that arrives with nothing still enters MIDDLE, so AUX1 gets
  // its one pass before the sequence falls through to AUX2.
  const siphon = ticks(first(spec.aux1!) + (Math.max(1, steps) - 1) * again(spec.aux1!));
  const undock = ticks(first(spec.aux2!));
  return { dock, siphon, undock, total: dock + siphon + undock };
}

/**
 * Steps of Tiberium in a full harvester, and what one is worth.
 *
 * `UnitTypeClass::STEP_COUNT` and `TIBERIUM_STEP` (TYPE.H:862). Their product
 * is `FULL_LOAD_CREDITS`, 700, which is what a full load pays.
 */
export const TIBERIUM_STEPS_PER_LOAD = 28;
export const TIBERIUM_STEP_CREDITS = 25;

/**
 * Green squares drawn under a full harvester.
 *
 * `UnitClass::Pip_Count` is `Fixed_To_Cardinal(FULL_LOAD_CREDITS/100,
 * Tiberium_Load())` (UNIT.CPP:4308) — seven, scaled by how full it is. It is a
 * readout and nothing else; the Refinery offloads steps, not pips.
 */
export const TIBERIUM_PIPS_PER_LOAD = 7;

/** The steps behind a pip reading, which is what the unload actually moves. */
export function tiberiumSteps(pips: number): number {
  return Math.round((pips * TIBERIUM_STEPS_PER_LOAD) / TIBERIUM_PIPS_PER_LOAD);
}

/**
 * The pips drawn under a harvester carrying this many steps.
 *
 * `Fixed_To_Cardinal(FULL_LOAD_CREDITS/100, Tiberium_Load())` — seven scaled
 * by the load, rounded down, so the last pip only lights when the harvester is
 * genuinely full.
 */
export function tiberiumPips(steps: number): number {
  const clamped = Math.max(0, Math.min(TIBERIUM_STEPS_PER_LOAD, steps));
  return Math.floor((clamped * TIBERIUM_PIPS_PER_LOAD) / TIBERIUM_STEPS_PER_LOAD);
}

export const MAKE_FRAMES = 75;

/** The same span in simulation ticks, for callers that count in those. */
export const MAKE_TICKS = (MAKE_FRAMES * GAME_FRAME_MS) / TICK_MS;

/**
 * How long the Construction Yard's crane swings for one placement, in ticks.
 *
 * One cycle. The yard starts when the structure's buildup starts and stops
 * when it ends, and a buildup always ends within a cycle and a bit.
 *
 * The two spans nearly coincide, and that is not a coincidence: both are cut
 * from the same five seconds. The crane is twenty frames at three frames each,
 * sixty. A buildup's rate is `trunc({@link MAKE_FRAMES} / count)`, so it
 * reaches its last frame — where `IsReadyToCommence` fires and RADIO_COMPLETE
 * goes to the yard — at `(count - 1) * that`. Integer division loses the
 * remainder, so it lands short of the seventy-five it was cut from: 57 frames
 * for the twenty-frame sequences that most structures use, 62 for the
 * Construction Yard's own, 65 for the Airstrip's fourteen, 70 for the Temple's
 * thirty-six. Between 0.95 and 1.17 cycles, every one of them.
 *
 * The yard's own `IsReadyToCommence` latches at frame 57 and is not cleared
 * until `Commence()` succeeds, so the ones that run past a cycle idle on the
 * tick their message arrives rather than swinging round again.
 *
 * Taking the buildup as a flat seventy-five and rounding up to a whole cycle
 * gave two swings for every building, which is one more than the game does.
 */
export const CRANE_TICKS = (() => {
  const crane = ANIM.fact!.active!;
  return (crane.count * crane.rate * GAME_FRAME_MS) / TICK_MS;
})();

const INFANTRY_FACINGS = 8;

/**
 * The sprite column a heading is drawn in. Infantry art runs counter-
 * clockwise, like every other sprite here, so the column is the mirror of the
 * facing — see vehicleFrameIndex, which says the same of vehicles.
 */
function infantryFrameColumn(facing: number): number {
  const cw = ((Math.round(facing) % INFANTRY_FACINGS) + INFANTRY_FACINGS) % INFANTRY_FACINGS;
  return (INFANTRY_FACINGS - cw) % INFANTRY_FACINGS;
}
/** A vehicle sprite is 32 headings; anything past them is a pose. */
export const VEHICLE_FACINGS = 32;

/**
 * Infantry frame layout, from the engine's `DoControls` table.
 *
 * Each sequence has a first frame, a stride per facing, and a length:
 *
 *     frame = start + facing * jump + stage
 *
 * The eight facings sit consecutively, so ready occupies 0..7, stand-guard
 * 8..15, prone 16..23, the walk cycle 24..71 and firing 72..135.
 *
 * The offsets were measured from the sprite, not assumed. Frame-to-frame
 * silhouette differences spike at the block boundaries: for the walk the
 * boundaries at 13, 19, 25, 31, 37, 43, 49 and 55 average a difference of
 * 26.4 against a baseline near 22, and for firing the boundaries fall every
 * eight frames from 72 (79, 87, 95, 103, 111) at 47-57.
 *
 * The original code read `8 + stage * 8 + facing` — the right starting frame
 * but a step-major stride, so it hopped between directions instead of walking
 * one, and only ever reached six of the eight facings. There was no firing
 * pose at all. E1 carries 532 frames, so the whole table is present.
 */
/**
 * Every infantry type's animation table, from IDATA.CPP.
 *
 * Each entry is `[Frame, Count, Jump]` out of the game's `DoInfoStruct`: the
 * sequence's first frame, how many frames it runs, and the stride between one
 * facing and the next. A frame is `start + facing * jump + stage`.
 *
 * These differ per type and cannot be shared. The Grenadier's firing sequence
 * strides 20 frames per facing where the Minigunner's strides 8, so reading
 * one with the other's table lands on a completely different pose — facing 4
 * at frame 96 instead of 144. Civilians walk from frame 56, not 16, and the
 * Engineer has no firing sequence at all, which the game writes as a zero
 * count and callers must treat as absent rather than as frame zero.
 *
 * Generated by scripts/dump-infantry-dos.mjs; do not hand-edit.
 */
export interface DoSequence {
  /** First frame of the sequence. */
  readonly start: number;
  /** How many frames it runs. Zero means this type does not have it. */
  readonly count: number;
  /** Frames between one facing and the next. */
  readonly jump: number;
}

export type DoName =
  | "ready" | "guard" | "prone" | "walk" | "fire"
  | "lieDown" | "crawl" | "getUp" | "fireProne"
  | "onGuard" | "fightReady" | "readyWeapon"
  | "punch" | "kick" | "punchHit1" | "punchHit2" | "punchDeath"
  | "kickHit1" | "kickHit2" | "kickDeath"
  | "pullGun" | "plead" | "pleadDeath"
  | DeathName
  | FidgetName;

/**
 * What a soldier standing guard does with himself, in DoType order: DO_IDLE1
 * and DO_IDLE2 (9, 10), then the gestures and salutes (27 to 30). The idles
 * have one set of frames for every facing; the gestures and salutes turn with
 * him. A type without one has a count of 0 — an Engineer has no second idle,
 * and civilians neither salute nor gesture.
 */
export const FIDGETS = ["idle1", "idle2", "gesture1", "salute1", "gesture2", "salute2"] as const;
export type FidgetName = (typeof FIDGETS)[number];

/**
 * The ways an infantryman can die, in DoType order (DEFINES.H, DO_GUN_DEATH
 * onward). Which one is the warhead's call; the recording shows which was
 * played, since a dying soldier is still exported and his frame is in it.
 * Each has one set of frames for every facing.
 */
export const DEATHS = ["gunDeath", "explosionDeath", "explosion2Death", "grenadeDeath", "fireDeath"] as const;
export type DeathName = (typeof DEATHS)[number];

export const INFANTRY_DOS: Readonly<Record<string, Readonly<Record<DoName, DoSequence>>>> = {
  e1: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 8, count: 1, jump: 1 },
    prone: { start: 192, count: 1, jump: 8 },
    walk: { start: 16, count: 6, jump: 6 },
    fire: { start: 64, count: 8, jump: 8 },
    lieDown: { start: 128, count: 2, jump: 2 },
    crawl: { start: 144, count: 4, jump: 4 },
    getUp: { start: 176, count: 2, jump: 2 },
    fireProne: { start: 192, count: 6, jump: 8 },
    idle1: { start: 256, count: 16, jump: 0 },
    idle2: { start: 272, count: 16, jump: 0 },
    onGuard: { start: 288, count: 13, jump: 0 },
    fightReady: { start: 292, count: 10, jump: 0 },
    punch: { start: 301, count: 2, jump: 0 },
    kick: { start: 303, count: 6, jump: 0 },
    punchHit1: { start: 309, count: 2, jump: 0 },
    punchHit2: { start: 311, count: 4, jump: 0 },
    punchDeath: { start: 315, count: 5, jump: 0 },
    kickHit1: { start: 319, count: 2, jump: 0 },
    kickHit2: { start: 321, count: 4, jump: 0 },
    kickDeath: { start: 325, count: 5, jump: 0 },
    readyWeapon: { start: 330, count: 5, jump: 0 },
    gunDeath: { start: 382, count: 8, jump: 0 },
    explosionDeath: { start: 398, count: 8, jump: 0 },
    explosion2Death: { start: 398, count: 8, jump: 0 },
    grenadeDeath: { start: 406, count: 12, jump: 0 },
    fireDeath: { start: 418, count: 18, jump: 0 },
    gesture1: { start: 436, count: 3, jump: 3 },
    salute1: { start: 460, count: 3, jump: 3 },
    gesture2: { start: 484, count: 3, jump: 3 },
    salute2: { start: 508, count: 3, jump: 3 },
    pullGun: { start: 0, count: 1, jump: 1 },
    plead: { start: 0, count: 1, jump: 1 },
    pleadDeath: { start: 0, count: 1, jump: 1 },
  },   // MiniGunnerDos
  e2: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 8, count: 1, jump: 1 },
    prone: { start: 288, count: 1, jump: 12 },
    walk: { start: 16, count: 6, jump: 6 },
    fire: { start: 64, count: 20, jump: 20 },
    lieDown: { start: 224, count: 2, jump: 2 },
    crawl: { start: 240, count: 4, jump: 4 },
    getUp: { start: 272, count: 2, jump: 2 },
    fireProne: { start: 288, count: 8, jump: 12 },
    idle1: { start: 384, count: 16, jump: 0 },
    idle2: { start: 400, count: 16, jump: 0 },
    onGuard: { start: 416, count: 13, jump: 0 },
    fightReady: { start: 420, count: 10, jump: 0 },
    punch: { start: 429, count: 2, jump: 0 },
    kick: { start: 431, count: 6, jump: 0 },
    punchHit1: { start: 437, count: 2, jump: 0 },
    punchHit2: { start: 439, count: 4, jump: 0 },
    punchDeath: { start: 443, count: 4, jump: 0 },
    kickHit1: { start: 447, count: 2, jump: 0 },
    kickHit2: { start: 449, count: 4, jump: 0 },
    kickDeath: { start: 453, count: 5, jump: 0 },
    readyWeapon: { start: 458, count: 5, jump: 0 },
    gunDeath: { start: 510, count: 8, jump: 0 },
    explosionDeath: { start: 526, count: 8, jump: 0 },
    explosion2Death: { start: 526, count: 8, jump: 0 },
    grenadeDeath: { start: 534, count: 12, jump: 0 },
    fireDeath: { start: 546, count: 18, jump: 0 },
    gesture1: { start: 564, count: 3, jump: 3 },
    salute1: { start: 588, count: 3, jump: 3 },
    gesture2: { start: 612, count: 3, jump: 3 },
    salute2: { start: 636, count: 3, jump: 3 },
    pullGun: { start: 0, count: 1, jump: 1 },
    plead: { start: 0, count: 1, jump: 1 },
    pleadDeath: { start: 0, count: 1, jump: 1 },
  },   // GrenadierDos
  e3: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 8, count: 1, jump: 1 },
    prone: { start: 192, count: 1, jump: 10 },
    walk: { start: 16, count: 6, jump: 6 },
    fire: { start: 64, count: 8, jump: 8 },
    lieDown: { start: 128, count: 2, jump: 2 },
    crawl: { start: 144, count: 4, jump: 4 },
    getUp: { start: 176, count: 2, jump: 2 },
    fireProne: { start: 192, count: 10, jump: 10 },
    idle1: { start: 272, count: 16, jump: 0 },
    idle2: { start: 288, count: 16, jump: 0 },
    onGuard: { start: 304, count: 13, jump: 0 },
    fightReady: { start: 308, count: 10, jump: 0 },
    punch: { start: 307, count: 2, jump: 0 },
    kick: { start: 319, count: 6, jump: 0 },
    punchHit1: { start: 325, count: 2, jump: 0 },
    punchHit2: { start: 327, count: 4, jump: 0 },
    punchDeath: { start: 331, count: 4, jump: 0 },
    kickHit1: { start: 335, count: 2, jump: 0 },
    kickHit2: { start: 337, count: 4, jump: 0 },
    kickDeath: { start: 341, count: 5, jump: 0 },
    readyWeapon: { start: 346, count: 5, jump: 0 },
    gunDeath: { start: 398, count: 8, jump: 0 },
    explosionDeath: { start: 414, count: 8, jump: 0 },
    explosion2Death: { start: 414, count: 8, jump: 0 },
    grenadeDeath: { start: 422, count: 12, jump: 0 },
    fireDeath: { start: 434, count: 18, jump: 0 },
    gesture1: { start: 452, count: 3, jump: 3 },
    salute1: { start: 476, count: 3, jump: 3 },
    gesture2: { start: 500, count: 3, jump: 3 },
    salute2: { start: 524, count: 3, jump: 3 },
    pullGun: { start: 0, count: 1, jump: 1 },
    plead: { start: 0, count: 1, jump: 1 },
    pleadDeath: { start: 0, count: 1, jump: 1 },
  },   // BazookaDos
  e4: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 8, count: 1, jump: 1 },
    prone: { start: 256, count: 1, jump: 16 },
    walk: { start: 16, count: 6, jump: 6 },
    fire: { start: 64, count: 16, jump: 16 },
    lieDown: { start: 192, count: 2, jump: 2 },
    crawl: { start: 208, count: 4, jump: 4 },
    getUp: { start: 240, count: 2, jump: 2 },
    fireProne: { start: 256, count: 16, jump: 16 },
    idle1: { start: 384, count: 16, jump: 0 },
    idle2: { start: 400, count: 16, jump: 0 },
    onGuard: { start: 416, count: 13, jump: 0 },
    fightReady: { start: 420, count: 10, jump: 0 },
    punch: { start: 429, count: 2, jump: 0 },
    kick: { start: 431, count: 6, jump: 0 },
    punchHit1: { start: 437, count: 2, jump: 0 },
    punchHit2: { start: 439, count: 4, jump: 0 },
    punchDeath: { start: 443, count: 4, jump: 0 },
    kickHit1: { start: 447, count: 2, jump: 0 },
    kickHit2: { start: 449, count: 4, jump: 0 },
    kickDeath: { start: 453, count: 5, jump: 0 },
    readyWeapon: { start: 458, count: 5, jump: 0 },
    gunDeath: { start: 510, count: 8, jump: 0 },
    explosionDeath: { start: 526, count: 8, jump: 0 },
    explosion2Death: { start: 526, count: 8, jump: 0 },
    grenadeDeath: { start: 534, count: 12, jump: 0 },
    fireDeath: { start: 546, count: 18, jump: 0 },
    gesture1: { start: 564, count: 3, jump: 3 },
    salute1: { start: 588, count: 3, jump: 3 },
    gesture2: { start: 612, count: 3, jump: 3 },
    salute2: { start: 636, count: 3, jump: 3 },
    pullGun: { start: 0, count: 1, jump: 1 },
    plead: { start: 0, count: 1, jump: 1 },
    pleadDeath: { start: 0, count: 1, jump: 1 },
  },   // FlamethrowerDos
  e6: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 8, count: 1, jump: 1 },
    prone: { start: 82, count: 1, jump: 4 },
    walk: { start: 16, count: 6, jump: 6 },
    fire: { start: 0, count: 0, jump: 0 },
    lieDown: { start: 67, count: 2, jump: 2 },
    crawl: { start: 82, count: 4, jump: 4 },
    getUp: { start: 114, count: 2, jump: 2 },
    fireProne: { start: 0, count: 0, jump: 0 },
    idle1: { start: 130, count: 16, jump: 0 },
    idle2: { start: 0, count: 0, jump: 0 },
    onGuard: { start: 0, count: 0, jump: 0 },
    fightReady: { start: 0, count: 0, jump: 0 },
    punch: { start: 0, count: 0, jump: 0 },
    kick: { start: 0, count: 0, jump: 0 },
    punchHit1: { start: 0, count: 0, jump: 0 },
    punchHit2: { start: 0, count: 0, jump: 0 },
    punchDeath: { start: 0, count: 0, jump: 0 },
    kickHit1: { start: 0, count: 0, jump: 0 },
    kickHit2: { start: 0, count: 0, jump: 0 },
    kickDeath: { start: 0, count: 0, jump: 0 },
    readyWeapon: { start: 0, count: 0, jump: 0 },
    gunDeath: { start: 146, count: 8, jump: 0 },
    explosionDeath: { start: 154, count: 8, jump: 0 },
    explosion2Death: { start: 162, count: 8, jump: 0 },
    grenadeDeath: { start: 170, count: 12, jump: 0 },
    fireDeath: { start: 182, count: 18, jump: 0 },
    gesture1: { start: 200, count: 3, jump: 3 },
    salute1: { start: 224, count: 3, jump: 3 },
    gesture2: { start: 200, count: 3, jump: 3 },
    salute2: { start: 224, count: 3, jump: 3 },
    pullGun: { start: 0, count: 1, jump: 1 },
    plead: { start: 0, count: 1, jump: 1 },
    pleadDeath: { start: 0, count: 1, jump: 1 },
  },   // EngineerDos
  c1: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 0, count: 1, jump: 1 },
    prone: { start: 0, count: 1, jump: 1 },
    walk: { start: 56, count: 6, jump: 6 },
    fire: { start: 205, count: 4, jump: 4 },
    lieDown: { start: 0, count: 1, jump: 1 },
    crawl: { start: 8, count: 6, jump: 6 },
    getUp: { start: 0, count: 1, jump: 1 },
    fireProne: { start: 0, count: 0, jump: 0 },
    idle1: { start: 104, count: 16, jump: 0 },
    idle2: { start: 120, count: 20, jump: 0 },
    onGuard: { start: 0, count: 0, jump: 0 },
    fightReady: { start: 0, count: 0, jump: 0 },
    punch: { start: 0, count: 0, jump: 0 },
    kick: { start: 0, count: 0, jump: 0 },
    punchHit1: { start: 0, count: 0, jump: 0 },
    punchHit2: { start: 0, count: 0, jump: 0 },
    punchDeath: { start: 0, count: 0, jump: 0 },
    kickHit1: { start: 0, count: 0, jump: 0 },
    kickHit2: { start: 0, count: 0, jump: 0 },
    kickDeath: { start: 0, count: 0, jump: 0 },
    readyWeapon: { start: 0, count: 0, jump: 0 },
    gunDeath: { start: 212, count: 8, jump: 0 },
    explosionDeath: { start: 220, count: 8, jump: 0 },
    explosion2Death: { start: 228, count: 12, jump: 0 },
    grenadeDeath: { start: 228, count: 12, jump: 0 },
    fireDeath: { start: 240, count: 18, jump: 0 },
    gesture1: { start: 0, count: 0, jump: 0 },
    salute1: { start: 0, count: 0, jump: 0 },
    gesture2: { start: 0, count: 0, jump: 0 },
    salute2: { start: 0, count: 0, jump: 0 },
    pullGun: { start: 0, count: 0, jump: 0 },
    plead: { start: 120, count: 31, jump: 0 },
    pleadDeath: { start: 151, count: 14, jump: 0 },
  },   // MoebiusDos
  c7: {
    ready: { start: 0, count: 1, jump: 1 },
    guard: { start: 0, count: 1, jump: 1 },
    prone: { start: 0, count: 1, jump: 1 },
    walk: { start: 56, count: 6, jump: 6 },
    fire: { start: 205, count: 4, jump: 4 },
    lieDown: { start: 0, count: 1, jump: 1 },
    crawl: { start: 8, count: 6, jump: 6 },
    getUp: { start: 0, count: 1, jump: 1 },
    fireProne: { start: 205, count: 4, jump: 4 },
    idle1: { start: 189, count: 10, jump: 0 },
    idle2: { start: 199, count: 6, jump: 0 },
    onGuard: { start: 104, count: 3, jump: 0 },
    fightReady: { start: 107, count: 7, jump: 0 },
    punch: { start: 114, count: 2, jump: 0 },
    kick: { start: 116, count: 6, jump: 0 },
    punchHit1: { start: 122, count: 2, jump: 0 },
    punchHit2: { start: 124, count: 4, jump: 0 },
    punchDeath: { start: 128, count: 4, jump: 0 },
    kickHit1: { start: 133, count: 2, jump: 0 },
    kickHit2: { start: 135, count: 4, jump: 0 },
    kickDeath: { start: 139, count: 5, jump: 0 },
    readyWeapon: { start: 144, count: 3, jump: 0 },
    gunDeath: { start: 329, count: 8, jump: 0 },
    explosionDeath: { start: 337, count: 8, jump: 0 },
    explosion2Death: { start: 337, count: 8, jump: 0 },
    grenadeDeath: { start: 345, count: 12, jump: 0 },
    fireDeath: { start: 357, count: 18, jump: 0 },
    gesture1: { start: 0, count: 0, jump: 0 },
    salute1: { start: 0, count: 0, jump: 0 },
    gesture2: { start: 0, count: 0, jump: 0 },
    salute2: { start: 0, count: 0, jump: 0 },
    pullGun: { start: 199, count: 6, jump: 0 },
    plead: { start: 237, count: 40, jump: 0 },
    pleadDeath: { start: 277, count: 6, jump: 0 },
  },   // DelphiDos
};

/**
 * The frame of the firing sequence at which the round leaves the weapon.
 *
 * IDATA.CPP calls this FireLaunch. It is what ties the animation to the
 * recording: the only direct evidence of a shot is the muzzle flash, and the
 * flash *is* this frame rather than the first one. A Minigunner is two frames
 * into its eight when it fires; a Grenadier is fourteen into its twenty, so a
 * sequence begun at the flash would drop the entire wind-up of the throw.
 */
export const FIRE_LAUNCH: Readonly<Record<string, number>> = {
  e1: 2, e2: 14, e3: 3, e4: 2, e6: 3, c1: 2, c7: 2,
};

/**
 * How many of the game's own 30Hz ticks each sequence holds a frame for.
 *
 * `InfantryClass::MasterDoControls` in INFANTRY.CPP, shared by every infantry
 * type — only the frame ranges differ per type, not the speed they run at.
 * The recordings agree: a walk frame lasts a measured median of 66ms against
 * the 67ms this implies, and a firing frame 37ms against 33ms.
 *
 * Generated by scripts/dump-infantry-dos.mjs; do not hand-edit.
 */
/**
 * Frames per game frame for each sequence, from InfantryClass::MasterDoControls
 * (INFANTRY.CPP). Zero means the pose does not animate.
 */
export const DO_RATE: Readonly<Record<DoName, number>> = {
  ready: 0,
  guard: 0,
  prone: 0,
  walk: 2,
  fire: 1,
  lieDown: 2,
  crawl: 2,
  getUp: 3,
  fireProne: 1,
  idle1: 2,
  idle2: 2,
  onGuard: 2,
  fightReady: 2,
  punch: 2,
  kick: 2,
  punchHit1: 2,
  punchHit2: 2,
  punchDeath: 1,
  kickHit1: 2,
  kickHit2: 2,
  kickDeath: 1,
  readyWeapon: 2,
  gunDeath: 2,
  explosionDeath: 2,
  explosion2Death: 2,
  grenadeDeath: 2,
  fireDeath: 2,
  gesture1: 2,
  salute1: 2,
  gesture2: 2,
  salute2: 2,
  pullGun: 2,
  plead: 2,
  pleadDeath: 2,
};

/**
 * The rest of what MasterDoControls says about a sequence:
 *
 *  - interruptable: another order can cut it short
 *  - mobile:        the man covers ground while it plays (walk, crawl, lie down)
 *  - randomStart:   it begins on a random frame, so a squad does not march in step
 */
export const DO_FLAGS: Readonly<Record<DoName, { interruptable: boolean; mobile: boolean; randomStart: boolean }>> = {
  ready: { interruptable: true, mobile: false, randomStart: false },
  guard: { interruptable: true, mobile: false, randomStart: false },
  prone: { interruptable: true, mobile: false, randomStart: false },
  walk: { interruptable: true, mobile: true, randomStart: true },
  fire: { interruptable: true, mobile: false, randomStart: false },
  lieDown: { interruptable: false, mobile: true, randomStart: false },
  crawl: { interruptable: true, mobile: true, randomStart: true },
  getUp: { interruptable: false, mobile: false, randomStart: false },
  fireProne: { interruptable: true, mobile: false, randomStart: false },
  idle1: { interruptable: true, mobile: false, randomStart: false },
  idle2: { interruptable: true, mobile: false, randomStart: false },
  onGuard: { interruptable: false, mobile: false, randomStart: false },
  fightReady: { interruptable: true, mobile: false, randomStart: false },
  punch: { interruptable: false, mobile: false, randomStart: false },
  kick: { interruptable: false, mobile: false, randomStart: false },
  punchHit1: { interruptable: false, mobile: false, randomStart: false },
  punchHit2: { interruptable: false, mobile: false, randomStart: false },
  punchDeath: { interruptable: false, mobile: false, randomStart: false },
  kickHit1: { interruptable: false, mobile: false, randomStart: false },
  kickHit2: { interruptable: false, mobile: false, randomStart: false },
  kickDeath: { interruptable: false, mobile: false, randomStart: false },
  readyWeapon: { interruptable: false, mobile: false, randomStart: false },
  gunDeath: { interruptable: false, mobile: false, randomStart: false },
  explosionDeath: { interruptable: false, mobile: false, randomStart: false },
  explosion2Death: { interruptable: false, mobile: false, randomStart: false },
  grenadeDeath: { interruptable: false, mobile: false, randomStart: false },
  fireDeath: { interruptable: false, mobile: false, randomStart: false },
  gesture1: { interruptable: false, mobile: false, randomStart: false },
  salute1: { interruptable: false, mobile: false, randomStart: false },
  gesture2: { interruptable: false, mobile: false, randomStart: false },
  salute2: { interruptable: false, mobile: false, randomStart: false },
  pullGun: { interruptable: true, mobile: false, randomStart: false },
  plead: { interruptable: true, mobile: false, randomStart: false },
  pleadDeath: { interruptable: true, mobile: false, randomStart: false },
};

/**
 * Game animation frames per simulation tick.
 *
 * Not a whole number: the game's frame is {@link GAME_FRAME_MS} and this
 * simulation's tick is a fifteenth of a second, so three of them to a tick and
 * a little over. It was taken as a flat 2 — a 30Hz game — which ran every
 * animation in the project at two thirds of its speed.
 */
export const GAME_FRAMES_PER_TICK = TICK_MS / GAME_FRAME_MS;

/**
 * How long the walk pose is held after a unit stops, in simulation ticks.
 *
 * `InfantryClass::Draw_It` keeps it for two game frames while the unit still
 * has a path. The Remastered added that in 2019 and gives the reason in the
 * source: without it, a unit pausing on its way through a waypoint flashes
 * the stand pose for a single frame.
 */
const STAND_HOLD_TICKS = 2 / GAME_FRAMES_PER_TICK;

/**
 * How often a soldier standing guard decides what to do with himself, in
 * simulation ticks.
 *
 * FootClass::Mission_Guard runs again after `TICKS_PER_SECOND +
 * Random_Picky(0, 4)` game frames — seventeen on average — and each time,
 * with no enemy near, calls InfantryClass::Random_Animate. At the shipped
 * game's pace that is a little under three times a second.
 */
const FIDGET_SLOT_TICKS = 17 / GAME_FRAMES_PER_TICK;

/**
 * Random_Animate's roll: Random_Picky(0, 55), and what each number does
 * (INFANTRY.CPP:1964). The rest of the numbers do nothing, and 0, 3 and 4
 * turn him to look somewhere else — which is left out here, because the
 * recording says which way he faces and a guessed glance would only be
 * contradicted by the next reading.
 */
const FIDGET_ROLL: Readonly<Record<number, FidgetName>> = {
  1: "idle1", 2: "idle2", 10: "salute1", 11: "salute2", 12: "gesture1", 13: "gesture2",
};

/** A number from `seed` and `slot` that looks random and is the same every time. */
function fidgetRoll(seed: number, slot: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(slot | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  // Unsigned before the modulo: the XOR comes back signed, and a negative
  // remainder never lands on a fidget, which halved every one of them.
  return ((h ^ (h >>> 16)) >>> 0) % 56;
}

/**
 * The fidget a standing soldier is in the middle of at `tick`, if any.
 *
 * The recording catches these — 104 of 8,228 Minigunner frames across three
 * matches were idles, salutes or gestures — but a soldier standing still is
 * restated rarely, and a fidget is caught in one reading at most, so almost
 * all of them fall between readings. They are rolled here the way the game
 * rolls them: the same odds, the same cadence, one roll at a time, and none
 * while one is already playing. Seeded by the soldier, so a replay watched
 * twice fidgets the same way twice.
 *
 * `standingSince` is when he last stopped, and `readAt` the tick of his last
 * reading: nothing is rolled before either, so a fidget never starts while he
 * was walking, and never contradicts a frame the recording gave.
 */
export function fidgetAt(
  kind: string,
  seed: number,
  tick: number,
  standingSince: number,
  readAt: number,
): { name: FidgetName; seq: DoSequence; stage: number } | null {
  const dos = INFANTRY_DOS[kind];
  if (!dos) return null;
  const from = Math.max(standingSince, readAt);
  const first = Math.ceil(from / FIDGET_SLOT_TICKS);
  const last = Math.floor(tick / FIDGET_SLOT_TICKS);
  // A roll only happens while he is standing, so one fidget has to finish
  // before the next can start: walk the slots forward and keep the one
  // playing now.
  let busyUntil = -Infinity;
  let playing: { name: FidgetName; seq: DoSequence; start: number } | null = null;
  // The longest fidget runs about two slots; nothing older can still be on.
  for (let slot = Math.max(first, last - 8); slot <= last; slot++) {
    const start = slot * FIDGET_SLOT_TICKS;
    if (start < busyUntil) continue;
    const name = FIDGET_ROLL[fidgetRoll(seed, slot)];
    const seq = name ? dos[name] : undefined;
    if (!name || !seq || seq.count === 0) continue;
    busyUntil = start + (seq.count * DO_RATE[name]) / GAME_FRAMES_PER_TICK;
    playing = { name, seq, start };
  }
  if (!playing || tick >= busyUntil) return null;
  const stage = Math.floor(((tick - playing.start) * GAME_FRAMES_PER_TICK) / DO_RATE[playing.name]);
  return stage < playing.seq.count ? { name: playing.name, seq: playing.seq, stage } : null;
}

/**
 * The order sequences are searched when reading a recorded frame.
 *
 * Every pose the game ships, not a chosen few. A frame that matches none of
 * these decodes as nothing and the man is drawn standing instead, so leaving a
 * sequence out of this list removes it from the screen however complete the
 * frame table is: on-guard, fight-ready, ready-weapon, the punch and kick set
 * and the civilian plead set were all in the art and none of them could ever
 * be read back.
 *
 * Order settles the overlaps the game data itself contains -- fireProne starts
 * on the same frame as prone, and on-guard and fight-ready share frames 292 to
 * 300 -- by asking for the more specific sequence first.
 */
const DO_SEARCH: readonly DoName[] = [
  "walk", "fire", "crawl", "lieDown", "getUp", "fireProne", "prone",
  "readyWeapon", "onGuard", "fightReady",
  "punch", "kick", "punchHit1", "punchHit2", "punchDeath",
  "kickHit1", "kickHit2", "kickDeath",
  "pullGun", "plead", "pleadDeath",
  "guard", "ready",
  ...FIDGETS,
];

/**
 * Where a recorded frame sits in its type's table: which sequence it belongs
 * to, the facing it was drawn at, and how far through the sequence it is.
 */
/** Which death a recorded frame belongs to, and how far into it. Null for any other frame. */
export function readInfantryDeath(kind: string, shape: number): { death: DeathName; stage: number } | null {
  const dos = INFANTRY_DOS[kind];
  if (!dos) return null;
  for (const death of DEATHS) {
    const seq = dos[death];
    if (seq.count > 0 && shape >= seq.start && shape < seq.start + seq.count) return { death, stage: shape - seq.start };
  }
  return null;
}

/** How long a death plays, in simulation ticks. Zero for a type without it. */
export function deathTicks(kind: string, death: DeathName): number {
  const seq = INFANTRY_DOS[kind]?.[death];
  if (!seq || seq.count === 0) return 0;
  return (seq.count * DO_RATE[death]) / GAME_FRAMES_PER_TICK;
}

export function readInfantryFrame(
  kind: string,
  shape: number,
): { name: DoName; seq: DoSequence; facing: number; stage: number } | null {
  const dos = INFANTRY_DOS[kind];
  if (!dos) return null;
  for (const name of DO_SEARCH) {
    const seq = dos[name];
    if (!seq || seq.count === 0) continue;
    /*
     * A sequence that is really the stand pose wearing another name.
     *
     * The game writes "this type has not got one" as a row pointing at frame 0
     * with a count of 1 — DO_PULL_GUN, DO_PLEAD and DO_PLEAD_DEATH all read
     * that way for every soldier, since only civilians have them. Searched
     * ahead of DO_STAND_READY they swallow it, and 17.5% of infantry frames
     * came back as a Minigunner pulling a gun he does not own.
     */
    if (name !== "ready" && seq.start === dos.ready.start && seq.count === dos.ready.count) continue;
    const span = seq.jump > 0 ? INFANTRY_FACINGS * seq.jump : seq.count;
    if (shape < seq.start || shape >= seq.start + span) continue;
    const off = shape - seq.start;
    if (seq.jump <= 0) return { name, seq, facing: 0, stage: off };
    return { name, seq, facing: Math.floor(off / seq.jump), stage: off % seq.jump };
  }
  return null;
}

/**
 * The flame files' directions, clockwise from north — the order an eight-point
 * heading indexes into.
 */
export const FLAME_DIRS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

/**
 * Buildings drawn as two pictures, the first under the one in BLDG_FILE.
 *
 * The Weapons Factory: BuildingClass::Draw_It draws WEAP (the building with
 * its bottom -- ramp and floor -- and a hole where the roof goes), then WEAP2
 * over it at the same place: the roof and the door it animates (Door_Stage,
 * +10 when below half strength). Drawing WEAP2 alone left the bottom off.
 */
export const BLDG_UNDERLAY_FILE: Partial<Record<BldgKind, string>> = {
  weap: "weap",
};

export interface SpriteBank {
  units: Partial<Record<UnitKind, ShpFile>>;
  buildings: Partial<Record<BldgKind, ShpFile>>;
  /** BLDG_UNDERLAY_FILE's pictures, by building. */
  underlays: Partial<Record<BldgKind, ShpFile>>;
  buildUp: Partial<Record<BldgKind, ShpFile>>;
  fx: { explosion: ShpFile | null; muzzle: ShpFile | null; cargoPlane: ShpFile | null; select: ShpFile | null; rotorL: ShpFile | null; rotorR: ShpFile | null };
  /**
   * The dirt apron a structure sits on, keyed by theater and then by how many
   * cells wide the building is.
   *
   * BuildingTypeClass::Bib_And_Offset picks it by width — 2 wide takes BIB3, 3
   * takes BIB2, 4 takes BIB1 — and only when the type wants one. The art is
   * theater art, so it carries a theater extension rather than .SHP and there
   * is a separate file per theater.
   */
  bibs: Partial<Record<Theater, Partial<Record<number, ShpFile>>>>;
  /**
   * The game's own art for each recorded combat effect, keyed by the name the
   * replay uses. These are the real files — minigun.shp, piff.shp, 120mm.shp —
   * so a recorded shot is drawn with the sprite the shot actually had.
   */
  effects: Partial<Record<CombatEffect, ShpFile>>;

  /**
   * The flame tongue, one file per direction (FLAME-N.SHP through FLAME-NW).
   *
   * A flamethrower's shot is not a bullet travelling: it is a cone drawn at the
   * nozzle, and the game ships eight of them because the cone has to point
   * somewhere. All eight were sitting in the assets unreferenced while the
   * viewer drew an orange line for the shot instead.
   */
  flames: (ShpFile | null)[];
}

export interface SpriteRef {
  pixels: Uint8Array;
  w: number;
  h: number;
  /** Sprite source id + frame index; use these to key render caches. */
  src: string;
  index: number;
}

async function loadShp(name: string): Promise<ShpFile | null> {
  try {
    return decodeShp(await fetchShpBytes(name));
  } catch {
    return null;
  }
}

let cached: Promise<SpriteBank> | null = null;

export function getSpriteBank(): Promise<SpriteBank> {
  if (cached) return cached;
  cached = (async () => {
    const units: Partial<Record<UnitKind, ShpFile>> = {};
    const buildings: Partial<Record<BldgKind, ShpFile>> = {};
    const buildUp: Partial<Record<BldgKind, ShpFile>> = {};

    await Promise.all(
      (Object.keys(UNIT_FILE) as UnitKind[]).map(async (k) => {
        const shp = await loadShp(UNIT_FILE[k]);
        if (shp) units[k] = shp;
      }),
    );

    await Promise.all(
      (Object.keys(BLDG_FILE) as BldgKind[]).map(async (k) => {
        const shp = await loadShp(BLDG_FILE[k]);
        if (shp) buildings[k] = shp;
        const makeName = BLDG_MAKE_FILE[k];
        const make = makeName ? await loadShp(makeName) : null;
        const fallback = make ?? shp;
        if (fallback) buildUp[k] = fallback;
      }),
    );

    const underlays: Partial<Record<BldgKind, ShpFile>> = {};
    await Promise.all(
      (Object.keys(BLDG_UNDERLAY_FILE) as BldgKind[]).map(async (k) => {
        const shp = await loadShp(BLDG_UNDERLAY_FILE[k]!);
        if (shp) underlays[k] = shp;
      }),
    );

    const bibs: Partial<Record<Theater, Partial<Record<number, ShpFile>>>> = {};
    await Promise.all(
      (["desert", "temperat", "winter"] as const).flatMap((theater) =>
        // BIB1 is the widest, so the file number runs opposite to the width.
        ([[4, 1], [3, 2], [2, 3]] as const).map(async ([width, file]) => {
          const shp = await loadShp(`bib${file}-${theater}`);
          if (!shp) return;
          (bibs[theater] ??= {})[width] = shp;
        }),
      ),
    );

    const [explosion, muzzle, cargoPlane, select, rotorL, rotorR] = await Promise.all([
      loadShp("art-exp1"),
      loadShp("piff"),
      loadShp("c17"), // Nod airstrip cargo plane
      loadShp("select"), // selection boxes and the repair wrench
      loadShp("lrotor"), // helicopter blades: the Chinook's rear rotor
      loadShp("rrotor"), // and the Apache's, and the Chinook's front one
    ]);

    const effects: Partial<Record<CombatEffect, ShpFile>> = {};
    await Promise.all(
      COMBAT_EFFECTS.map(async (name) => {
        const shp = await loadShp(name.toLowerCase());
        if (shp) effects[name] = shp;
      }),
    );
    // In the compass order FLAME_DIRS gives, so a heading indexes straight in.
    const flames = await Promise.all(FLAME_DIRS.map((d) => loadShp("flame-" + d)));
    return {
      units, buildings, underlays, buildUp, bibs, flames,
      fx: { explosion, muzzle, cargoPlane, select, rotorL, rotorR }, effects,
    } satisfies SpriteBank;
  })();
  return cached;
}

export interface BuildingLayout {
  /** Frames per state (length of one idle-animation cycle). */
  anim: number;
  /** First frame of the healthy state. */
  healthy: number;
  /** First frame of the damaged state. */
  damaged: number;
  /** Destroyed-rubble frame, or -1 when the file carries none. */
  rubble: number;
}

/** Split a structure SHP into healthy / damaged / rubble frame ranges. */
export function buildingLayout(shp: ShpFile): BuildingLayout {
  const n = shp.frames.length;
  if (n >= 3 && n % 2 === 1) {
    const k = (n - 1) / 2;
    return { anim: k, healthy: 0, damaged: k, rubble: 2 * k };
  }
  if (n >= 2) {
    const k = n >> 1;
    return { anim: k, healthy: 0, damaged: k, rubble: -1 };
  }
  return { anim: 1, healthy: 0, damaged: 0, rubble: -1 };
}

/**
 * `src` and `index` identify the exact frame returned.
 *
 * Callers cache rendered canvases, and the cache key has to be derived from
 * the frame actually chosen. Reconstructing the key at the call site means
 * re-deriving the animation logic there, and getting it slightly wrong
 * pins a building to one frame forever — which is what stopped the radar
 * dishes turning even though this function was returning new frames.
 */
function frameAt(shp: ShpFile, idx: number, src: string): SpriteRef | null {
  const n = shp.frames.length;
  if (n === 0) return null;
  const i = Math.max(0, Math.min(n - 1, idx));
  const fr = shp.frames[i]!;
  return { pixels: fr.pixels, w: fr.w, h: fr.h, src, index: i };
}

export interface FrameQuery {
  /** Body/hull facing, in the entity's own facing resolution. */
  facing: number;
  /**
   * The frame the game drew this unit with right now, when the recording has
   * every one. Drawn as it is, ahead of any modelled pose.
   */
  exact?: number;
  /** True once HP has dropped below the damage threshold. */
  damaged: boolean;
  /** Construction progress, 0..1; values < 1 play the build-up sequence. */
  build: number;
  /**
   * Ticks since a sale began, when this building is being sold. Absent for
   * everything else. The sale plays the build-up backwards; see buildingFrame.
   */
  selling?: number;
  /**
   * The engine's own animation state, for structures whose states are
   * modelled rather than guessed at from whether they look busy.
   *
   * Only the Refinery so far: its unload is four states in order, not one
   * long loop. Anything that leaves this unset falls back to {@link active}
   * and {@link full}.
   */
  bstate?: BState;
  /** Ticks since {@link bstate} was entered, which its animation is phased on. */
  stateAge?: number;
  /**
   * Simulation tick, used to advance idle/walk animation.
   *
   * Fractional between ticks, because the game's animation rates are finer
   * than this simulation's step: a delay of one game tick is two frames per
   * tick here, and rounding down would show only every other one.
   */
  tick: number;
  /** True while the entity is moving (drives the infantry walk cycle). */
  moving: boolean;
  /** True while the entity is shooting (drives the infantry firing cycle). */
  firing?: boolean;
  /**
   * The sprite frame the replay recorded. When present it is drawn as-is and
   * every field above is ignored: the recording already says which frame the
   * game drew, so choosing one from facing and movement can only differ from
   * it.
   */
  shape?: number;
  /**
   * Which frame of the firing sequence to draw, if this unit is shooting.
   *
   * Counted from the start of the sequence, so it is the type's own table that
   * turns it into a frame. Absent means not firing.
   */
  fireStage?: number;
  /**
   * Something that tells this unit from every other, for the dice it rolls
   * when it fidgets: the same soldier fidgets the same way on every viewing.
   */
  seed?: number;
  /**
   * Whether this unit is between two recorded sprite frames with a turn to
   * make. The heading then comes from the body rather than from the frame:
   * see the recorded branch of unitFrame.
   */
  turning?: boolean;
  /** The death being played, and ticks since it began, fractional. */
  death?: DeathName;
  deathAge?: number;
  /**
   * Ticks since {@link shape} was recorded, fractional.
   *
   * What lets a walk cycle carry on between readings rather than freezing on
   * the last one the stream happened to restate.
   */
  shapeAge?: number;
  /**
   * Whether the entity actually changed place this tick.
   *
   * Gates the walk cycle: a unit that has stopped but whose last recorded
   * frame was mid-stride must not keep marching.
   */
  advancing?: boolean;
  /**
   * Ticks the entity has stood still, which is what lets a walk pose end.
   *
   * The engine drops a unit into its stand pose the moment it stops driving,
   * holding the walk for two frames first so a pause at a waypoint does not
   * flash it.
   */
  stillTicks?: number;
  /** Harvester only: true while it is actually collecting Tiberium. */
  harvesting?: boolean;
  /**
   * True while the structure is doing the thing its animation depicts —
   * producing, or (for a Refinery) unloading a docked harvester. Structures
   * in `active` mode hold frame 0 unless this is set.
   */
  active?: boolean;
  /**
   * Refinery only: a harvester is inbound but not yet docked, which makes
   * the real building flash its lights (BSTATE_FULL).
   */
  full?: boolean;
  /** Ticks since construction finished, for the build-up hand-off. */
  age?: number;
  /** Ticks since the current one-shot activity started (crane swing). */
  activityAge?: number;
  /** True once the entity is destroyed (selects the rubble frame). */
  dead?: boolean;
}

export function spriteFrame(bank: SpriteBank, kind: EntityKind, q: FrameQuery): SpriteRef | null {
  if (isBuilding(kind)) return buildingFrame(bank, kind, q);
  return unitFrame(bank, kind as UnitKind, q);
}

function buildingFrame(bank: SpriteBank, kind: BldgKind, q: FrameQuery): SpriteRef | null {
  // Under construction: play the *MAKE sequence at its own natural rate and
  // hold on its last frame until construction actually finishes.
  //
  // Scaling the sequence to the build duration (frame = build * frameCount)
  // is what made the build-up stutter: construction rates differ per
  // structure and per game speed, so the animation was played back at an
  // arbitrary speed — sometimes several frames per tick, sometimes one
  // frame held for a second. The original plays it once, quickly, then
  // shows the finished building waiting for the timer.
  // Being sold: the same sequence, run the other way. The game sells a
  // building as MISSION_DECONSTRUCTION with BSTATE_CONSTRUCTION art, and
  // "the display frame progresses from the end to the beginning"
  // (BUILDING.CPP:516-525).
  if (q.selling != null) {
    const make = bank.buildUp[kind];
    if (make && make.frames.length > 0) {
      const rate = Math.max(1, Math.floor(MAKE_FRAMES / make.frames.length));
      const step = Math.floor((q.selling * GAME_FRAMES_PER_TICK) / rate);
      const last = make.frames.length - 1;
      return frameAt(make, Math.max(0, last - Math.min(last, step)), kind + ":make");
    }
  }

  if (q.build < 1) {
    const make = bank.buildUp[kind];
    if (make && make.frames.length > 0) {
// The game derives the rate from the frame count rather than the build
      // cost, and truncates:
      //   timedelay = (5 * TICKS_PER_SECOND) / count   (BDATA.CPP)
      // so the sequence runs in whole game frames, not in ticks.
      const rate = Math.max(1, Math.floor(MAKE_FRAMES / make.frames.length));
      const step = Math.floor(((q.age ?? 0) * GAME_FRAMES_PER_TICK) / rate);
      return frameAt(make, Math.min(make.frames.length - 1, step), kind + ":make");
    }
  }

  const shp = bank.buildings[kind] ?? bank.buildUp[kind];
  if (!shp || shp.frames.length === 0) return null;
  const layout = buildingLayout(shp);
  const src = kind;

  // The frame the game drew, when the recording has it: the animation, the
  // damage and a turret's aim are all in it.
  if (!q.dead && q.exact != null && q.exact >= 0 && q.exact < shp.frames.length) return frameAt(shp, q.exact, src + ":exact");

  if (q.dead && layout.rubble >= 0) return frameAt(shp, layout.rubble, src);

  const base = q.damaged ? layout.damaged : layout.healthy;

  // Defensive turrets aim rather than animate.
  if (TURRET_BLDG.has(kind)) {
    const f = ((Math.round(q.facing) % VEHICLE_FACINGS) + VEHICLE_FACINGS) % VEHICLE_FACINGS;
    return frameAt(shp, base + f, src);
  }

  const spec = ANIM[kind];
  if (!spec) return frameAt(shp, base, src);

  // Pick the state the way the game does, then step its own range at its
  // own rate. `active` covers BSTATE_ACTIVE, `full` the refinery's
  // inbound-harvester lights; anything else rests on the idle loop.
  // A caller that knows the engine's state names it; the rest fall back to
  // the two flags, which cover a structure that is either working or not.
  const named = q.bstate ? spec[q.bstate] : undefined;
  const range = named ?? ((q.active && spec.active) || (q.full && spec.full) || spec.idle);
  if (!range || range.count <= 1 || range.rate <= 0) {
    return frameAt(shp, base + (range?.start ?? 0), src);
  }
  const count = Math.max(1, Math.min(range.count, layout.anim - range.start));
  // The delay, as BUILDING.CPP sets it. `Begin_Mode` normalizes for regulated
  // types on entry, and the loop at the bottom of `BuildingClass::AI` — which
  // is the steady state for anything that keeps running — normalizes IDLE and
  // CONSTRUCTION whatever the type, leaving ACTIVE raw. Both are counted in
  // the game's own frames.
  const idling = range === spec.idle;
  const delay = Math.max(1, spec.regulated || idling ? normalizeDelay(range.rate) : range.rate);
  const frames = (t: number) => Math.floor((t * GAME_FRAMES_PER_TICK) / delay);
  // Phased from when this building entered the state, not from the global
  // clock. `Begin_Mode` ends with `Set_Stage(ctrl->Start)`, so a structure's
  // cycle starts where it was built — which is why no two power plants in the
  // real game blink together. Running every one of them off the same tick put
  // a whole base in lockstep.
  // Phased from when this building entered the state it is in.
  const since = q.bstate ? q.stateAge : range === spec.idle ? q.age : q.activityAge;
  const step = range.once
    ? Math.max(0, Math.min(count - 1, frames(Math.max(0, since ?? 0))))
    : frames(Math.max(0, since ?? 0)) % count;
  return frameAt(shp, base + range.start + step, src);
}

/**
 * Which pose an infantryman is in, and how far through it.
 *
 * One resolver for all thirty-four sequences rather than a special case each
 * for firing, fidgeting and walking — those three were the only ones that ever
 * animated, so a man caught lying down, getting up, crawling or readying his
 * weapon was drawn on whichever single frame the recording last carried and
 * held it until the next sighting, a median of ten ticks later.
 *
 * The order is InfantryClass's own. Death outranks everything; a sequence
 * already running finishes unless it is interruptable and something more
 * urgent has arrived; firing beats moving; moving beats standing; and when
 * nothing else applies the engine's fallback is
 * `IsDriving ? (IsProne ? DO_CRAWL : DO_WALK) : (IsProne ? DO_PRONE : DO_STAND_READY)`.
 *
 * Timing is each sequence's own rate from MasterDoControls, converted from the
 * game's frames to simulation ticks. A one-shot that has run out falls through
 * to whatever the man should be doing instead; a cycle wraps.
 */
interface InfantryPose { seq: DoSequence; stage: number; facing: number; why: string }

function infantryPose(
  kind: UnitKind,
  dos: Readonly<Record<DoName, DoSequence>>,
  q: FrameQuery,
  recorded: number | null,
): InfantryPose | null {
  const read = recorded != null ? readInfantryFrame(kind, recorded) : null;
  // The heading: the recorded frame's while it stands, the body's while it
  // walks. A walking man's last recorded frame can be the best part of a
  // second old -- he may have turned since -- while the body faces the way he
  // is going this tick.
  const walking = q.advancing === true;
  const facing = read && !q.turning && !walking ? read.facing : infantryFrameColumn(q.facing);
  const ticksPer = (name: DoName): number => DO_RATE[name] / GAME_FRAMES_PER_TICK;
  const stageOf = (name: DoName, from: number, age: number): number => {
    const rate = ticksPer(name);
    return rate > 0 ? from + Math.floor(age / rate) : from;
  };

  // 1. Dying. The game removes the body on the sequence's last frame.
  if (q.death) {
    const seq = dos[q.death];
    if (seq.count === 0) return null;
    const stage = stageOf(q.death, 0, q.deathAge ?? 0);
    if (stage >= seq.count) return null;
    return { seq, stage, facing, why: q.death };
  }

  // 2. Shooting, ahead of anything the recording caught him doing.
  //
  // A shot lasts about a quarter of a second and the stream restates an object
  // perhaps twice that slowly, so firing appears in 273 of 14,029 infantry
  // readings: the recording is almost never holding a firing frame when the
  // shot happens. It has to outrank the pose on file, or a soldier caught
  // mid-salute keeps saluting through the burst -- which is what putting this
  // second did.
  if (q.fireStage != null) {
    const kneeling = read?.name === "prone" || read?.name === "crawl" || read?.name === "fireProne";
    const name: DoName = kneeling && dos.fireProne.count > 0 ? "fireProne" : "fire";
    const seq = dos[name];
    if (seq.count > 0 && q.fireStage < seq.count) {
      return { seq, stage: q.fireStage, facing, why: name };
    }
  }

  // 3. A sequence the recording caught, carried on at its own rate.
  //
  // Everything except the poses that are a single frame (ready, guard, prone)
  // and the two cycles, which are handled below where movement is known.
  // Not once he is walking: a man caught mid-fidget who sets off walks, rather
  // than finishing his stretch while he slides along.
  if (!walking && read && read.seq.count > 1 && read.name !== "walk" && read.name !== "crawl") {
    const stage = stageOf(read.name, read.stage, q.shapeAge ?? 0);
    const looping = read.name === "idle1" || read.name === "idle2";
    if (stage < read.seq.count) {
      return { seq: read.seq, stage, facing, why: read.name };
    }
    if (looping && read.seq.count > 0) {
      // The idles are the one thing the engine leaves running: Random_Animate
      // picks another when the guard timer comes round again.
      return { seq: read.seq, stage: stage % read.seq.count, facing, why: read.name };
    }
    // Otherwise it has run out, and what he does next is decided below.
  }

  // 4. Moving: the walk, or the crawl when he is down.
  const prone = read?.name === "prone" || read?.name === "crawl" || read?.name === "fireProne";
  const cycleName: DoName = prone && dos.crawl.count > 0 ? "crawl" : "walk";
  const cycle = dos[cycleName];
  const moving = q.advancing === true || (q.advancing == null && q.moving === true);
  if (moving && cycle.count > 1) {
    // randomStart is set for both cycles in MasterDoControls, so a squad does
    // not march in step. The seed is the unit's, so its phase is its own and
    // stays the same from tick to tick.
    //
    // The stride runs on the clock, not from the last recorded frame. Picked up
    // again from each reading -- one every 0.7s or so -- it restarted wherever
    // that frame happened to be, and the step hitched: 5% of all the frames
    // infantry spent walking skipped ahead or went back.
    const phase = DO_FLAGS[cycleName].randomStart ? (q.seed ?? 0) % cycle.count : 0;
    const stage = stageOf(cycleName, phase, q.tick) % cycle.count;
    return { seq: cycle, stage, facing, why: cycleName };
  }

  // 5. Just stopped. InfantryClass::Draw_It keeps the walk pose for two game
  // frames while the man still has a path, so a pause at a waypoint does not
  // flash the stand pose for a single frame. Below that bar the recorded pose
  // stands as it was recorded, however stale the sighting.
  if (read && (q.stillTicks ?? 0) <= STAND_HOLD_TICKS) {
    return { seq: read.seq, stage: read.stage, facing, why: "hold" };
  }

  // 6. Standing still. Prone stays down; everyone else stands, and fidgets the
  // way Mission_Guard does when he has been still long enough.
  if (prone && dos.prone.count > 0) return { seq: dos.prone, stage: 0, facing, why: "prone" };
  if (!q.firing) {
    const readAt = q.tick - (q.shapeAge ?? 0);
    const fid = fidgetAt(kind, q.seed ?? 0, q.tick, q.tick - (q.stillTicks ?? 0), readAt);
    if (fid) return { seq: fid.seq, stage: fid.stage, facing, why: "fidget" };
  }
  const rest = dos.ready.count > 0 ? dos.ready : dos.guard;
  return { seq: rest, stage: 0, facing, why: "stand" };
}

function unitFrame(bank: SpriteBank, kind: UnitKind, q: FrameQuery): SpriteRef | null {
  const shp = bank.units[kind];
  if (!shp || shp.frames.length === 0) return null;
  const recorded = q.shape != null && q.shape >= 0 && q.shape < shp.frames.length ? q.shape : null;

  // Firing is drawn from the type's own table, ahead of the recorded frame.
  //
  // Not because the recording is wrong, but because it hardly ever catches
  // this: a shot runs about a quarter of a second while the stream restates an
  // object perhaps four times that slowly, so a firing frame appears in 273 of
  // 14,029 infantry readings. The rest of the time the recording's most recent
  // frame is the unit standing or walking, and drawing that is why infantry
  // stood at ease while their own muzzle flashes went off. The sequence, its
  // stride and its rate are all known exactly, so when the replay says this
  // unit is shooting the pose comes from the table.
  //
  // The heading still comes from the recording wherever it can: a recorded
  // frame carries the facing it was drawn at, whatever pose it is.
  const dos = INFANTRY_DOS[kind];
  if (dos && INFANTRY.has(kind)) {
    if (q.exact != null && q.exact >= 0 && q.exact < shp.frames.length && q.death == null) return frameAt(shp, q.exact, kind + ":exact");
    const pose = infantryPose(kind, dos, q, recorded);
    if (pose === null) return null;                       // dead and gone
    const idx = pose.seq.start + (pose.seq.jump > 0 ? pose.facing * pose.seq.jump : 0) + pose.stage;
    if (idx >= 0 && idx < shp.frames.length) return frameAt(shp, idx, kind + ":" + pose.why);
    if (recorded != null) return frameAt(shp, recorded, kind + ":rec");
    return frameAt(shp, pose.facing, kind);
  }
  // The frame the game drew this vehicle with, at this moment.
  if (q.exact != null && q.exact >= 0 && q.exact < shp.frames.length && q.death == null) return frameAt(shp, q.exact, kind + ":exact");
  if (recorded != null) return frameAt(shp, recorded, kind + ":rec");

  const facings = Math.min(VEHICLE_FACINGS, shp.frames.length);
  const f = vehicleFrameIndex(q.facing, facings);

  // A Harvester carries a second full set of 32 facings after the first, and
  // it is not a turret layer: those frames are the same directions with the
  // collection arms swung out and the scoop lowered. Measured, they average
  // 497 pixels of sprite against 510 for the driving frames, where a real
  // turret layer is tiny — a Jeep's and a Buggy's are both 9. Show them only
  // while it is actually collecting, which is when the original extends them.
  if (kind === "harv" && q.harvesting && shp.frames.length >= VEHICLE_FACINGS * 2) {
    return frameAt(shp, VEHICLE_FACINGS + f, kind + ":dig");
  }

  return frameAt(shp, f, kind);
}

/**
 * Frame index for a vehicle facing.
 *
 * **Vehicle sprites run counter-clockwise**, opposite to the engine's facing
 * count. North and south agree either way, which is what hid this: it is the
 * east/west halves that are swapped. Verified by eye on three sprites — a
 * Light Tank turret at facing 8 (east) has its barrel pointing *west*, and at
 * facing 24 (west) it points *east*; the Medium Tank turret and the Buggy body
 * do the same. The Harvester is the clearest case, since its scoop is
 * unmistakable: read clockwise it drives backwards, dragging the scoop.
 *
 * C17.SHP was already being indexed this way, described as running "opposite
 * to the vehicle sprites". It is not the exception — every vehicle does it,
 * and the plane was simply the one case where flying tail-first was obvious
 * enough to notice.
 */
function vehicleFrameIndex(facing: number, facings: number): number {
  // Facing is carried as a real number, because ROT turns a unit by a
  // fraction of a facing each tick; the frame is the nearest one to it.
  const cw = ((Math.round(facing) % facings) + facings) % facings;
  return (facings - cw) % facings;
}

/**
 * Independent turret overlay for dual-layer vehicles, or null when this
 * unit has no turret layer. The layer only exists when the file actually
 * carries >= 64 frames, so a unit definition claiming a turret it has no
 * art for (e.g. a 32-frame stealth tank) safely renders hull-only rather
 * than drawing unrelated animation frames on top of itself.
 */
export function turretFrame(
  bank: SpriteBank,
  kind: UnitKind,
  turretFacing: number,
  recordedShape?: number,
): SpriteRef | null {
  const def = UNIT_DEFS[kind];
  if (!def?.turret) return null;
  const shp = bank.units[kind];
  if (!shp || shp.frames.length < VEHICLE_FACINGS * 2) return null;
  // The turret is its own object in the stream and carries its own frame, so
  // when the replay recorded one it is drawn rather than derived.
  if (recordedShape != null && recordedShape >= 0 && recordedShape < shp.frames.length) {
    return frameAt(shp, recordedShape, kind + ":turret:rec");
  }
  const f = vehicleFrameIndex(turretFacing, VEHICLE_FACINGS);
  return frameAt(shp, VEHICLE_FACINGS + f, kind + ":turret");
}

/**
 * One of the 32 cargo-plane facings, for airstrip deliveries.
 *
 * Counter-clockwise, like every other vehicle sprite — see
 * {@link vehicleFrameIndex}. This one was noticed first only because a plane
 * flying tail-first is harder to miss than a tank whose barrel points the
 * wrong way along one axis.
 */
export function cargoPlaneFrame(bank: SpriteBank, facing: number): SpriteRef | null {
  const shp = bank.fx.cargoPlane;
  if (!shp || shp.frames.length === 0) return null;
  const n = Math.min(VEHICLE_FACINGS, shp.frames.length);
  return frameAt(shp, vehicleFrameIndex(facing, n), "c17");
}

/** The cargo plane in the frame the recording gives, when it gives one. */
export function cargoPlaneFrameAt(bank: SpriteBank, frame: number): SpriteRef | null {
  const shp = bank.fx.cargoPlane;
  if (!shp || shp.frames.length === 0) return null;
  return frameAt(shp, Math.max(0, Math.min(shp.frames.length - 1, frame)), "c17");
}

export type { ShpFile };

/**
 * Where a unit's turret is drawn, relative to the body's own centre.
 *
 * `UnitClass::Draw_It` starts the turret at the body's pixel and then moves it
 * for three cases. The Jeep and the Buggy lift it four pixels — their guns sit
 * on a roll bar above the cab, not on the hull. The rocket launchers run their
 * turret through `Turret_Adjust`, a 32-entry table walking the launcher around
 * the chassis as the *body* turns, so it stays over the bed rather than
 * pivoting about the centre. Everything else draws on the body's own pixel.
 *
 * The table is UNIT.CPP:222 verbatim. Its own comments label the entries
 * counter-clockwise — 4 as NW, 8 as W — and they are simply wrong: the offsets
 * put the launcher behind the cab, which only works if 8 is east. See
 * {@link adjustIndex}.
 */
const TURRET_ADJUST: readonly (readonly [number, number])[] = [
  [1, 2], [-1, 1], [-2, 0], [-3, 0], [-3, 1], [-4, -1], [-4, -1], [-5, -2],
  [-5, -3], [-5, -3], [-3, -3], [-3, -4], [-3, -4], [-3, -5], [-2, -5], [-1, -5],
  [0, -5], [1, -6], [2, -5], [3, -5], [4, -5], [6, -4], [6, -3], [6, -3],
  [6, -3], [5, -1], [5, -1], [5, -1], [4, 0], [3, 0], [2, 0], [2, 1],
];

/** Units whose turret rides four pixels above the hull. */
const TURRET_LIFTED = new Set(["jeep", "buggy"]);

/** Units whose turret walks around the chassis with the body's facing. */
const TURRET_WALKED = new Set(["mlrs", "msam"]);

/**
 * A facing as the adjust tables index themselves.
 *
 * These tables are read with `Facing_To_32(dir)` — `Facing32[]` in CONST.CPP,
 * which climbs 0..31 as the direction goes round, so 0 is north, 8 east, 16
 * south, 24 west. That is this engine's facing exactly. The mirror belongs to
 * the *sprite*, not to the facing: the game picks its shape as
 * `BodyShape[Facing_To_32(dir)]`, and `TechnoClass::BodyShape` (TECHNO.CPP:131)
 * is {0,31,30,...,1} — the same reversal {@link vehicleFrameIndex} applies.
 *
 * So a table indexed by `Facing_To_32` takes the facing straight, and putting
 * it through the shape mirror as well undoes itself. That is what was
 * happening to `Turret_Adjust`: north and south are their own mirror images
 * and looked right, while an east-facing rocket launcher had its launcher
 * drawn six pixels *in front of* the cab instead of five behind it.
 */
const adjustIndex = (facing: number): number => ((Math.round(facing) % 32) + 32) % 32;

/**
 * The turret's offset in pixels, given the body's facing.
 *
 * This is the mount only. A gun that has just fired also sits one pixel back
 * along its own heading, which {@link turretRecoil} gives.
 */
export function turretOffset(kind: string, bodyFacing: number): readonly [number, number] {
  if (TURRET_LIFTED.has(kind)) return [0, -4];
  if (TURRET_WALKED.has(kind)) return TURRET_ADJUST[adjustIndex(bodyFacing)]!;
  return [0, 0];
}

/**
 * How far a gun kicks when it fires, per facing.
 *
 * `Recoil_Adjust` (UNIT.CPP:156). The table is a unit circle rounded to whole
 * pixels — one pixel *backward* along the way the gun points — read through
 * {@link adjustIndex}, which is what makes it point backward: entry 0 is north
 * and holds {0,1}, a pixel down the screen.
 */
const RECOIL_ADJUST: readonly (readonly [number, number])[] = [
  [0, 1], [0, 1], [0, 1], [-1, 1], [-1, 1], [-1, 1], [-1, 0], [-1, 0],
  [-1, 0], [-1, 0], [-1, -1], [-1, -1], [-1, -1], [-1, -1], [-1, -1], [0, -1],
  [0, -1], [0, -1], [0, -1], [1, -1], [1, -1], [1, -1], [1, 0], [1, 0],
  [1, 0], [1, 0], [1, 1], [1, 1], [1, 1], [1, 1], [0, 1], [0, 1],
];

const NO_RECOIL: readonly [number, number] = [0, 0];

/**
 * Units whose gun kicks at all.
 *
 * Recoil belongs to the round rather than to the unit firing it:
 * `TechnoClass::Fire_At` sets `IsInRecoilState` only `if
 * (!bullet->Class->IsFueled)` (TECHNO.CPP:2362), so a shell kicks and a
 * rocket, which leaves under its own power, does not. Reading each unit's
 * weapon out of UDATA.CPP, through the weapon table in CONST.CPP, to the
 * projectile in BBDATA.CPP:
 *
 *     ltnk 75mm, mtnk 105mm, htnk 120mm -> APDS         not fuelled
 *     arty 155mm                        -> HE           not fuelled
 *     jeep, buggy, apc M60MG            -> BULLET       not fuelled
 *     stnk, bike DRAGON; mlrs MLRS      -> TOW, SSM2    fuelled
 *     ftnk FLAME_TONGUE                 -> FLAME        fuelled
 *
 * The APC is on this list and still never appears to move, because it has no
 * turret and is not the Artillery, and those are the only two things
 * `Recoil_Adjust` is ever applied to.
 */
const RECOILING: ReadonlySet<string> = new Set(["ltnk", "mtnk", "htnk", "arty", "jeep", "buggy", "apc"]);

/**
 * Units that recoil their whole body instead of a turret.
 *
 * `if (*this == UNIT_ARTY && IsInRecoilState)` (UNIT.CPP:2196) — named, not
 * derived, so nothing else joins it by having no turret.
 */
const RECOIL_BODY: ReadonlySet<string> = new Set(["arty"]);

/** Game frames a gun stays kicked back for. */
export const RECOIL_FRAMES = 1;

const recoilAdjust = (facing: number): readonly [number, number] =>
  RECOIL_ADJUST[adjustIndex(facing)]!;

/**
 * The hull's recoil offset, given the body's facing.
 *
 * Only the Artillery has one; every other unit that kicks does it with the
 * turret.
 */
export function bodyRecoil(kind: string, bodyFacing: number): readonly [number, number] {
  return RECOIL_BODY.has(kind) ? recoilAdjust(bodyFacing) : NO_RECOIL;
}

/**
 * The turret's recoil offset, given the *turret's* facing.
 *
 * `Recoil_Adjust(SecondaryFacing.Current(), x1, y1)` (UNIT.CPP:2250): the gun
 * kicks back along where it is aimed, which on a tank is not where the hull
 * points. It is added to {@link turretOffset}, as the game adds it before
 * `Turret_Adjust` and the Humvee's four-pixel lift.
 */
export function turretRecoil(kind: string, turretFacing: number): readonly [number, number] {
  if (RECOIL_BODY.has(kind) || !RECOILING.has(kind)) return NO_RECOIL;
  if (!isUnit(kind as EntityKind) || !UNIT_DEFS[kind as UnitKind].turret) return NO_RECOIL;
  return recoilAdjust(turretFacing);
}

/**
 * Facings a unit turns per simulation tick.
 *
 * ROT is applied once per game frame in 256ths of a circle, so converting it
 * is ROT/256 of the unit's own facings, times the game frames a tick covers.
 * A unit with no ROT turns outright.
 */
/**
 * Facings a turret turns per tick.
 *
 * TurretClass::AI runs the turret at Class->ROT + 1 (TURRET.CPP:206), a step
 * faster than the body it sits on, so it can lead the chassis round.
 */
export function turretTurnRate(kind: EntityKind): number {
  if (!isUnit(kind)) return 1;
  const rot = unitRot(kind);
  if (rot === null) return UNIT_DEFS[kind].facings;
  return ((rot + 1) / 256) * UNIT_DEFS[kind].facings * GAME_FRAMES_PER_TICK;
}

export function turnRate(kind: EntityKind): number {
  if (!isUnit(kind)) {
    // A turret-equipped building turns at a rate BuildingClass applies
    // itself; BDATA.CPP has no ROT field, which is why this used to sit at
    // one facing a tick as a placeholder. Everything else on a building is
    // fixed, so it keeps that.
    const rot = bldgRot(kind);
    if (rot === null) return 1;
    return (rot / 256) * VEHICLE_FACINGS * GAME_FRAMES_PER_TICK;
  }
  const facings = UNIT_DEFS[kind].facings;
  const rot = unitRot(kind);
  if (rot === null) return facings;
  return (rot / 256) * facings * GAME_FRAMES_PER_TICK;
}









/**
 * The wrench the game shows over a building being repaired.
 *
 * `SelectShapes` frame 2: the enum runs SELECT_INFANTRY, SELECT_UNIT, then
 * SELECT_WRENCH (DEFINES.H:1660-1669), and BuildingClass::Draw_It draws it
 * centred on the building while `IsRepairing && IsWrenchVisible`.
 */
export const SELECT_WRENCH_FRAME = 2;

/**
 * How long the wrench stays on, and then off, in ticks.
 *
 * BuildingClass::AI toggles it every fifteen game frames, in the same step
 * that spends the money and adds the strength. The shipped game runs 45 frames
 * a second — the health in a recorded repair climbs by 5 every 0.33s, 418
 * rises out of 426 — so that is three steps a second.
 */
export const WRENCH_BLINK_TICKS = (15 * GAME_FRAME_MS) / TICK_MS;
