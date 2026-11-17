export type Theater = "desert" | "temperat" | "winter";
export type House = "gdi" | "nod";
export type VisionMode = "gdi" | "nod" | "omni";

export const CELL = 24;
export const TICK_HZ = 15;
/**
 * House-color remap range: palette indices **176-191**.
 *
 * These hold a 16-entry gold ramp (244,212,120 down to 16,12,4, in two
 * sub-ramps at 176-183 and 184-191), byte-identical across DESERT.PAL,
 * TEMPERAT.PAL and WINTER.PAL. Gold is GDI's color *and* the palette
 * default, so unremapped art already looks GDI; the engine swaps this
 * range per house at render time.
 *
 * This was previously set to 192-199 on the reasoning that a remap range
 * ought to be a neutral gray ramp (192-199 is exactly that). It isn't:
 * 192-199 is ordinary structural shading — concrete, metal, glass — shared
 * by terrain and buildings, and recoloring it painted red speckle across
 * every Nod structure while leaving the actual team-colored pixels gold.
 *
 * Confirmed by index usage in the real sprites: of the opaque pixels in
 * MTNK (Medium Tank, almost entirely house-colored) 79.9% fall in 176-191
 * and 1.9% in 192-199; HTNK is 80.2%, and infantry E1 is 69.4% vs 0.0%.
 */
export const REMAP_LO = 176;
export const REMAP_HI = 191;
export const SNAPSHOT_INTERVAL = 30;

export type UnitKind =
  | "e1"
  | "e2"
  | "e3"
  | "e4"
  | "e6"
  | "c1"
  | "c7"
  | "jeep"
  | "apc"
  | "ltnk"
  | "mtnk"
  | "htnk"
  | "stnk"
  | "ftnk"
  | "arty"
  | "mlrs"
  | "bike"
  | "buggy"
  | "harv"
  | "mcv"
  | "orca"
  /** The Chinook: carries infantry, unarmed. */
  | "tran"
  /** The A-10 of an airstrike: flies in, drops napalm, leaves. */
  | "a10"
  | "heli";

export type BldgKind =
  | "fact"
  | "proc"
  | "powr"
  | "apwr"
  | "pyle"
  | "hand"
  | "weap"
  | "afld"
  | "hq"
  | "hpad"
  | "fix"
  | "silo"
  | "gtwr"
  | "atwr"
  | "gun"
  | "obli"
  | "sam"
  | "tmpl"
  | "eye"
  | "bio"
  | "hosp"
  | "miss";

export type EntityKind = UnitKind | BldgKind;

export type OverlayKind =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28;

export interface GameMap {
  id: string;
  name: string;
  theater: Theater;
  width: number;
  height: number;
  /** Real template id per cell (index into template-table.ts). */
  tiles: Uint16Array;
  /** Icon (sub-tile) number per cell, as stored in the map's `.bin`. */
  icons: Uint8Array;
  /**
   * overlay: 0 none, 1-12 green tib, 13-24 blue tib, 25 road, 26 wall, 27
   * sandbag, 28 crater.
   *
   * For Tiberium this is the *variant* — which of the twelve TI files the
   * cell is drawn from — not how much is there. The game picks it at random
   * per cell and throws away whatever the map's INI said
   * (`Tiberium_Adjust(pregame)`, CELL.CPP:1897), so it carries no quantity.
   */
  overlay: Uint8Array;
  /**
   * How much Tiberium is in the cell, 0 to 11. Meaningless where the overlay
   * is not Tiberium.
   *
   * This is `CellClass::OverlayData`, and the game draws it as the *frame*
   * of the overlay's own sprite (CELL.CPP:1039) — twelve frames, one per
   * level. Growth advances it, a harvester reduces it, and at zero the
   * Tiberium is gone.
   */
  tibStage: Uint8Array;
  /** 0 passable, 1 blocked (rock/water/cliff) */
  block: Uint8Array;
  /** Terrain-object sprites (trees, rocks) by cell index. */
  terrain: Map<number, string>;
  spawns: [{ x: number; y: number }, { x: number; y: number }];
  /** All start positions from the map's waypoints (>= 2 on multiplayer maps). */
  starts: { x: number; y: number }[];
  /** True when this came from a real ported `.bin`/`.ini` rather than the generator. */
  real: boolean;
}

export interface UnitDef {
  kind: UnitKind;
  name: string;
  cost: number;
  hp: number;
  speed: number;
  range: number;
  damage: number;
  cooldown: number;
  sight: number;
  facings: 8 | 32;
  turret: boolean;
  aircraft: boolean;
  harvester: boolean;
  footprint: 1;
}

export interface BldgDef {
  kind: BldgKind;
  name: string;
  cost: number;
  hp: number;
  w: number;
  h: number;
  sight: number;
  power: number;
  producer?: "infantry" | "vehicle" | "aircraft" | "none";
  weapon?: { range: number; damage: number; cooldown: number; projectile: ProjectileKind };
}

/**
 * Effects the replay records as objects in their own right, each with a
 * position and an instant: 2,433 muzzle flashes, 1,924 bullet impacts and 143
 * tank shells in a single six-minute match. The order is the wire order —
 * append only.
 */
export const COMBAT_EFFECTS = [
  "MINIGUN", "PIFF", "PIFFPIFF", "120MM", "GUNFIRE",
  "FIRE1", "FIRE2", "FIRE3", "FIRE4", "FRAG1", "FRAG3", "FBALL1",
  "NAPALM1", "NAPALM2", "NAPALM3", "SMOKEY",
  // Rounds in flight: a bazooka's or a launcher's rocket, and a bomb or an
  // Artillery shell. Both are objects in the stream, with a position every
  // frame, and neither was drawn at all before.
  "DRAGON", "BOMB",
  // The superweapons: the nuclear missile going up and coming down, its
  // blast, the Temple's door, and the ion cannon's strike.
  "ATOMICUP", "ATOMICDN", "ATOMSFX", "ATOMDOOR", "IONSFX",
  // More rounds: an A-10's napalm bomblets, and the SAM Site's and the
  // Orca's missiles.
  "BOMBLET", "MISSILE", "MISSILE2",
] as const;

export type CombatEffect = (typeof COMBAT_EFFECTS)[number];

/**
 * Effects that are a thing travelling rather than a thing happening.
 *
 * A tank shell is an object in the stream with a position every frame of its
 * flight, not a one-off puff at the muzzle. It has to be drawn where it
 * currently is, which means one effect per recorded position and a life just
 * long enough to reach the next one — otherwise the shell either sits at the
 * gun or smears into a trail of eight copies of itself.
 */
export const PROJECTILE_EFFECTS: ReadonlySet<CombatEffect> = new Set(["120MM", "DRAGON", "BOMB", "ATOMICUP", "ATOMICDN", "BOMBLET", "MISSILE", "MISSILE2"]);

/**
 * Effects drawn from their own recorded frames for as long as the recording
 * shows them, standing where they stood: a blast or a door plays out over its
 * whole animation, one frame a game frame, which the fixed short life of an
 * ordinary puff would cut off after a few.
 */
export const RECORDED_ANIMS: ReadonlySet<CombatEffect> = new Set(["ATOMSFX", "ATOMDOOR", "IONSFX"]);
/** Ticks a shell sprite lasts: about the gap between two recorded positions. */
export const PROJECTILE_LIFE_TICKS = 2;

/** One recorded effect playing in the viewer. */
export interface Effect {
  kind: CombatEffect;
  /** World pixels. */
  x: number;
  y: number;
  /** Ticks since it started. */
  age: number;
  /**
   * The frame the recording says was drawn, when it has one.
   *
   * Not usable for directional art. MINIGUN.SHP holds 48 frames and the
   * recorded value runs past 88, so it is not an index into the file, and
   * reading it as one gave every flash in a burst a different heading.
   */
  frame?: number;
  /**
   * Which of eight ways a directional flash points, fixed when it is made.
   *
   * The game picks the animation by direction — `ANIM_GUN_N +
   * Dir_Facing(PrimaryFacing.Current())` — so the heading belongs to the
   * shooter, not to the effect's own frame counter.
   */
  dir?: number;
}

export type ProjectileKind = "bullet" | "cannon" | "rocket" | "laser" | "flame" | "shell";

/**
 * Set on an input command's `target` for a drag box that took nothing: none
 * of the player's units were inside it. It selected nothing, so it is not
 * counted as an action.
 */
export const INPUT_EMPTY_BOX = 1 << 16;

export type CmdKind =
  | "deploy"
  | "place"
  | "spawn"
  | "queue"
  | "move"
  | "attack"
  | "harvest"
  | "stop"
  | "sell"
  | "select"
  | "rally"
  | "kill"
  /**
   * A decoded object left the map, with nothing to say it died.
   *
   * The recording's key is the object's identity: the game holds it while the
   * object is merely out of sight -- a harvester unloading is in limbo and so
   * is not exported at all, and across 133 of those holes not one key was
   * taken by anything else -- and hands it on only once the object is gone. A
   * track followed by another object on the same key is therefore a unit that
   * left play, whatever its last health reading said.
   *
   * What it does not say is how. Destroyed is much the likeliest, but an
   * Engineer is spent on the building it takes and a vehicle can be sold on a
   * Repair Bay, and neither is a loss. So this removes the unit and counts
   * nothing: no explosion, no entry in either side's losses. Leaving it
   * standing was the alternative, and that left a harvester parked in a field
   * for the four minutes the match had left to run.
   */
  | "gone"
  /**
   * A decoded harvester was taken into a Refinery to unload, at this tick.
   * `ref` names the harvester and `target` the steps of Tiberium it gave up.
   *
   * Read off the recording rather than modelled: an unloading harvester is in
   * limbo (UNIT.CPP:1819) and limboed objects are not exported
   * (DLLInterface.cpp:3382), so every unload leaves a hole in its track — 615
   * game frames in 119 of 162 at a Refinery, which is the 600 the Refinery
   * plays plus the frames either side of it. Starting the unload the moment a
   * harvester came within a cell of the pad instead had it vanish a median of
   * 28 ticks before the game took it.
   */
  | "dock"
  /**
   * An Engineer took a building. `x`/`y` name the ground it stands on and
   * `p` the player it now belongs to.
   *
   * The building itself is untouched otherwise: `BuildingClass::Captured`
   * changes `House` and moves the power, drain and storage across, and leaves
   * `Strength` exactly where it was.
   */
  | "capture"
  /** Decoded credit balance for a player at this tick. */
  | "credits"
  /**
   * One waypoint of a cargo plane's recorded flight: `px`/`py` the position,
   * `target` the altitude, `id` the ticks the leg took. A command with no
   * position ends that plane's pass.
   */
  | "cargo"
  /** A control group was set. Carries no effect; it exists to be counted. */
  | "group"
  /** The player changed what they had selected. Carries no effect. */
  | "sel"
  /** A repair was ordered. Carries no effect; it exists to be counted. */
  | "repair"
  /**
   * A combat effect the replay recorded — a muzzle flash, a bullet impact, a
   * shell, an explosion. `px`/`py` place it, `target` indexes
   * {@link COMBAT_EFFECTS}.
   */
  | "fx"
  /**
   * A unit opened fire; `ref` names it.
   *
   * For infantry this starts the firing sequence, timed so it reaches the
   * frame the round leaves at the moment the recorded muzzle flash appears —
   * see FIRE_LAUNCH. The tick can be earlier than the evidence for it,
   * because the wind-up comes first.
   *
   * For a vehicle it is the shot itself, dated by the muzzle flash the game
   * attached to it, and it drives the recoil.
   */
  | "fire"
  /**
   * One item's turn in a production queue, for the sidebar.
   *
   * `t` is when it entered the queue, `target` how many ticks it took, and
   * `id` is 1 if it finished and 0 if the player cancelled it. Carries no
   * effect on the simulation — `queue` is what actually builds things; this
   * exists so the queue can be shown as the players saw it.
   */
  | "build"
  /**
   * A structure's health, as the recording restated it. `x`/`y` name a cell
   * it stands on and `hp` is its Strength, on the same scale as BLDG_DEFS.
   *
   * Units carry their health on their own movement; a building never moves,
   * so without this it was drawn at full health until the moment it fell.
   */
  | "health"
  /**
   * A player clicked an object as the target of an order — an attack, or a
   * unit sent onto something — at `x`/`y`. Read off the flash the game plays
   * on what was clicked (FlashingFlags). Carries no effect: the units' own
   * tracks already show what they did about it. It exists to be seen and
   * counted.
   */
  | "target"
  /**
   * A unit's control group changed: `ref` names it and `target` is the group,
   * 255 for none. Read off each unit (the ControlGroup the game exports), so
   * the number can be drawn on it as the game does.
   */
  | "ingroup"
  /**
   * Something a player sent the game: a click, a drag box, a control group key,
   * a sidebar, unit or structure request. Read from the replay's input
   * messages (readInputs). `target` is (code << 8) | event, plus
   * INPUT_EMPTY_BOX for a drag box with none of the player's units in it;
   * `px`/`py` the point in map pixels; for a box `id`/`ref` the other
   * corner, for a control group key `id` the group. Carries no effect on the
   * game.
   */
  | "input"
  /**
   * A replayed unit's full recorded path: `path` holds tick, x and y in world
   * pixels, three numbers a point, for every point a straight line through its
   * neighbours could not stand in for (see simplifyPath). The waypoints on
   * "move" carry the movement records' coarser sightings; this is the one
   * position a frame the game itself drew.
   */
  | "path"
  /**
   * A round in flight (PROJECTILE_EFFECTS): `target` its effect, `path` its
   * whole flight frame by frame, `frames` its sprite frames and `alts` its
   * height. Drawn where it is at every moment rather than as a puff at each
   * sighting.
   */
  | "shot";

export interface ReplayCommand {
  t: number;
  p: 0 | 1;
  k: CmdKind;
  /** Replay object id, for a command aimed at a specific decoded object. */
  ref?: number;
  /**
   * Exact render position in world pixels, decoded from the replay. Present on
   * track waypoints, where it replaces the cell centre as the destination so a
   * unit stands where it really stood rather than snapped to its cell.
   */
  px?: number;
  py?: number;
  /** Health the replay recorded for this object at this moment. */
  hp?: number;
  /** Recorded sprite frame; for a vehicle this carries its facing. */
  shape?: number;
  /** Recorded turret frame, for vehicles whose turret is its own object. */
  turretShape?: number;
  /** For "path": tick (fractional: frames come three to a tick), px, py, repeated. */
  path?: number[];
  /** For "path": tick and sprite frame, at each frame the game drew it with a new one. */
  frames?: number[];
  /** For "path": the same for the vehicle's turret, which is its own object in the recording. */
  turretFrames?: number[];
  /** For "path": an aircraft's height, tick and 0..256 (256 is flying), where it changed. */
  alts?: number[];
  /**
   * A waypoint replayed from a decoded track rather than a player's click.
   * These arrive several times a second per unit, so they are kept out of the
   * click-ring feed and out of APM — nobody clicked them.
   */
  silent?: boolean;
  /**
   * Decoded from a real .Replay rather than generated. Such an event is
   * ground truth: it is known to have happened, so the simulation must not
   * veto it on the strength of its own approximated economy.
   */
  real?: boolean;
  kind?: EntityKind;
  x?: number;
  y?: number;
  id?: number;
  target?: number;
}

export interface ReplayHeader {
  magic: "TD1R";
  version: 1;
  matchId: number;
  mapId: string;
  mapName: string;
  theater: Theater;
  durationTicks: number;
  startCredits: number;
  seed: number;
  players: [ReplayPlayer, ReplayPlayer];
  winner: 0 | 1;
  replayUrl?: string | null;
  startTime?: string | null;
  /** Rules this match was played under, read from the real replay when available. */
  settings?: MatchSettings;
}

import type { MatchSettings } from "./settings";

export type Faction = "GDI" | "NOD";

export interface ReplayPlayer {
  id: string;
  name: string;
  /**
   * Player *color slot*, not faction. In real Quickmatch both players can
   * field the same faction (Nod mirrors are the most common matchup), so
   * team color is per-slot while `faction` decides what they can build.
   */
  house: House;
  faction: Faction;
  points: number;
}

export interface ReplayFile {
  header: ReplayHeader;
  commands: ReplayCommand[];
}

export interface Entity {
  id: number;
  /**
   * Construction cost not yet paid. A structure is charged gradually rather
   * than the whole price at placement, the way C&C bills you while the
   * sidebar produces it.
   *
   * This outlives {@link build}. The sidebar's production takes as long as the
   * structure's build time, while the buildup on the ground is 1.65 seconds
   * for everything, so an Airstrip is still being paid for long after it is
   * finished and working.
   */
  owed?: number;
  /**
   * The object id this entity was decoded from, when its movement comes from
   * the replay rather than the simulation. A harvester with a ref follows the
   * cells it was really seen in; one without is steered by the model.
   */
  ref?: number;
  /**
   * Decoded from a real .Replay rather than generated. Such a structure is
   * known to have stood, and the replay does not say what destroyed it, so
   * synthesised combat is not allowed to delete it.
   */
  real?: boolean;
  kind: EntityKind;
  player: 0 | 1;
  x: number;
  y: number;
  px: number;
  py: number;
  /**
   * Where this entity stood when the current tick began.
   *
   * The simulation steps 15 times a second and the canvas draws far more
   * often, so without this a sprite only moves 15 times a second — a buggy
   * jumps a median of 3.6 pixels and as much as 6.8 in one go, which is the
   * teleporting. Holding the previous position lets the renderer draw the
   * point in between that the elapsed fraction of the tick calls for.
   */
  ppx?: number;
  ppy?: number;
  /**
   * The heading and turret angle this entity had at the end of the previous
   * tick, for the same reason.
   *
   * A vehicle turns at ROT, which the game applies once a *game frame* — three
   * of those to a tick. A Harvester's ROT of 5 is 0.63 facings a frame but
   * 1.89 a tick, so the game walks through every one of the 32 sprites as it
   * turns and this walked through every other one. That is the stutter in a
   * turning vehicle: not the heading being wrong, but a third of the frames on
   * the way to it never being drawn.
   */
  pfacing?: number;
  pturret?: number;
  /**
   * Ticks since this entity last changed place.
   *
   * Infantry hold their walk pose for a moment after stopping. `Draw_It`
   * keeps it for two frames when the unit still has a path — added to the
   * Remastered to stop a unit pausing at a waypoint flashing its stand pose
   * for a single frame.
   */
  stillTicks?: number;
  /**
   * Buildup progress per tick — how fast the structure assembles itself on
   * the ground, which BDATA.CPP times to the same 75 game frames for every
   * structure — 1.65 seconds, not the five the constant is named for.
   *
   * Distinct from how long it took to produce: that is billed against
   * {@link owed} and is already over by the time a placement is recorded.
   */
  buildStep?: number;
  /** The tick {@link Entity.shape} was last set from the recording. */
  shapeTick?: number;
  /**
   * The sprite frame the game drew this unit with at the current tick, when
   * the recording has its every frame. An infantryman is drawn from it as it
   * stands: walking, firing, crawling and idling are all in the frame.
   */
  drawnShape?: number;
  /**
   * The tick this unit last opened fire.
   *
   * For infantry this dates the firing sequence: it runs from here at the
   * game's own rate and then stops, and is not restarted by further shots
   * while it is still playing, which is what `InfantryClass::Do_Action` does
   * with its `todo != Doing` guard.
   *
   * For a vehicle there is no sequence, and this dates the shot itself — the
   * one thing it changes about how the vehicle is drawn is the recoil, which
   * the game clears on the next AI a game frame later.
   */
  firingSince?: number;
  hp: number;
  maxHp: number;
  facing: number;
  turret: number;
  /** The facing the recording last gave the turret; it turns toward this. */
  wantTurret: number;
  state: "idle" | "move" | "attack" | "harvest" | "return" | "build" | "dead";
  targetId: number;
  destX: number;
  destY: number;
  progress: number;
  cargo: number;
  build: number;
  /** The tick a building finished going up, when the simulation saw it happen. */
  builtAt?: number;
  cooldown: number;
  produced: number;
  queue: UnitKind[];
  w: number;
  h: number;
  alive: boolean;
  /** Remaining cells to walk (A*), nearest first. */
  path: { x: number; y: number }[];
  /** Whether this unit's facing comes from the replay rather than its motion. */
  recordedFacing?: boolean;
  /**
   * The exact sprite frame the game drew for this object, when the replay
   * recorded one. It carries the pose as well as the facing — walking, firing,
   * prone, crawling — so nothing about the animation has to be guessed from
   * whether the unit happens to be moving.
   */
  shape?: number;
  /** The turret's own recorded frame, when the replay carries one. */
  turretShape?: number;
  /**
   * How an infantryman died, and the tick his death began. He is drawn playing
   * it out after he stops being alive, the way the game keeps a dying soldier
   * on the map until his last frame (INFANTRY.CPP, IsDying).
   */
  death?: import("./sprites").DeathName;
  /** The control group this unit is in, as the replay recorded it. */
  group?: number;
  diedAt?: number;
  /**
   * The tick a building's sale began. It stands through its buildup played
   * backwards and then is gone, and nobody lost it — the game runs the sale as
   * MISSION_DECONSTRUCTION, which plays the build-up frames "from the end to
   * the beginning" (BUILDING.CPP:516-525) rather than blowing anything up.
   */
  soldAt?: number;
  /**
   * While a building is being repaired: when the player ordered it and the
   * tick its health stopped climbing. The wrench is drawn between the two.
   */
  repairFrom?: number;
  repairUntil?: number;
  /**
   * The turn a vehicle is in the middle of, between two recorded sprite
   * frames: the facing the last one gave, the facing the next one gives, and
   * the ticks they sit on.
   *
   * The recording restates a vehicle's frame a median of 660ms apart, and
   * holding the last one until the next arrives draws a turn as a jump. Since
   * both ends are on record, the body can be turned across the gap and still
   * be pointing exactly where the recording says at either end.
   */
  turnFrom?: number;
  turnTo?: number;
  turnAt?: number;
  turnUntil?: number;
  /** Exact destination in world pixels, when the replay recorded one. */
  tgtPx?: number;
  tgtPy?: number;
  /** Ticks left to reach {@link tgtPx}, as long as the recorded leg took. */
  followLeft?: number;
  /**
   * The pace this unit has been driving at, in pixels a tick.
   *
   * Smoothed across legs, because a leg's own length over its own duration is
   * a noisy reading of one speed rather than a speed of its own.
   */
  pace?: number;
  /**
   * Whether the owning player had this unit selected, decoded from the replay.
   * Drawn with the game's own corner brackets.
   */
  selected?: boolean;
  /**
   * Between two points of its full path that it cannot have driven: dead with
   * its key passed on, or inside an APC or a refinery. Not drawn meanwhile.
   */
  offMap?: boolean;
  /** Ticks left docked inside a refinery while unloading. */
  dock: number;
  /**
   * Id of the refinery this harvester has claimed a bay in, or undefined when
   * it holds none. The engine models this as radio contact: a refinery already
   * talking to one harvester turns the next one away, which is what sends a
   * fleet to different refineries instead of all to the same one.
   */
  bay?: number;
  /**
   * The Refinery this harvester is unloading into, while it is unloading.
   *
   * A statement of fact, unlike {@link bay}, which is a reservation made on
   * the way there and can name a Refinery the harvester never reaches. The
   * Refinery's own animation is driven off this: `Mission_Harvest` is
   * something the building plays *over* a docked harvester, so it has to know
   * which one, and asking the question a second way — is a harvester of mine
   * standing near my dock cell — answered differently from the simulation on
   * a tenth of the ticks a harvester spent unloading, which is a Refinery
   * standing idle with a harvester sitting in it.
   */
  dockedAt?: number;
  /** Facing the unit is turning toward; `facing` rotates to meet it. */
  wantFacing: number;
  /** Ticks since this entity finished construction / was created. */
  age: number;
  /**
   * Ticks since a one-shot activity animation started, or -1 when idle.
   * Drives the Construction Yard crane, which swings once per placement.
   */
  activityAge: number;
}

/**
 * Each unit's ROT — its rate of turn, as the game states it.
 *
 * `FacingClass::Rotation_Adjust(Class->ROT)` steps the current facing toward
 * the desired one by this much each time the unit's AI runs, in 256ths of a
 * circle. The values are UDATA.CPP's own (AADATA.CPP for the two aircraft):
 * wheels turn at 10, tracks at 5, Artillery crawls round at 2 and the Flame
 * Tank at 3.
 *
 * Guessing this from top speed, as this did before, had a Medium Tank turning
 * at 1 facing a tick where the game turns it at 1.9, and a Buggy at 2 against
 * 3.8. A body that turns at half the rate its position is moving lags behind
 * its own direction of travel, which is what made units look like they were
 * floating rather than driving.
 */
const UNIT_ROT: Readonly<Record<string, number>> = {
  jeep: 10, buggy: 10, bike: 10,
  ltnk: 5, mtnk: 5, htnk: 5, stnk: 5, mlrs: 5, apc: 5, harv: 5, mcv: 5,
  ftnk: 3, arty: 2,
  orca: 4, heli: 4,
};

/**
 * How fast a turret-equipped building swings, in the same 256ths.
 *
 * These are not in BDATA.CPP, which is why they were missing: BuildingClass
 * turns its own turret and the rates are written into the code that does it —
 * `Rotation_Adjust(15)` for a SAM Site and `Rotation_Adjust(12)` for
 * everything else with a turret (BUILDING.CPP:1262).
 *
 * A defensive turret was left at one facing a tick as a placeholder, against
 * the 4.6 and 5.7 these work out to, so it tracked a passing unit about four
 * times slower than the game does.
 */
const BLDG_ROT: Readonly<Record<string, number>> = {
  gun: 12,
  sam: 15,
};

/** A turret-equipped building's ROT, or null if it has no turret. */
export function bldgRot(kind: EntityKind): number | null {
  return BLDG_ROT[kind] ?? null;
}

/**
 * A unit's ROT, or null when it has none and turns outright.
 *
 * Infantry have no such field — IDATA.CPP does not carry one, and
 * InfantryClass sets its facing directly — so they snap.
 */
export function unitRot(kind: EntityKind): number | null {
  if (!isUnit(kind)) return null;
  return UNIT_ROT[kind] ?? null;
}

/**
 * Part of the way from one facing to another, the short way round.
 *
 * Used to draw the part-ticks between two headings, and to carry a vehicle
 * through the turn between two recorded sprite frames.
 */
export function facingBetween(prev: number | undefined, now: number, frac: number, facings: number): number {
  if (prev === undefined || prev === now) return now;
  let d = (now - prev) % facings;
  const half = facings / 2;
  if (d > half) d -= facings;
  if (d < -half) d += facings;
  return ((prev + d * frac) % facings + facings) % facings;
}

/** Step `from` toward `to` by at most `rate`, wrapping around `facings`. */
export function turnToward(from: number, to: number, facings: number, rate: number): number {
  const diff = ((((to - from) % facings) + facings + facings / 2) % facings) - facings / 2;
  if (Math.abs(diff) <= rate) return ((to % facings) + facings) % facings;
  return ((from + Math.sign(diff) * rate + facings) % facings + facings) % facings;
}

/**
 * A flamethrower's burst: FLAME-<dir>, attached to the man who fired it
 * (TechnoClass::Fire_At creates it at his Fire_Coord and attaches it), one
 * frame a game frame.
 */
export interface FlameBurst {
  /** The shooter. */
  id: number;
  /** One of eight, clockwise from north, as the FLAME files are numbered. */
  dir: number;
  born: number;
}

export interface Projectile {
  x: number;
  y: number;
  tx: number;
  ty: number;
  kind: ProjectileKind;
  player: 0 | 1;
  damage: number;
  targetId: number;
  alive: boolean;
}

export interface Explosion {
  x: number;
  y: number;
  life: number;
  max: number;
  scale: number;
}

/**
 * A cargo plane delivering a vehicle to a Nod Airstrip.
 *
 * Nod builds vehicles by air: the Airstrip doesn't produce them on the spot
 * the way a GDI Weapons Factory does, a C-17 flies in, lands, drops the
 * vehicle and leaves. Without it, Nod vehicles appear from nowhere.
 */
export interface Delivery {
  /** Cargo plane position, in world pixels. */
  x: number;
  y: number;
  /** Airstrip pad the plane is heading for. */
  padX: number;
  padY: number;
  facing: number;
  player: 0 | 1;
  /**
   * Height, 1 at cruise and 0 over the strip.
   *
   * The engine scales `Altitude` down from `FLIGHT_LEVEL` once the plane is
   * within 0x0600 leptons — six cells — of its drop point, then climbs again
   * on the way out (AIRCRAFT.CPP, FLY_TO_AIRSTRIP). That descent *is* the
   * landing: the plane never stops.
   */
  alt: number;
  /** What is being delivered; released as the plane passes over. */
  cargo: UnitKind;
  phase: "inbound" | "unloading" | "outbound";
  /** Ticks remaining in the current phase (unloading only). */
  timer: number;
  alive: boolean;
  /**
   * The decoded C17 track this plane is flying, when its path comes from the
   * replay rather than the model. Everything below is that track's next
   * waypoint.
   */
  ref?: number;
  tgtX?: number;
  tgtY?: number;
  tgtAlt?: number;
  followLeft?: number;
}

export interface PlayerEco {
  credits: number;
  spent: number;
  harvested: number;
  power: number;
  drain: number;
  armyValue: number;
}

export interface BuildEvent {
  tick: number;
  player: 0 | 1;
  kind: EntityKind;
  name: string;
  cost: number;
}

export interface Engagement {
  start: number;
  end: number;
  x: number;
  y: number;
  gdiLost: number;
  nodLost: number;
  gdiValue: number;
  nodValue: number;
}

/*
 * Speeds are the game's own MPHType values (DEFINES.H, and each type's entry in
 * UDATA.CPP or IDATA.CPP) on one scale: MPH_MEDIUM_SLOW -- the Harvester, the
 * MCV, the artillery and the Mammoth -- is 1.0, and everything else keeps its
 * ratio to that. Written by hand they disagreed with the game in both
 * directions: a Minigunner (MPH_SLOW) outran a Flamethrower (MPH_SLOW_ISH), and
 * a Medium Tank crawled behind a Light Tank when the game gives both MPH_MEDIUM.
 */
export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  // Civilians, from IDATA.CPP. They are not built: BuildingClass::Crew_Type
  // releases a C1 or a C7 on a coin flip when a Silo is destroyed, and
  // UNIT.CPP sends out a C1 technician when an unarmed vehicle dies. Both
  // turn up owned by the house that lost the building or the vehicle.
  c1: { kind: "c1", name: "Civilian", cost: 10, hp: 25, speed: 0.833, range: 0, damage: 0, cooldown: 0, sight: 2, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  c7: { kind: "c7", name: "Civilian", cost: 10, hp: 5, speed: 0.833, range: 0, damage: 0, cooldown: 0, sight: 2, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  e1: { kind: "e1", name: "Minigunner", cost: 100, hp: 50, speed: 0.667, range: 2, damage: 15, cooldown: 7.6, sight: 1, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  e2: { kind: "e2", name: "Grenadier", cost: 160, hp: 50, speed: 0.833, range: 3.25, damage: 50, cooldown: 20.8, sight: 1, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  e3: { kind: "e3", name: "Rocket Soldier", cost: 300, hp: 25, speed: 0.5, range: 4, damage: 30, cooldown: 20.8, sight: 2, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  e4: { kind: "e4", name: "Flamethrower", cost: 200, hp: 70, speed: 0.833, range: 2, damage: 35, cooldown: 17.5, sight: 1, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  e6: { kind: "e6", name: "Engineer", cost: 500, hp: 25, speed: 0.667, range: 0, damage: 0, cooldown: 0, sight: 2, facings: 8, turret: false, aircraft: false, harvester: false, footprint: 1 },
  jeep: { kind: "jeep", name: "Humvee", cost: 400, hp: 150, speed: 2.5, range: 4, damage: 15, cooldown: 10.9, sight: 2, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  apc: { kind: "apc", name: "APC", cost: 700, hp: 200, speed: 2.917, range: 4, damage: 15, cooldown: 10.9, sight: 4, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  ltnk: { kind: "ltnk", name: "Light Tank", cost: 600, hp: 300, speed: 1.5, range: 4, damage: 25, cooldown: 20.8, sight: 3, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  mtnk: { kind: "mtnk", name: "Medium Tank", cost: 800, hp: 400, speed: 1.5, range: 4.75, damage: 30, cooldown: 17.5, sight: 3, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  htnk: { kind: "htnk", name: "Mammoth Tank", cost: 1500, hp: 600, speed: 1, range: 4.75, damage: 40, cooldown: 27.4, sight: 4, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  // Stealth Tank fires fixed missile pods — STNK.SHP is 32 frames (hull
  // only), so there is no independent turret layer to aim.
  stnk: { kind: "stnk", name: "Stealth Tank", cost: 900, hp: 110, speed: 2.5, range: 4, damage: 30, cooldown: 20.8, sight: 4, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  ftnk: { kind: "ftnk", name: "Flame Tank", cost: 800, hp: 300, speed: 1.5, range: 2, damage: 50, cooldown: 17.5, sight: 4, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  arty: { kind: "arty", name: "Artillery", cost: 450, hp: 75, speed: 1, range: 6, damage: 150, cooldown: 22.4, sight: 4, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  mlrs: { kind: "mlrs", name: "MLRS", cost: 750, hp: 120, speed: 1.5, range: 10, damage: 100, cooldown: 67, sight: 4, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  bike: { kind: "bike", name: "Recon Bike", cost: 500, hp: 90, speed: 3.333, range: 4, damage: 30, cooldown: 20.8, sight: 2, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  buggy: { kind: "buggy", name: "Attack Buggy", cost: 300, hp: 140, speed: 2.5, range: 4, damage: 15, cooldown: 10.9, sight: 2, facings: 32, turret: true, aircraft: false, harvester: false, footprint: 1 },
  harv: { kind: "harv", name: "Harvester", cost: 1400, hp: 600, speed: 1, range: 0, damage: 0, cooldown: 0, sight: 2, facings: 32, turret: false, aircraft: false, harvester: true, footprint: 1 },
  mcv: { kind: "mcv", name: "MCV", cost: 5000, hp: 600, speed: 1, range: 0, damage: 0, cooldown: 0, sight: 2, facings: 32, turret: false, aircraft: false, harvester: false, footprint: 1 },
  tran: { kind: "tran", name: "Chinook", cost: 1500, hp: 90, speed: 3.6, range: 0, damage: 0, cooldown: 0, sight: 0, facings: 32, turret: false, aircraft: true, harvester: false, footprint: 1 },
  a10: { kind: "a10", name: "A-10", cost: 0, hp: 60, speed: 5, range: 1, damage: 100, cooldown: 2, sight: 0, facings: 32, turret: false, aircraft: true, harvester: false, footprint: 1 },
  orca: { kind: "orca", name: "Orca", cost: 1200, hp: 200, speed: 3.2, range: 4, damage: 30, cooldown: 20.8, sight: 6, facings: 32, turret: false, aircraft: true, harvester: false, footprint: 1 },
  heli: { kind: "heli", name: "Apache", cost: 1200, hp: 200, speed: 3.0, range: 4, damage: 25, cooldown: 17.5, sight: 6, facings: 32, turret: false, aircraft: true, harvester: false, footprint: 1 },
};

/**
 * Footprints are the bounding box of the game's own occupy list in BDATA.CPP,
 * not a guess. Several were wrong: the Construction Yard is 3x2 and was drawn
 * 2x2, the Airstrip 4x2, the Hand of Nod 2x3, the Weapons Factory 3x3, the
 * Barracks only 2x1, and the Obelisk 1x2.
 *
 * The real foundations are **not rectangles**. A Refinery occupies
 * `{1, MCW, MCW+1, MCW+2}` — four cells of a 3x2 box, both top corners free;
 * a Hand of Nod is an L. Players tuck turrets into those notches, which is why
 * decoded bases showed a turret apparently sharing a cell with a building and
 * looked like a placement bug. It is not one — the cell really is free.
 * Treating the box as solid remains an approximation; the occupy lists are
 * what a faithful version would carry.
 *
 * Health is what the game really gives a structure, which is not BDATA.CPP's.
 * Every structure the recordings show reads exactly twice its STRNTH there at
 * full health: a Refinery 900 against 450, a Construction Yard 800 against
 * 400, a Power Plant 400 against 200, over 25 ladder replays and thirteen
 * types (_bldscale.ts). The one exception is the Weapons Factory, at 520:
 * Modern Balance sets that one outright (SCENARIO.CPP:810), after whatever
 * doubles the rest. The Obelisk, SAM Site, Temple, Advanced Power and
 * Advanced Comm. Center were not seen and are doubled on the same rule; the
 * civilian buildings are left as they were. Units are not affected: a
 * Minigunner reads 50 and a Buggy 140, exactly as in the source.
 */
export const BLDG_DEFS: Record<BldgKind, BldgDef> = {
  fact: { kind: "fact", name: "Construction Yard", cost: 5000, hp: 800, w: 3, h: 2, sight: 3, power: 15, producer: "none" },
  proc: { kind: "proc", name: "Tiberium Refinery", cost: 2000, hp: 900, w: 3, h: 3, sight: 4, power: -30 },
  powr: { kind: "powr", name: "Power Plant", cost: 300, hp: 400, w: 2, h: 2, sight: 2, power: 100 },
  apwr: { kind: "apwr", name: "Advanced Power", cost: 700, hp: 600, w: 2, h: 2, sight: 2, power: 200 },
  pyle: { kind: "pyle", name: "Barracks", cost: 300, hp: 800, w: 2, h: 2, sight: 3, power: -20, producer: "infantry" },
  hand: { kind: "hand", name: "Hand of Nod", cost: 300, hp: 800, w: 2, h: 3, sight: 3, power: -20, producer: "infantry" },
  weap: { kind: "weap", name: "Weapons Factory", cost: 2000, hp: 520, w: 3, h: 3, sight: 3, power: -30, producer: "vehicle" },
  afld: { kind: "afld", name: "Airstrip", cost: 2000, hp: 1000, w: 4, h: 2, sight: 5, power: -30, producer: "vehicle" },
  hq: { kind: "hq", name: "Communications Center", cost: 1000, hp: 1000, w: 2, h: 2, sight: 10, power: -40 },
  hpad: { kind: "hpad", name: "Helipad", cost: 1500, hp: 800, w: 2, h: 2, sight: 3, power: -10, producer: "aircraft" },
  fix: { kind: "fix", name: "Repair Facility", cost: 1200, hp: 800, w: 3, h: 3, sight: 3, power: -30 },
  silo: { kind: "silo", name: "Tiberium Silo", cost: 150, hp: 300, w: 2, h: 1, sight: 2, power: -10 },
  gtwr: { kind: "gtwr", name: "Guard Tower", cost: 500, hp: 400, w: 1, h: 1, sight: 3, power: -10, weapon: { range: 4, damage: 25, cooldown: 17.5, projectile: "bullet" } },
  atwr: { kind: "atwr", name: "Advanced Guard Tower", cost: 1000, hp: 600, w: 1, h: 2, sight: 4, power: -20, weapon: { range: 6.5, damage: 60, cooldown: 14.2, projectile: "rocket" } },
  gun: { kind: "gun", name: "Turret", cost: 600, hp: 400, w: 1, h: 1, sight: 5, power: -20, weapon: { range: 6, damage: 40, cooldown: 20.8, projectile: "cannon" } },
  obli: { kind: "obli", name: "Obelisk of Light", cost: 1500, hp: 400, w: 1, h: 2, sight: 5, power: -150, weapon: { range: 7.5, damage: 200, cooldown: 30.7, projectile: "laser" } },
  sam: { kind: "sam", name: "SAM Site", cost: 750, hp: 400, w: 2, h: 1, sight: 3, power: -20, weapon: { range: 7.5, damage: 50, cooldown: 17.5, projectile: "rocket" } },
  tmpl: { kind: "tmpl", name: "Temple of Nod", cost: 3000, hp: 2000, w: 3, h: 3, sight: 4, power: -150 },
  eye: { kind: "eye", name: "Advanced Comm. Center", cost: 2800, hp: 1000, w: 2, h: 2, sight: 10, power: -200 },
  bio: { kind: "bio", name: "Bio-Research Lab", cost: 0, hp: 400, w: 2, h: 2, sight: 3, power: 0 },
  hosp: { kind: "hosp", name: "Hospital", cost: 0, hp: 400, w: 2, h: 2, sight: 3, power: 0 },
  miss: { kind: "miss", name: "Tech Center", cost: 1500, hp: 400, w: 3, h: 2, sight: 6, power: -30 },
};

export function isBuilding(kind: EntityKind): kind is BldgKind {
  return kind in BLDG_DEFS;
}

export function isUnit(kind: EntityKind): kind is UnitKind {
  return kind in UNIT_DEFS;
}

export function defOf(kind: EntityKind): { name: string; cost: number; hp: number } {
  if (isBuilding(kind)) return BLDG_DEFS[kind];
  return UNIT_DEFS[kind];
}

export function facingFromDelta(dx: number, dy: number, facings: 8 | 32): number {
  if (dx === 0 && dy === 0) return 0;
  const a = Math.atan2(dx, -dy);
  const step = (Math.PI * 2) / facings;
  return ((Math.round(a / step) + facings) % facings);
}

export function mapIndex(map: GameMap, x: number, y: number): number {
  return y * map.width + x;
}
