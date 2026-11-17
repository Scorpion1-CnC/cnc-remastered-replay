/**
 * Build a playable `ReplayFile` from a real `.Replay`'s decoded contents.
 *
 * `generate.ts` synthesises a faithful-but-generic ladder opening at a
 * synthesised base layout. This module does the opposite: it takes what was
 * actually read out of the match — which structures each side built, when
 * production started, and the map cell each one went on — and emits those as
 * the command stream, so the reconstruction plays back the real game rather
 * than a representative one.
 *
 * Only structures are covered. Unit and infantry production is visible in the
 * sidebar stream but has no owner attached, so it is left to the generator
 * until that is solved; see `docs/RESEARCH-LOG.md`.
 */

import type {
  ReplayCommand,
  ReplayFile,
  ReplayHeader,
  UnitKind,
  BldgKind,
  EntityKind,
  CombatEffect,
} from "../engine/types";
import { BLDG_DEFS, CELL, INPUT_EMPTY_BOX, TICK_HZ, UNIT_DEFS } from "../engine/types";
import { COMBAT_EFFECTS, PROJECTILE_EFFECTS, RECORDED_ANIMS } from "../engine/types";
import { FLIGHT_LEVEL, INPUT_CODE, INPUT_EVENT, SIDEBAR_REQUEST, STRUCTURE_REQUEST, VEHICLE_SHAPE_FACINGS, infantryFacingFromShape, inputCall, sidebarCall } from "./object-stream";
import { DEATHS, DO_RATE, GAME_FRAMES_PER_TICK, INFANTRY_DOS, readInfantryDeath, readInfantryFrame, bldgCenterCell, bldgFootprint, BLDG_OCCUPY, KIND_BY_ASSET } from "../engine/sprites";
import { GAME_FRAME_MS, TIBERIUM_STEPS_PER_LOAD, refineryUnload } from "../engine/sprites";
import type { DeltaSighting, InputMessage, ObjectTrack, ObjectTracks, ReplayBuildOrders, StructureFrames } from "./object-stream";
import { cargoPasses, type TrackSample } from "./cargo-passes";

/** A sold building's last frames count down: at least this many steps... */
const SOLD_COUNTDOWN_FRAMES = 6;
/** ...to one of its first frames... */
const SOLD_LAST_FRAME = 3;
/** ...inside this long, in ms. */
const SOLD_COUNTDOWN_MS = 5000;
/** How far around the count a loss or a sale on that building is the same event, in ticks. */
const SOLD_SLACK_TICKS = 15 * TICK_HZ;
/** How near the building that went up must be to a placement order, in cells. */
const PLACE_MATCH_CELLS = 2;
/** What a cell off its order counts for, against time off it, in matching. */
const PLACE_CELL_COST_MS = 10 * 60_000;

/** The effects a dying thing leaves behind. */
const DEATH_BLASTS: ReadonlySet<CombatEffect> = new Set<CombatEffect>([
  "FRAG1", "FRAG3", "FBALL1", "NAPALM1", "NAPALM2", "NAPALM3", "FIRE2", "FIRE3",
]);

/** How near an explosion must be, in cells, to be this unit's. */
const BLAST_CELLS = 2;

/** And how near in time. */
const BLAST_WINDOW_MS = 1500;

/** Bucket width for the explosion index. */
const BLAST_BIN_MS = 1000;

/** TD asset name -> the simulation's unit kind. */
/**
 * How stale a unit's last sighting may be and still say where it stood when a
 * drag box was drawn. A unit that is not moving is not restated, so its last
 * sighting can be old and still right; a track that stopped long before the
 * box is a unit that was gone.
 */
const BOX_SIGHTING_MS = 30_000;
/** A unit this close outside a box's edge still counts as in it. */
const BOX_SLACK_PX = 6;

const UNIT_BY_ASSET: Readonly<Record<string, UnitKind>> = {
  E1: "e1",
  E2: "e2",
  E3: "e3",
  E4: "e4",
  E6: "e6",
  C1: "c1",
  C7: "c7",
  MCV: "mcv",
  HARV: "harv",
  JEEP: "jeep",
  BGGY: "buggy",
  BIKE: "bike",
  LTNK: "ltnk",
  MTNK: "mtnk",
  HTNK: "htnk",
  FTNK: "ftnk",
  STNK: "stnk",
  ARTY: "arty",
  MLRS: "mlrs",
  MSAM: "mlrs",
  APC: "apc",
  HELI: "heli",
  ORCA: "orca",
  TRAN: "tran",
  A10: "a10",
};


/** Units that roll out of (or are flown to) a production building. */
const VEHICLES: ReadonlySet<UnitKind> = new Set<UnitKind>([
  "jeep", "buggy", "bike", "ltnk", "mtnk", "htnk", "ftnk", "stnk",
  "arty", "mlrs", "apc", "harv", "mcv",
]);

export interface RealReplayInputs {
  header: ReplayHeader;
  orders: ReplayBuildOrders;
  /** Map size in cells, to keep placements inside the playfield. */
  mapWidth: number;
  mapHeight: number;
  /**
   * Also place decoded units. Off by default.
   *
   * The object stream only gives a unit's *first sighting*, so a spawned unit
   * stands still for the rest of the match — and ~100 extra standing units
   * push the simulation's warm-up pass from about 4.6s to 7.2s measured, and
   * hang it outright in the browser. The unit data is still decoded and
   * attributed; it just isn't worth feeding to the simulation until units can
   * be tracked over time rather than pinned where they were first noticed.
   */
  includeUnits?: boolean;
  /**
   * Every delta sighting, used to follow a harvester over the match.
   *
   * Harvesting was previously modelled end to end: the simulation chose a
   * patch, drove there, and credited the owner. The replay does record where
   * each harvester actually was, so those cells drive it instead — see
   * `tickHarvest`. Credits themselves stay modelled, because no credit total
   * has been found in the file.
   */
  deltaObjects?: readonly DeltaSighting[];
  /**
   * Dense per-object movement from the 0x5781 records — a position every frame
   * the object existed, segmented into one track per unit life.
   *
   * This supersedes {@link deltaObjects} for anything that moves. The object
   * records report a unit two or three times in a whole match, which is why
   * movement had to be modelled; these carry the route the unit actually
   * drove, so the simulation replays it instead of inventing one.
   */
  objectTracks?: readonly ObjectTrack[];
  /**
   * Each player slot's spawn index, as the ladder reports it. Used to pair
   * players with the decoded bases in a mirror match, where faction cannot;
   * see {@link slotsByOwner}.
   */
  spawnLocations?: readonly [number, number];
  /**
   * The map's start waypoints, indexed the way `spawnLocations` indexes
   * them. Together they identify which decoded base belongs to which
   * player; see {@link slotsByOwner}.
   */
  spawnCells?: readonly { x: number; y: number }[];
  /**
   * Decoded unit production: which player started building what, and when.
   *
   * Vehicles are queued at the real factory rather than spawned where they
   * were first noticed. That matters for fidelity: Nod delivers vehicles by
   * cargo plane onto the airstrip, so a decoded spawn dropped them at a
   * random spot on the map with no plane and no airstrip involved.
   */
  unitRuns?: readonly {
    owner: number;
    name: string;
    start: number;
    /** Milliseconds when it finished or was given up on. */
    end?: number;
    /** False when the player cancelled it. */
    done?: boolean;
  }[];
  /**
   * Decoded move orders: when each player clicked, and the cell they
   * clicked on. The only player command the replay records.
   */
  moveOrders?: readonly { t: number; owner: number; cellX: number; cellY: number }[];
  /**
   * How many units each slot lost, as the game counted them at the end: the
   * other player's tally from the score screen. Absent for a match that
   * reached no score screen, and then nothing is made up.
   */
  unitLosses?: readonly [number, number];
  /**
   * Each time a player clicked an object as the target of an order: an
   * attack, or a unit sent onto something. `key` is the object's record key.
   */
  targetClicks?: readonly { t: number; owner: number; key: number }[];
  /**
   * Everything the players sent the game: clicks, drag boxes, control group
   * keys, sidebar and unit requests, each with the house that sent it. See
   * readInputs.
   */
  playerInputs?: readonly { t: number; owner: number; code: number; event: number; data: Uint8Array }[];
  /**
   * What to add to an input's pixel position to put it in world pixels: the
   * same origin the recorded unit positions are measured from, which is the
   * corner of the map's playable area (readObjectTracks measures it).
   */
  inputOrigin?: { x: number; y: number };
  /** Control groups the players set, one entry per press of ctrl+N. */
  controlGroups?: readonly { t: number; owner: number; group: number; size: number }[];
  /**
   * Decoded credit balances. These replace the simulated economy outright:
   * the model only ever approximated harvesting, and this is what the players
   * actually had.
   */
  creditSamples?: readonly { t: number; owner: number; credits: number }[];
}

/**
 * Which house is which player slot.
 *
 * **Spawn waypoint.** The decisive rule. A Construction Yard stands where the
 * MCV unpacked, which is the map's start waypoint, and the ladder reports each
 * player's start as an index into that same waypoint list. So matching each
 * decoded yard to the nearer of the two reported waypoints names both sides.
 * The yards land almost exactly on them — (49,48) against waypoint (49,49),
 * (14,13) against (14,14), (9,13) against (9,14) — and this works in a mirror,
 * where nothing about the factions distinguishes anyone.
 *
 * Verified against 10 mixed-faction matches where faction independently gives
 * the answer: **10 correct, 0 wrong**.
 *
 * **Faction.** Fallback for a replay with no usable waypoint data. Only Nod
 * builds a Hand of Nod, only GDI a Barracks, so a mixed matchup settles itself.
 *
 * **First build.** Last resort, keeping the sides at least self-consistent.
 *
 * Two earlier rules were tested and discarded. Keying on the house index in
 * the object records — the claim that houses are handed out in the replay's
 * `playerList` order — matched 12 of 18 mixed replays, which is chance; the
 * owner bytes are 0x8, 0xa, 0xe, 0x10 and 0x12, so players get arbitrary
 * multiplayer slots. Ordering the two bases west-to-east against the location
 * indices scored 3 of 10, because `location` is not a left-right ordinal: it
 * is a waypoint number, and Heavy Metal games use 0/1 or 2/3 depending on
 * which corners were assigned.
 */
/**
 * A unit's full path thinned to the points a straight line between neighbours
 * cannot stand in for.
 *
 * The game records a position every frame a unit moves, most of them on a
 * straight run at a steady pace, where the line joining the run's ends already
 * says where it was. A point is kept when dropping it would put the unit more
 * than `tolPx` from where the game drew it at any recorded frame, or when the
 * gap to the last kept point would exceed `maxGapMs`. At a pixel that keeps
 * about one point in five (2.34M down to 430k over three ladder replays, see
 * _pathcheck.ts), and the simulation then places units a median 0.3px from
 * where the game drew them, 99% within a pixel (_pathsim.ts).
 */
/** Silence in a round's path that ends one flight. */
const FLIGHT_GAP_MS = 250;
/** A step back against its flight this long starts a new round. */
const FLIGHT_BACK_PX = 8;
/** As does a leap this long across a silence this long. */
const FLIGHT_LEAP_PX = 40;
const FLIGHT_LEAP_GAP_MS = 80;

/** How far a thinned path may stray from the drawn one, in pixels. */
const PATH_TOLERANCE_PX = 1;
/** And the longest it may go between points regardless, in ticks. */
const PATH_MAX_GAP_TICKS = 30;

export function simplifyPath<P extends { t: number; px: number; py: number }>(path: readonly P[], tolPx: number, maxGapMs: number): P[] {
  if (path.length <= 2) return path.slice();
  const kept: P[] = [path[0]!];
  let a = 0;
  // Grow the run from `a` while every point inside it sits on the line.
  let j = a + 1;
  while (j < path.length) {
    const A = path[a]!;
    const B = path[j]!;
    let fits = B.t - A.t <= maxGapMs;
    for (let k = a + 1; fits && k < j; k++) {
      const p = path[k]!;
      const f = B.t > A.t ? (p.t - A.t) / (B.t - A.t) : 0;
      if (Math.hypot(A.px + (B.px - A.px) * f - p.px, A.py + (B.py - A.py) * f - p.py) > tolPx) fits = false;
    }
    if (fits) { j++; continue; }
    // The run ends at the point before the one that broke it.
    a = Math.max(a + 1, j - 1);
    kept.push(path[a]!);
    j = a + 1;
  }
  if (kept[kept.length - 1] !== path[path.length - 1]) kept.push(path[path.length - 1]!);
  return kept;
}

export function slotsByOwner(
  orders: ReplayBuildOrders,
  factions: [string, string],
  spawnLocations?: readonly [number, number],
  spawnCells?: readonly { x: number; y: number }[],
): Map<number, 0 | 1> {
  const NOD_ONLY = new Set(["HAND", "AFLD", "OBLI", "SAM", "TMPL"]);
  const GDI_ONLY = new Set(["PYLE", "WEAP", "ATWR", "GTWR", "EYE"]);
  const owners = [...orders.byOwner.entries()].sort(
    (a, b) =>
      (a[1][0]?.completedAt ?? a[1][0]?.placedAt ?? 0) - (b[1][0]?.completedAt ?? b[1][0]?.placedAt ?? 0),
  );
  const out = new Map<number, 0 | 1>();

  // Where this owner's base is anchored: its Construction Yard, or failing
  // that the centre of everything it built.
  const anchorOf = (list: (typeof owners)[number][1]) => {
    const yard = list.find((e) => e.name === "FACT" && e.cellX !== null && e.cellY !== null);
    if (yard) return { x: yard.cellX!, y: yard.cellY! };
    const cells = list.filter((e) => e.cellX !== null && e.cellY !== null);
    if (!cells.length) return null;
    return {
      x: cells.reduce((s, e) => s + e.cellX!, 0) / cells.length,
      y: cells.reduce((s, e) => s + e.cellY!, 0) / cells.length,
    };
  };

  const knownSpawns =
    spawnLocations !== undefined && spawnLocations[0] >= 0 && spawnLocations[1] >= 0;
  if (knownSpawns && spawnCells && owners.length === 2) {
    const wp0 = spawnCells[spawnLocations[0]];
    const wp1 = spawnCells[spawnLocations[1]];
    const a0 = anchorOf(owners[0]![1]);
    const a1 = anchorOf(owners[1]![1]);
    if (wp0 && wp1 && a0 && a1 && spawnLocations[0] !== spawnLocations[1]) {
      const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y);
      // Take the pairing that puts both yards nearer their own waypoint.
      const straight = d(a0, wp0) + d(a1, wp1);
      const swapped = d(a0, wp1) + d(a1, wp0);
      out.set(owners[0]![0], straight <= swapped ? 0 : 1);
      out.set(owners[1]![0], straight <= swapped ? 1 : 0);
      return out;
    }
  }

  if (factions[0] !== factions[1]) {
    for (const [owner, list] of owners) {
      let nod = 0;
      let gdi = 0;
      for (const e of list) {
        if (NOD_ONLY.has(e.name)) nod++;
        if (GDI_ONLY.has(e.name)) gdi++;
      }
      if (nod && !gdi) out.set(owner, factions[0] === "NOD" ? 0 : 1);
      else if (gdi && !nod) out.set(owner, factions[0] === "GDI" ? 0 : 1);
    }
    if (out.size === owners.length && new Set(out.values()).size === out.size) return out;
    out.clear();
  }

  let next: 0 | 1 = 0;
  for (const [owner] of owners) {
    if (out.has(owner)) continue;
    out.set(owner, next);
    next = next === 0 ? 1 : 0;
  }
  return out;
}/**
 * Turn decoded build orders into a command stream.
 *
 * Timing uses `completedAt` — when the sidebar item finished, from the
 * sidebar stream — falling back to when the object was first seen. The
 * Construction Yard becomes the deploy command so the sim starts each side at
 * its real base rather than the map's nominal spawn.
 */
export function commandsFromReal(inputs: RealReplayInputs): ReplayCommand[] {
  const { orders, header, mapWidth, mapHeight } = inputs;
  const factions: [string, string] = [header.players[0].faction, header.players[1].faction];
  const slots = slotsByOwner(orders, factions, inputs.spawnLocations, inputs.spawnCells);
  const cmds: ReplayCommand[] = [];
  /** Every moment a player's selection changed, before grouping into actions. */
  const selectionChangedAt: { p: 0 | 1; t: number }[] = [];
  const tick = (ms: number) => Math.max(0, Math.round((ms / 1000) * TICK_HZ));
  const inBounds = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < mapWidth && y < mapHeight;

  /**
   * When each player's Construction Yard was first sighted.
   *
   * The MCV unpacking is the one structure that is not built, so nothing in
   * the production records marks the moment. The yard's own first sighting
   * does.
   */
  /** Refs handed to replayed objects, so a command can name one. */
  let unitRef = 1;

  const firstSeenFact = new Map<0 | 1, number>();
  /**
   * Every sighting of each player's MCV, however few there are.
   *
   * Taken from all its track segments rather than one, because the stream
   * barely follows an MCV: one player's is sighted a single time in its whole
   * life, which is below the two the unit loop needs to call something a route
   * and is why it was skipped entirely.
   */
  const mcvSeen = new Map<0 | 1, { t: number; px: number; py: number }[]>();
  const mcvPath = new Map<0 | 1, { path: { t: number; px: number; py: number }[]; frames: number[] }>();
  for (const track of inputs.objectTracks ?? []) {
    if (track.name !== "MCV") continue;
    const owner = slots.get(track.owner);
    if (owner === undefined) continue;
    const list = mcvSeen.get(owner) ?? [];
    for (const q of track.samples) {
      list.push({
        t: tick(q.pt ?? q.t),
        px: q.px ?? q.cellX * CELL + CELL / 2,
        py: q.py ?? q.cellY * CELL + CELL / 2,
      });
    }
    mcvSeen.set(owner, list);
    // And its full path, every frame it moved, with its frames: the MCV drives
    // from the frame the player sent it, rather than gliding from the start
    // between sightings.
    if (track.path?.length) {
      const full = mcvPath.get(owner) ?? { path: [], frames: [] };
      for (const q of track.path) full.path.push({ t: (q.t / 1000) * TICK_HZ, px: Math.round(q.px), py: Math.round(q.py) });
      for (const q of track.shapes ?? []) if (q.v < 32) full.frames.push((q.t / 1000) * TICK_HZ, q.v);
      mcvPath.set(owner, full);
    }
  }
  for (const track of inputs.objectTracks ?? []) {
    if (track.name !== "FACT" || track.samples.length === 0) continue;
    const owner = slots.get(track.owner);
    if (owner === undefined) continue;
    const at = tick(track.samples[0]!.t);
    const cur = firstSeenFact.get(owner);
    if (cur == null || at < cur) firstSeenFact.set(owner, at);
  }

  const unbuilt = ordersNeverBuilt(orders, (inputs.objectTracks as ObjectTracks | undefined)?.structureFrames ?? []);
  for (const [owner, list] of orders.byOwner) {
    const p = slots.get(owner);
    if (p === undefined) continue;
    let deployed = false;
    for (const e of list) {
      const kind = KIND_BY_ASSET[e.name];
      if (!kind) continue;
      if (e.cellX === null || e.cellY === null) continue;
      // The cell in the recording is where the building is *drawn* from —
      // `Cell_X(Coord_Cell(Render_Coord()))`, and a building renders from its
      // centre — so the top-left is that cell less the centre's own offset.
      // Read as the origin it put everything bigger than two cells down and to
      // the right of where it stood.
      const [ox, oy] = bldgCenterCell(kind);
      const x = Math.round(e.cellX) - ox;
      const y = Math.round(e.cellY) - oy;
      if (!inBounds(x, y)) continue;
      // A structure reaches the map when its sidebar item finishes, not when
      // it is queued. Timing placements by `queuedAt` put every early
      // building on the ground a whole build too soon — the Refinery by 14
      // seconds, the Power Plant and Hand of Nod by 7 — so bases assembled
      // themselves before the player had paid for them.
      const t = tick(e.completedAt ?? e.placedAt);
      // The build order is a different question from where the building is.
      // A player's order is what they started and when they started it, so
      // the list wants the queue moment while the map wants the finish. Both
      // are decoded, so both are sent: the placement rides on `t` and the
      // queue moment on `target`, which a placement has no other use for.
      const queuedTick = e.queuedAt == null ? undefined : tick(e.queuedAt);
      if (kind === "fact" && !deployed) {
        // A Construction Yard is not built — it is the MCV each player starts
        // with, driven somewhere and unpacked. So the yard cell is really the
        // MCV's destination: order the MCV there at t=0 and let it deploy on
        // arrival. A player who unpacked on the spot barely moves; one who
        // relocated first is shown doing exactly that.
        //
        // The deploy tick comes from the decoded first-production time (see
        // readBuildOrdersFromProduction), which bounds when the yard must
        // already have been standing.
        // When the yard actually appeared, if the recording saw it.
        //
        // The production time only bounds this: it says the yard must already
        // have been standing by then, not when it went up. The stream sights
        // the Construction Yard itself, and that is the moment the MCV
        // unpacked — 5.4s and 9.1s in the reference match, against the 6.8s
        // and 10.5s production implies. Both players therefore sat motionless
        // through the opening seconds of every replay, when what they were
        // really doing was driving off and unpacking.
        const seen = firstSeenFact.get(p);
        const deployTick = seen != null ? Math.min(seen, t) : t;
        // Drive it there, rather than leaving it parked until it pops into a
        // building. Both MCVs stood perfectly still for the first five seconds
        // of every replay and then a Construction Yard simply appeared.
        //
        // The route is the sightings there are, bracketed by where the unit
        // starts and the cell it unpacked on. Two of those three are recorded;
        // the line between them is not, and a player crossing open ground to a
        // spot they have already chosen drives roughly straight, so a straight
        // line is the honest reading. It arrives as the yard goes up.
        const ref = unitRef++;
        const route = (mcvSeen.get(p) ?? []).slice().sort((a2, b2) => a2.t - b2.t);
        const startPx = route[0]?.px ?? x * CELL + CELL / 2;
        const startPy = route[0]?.py ?? y * CELL + CELL / 2;
        cmds.push({
          t: 0, p, k: "spawn", kind: "mcv", x: Math.floor(startPx / CELL), y: Math.floor(startPy / CELL),
          ref, px: startPx, py: startPy, real: true,
        });
        for (const q of route) {
          if (q.t <= 0 || q.t >= deployTick) continue;
          cmds.push({
            t: q.t, p, k: "move", kind: "mcv", x: Math.floor(q.px / CELL), y: Math.floor(q.py / CELL),
            ref, px: q.px, py: q.py, real: true, silent: true,
          });
        }
        cmds.push({
          t: Math.max(1, deployTick), p, k: "move", kind: "mcv", x, y,
          ref, px: x * CELL + CELL / 2, py: y * CELL + CELL / 2, real: true, silent: true,
        });
        const full = mcvPath.get(p);
        if (full && full.path.length > 1) {
          const kept = simplifyPath(full.path.sort((a2, b2) => a2.t - b2.t), PATH_TOLERANCE_PX, PATH_MAX_GAP_TICKS);
          cmds.push({
            t: Math.floor(kept[0]!.t), p, k: "path", ref, real: true, silent: true,
            path: kept.flatMap((q) => [q.t, q.px, q.py]),
            ...(full.frames.length ? { frames: full.frames } : {}),
          });
        }
        cmds.push({ t: deployTick, p, k: "deploy", x, y, real: true, ...(queuedTick != null ? { target: queuedTick } : {}) });
        deployed = true;
        continue;
      }
      if (unbuilt.has(e)) continue;
      cmds.push({ t, p, k: "place", kind, x, y, real: true, ...(queuedTick != null ? { target: queuedTick } : {}) });
    }
    // Deliberately no fallback Construction Yard. If no FACT record appears
    // for a side, inventing one both blocks real placements (the sim rejects
    // structures overlapping it) and can be flatly wrong — selling the MCV is
    // ordinary play, and a player who did that genuinely has no yard.
  }
  // Vehicles come out of the building that made them. The production stream
  // gives the exact moment each one entered the queue, so it is fed to the
  // real factory and rolls out (or is flown in) the way the game does it.
  for (const run of inputs.unitRuns ?? []) {
    const p3 = slots.get(run.owner);
    if (p3 === undefined) continue;
    const kind = UNIT_BY_ASSET[run.name];
    if (!kind) continue;
    // Harvesters arrive free with a refinery and are tracked from the replay;
    // an MCV is a starting unit, not something produced.
    if (kind === "harv" || kind === "mcv") continue;
    if (!VEHICLES.has(kind)) continue;
    cmds.push({ t: tick(run.start), p: p3, k: "queue", kind, real: true });
  }

  // The production queue as the players saw it, for the sidebar.
  //
  // Every run, not just the vehicles the simulation builds: a queue shows
  // structures and infantry too. Nothing here drives the simulation — `queue`
  // above does that — so this is silent, and carries only what a sidebar needs
  // to draw one item: when it entered the queue, how long it took, and whether
  // it finished or the player changed their mind.
  for (const run of inputs.unitRuns ?? []) {
    const p4 = slots.get(run.owner);
    if (p4 === undefined) continue;
    const kind: EntityKind | undefined = UNIT_BY_ASSET[run.name] ?? KIND_BY_ASSET[run.name];
    if (!kind) continue;
    const from = tick(run.start);
    const took = run.end === undefined ? 1 : Math.max(1, tick(run.end) - from);
    cmds.push({
      t: from,
      p: p4,
      k: "build",
      kind,
      target: took,
      id: run.done === false ? 0 : 1,
      real: true,
      silent: true,
    });
  }

  // Units and infantry carry the same owner byte as structures, so they can
  // be attributed and placed where they were actually first seen. The object
  // stream samples sparsely, so this is where a unit was *noticed*, not
  // necessarily where it was produced.
  for (const u of inputs.includeUnits ? orders.units : []) {
    const p2 = slots.get(u.owner);
    if (p2 === undefined) continue;
    const kind = UNIT_BY_ASSET[u.name];
    if (!kind) continue;
    if (u.cellX === null || u.cellY === null) continue;
    const x = Math.round(u.cellX);
    const y = Math.round(u.cellY);
    if (!inBounds(x, y)) continue;
    // The MCV becomes the Construction Yard via the deploy command; spawning
    // it as well would leave a phantom MCV parked in the base all match.
    if (kind === "mcv") continue;
    // Harvesters are emitted above with their full route, not as a one-off
    // spawn at wherever they were first noticed.
    if (kind === "harv") continue;
    // Queued above, so they arrive from their factory instead of appearing
    // wherever the object stream happened to first notice them.
    if (VEHICLES.has(kind) && inputs.unitRuns?.length) continue;
    // Aircraft are skipped. The object stream only ever gives a first sighting,
    // so a cargo plane would hang motionless over the base for the rest of the
    // match, and every extra standing unit costs simulation time for no gain.
    if (u.dllType === 3) continue;
    cmds.push({ t: tick(u.firstSeen), p: p2, k: "spawn", kind, x, y, real: true });
  }

  // How long after a track's last sample the match must still run before that
  // silence counts as a death rather than the recording simply ending.
  const TRACK_SURVIVOR_MS = 3000;
  /**
   * The same, for a unit whose end has a witness — next to no health left, or
   * an explosion where it stood. A living unit is restated every 0.2-0.6s, so
   * a second of silence after that is enough; the full three seconds was
   * leaving every death of a match's closing fight standing to the end.
   */
  const WITNESSED_SURVIVOR_MS = 1000;
  /**
   * Where things blew up, bucketed by the second they blew up in.
   *
   * A vehicle that dies leaves an explosion behind it. Infantry do not — their
   * death is an animation on the sprite rather than a separate effect — but an
   * infantryman killed by a shell is standing in one all the same.
   */
  const blasts = new Map<number, { x: number; y: number }[]>();
  for (const track of inputs.objectTracks ?? []) {
    if (!DEATH_BLASTS.has(track.name as CombatEffect)) continue;
    const at = track.samples[0];
    if (!at) continue;
    const bin = Math.floor(at.t / BLAST_BIN_MS);
    const list = blasts.get(bin);
    if (list) list.push({ x: at.cellX, y: at.cellY });
    else blasts.set(bin, [{ x: at.cellX, y: at.cellY }]);
  }
  /**
   * Whether something exploded on this spot at about this moment. The wider
   * reach is only ever used to rank the tracks that make up the score
   * screen's count, never to convict one on its own.
   */
  const blastAt = (x: number, y: number, at: number, cells = BLAST_CELLS, window = BLAST_WINDOW_MS): boolean => {
    const lo = Math.floor((at - window) / BLAST_BIN_MS);
    const hi = Math.floor((at + window) / BLAST_BIN_MS);
    for (let bin = lo; bin <= hi; bin++) {
      const here = blasts.get(bin);
      if (!here) continue;
      for (const b of here) {
        if (Math.abs(b.x - x) + Math.abs(b.y - y) <= cells) return true;
      }
    }
    return false;
  };
  /** Health left at a unit's last sighting for that sighting to be its death. */
  const UNIT_DEAD_FRACTION = 0.25;
  /**
   * How whole a unit may have been at its last sighting and still be taken as
   * one of the deaths the score screen counted.
   *
   * A unit that parks is restated no more often than one that dies, so the
   * only thing separating them is damage: a unit that had taken none is left
   * alone however long ago it was last seen.
   */
  const LOST_MAX_HEALTH_FRACTION = 0.9;
  /**
   * How far and how long around a last sighting an explosion still counts as
   * possibly this unit's, when making up the score screen's count. Wider
   * than the test that convicts a death on its own (2 cells, 1.5s), because
   * here it only orders candidates and the total is already known.
   */
  const LOST_BLAST_CELLS = 4;
  const LOST_BLAST_WINDOW_MS = 3000;
  const lastFrameMs = Math.max(
    0,
    ...(inputs.objectTracks ?? []).map((t) => t.samples[t.samples.length - 1]?.t ?? 0),
  );

/**
 * Whether a sample has moved far enough in pixels to be worth a waypoint.
 *
 * Cell changes alone throw away everything the render position adds: a unit
 * crossing a cell slowly would emit one waypoint for 24 pixels of travel. Half
 * a cell keeps the path faithful without flooding the command stream.
 */
/**
 * Flips this close together are one selection. Gaps between flips are bimodal
 * with nothing at all in 10-20ms: inside one selection they are under 10ms,
 * between separate actions they start at 20ms.
 */
const SELECTION_ACTION_MS = 20;
/**
 * Effect art that is one block of frames per facing, and how it is laid out.
 *
 * Read off the files themselves. MINIGUN.SHP holds 48 frames — eight facings
 * of six animation steps, facing-major — and PIFFPIFF.SHP holds eight, one
 * per facing with no animation.
 *
 * GUNFIRE is deliberately absent. It has three frames, so it cannot be eight
 * of anything: it is a plain three-step animation and belongs on the timer.
 * Treating it as directional multiplied a facing by the step count and landed
 * outside the file, which the drawing modulo then scattered across all three
 * frames — the very flicker the directional handling exists to stop.
 */
/** Every directional effect in TD uses eight facings. */
const FLASH_FACINGS = 8;
/**
 * The effects that are a weapon firing, as opposed to a round landing.
 *
 * Only these say who shot. PIFF and the fireballs mark where the round hit,
 * so the unit nearest one of those is the target rather than the shooter.
 */
const MUZZLE_FLASHES: ReadonlySet<CombatEffect> = new Set<CombatEffect>(["MINIGUN", "GUNFIRE"]);

const DIRECTIONAL_FLASHES: ReadonlyMap<CombatEffect, { facings: number; steps: number }> = new Map([
  ["MINIGUN", { facings: 8, steps: 6 }],
  ["PIFFPIFF", { facings: 8, steps: 1 }],
]);

/**
 * How near in time and space the shooter must be to own the flash.
 *
 * Set from the measured gap rather than guessed. A flash sits on its shooter —
 * 87% land within one cell of a unit and 95% within two — so distance was
 * never the binding constraint: widening the radius alone moved coverage not
 * at all. Time was. Units are restated a median 220ms apart but a p90 of
 * 638ms, so a 400ms window clipped the tail and lost a quarter of the flashes.
 * At two cells and 800ms, 95% of them find their shooter.
 */
const FLASH_SHOOTER_MS = 800;
const FLASH_SHOOTER_CELLS = 2;
/**
 * How far a unit must have moved before its new position becomes a waypoint.
 *
 * One pixel: every sighting the recording gives is used. This was half a cell,
 * which is where the walking stutter came from — a Minigunner covers about
 * 1.7 pixels a tick, so twelve of them took seven ticks. The unit stood still
 * for very nearly half a second, then slid a full half-cell at once, over and
 * over. It matched the measurement exactly: mid-journey pauses had a median of
 * eight to nine ticks, which is the time it takes to earn a waypoint.
 *
 * A sighting is a fact about where the unit was. Discarding four in five of
 * them to save commands is what made the motion synthetic.
 */
const PIXEL_WAYPOINT = 1;

/** The Nod airstrip's cargo plane, whose flight the replay records in full. */
const CARGO_PLANE = "C17";

/**
 * How close two cargo-plane tracks must be in time to be the same delivery.
 *
 * The pair's ends land within a frame or two of each other, so a fifth of a
 * second is ample to bracket them and far short of the gap between two real
 * deliveries.
 */
const CARGO_PAIR_MS = 200;


/**
 * The longest gap between waypoints that is treated as one continuous move.
 *
 * Four ticks. Beyond that the unit really had stopped, and stretching a leg
 * across the pause only slows it down: at eight ticks the freezes stayed
 * exactly where they were while a buggy fell from 2.23 cells a second to 1.78.
 */
const WAYPOINT_GAP_TICKS = 4;

/** How near a repair press its building's flash must be, in milliseconds. */
const REPAIR_FLASH_MS = 400;

/**
 * How long a gap in the health rises ends a repair, in milliseconds.
 *
 * A step lands every 0.33s while the repair runs — 418 of 426 measured rises
 * are exactly the +5 of REPAIR_STEP — so a second of nothing is three steps
 * missed, which means it stopped: whole again, out of money, or pressed off.
 */
const REPAIR_STEP_GAP_MS = 1000;

/** How long after a structure's last sighting its refund should land. */
const SELL_REFUND_TICKS = 45;

/**
 * How near a structure's last sighting the player's sell press has to be for
 * that building to be the one they sold: up to two and a half seconds before
 * it went, or half a second after.
 *
 * Measured over eight matches. Of 83 sell presses, 67 have a building of that
 * player's leaving the recording, a median 0.1s later and nine in ten inside
 * 1.2s — the building goes as the press lands.
 */
const SELL_PRESS_BEFORE_TICKS = 38;
const SELL_PRESS_AFTER_TICKS = 8;

/** How far the refund may sit from half the price and still be one. */
const SELL_REFUND_TOLERANCE = 0.08;

/** A structure is only gone if the recording ran on well past its last sighting. */
const STRUCTURE_GONE_TICKS = 75;

/** How near an existing kill or sale must be for a handed-on key's building to be that one. */
const HANDOVER_KILL_CELLS = 2;
/** And how near in time, around the building's last sign of life and the handover, in ticks. */
const HANDOVER_KILL_SLACK_TICKS = 20 * TICK_HZ;

/** How near a flight must pass a strip for that strip to claim it. */
const CARGO_STRIP_CELLS = 6;

/** How close in time and place a turret reading has to be to its hull. */
/** How long a turret angle stays valid after its last reading. */
const TURRET_CARRY_MS = 6000;
const TURRET_MATCH_CELLS = 1;
/** How close in time two samples must be to be read as the same moment. */
const TURRET_PAIR_MS = 600;
/** Co-located samples needed before a turret is assigned to a hull. */
const TURRET_PAIR_MIN_VOTES = 3;

function movedPixels(
  s: { px?: number; py?: number },
  lastPx: number,
  lastPy: number,
): boolean {
  if (s.px == null || s.py == null) return false;
  if (!Number.isFinite(lastPx) || !Number.isFinite(lastPy)) return true;
  return Math.abs(s.px - lastPx) + Math.abs(s.py - lastPy) >= PIXEL_WAYPOINT;
}

/**
 * Whether a sighting that says the unit has not moved still says something.
 *
 * A waypoint carries the heading and the health as well as the place, so a
 * sighting kept only for the place was throwing the other two away whenever
 * the unit happened to be standing still. Over a match that lost 1681-3067
 * changes of heading and 2102-2250 changes of health, and the headings are the
 * ones that show: a vehicle turns on the spot before it drives off, and 103-149
 * of a harvester's turns a match were turns it made while parked. With them
 * gone it sat facing the wrong way and then snapped round the instant it
 * started moving.
 *
 * These waypoints repeat the position, which is what collapseStops is for --
 * a run of them is read back as one stop rather than as a crawl.
 */
function standing(
  s: { shape?: number; hp?: number },
  lastShape: number | undefined,
  lastHp: number | undefined,
): boolean {
  if (s.shape != null && s.shape !== lastShape) return true;
  return s.hp != null && s.hp !== lastHp;
}

  // Turrets are their own objects.
  //
  // The DLL exports a vehicle's turret as a sub-object with its own record, so
  // a Buggy reaches the stream as two keys: the hull, whose frames are 0..31,
  // and the turret, whose frames are 32..63. Of 80 Buggy keys in the sample
  // match, 39 are pure hull and 41 pure turret, with none mixed.
  //
  // Spawning both put a second Buggy on top of every real one — roughly half
  // the vehicles on screen were turrets being drawn as whole units.
  //
  // A Harvester's 32+ frames are *not* a turret: they are the digging pose,
  // the same directions with the arms swung out. Its keys are mixed rather
  // than split, which is exactly how the two cases tell themselves apart.
  // A turret carries no strength of its own.
  //
  // CNCObjectStruct has a SubObject field and strength lives on the parent,
  // so a turret reports 0 for its whole life while its hull reports a real
  // value. Against the shape test this used to rely on — over 95% of frames
  // in 32..63 — the two agree on all 140 Buggy tracks of the reference
  // replay, 71 turrets and 69 hulls with nothing misfiled either way.
  //
  // Strength is the better test because it needs no sample budget: the shape
  // test had to see 20 frames before it would judge, so every short-lived
  // vehicle went unclassified and its turret was spawned as a second buggy.
  //
  // A Harvester's 32+ frames are not a turret — they are the digging pose,
  // the same directions with the arms swung out — and it reports strength
  // like any other hull, so it never reaches this test.
  const peakStrength = (t: ObjectTrack): number => {
    let peak = 0;
    for (const s of t.samples) if (s.hp != null && s.hp > peak) peak = s.hp;
    return peak;
  };
  const turretTrack = new Set<ObjectTrack>();
  const hullTracks: ObjectTrack[] = [];
  for (const t of inputs.objectTracks ?? []) {
    const kind = UNIT_BY_ASSET[t.name];
    if (!kind || kind === "harv" || !UNIT_DEFS[kind]?.turret) continue;
    if (peakStrength(t) === 0) turretTrack.add(t);
    else hullTracks.push(t);
  }

  // Pair each turret with the one hull it rides on, once.
  //
  // The previous join asked, for every waypoint, which turret reading of this
  // player last stood on this cell. That misses whenever the two are restated
  // a moment apart, and with a one-cell tolerance it can hand a vehicle its
  // neighbour's gun. The object record carries no link to the parent — every
  // offset was checked at u16 and u32 against 112 turret records whose hull
  // was known, and nothing names it — so the pairing is derived instead:
  // whichever hull a turret shares a cell with most often is its hull, and
  // that holds for the turret's whole life. Every turret pairs, and coverage
  // goes from 82-91% of waypoints to 93-96%.
  const turretShapesFor = new Map<ObjectTrack, { t: number; v: number }[]>();
  /** The same, every frame the game drew the turret with: its turn, frame by frame. */
  const turretFramesFor = new Map<ObjectTrack, { t: number; v: number }[]>();
  {
    const positions = new Map<ObjectTrack, { t: number; x: number; y: number }[]>();
    for (const h of hullTracks) {
      positions.set(h, h.samples.map((q) => ({ t: q.t, x: q.cellX, y: q.cellY })).sort((a, b) => a.t - b.t));
    }
    // The sighting nearest in time, the earliest of any tied: a binary search
    // over the sorted positions, where a scan of every one was quadratic in
    // the length of the match.
    const nearestAt = (a: { t: number; x: number; y: number }[], t: number) => {
      let lo = 0;
      let hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid]!.t < t) lo = mid + 1;
        else hi = mid;
      }
      let best: { t: number; x: number; y: number } | undefined;
      let bd = Infinity;
      if (lo > 0) {
        let j = lo - 1;
        while (j > 0 && a[j - 1]!.t === a[j]!.t) j--;
        best = a[j];
        bd = t - a[j]!.t;
      }
      if (lo < a.length && a[lo]!.t - t < bd) {
        best = a[lo];
        bd = a[lo]!.t - t;
      }
      return bd <= TURRET_PAIR_MS ? best : undefined;
    };
    for (const turret of turretTrack) {
      const votes = new Map<ObjectTrack, number>();
      for (const s of turret.samples) {
        for (const h of hullTracks) {
          if (h.owner !== turret.owner) continue;
          const q = nearestAt(positions.get(h)!, s.t);
          if (!q) continue;
          if (Math.abs(q.x - s.cellX) + Math.abs(q.y - s.cellY) > TURRET_MATCH_CELLS) continue;
          votes.set(h, (votes.get(h) ?? 0) + 1);
        }
      }
      let hull: ObjectTrack | undefined;
      let bestVotes = 0;
      for (const [h, n] of votes) if (n > bestVotes) { bestVotes = n; hull = h; }
      if (!hull || bestVotes < TURRET_PAIR_MIN_VOTES) continue;
      const series = turretShapesFor.get(hull) ?? [];
      for (const q of turret.samples) if (q.shape != null) series.push({ t: q.t, v: q.shape });
      series.sort((a, b) => a.t - b.t);
      turretShapesFor.set(hull, series);
      if (turret.shapes?.length) {
        const dense = turretFramesFor.get(hull) ?? [];
        dense.push(...turret.shapes);
        dense.sort((a, b) => a.t - b.t);
        turretFramesFor.set(hull, dense);
      }
    }
  }

  /**
   * The angle this hull's turret was last known to be pointing.
   *
   * Carrying the last reading forward is what the engine does between
   * updates: a turret keeps pointing where it was pointing until it is told
   * otherwise, and it is restated far less often than its hull moves.
   */
  function turretShapeForHull(hull: ObjectTrack, t: number): number | undefined {
    const series = turretShapesFor.get(hull);
    if (!series || !series.length) return undefined;
    let best: number | undefined;
    for (const q of series) {
      if (q.t > t) break;
      if (t - q.t > TURRET_CARRY_MS) continue;
      best = q.v;
    }
    // Before the first reading, the earliest angle is the best evidence there
    // is — the alternative is drawing the gun straight ahead, which is wrong
    // in a way the recording plainly contradicts.
    return best ?? (series[0]!.t - t <= TURRET_CARRY_MS ? series[0]!.v : undefined);
  }
  // Every mobile unit, driven by where it really was.
  //
  // Each decoded track is spawned at its first sample and then given a move
  // order for every cell it changed to, so it drives the route it actually
  // drove. Waypoints are marked silent: they arrive several times a second per
  // unit and are not clicks, so they must not show a click ring or count
  // toward APM.
  //
  // A refinery already produces a harvester, so a decoded harvester is adopted
  // by the simulation rather than added a second time (see the "spawn" case).
  /** The entity ref each decoded track was given, so a flash can name its shooter. */
  const trackRef = new Map<ObjectTrack, number>();
  /**
   * Tracks whose key the game later handed to another object.
   *
   * The key is the object's identity, not a free slot: it is held while the
   * object is only out of sight. A harvester unloading is put in limbo
   * (UNIT.CPP:1819) and limboed objects are not exported at all
   * (DLLInterface.cpp:3382), so its track has a 13.5-second hole in it while
   * it is provably still alive — and across 133 of those holes, in four
   * matches, not one key was taken by anything else.
   *
   * So a track followed by a second object on the same key is a unit that has
   * left the map, however healthy its last sighting was. That is the only
   * evidence there is for the ones health and explosions miss: 8 of 15 in one
   * match, and the ones it catches are the ones that stood longest.
   */
  const structureGone = structureLosses(inputs.objectTracks ?? [], inBounds);

  // Where each side's Refineries stood, and while, for telling an unload
  // from a stop. A Refinery counts only from its first sighting to its last:
  // a Harvester parked on the ground where one had stood before it was
  // destroyed was being read as unloading into it.
  const refinerySites = (inputs.objectTracks ?? [])
    .filter((t) => t.name === "PROC" && t.samples.length > 0)
    .flatMap((t) => {
      const from = t.samples[0]!.t;
      const to = t.samples[t.samples.length - 1]!.t;
      return t.samples.map((q) => ({ owner: t.owner, x: q.cellX, y: q.cellY, from, to }));
    });
  const atRefinery = (owner: number) => (x: number, y: number, t: number) =>
    refinerySites.some(
      (r) =>
        r.owner === owner && t >= r.from && t <= r.to &&
        Math.abs(r.x - x) <= STRUCTURE_SITE_CELLS && Math.abs(r.y - y) <= STRUCTURE_SITE_CELLS,
    );

  const tombOf = (track: ObjectTrack): StructureLoss | undefined => {
    const last = track.samples[track.samples.length - 1];
    return last ? tombFor(last, track.owner, structureGone) : undefined;
  };

  /**
   * Tracks that stopped early with nothing to say why, and how hurt each was
   * when it was last seen. Only used to make up the score screen's count; see
   * the budget after the track loop.
   */
  const unconvicted: { p: 0 | 1; ref: number; t: number; hurt: number | null; nearBlast: boolean }[] = [];
  /** Units that left play with no cause recorded, as their "gone" commands. */
  const leftPlay: { p: 0 | 1; t: number; gone: ReplayCommand }[] = [];

  const handedOn = new Set<ObjectTrack>();
  {
    const byKey = new Map<number, ObjectTrack[]>();
    for (const t of inputs.objectTracks ?? []) {
      byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
    }
    for (const [, group] of byKey) {
      if (group.length < 2) continue;
      for (const t of group) {
        const end = t.samples[t.samples.length - 1]?.t;
        if (end == null) continue;
        if (group.some((u) => u !== t && (u.samples[0]?.t ?? -1) >= end)) handedOn.add(t);
      }
    }
  }

  for (const track of inputs.objectTracks ?? []) {
    const kind = UNIT_BY_ASSET[track.name];
    if (kind === undefined) continue;          // structures, effects, aircraft
    // The MCV is routed with the deploy above, from all of its segments at
    // once. Letting it through here as well spawned a second one beside the
    // first, which is where the 1300-pixel jump at the opening came from.
    if (track.name === "MCV") continue;
    if (turretTrack.has(track)) continue;      // a turret, not a second vehicle
    // An aircraft's rotors are objects too: an Apache comes with two that
    // report no strength and fly exactly where it does, and spawned as units
    // they were two more Apaches under the real one.
    if (UNIT_DEFS[kind]?.aircraft && track.samples.every((q) => !q.hp)) continue;
    const p = slots.get(track.owner);
    if (p === undefined) continue;
    // One sample is a sighting, not a route; it says nothing about movement
    // and spawning from it would litter the map with units that never move.
    if (track.samples.length < 2) continue;
    const ref = unitRef++;
    trackRef.set(track, ref);
    let first = true;
    let lastX = -1;
    let lastY = -1;
    let wasSelected = false;
    let wasGroup = 255;
    let lastPx = Number.NaN;
    let lastPy = Number.NaN;
    let lastShape: number | undefined;
    let lastHp: number | undefined;
    const turretShapeAt = (s2: { t: number; cellX: number; cellY: number }): number | undefined =>
      turretShapeForHull(track, s2.t);
    let lastPt: number | undefined;
    // The first frame of a death, if the recording caught him dying.
    let died: { at: number; death: number } | null = null;
    // Every shot, from every frame. A sighting catches a firing frame now and
    // then -- a burst runs a quarter of a second against readings a median
    // 330ms apart -- and a Flamethrower's are short enough that most of his
    // went unseen, and with them the flame. With every frame on record each
    // firing sequence that starts is a shot, timed to the frame it started.
    const denseShots = !!(track.shapes?.length && INFANTRY_DOS[kind]);
    if (denseShots) {
      let wasFire = false;
      let wasStage = -1;
      for (const q of track.shapes!) {
        const at = readInfantryFrame(kind, q.v);
        // Standing or lying down: a man fires prone too.
        const fire = at?.name === "fire" || at?.name === "fireProne";
        if (fire && (!wasFire || at!.stage < wasStage)) {
          cmds.push({ t: tick(q.t), p, k: "fire", ref, real: true, silent: true });
        }
        wasFire = fire;
        wasStage = fire ? at!.stage : -1;
      }
    }
    // Every position the game drew it at, thinned to what a line cannot
    // stand in for. The waypoints below come from the movement records,
    // a median 330ms apart; joined with straight lines those sat more than a
    // quarter of a cell from the drawn position 14% of the time.
    //
    // Timed in fractions of a tick. The recording has a frame every 22ms,
    // three to a tick, and rounding each to its tick moved it by up to 33ms
    // -- three pixels for a Buggy -- which was most of the error left.
    //
    // A vehicle's frames go with it, every one the game drew: its heading as
    // it turned. The waypoints carry one every few hundred milliseconds, and
    // turning towards those at the unit's rate of turn drew a Buggy 45
    // degrees or more from the game's own frame 15% of the time.
    const kept = track.path && track.path.length > 1
      ? simplifyPath(track.path.map((q) => ({ t: (q.t / 1000) * TICK_HZ, px: Math.round(q.px), py: Math.round(q.py) })), PATH_TOLERANCE_PX, PATH_MAX_GAP_TICKS)
      : null;
    //
    // Only the body's frames. A Harvester's 32-63 are its 32 headings again
    // with the arms out, but on the other vehicles that range is the gun: a
    // Buggy's frames 32-63 sit a median 4 facings off its line of travel
    // against 1 for 0-31 (_framedir.ts). Through those the body keeps the
    // last heading it had.
    //
    // An infantryman's go too, all of them: his frame is his pose, and with
    // every one on record the viewer draws what the game drew rather than
    // modelling his walk and his shots from a reading every 0.7s.
    //
    // And an aircraft's, all of them: past 31 they are its own art, not a
    // gun -- an Orca flying fast draws its forward-tilted set, 32 on
    // (AIRCRAFT.CPP Draw_It), 44% of its frames in the recordings; a
    // Chinook with its door open, 32-35. Left out, both were drawn level and
    // shut, with headings turned by the model between sightings.
    let frames: number[] | null = null;
    const infantry = !!INFANTRY_DOS[kind];
    const aircraft = !!UNIT_DEFS[kind]?.aircraft;
    if (track.shapes && (UNIT_DEFS[kind]?.facings === 32 || infantry)) {
      frames = [];
      let last = -1;
      for (const q of track.shapes) {
        if (!infantry && !aircraft && q.v >= 32 && kind !== "harv") continue;
        if (q.v === last) continue;
        last = q.v;
        frames.push((q.t / 1000) * TICK_HZ, q.v);
      }
      if (!frames.length) frames = null;
    }
    const turretDense = turretFramesFor.get(track);
    const turretFrames = turretDense?.length ? turretDense.flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]) : null;
    const alts = track.alts?.length ? track.alts.flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]) : null;
    if (kept || frames || turretFrames || alts) {
      cmds.push({
        t: Math.floor(Math.min(kept?.[0]!.t ?? Infinity, frames?.[0] ?? Infinity, turretFrames?.[0] ?? Infinity, alts?.[0] ?? Infinity)), p, k: "path", ref, real: true, silent: true,
        ...(kept ? { path: kept.flatMap((q) => [q.t, q.px, q.py]) } : {}),
        ...(frames ? { frames } : {}),
        ...(turretFrames ? { turretFrames } : {}),
        ...(alts ? { alts } : {}),
      });
    }
    for (const s of track.samples) {
      const x = s.cellX;
      const y = s.cellY;
      if (!inBounds(x, y)) continue;
      if (!died && s.shape != null && INFANTRY_DOS[kind]) {
        const d = readInfantryDeath(kind, s.shape);
        // Dated back by how far into the sequence the frame already is, the
        // same way a shot is.
        if (d) died = { at: tick(s.t) - Math.round((d.stage * DO_RATE[d.death]) / GAME_FRAMES_PER_TICK), death: DEATHS.indexOf(d.death) };
      }
      if (first) {
        cmds.push({
          t: tick(s.t), p, k: "spawn", kind, x, y, ref, real: true,
          ...(s.hp != null ? { hp: s.hp } : {}),
          ...(s.shape != null ? { shape: s.shape } : {}),
          ...(turretShapeAt(s) != null ? { turretShape: turretShapeAt(s) } : {}),
        });
        first = false;
      } else if (x !== lastX || y !== lastY || movedPixels(s, lastPx, lastPy) || standing(s, lastShape, lastHp)) {
        // Carry the exact render position when the replay has one, so the unit
        // is placed where it really stood instead of at its cell's centre.
        //
        // A waypoint is this position at this position's own time.
        //
        // It used to be stamped with the PREVIOUS sample's time and carry the
        // current sample's place, handing the unit its target a sample early
        // so it could drive the interval and arrive on time. That was right
        // while movement was a push towards a target. It is wrong now that
        // position is read straight off the track: pairing a place with a time
        // it was not seen at shears every segment by one sighting, and since
        // sightings are irregular the speed that falls out of them is too.
        // Measured over a match, legs asked for anything between a fifth of a
        // unit's table speed and three times it — a buggy's ranged from 0.45
        // to 10.76 cells a second against the 3.52 it has — which is a unit
        // that crawls and then darts.
        //
        // The time is the pixel clock's, because the position is: a sighting's
        // pixel reading can have been taken up to 250ms from the sighting
        // itself, and timing a distance by one clock while measuring it with
        // another reports a speed nothing ever moved at.
        const nowPt = s.pt ?? s.t;
        const fromPt = lastPt ?? nowPt;
        // `target` still carries the leg's length in ticks, for the fallback
        // that pushes a unit along when it has no track to be read from.
        const legTicks = Math.max(1, tick(nowPt) - tick(fromPt));
        cmds.push({
          t: tick(nowPt), p, k: "move", kind, x, y, ref, real: true, silent: true,
          target: legTicks,
          ...(s.shape != null ? { shape: s.shape } : {}),
          ...(turretShapeAt(s) != null ? { turretShape: turretShapeAt(s) } : {}),
          ...(s.hp != null ? { hp: s.hp } : {}),
          ...(s.px != null && s.py != null ? { px: s.px, py: s.py } : {}),
        });
        if (s.px != null) lastPx = s.px;
        if (s.py != null) lastPy = s.py;
      }
      // Selection, decoded rather than simulated. Only the changes are sent,
      // and silently: the flag is restated every frame the unit exists, which
      // is not a click and must not count as one.
      // The recording caught this unit firing.
      //
      // A frame inside the type's firing block is direct evidence: the game
      // drew that man shooting, at that stage of the sequence, at that moment.
      // The stage says how long ago the sequence began, so the start is dated
      // back by it and the whole animation plays out from there rather than
      // restarting at frame zero on a pose that is already half over.
      if (s.shape != null && INFANTRY_DOS[kind] && !denseShots) {
        const at = readInfantryFrame(kind, s.shape);
        if (at && at.name === "fire") {
          const began = tick(s.t) - Math.round(at.stage / GAME_FRAMES_PER_TICK);
          cmds.push({ t: Math.max(0, began), p, k: "fire", ref, real: true, silent: true });
        }
      }
      // Which control group the unit is in, as the game shows it on the unit.
      if (s.group !== undefined && s.group !== wasGroup) {
        cmds.push({ t: tick(s.t), p, k: "ingroup", ref, target: s.group, real: true, silent: true });
        wasGroup = s.group;
      }
      if (s.selected !== wasSelected) {
        cmds.push({ t: tick(s.t), p, k: "select", ref, target: s.selected ? 1 : 0, real: true, silent: true });
        selectionChangedAt.push({ p, t: s.t });
        wasSelected = s.selected;
      }
      lastX = x;
      lastY = y;
      lastPt = s.pt ?? s.t;
      if (s.shape != null) lastShape = s.shape;
      if (s.hp != null) lastHp = s.hp;
    }
    // Unloads, when the game took the harvester in rather than when it came
    // near the pad. See recordedUnloads.
    if (kind === "harv") {
      for (const at of recordedUnloads(track.samples, atRefinery(track.owner))) {
        cmds.push({ t: tick(at), p, k: "dock", ref, target: TIBERIUM_STEPS_PER_LOAD, real: true, silent: true });
      }
    }
    // The track stopping is usually the unit dying — the stream restates an
    // object while it exists and recycles its key once it is gone — but not
    // always: a track can simply stop being reported. Health tells the two
    // apart, exactly as it does for structures. Of 59 Buggy hulls in the
    // sample match, 45 end at 20 health or less of 140; those died. Killing on
    // the track ending alone buried the other 14 as well.
    const last = track.samples[track.samples.length - 1]!;
    const peakHp = track.samples.reduce((m, q) => (q.hp != null && q.hp > m ? q.hp : m), 0);
    // The final sample does not always carry a health reading, so take the
    // last one that does. Requiring it on the very last sample let most deaths
    // through unrecorded.
    let finalHp: number | undefined;
    for (let i = track.samples.length - 1; i >= 0; i--) {
      const h = track.samples[i]!.hp;
      if (h != null) { finalHp = h; break; }
    }
    const diedOfWounds = peakHp > 0 && finalHp != null && finalHp <= peakHp * UNIT_DEAD_FRACTION;
    // Or it visibly blew up.
    //
    // Health at the last sighting is not always there to read, and a unit
    // whose final reading never arrived was being left standing. An explosion
    // on the spot it was last seen, at the moment it was last seen, says as
    // much on its own: of 119 vehicle tracks that end early, 74 have one,
    // against 8% of the same units tested at a moment they were alive. The two
    // tests agree on 97 of the 119 — and where they disagree, three units that
    // plainly exploded had no health reading to convict them.
    const blewUp = blastAt(last.cellX, last.cellY, last.t);
    const tomb = tombOf(track);
    // No evidence either way is not evidence of anything; leaving the unit
    // alive under-reports a death, which is the safe direction.
    if (!first && died) {
      // A dying soldier is still exported, drawn in his death frames at zero
      // health: of 396 Minigunner tracks in twelve ladder replays, 176 show
      // one. That is the death itself, which one it was, and when.
      cmds.push({ t: Math.max(0, died.at), p, k: "kill", ref, target: died.death, real: true, silent: true });
    } else if (!first && (diedOfWounds || blewUp) && last.t < lastFrameMs - WITNESSED_SURVIVOR_MS) {
      cmds.push({ t: tick(last.t), p, k: "kill", ref, real: true, silent: true });
    } else if (!first && last.t < lastFrameMs - TRACK_SURVIVOR_MS) {
      if (diedOfWounds || blewUp) {
        cmds.push({ t: tick(last.t), p, k: "kill", ref, real: true, silent: true });
      } else if (tomb) {
        // It was inside a building that fell, and the building took it with
        // it. Dated to the building's death, not to the last sighting: it was
        // alive in there until then. See tombOf.
        cmds.push({ t: tick(tomb.at), p, k: "kill", ref, real: true, silent: true });
      } else if (handedOn.has(track)) {
        // Gone, with nothing to say how. See handedOn, and the gone CmdKind.
        const gone: ReplayCommand = { t: tick(last.t), p, k: "gone", ref, real: true, silent: true };
        cmds.push(gone);
        // Destroyed is much the likeliest way to go, so if the score screen
        // says this player lost more than were convicted, these come early in
        // the reckoning. Not an Engineer: he is spent on what he captures.
        if (kind !== "e6") leftPlay.push({ p, t: gone.t, gone });
      } else {
        // Nothing convicts it, so it stands — but keep it, with how hurt it
        // was, in case the score screen says more of this player's units died
        // than were convicted. See the budget below.
        unconvicted.push({
          p, ref, t: tick(last.t),
          // Null where nothing was ever read: that is not the same as whole.
          hurt: peakHp > 0 && finalHp != null ? finalHp / peakHp : null,
          // A wider net than the one that convicts: something blew up near
          // enough to have been this unit. A tank an Obelisk hits goes from
          // whole to gone between two readings, so damage is not always the
          // sign of a death.
          nearBlast: blastAt(last.cellX, last.cellY, last.t, LOST_BLAST_CELLS, LOST_BLAST_WINDOW_MS),
        });
      }
    }
  }

  // The deaths the game counted but nothing here could pin down.
  //
  // A track that stops being restated is not a death: a unit that parks is
  // restated no more than one that dies, and in two matches where every death
  // was accounted for there were still 75 and 33 tracks that stopped 20s or
  // more before the end. So the rules above stay as they are, and the only
  // thing that moves is the count — where the game itself gives one.
  //
  // The score screen says how many units each player destroyed, which is how
  // many the other player lost. Where that is more than was convicted, the
  // difference is made up from the tracks that stopped early, worst hurt
  // first: a unit last seen at a third of its health is a likelier death than
  // one last seen whole. Nothing is invented beyond the game's own total, and
  // a match without a score screen is left exactly as it was.
  // Both players together, as well as each on their own. A death the score
  // screen credits to nobody — a soldier caught in his own building — is in
  // neither column, so the totals are a floor rather than an exact count, and
  // one side being over must not license adding to the other.
  const lossTotal = inputs.unitLosses ? inputs.unitLosses[0] + inputs.unitLosses[1] : null;
  let roomLeft =
    lossTotal == null ? 0 : lossTotal - cmds.filter((c) => c.k === "kill" && c.ref != null).length;
  for (const p of [0, 1] as const) {
    const budget = inputs.unitLosses?.[p];
    if (budget == null || roomLeft <= 0) continue;
    const already = cmds.filter((c) => c.k === "kill" && c.p === p && c.ref != null).length;
    let room = Math.min(budget - already, roomLeft);
    if (room <= 0) continue;
    // Hurt ones first, worst first; then the ones whose health was never
    // read, earliest gone first, since a unit missing for most of a match is
    // a likelier death than one last seen a moment ago. A unit last seen
    // whole is never taken.
    const mine = unconvicted.filter((u) => u.p === p);
    // A unit that left play is turned from gone into killed where it stands:
    // same moment, same unit, now counted.
    const asKill = (u: { t: number; ref: number }) => () => cmds.push({ t: u.t, p, k: "kill", ref: u.ref, real: true, silent: true });
    const pool: (() => void)[] = [
      ...mine.filter((u) => u.hurt != null && u.hurt <= LOST_MAX_HEALTH_FRACTION).sort((a, b) => a.hurt! - b.hurt! || a.t - b.t).map(asKill),
      // Then those that left play: their key went to another object, which
      // the game does only once an object is gone.
      ...leftPlay.filter((u) => u.p === p).sort((a, b) => a.t - b.t).map((u) => () => {
        u.gone.k = "kill";
      }),
      ...mine.filter((u) => u.hurt == null).sort((a, b) => a.t - b.t).map(asKill),
      // Last, the ones last seen whole with an explosion nearby.
      ...mine.filter((u) => u.hurt != null && u.hurt > LOST_MAX_HEALTH_FRACTION && u.nearBlast).sort((a, b) => a.t - b.t).map(asKill),
    ];
    for (const take of pool) {
      if (room <= 0) break;
      take();
      room--;
      roomLeft--;
    }
  }

  // Selection, as an action rather than as state.
  //
  // Every unit in a box-select flips in the same frame, so a drag is one
  // action and not a dozen. The window comes from the data: gaps between
  // flips are bimodal with an empty band at 10-20ms — inside one selection
  // they fall under 10ms, between separate actions they start at 20ms. So it
  // is one action per player per frame in which their selection changed.
  //
  // This is also the only way a control group *recall* is visible. Pressing
  // the key writes nothing to any unit, so nothing but the selection change
  // betrays it.
  //
  // Counted only when BOTH players decode. The decoder now refuses a bit
  // whose selections do not last a human length, so a player whose bit is
  // unreadable reports nothing at all rather than noise — but crediting one
  // player for selections while the other shows none would make the two
  // incomparable, which is worse for a rate meant to be read side by side
  // than leaving it out of both.
  {
    const byPlayer = new Map<0 | 1, number[]>();
    for (const c of selectionChangedAt) (byPlayer.get(c.p) ?? byPlayer.set(c.p, []).get(c.p)!).push(c.t);
    const everyPlayerDecodes = [0, 1].every((pl) => (byPlayer.get(pl as 0 | 1)?.length ?? 0) > 0);
    if (everyPlayerDecodes) {
      for (const [player, times] of byPlayer) {
        times.sort((a, b) => a - b);
        let last = Number.NEGATIVE_INFINITY;
        for (const t of times) {
          if (t - last <= SELECTION_ACTION_MS) continue;
          last = t;
          cmds.push({ t: tick(t), p: player, k: "sel", real: true });
        }
      }
    }
  }
  // Buildings that changed hands.
  //
  // Emitted before the losses below, and read before them, because a captured
  // building's destruction is recorded against the house that took it: a
  // `kill` looks for a building belonging to the player it names, and until
  // the capture has been applied that building still belongs to the other one.
  for (const cap of structureCaptures(inputs.objectTracks ?? [])) {
    const p2 = slots.get(cap.to);
    if (p2 === undefined) continue;
    if (!inBounds(cap.cellX, cap.cellY)) continue;
    cmds.push({ t: tick(cap.at), p: p2, k: "capture", x: cap.cellX, y: cap.cellY, real: true, silent: true });
  }
  // Structures the players lost.
  //
  // A building's track stopping well before the match does is that building
  // going away — destroyed or sold. Without this every structure ever built
  // stands to the final frame, which is why a base that really ended up with
  // two refineries was drawn with six.
  //
  // Only a building that was genuinely being followed counts. A structure is
  // restated when something about it changes, so a track of one or two
  // sightings means it was never tracked, not that it fell down — house 10's
  // Construction Yard has a single sighting at 5s and plainly survived.
  for (const loss of structureGone) {
    const p = slots.get(loss.owner);
    if (p === undefined) continue;
    const kind = KIND_BY_ASSET[loss.name];
    cmds.push({ t: tick(loss.at), p, k: "kill", ...(kind && kind in BLDG_DEFS ? { kind } : {}), x: loss.cellX, y: loss.cellY, real: true, silent: true });
  }
  // Structures' frames, every one the game drew: a refinery unloading, a
  // factory's doors, a turret's aim. Keyed by the building's recorded centre
  // cell, as its health is, since buildings are placed from the build orders
  // rather than from their tracks.
  for (const b of (inputs.objectTracks as ObjectTracks | undefined)?.structureFrames ?? []) {
    const kind = KIND_BY_ASSET[b.name];
    if (!kind || !(kind in BLDG_DEFS) || !b.shapes.length) continue;
    const p = slots.get(b.owner);
    if (p === undefined) continue;
    const frames = b.shapes.flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]);
    cmds.push({ t: Math.floor(frames[0]!), p, k: "path", kind, x: Math.round(b.cellX), y: Math.round(b.cellY), frames, real: true, silent: true });
  }
  // Structures' health. The recording restates a building whenever its
  // Strength changes, so every reading that differs from the one before is a
  // hit taken or a repair made.
  for (const track of inputs.objectTracks ?? []) {
    const kind = KIND_BY_ASSET[track.name];
    if (!kind || !(kind in BLDG_DEFS)) continue;
    const p = slots.get(track.owner);
    if (p === undefined) continue;
    let was: number | undefined;
    for (const s of track.samples) {
      if (s.hp == null || s.hp <= 0 || s.hp === was) continue;
      if (was !== undefined || s.hp < BLDG_DEFS[kind as BldgKind].hp) {
        cmds.push({ t: tick(s.t), p, k: "health", x: s.cellX, y: s.cellY, hp: s.hp, real: true, silent: true });
      }
      was = s.hp;
    }
  }
  // Whether the recording still shows a live building on this ground after a
  // given moment. `crowdedOut` asks before concluding anything.
  const seenAliveAfter = (
    p: 0 | 1,
    kind: string,
    x: number,
    y: number,
    after: number,
  ): boolean => {
    for (const track of inputs.objectTracks ?? []) {
      // This building, not merely something of this player's nearby. The site
      // window is two cells each way, which at a looser reading lets a
      // neighbour two cells off vouch for a building that has gone.
      if (KIND_BY_ASSET[track.name] !== kind || slots.get(track.owner) !== p) continue;
      for (const s of track.samples) {
        if (s.hp == null || s.hp <= 0) continue;
        if (tick(s.t) <= after) continue;
        if (Math.abs(s.cellX - x) <= STRUCTURE_SITE_CELLS && Math.abs(s.cellY - y) <= STRUCTURE_SITE_CELLS) {
          return true;
        }
      }
    }
    return false;
  };
  const crowded = crowdedOut(cmds, seenAliveAfter);
  cmds.push(...crowded.kills);

  // Combat, as it was recorded.
  //
  // Muzzle flashes, bullet impacts, shells and explosions are objects in the
  // stream like any other, each with a position and a moment. The viewer used
  // to invent all of this; these are the real shots.
  const effectIndex = new Map<string, number>();
  COMBAT_EFFECTS.forEach((n, i) => effectIndex.set(n, i));

  /**
   * Which way the thing that fired this was pointing.
   *
   * A flash is drawn on whatever fired it, so the shooter is whichever of the
   * player's units is standing on that spot. A turreted vehicle points its
   * turret; anything else points its body, and infantry carry their facing in
   * the pose rather than as a plain heading.
   */
  // Every unit sample, filed by the time bucket it falls in.
  //
  // The flash lookup runs once per recorded flash — thousands of times — and
  // scanning every track's every sample each time made rebuilding a match take
  // seconds. Bucketing by time is enough: a flash only ever looks at the
  // samples within its own window, which is two or three buckets rather than
  // the whole match.
  type ShooterSample = { track: ObjectTrack; s: ObjectTrack["samples"][number] };
  const shooterBins = new Map<number, ShooterSample[]>();
  const SHOOTER_BIN_MS = FLASH_SHOOTER_MS;
  for (const track of inputs.objectTracks ?? []) {
    const armed = UNIT_BY_ASSET[track.name];
    // Only something that can shoot. A muzzle flash beside a Harvester came
    // from whatever was shooting at it; crediting the Harvester put a firing
    // pose on a unit with no weapon, and did the same to Engineers and
    // civilians, which the game gives no firing sequence at all.
    if (!armed || (UNIT_DEFS[armed]?.damage ?? 0) <= 0) continue;
    for (const s of track.samples) {
      const bin = Math.floor(s.t / SHOOTER_BIN_MS);
      const at = shooterBins.get(bin);
      if (at) at.push({ track, s });
      else shooterBins.set(bin, [{ track, s }]);
    }
  }

  const shooterAt = (cx: number, cy: number, t: number): { facing?: number; track: ObjectTrack } | undefined => {
    // The closest unit, not the first that happens to qualify. In a firefight
    // several sit inside the search radius, and taking whichever came first in
    // track order would hand the flash a facing borrowed from a bystander.
    let bestTrack: ObjectTrack | undefined;
    let bestSample: ShooterSample["s"] | undefined;
    let bestDist = Infinity;
    let bestDt = Infinity;
    const lo = Math.floor((t - FLASH_SHOOTER_MS) / SHOOTER_BIN_MS);
    const hi = Math.floor((t + FLASH_SHOOTER_MS) / SHOOTER_BIN_MS);
    for (let bin = lo; bin <= hi; bin++) {
      const here = shooterBins.get(bin);
      if (!here) continue;
      for (const { track, s } of here) {
        const dt = Math.abs(s.t - t);
        if (dt > FLASH_SHOOTER_MS) continue;
        const dist = Math.abs(s.cellX - cx) + Math.abs(s.cellY - cy);
        if (dist > FLASH_SHOOTER_CELLS) continue;
        // Nearest in space; a tie goes to whichever was recorded nearest in time.
        if (dist > bestDist || (dist === bestDist && dt >= bestDt)) continue;
        bestDist = dist;
        bestDt = dt;
        bestTrack = track;
        bestSample = s;
      }
    }
    if (!bestTrack || !bestSample) return undefined;
    const kind = UNIT_BY_ASSET[bestTrack.name]!;
    if (UNIT_DEFS[kind]?.turret) {
      const turret = turretShapeForHull(bestTrack, t);
      if (turret != null) {
        const f = Math.round(((turret - VEHICLE_SHAPE_FACINGS) % VEHICLE_SHAPE_FACINGS) / 4) % FLASH_FACINGS;
        return { track: bestTrack, facing: f };
      }
    }
    if (bestSample.shape == null) return { track: bestTrack };
    const facings = UNIT_DEFS[kind]?.facings ?? 8;
    const facing = facings === 8
      ? infantryFacingFromShape(bestSample.shape)
      : Math.round((bestSample.shape % VEHICLE_SHAPE_FACINGS) / 4);
    return { track: bestTrack, ...(facing == null ? {} : { facing: facing % FLASH_FACINGS }) };
  };
  /** A facing becomes the first frame of that facing's block. */
  const flashFrameFrom = (facing: number | undefined, steps: number): number | undefined =>
    facing == null ? undefined : facing * steps;
  for (const track of inputs.objectTracks ?? []) {
    const idx = effectIndex.get(track.name);
    if (idx === undefined) continue;
    // A shell is drawn along its flight; everything else fires once and is
    // over, so only its first position matters.
    const flying = PROJECTILE_EFFECTS.has(track.name as CombatEffect);
    // With its whole flight on record, a round is one command: its path
    // thinned like a unit's, its frames and its height, for the viewer to
    // place at every moment. A puff at each sighting showed a shell for two
    // ticks in every five, blinking along its line.
    if ((flying && track.path && track.path.length > 1) || (RECORDED_ANIMS.has(track.name as CombatEffect) && track.samples.length)) {
      if (flying && track.path && track.path.length > 1) {
        // One key, many rounds. When a round lands its key passes to the next
        // round fired, which starts back at the gun: drawn as one flight, an
        // Artillery shell landed and slid back up to the barrel to be fired
        // again. So a flight ends at a long silence, or at a step back against
        // the way it was flying. Not at any short gap: a round in flight skips
        // a frame or two often (in one match 528 two-frame gaps of a median
        // 8px), while the gaps between rounds are mostly over 300ms.
        const flights: { t: number; px: number; py: number }[][] = [[]];
        for (const q of track.path) {
          const cur = flights[flights.length - 1]!;
          const prev = cur[cur.length - 1];
          const first = cur[0];
          const back =
            prev && first && Math.hypot(q.px - prev.px, q.py - prev.py) > FLIGHT_BACK_PX &&
            (q.px - prev.px) * (prev.px - first.px) + (q.py - prev.py) * (prev.py - first.py) < 0;
          // Or a leap across a short silence: a round never covers 40 pixels
          // after missing frames, a new one fired elsewhere does.
          const leap = prev && q.t - prev.t >= FLIGHT_LEAP_GAP_MS && Math.hypot(q.px - prev.px, q.py - prev.py) > FLIGHT_LEAP_PX;
          if (prev && (q.t - prev.t > FLIGHT_GAP_MS || back || leap)) flights.push([q]);
          else cur.push(q);
        }
        const within = (list: { t: number; v: number }[] | undefined, from: number, to: number) =>
          (list ?? []).filter((q) => q.t >= from - FLIGHT_GAP_MS && q.t <= to).flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]);
        for (const flight of flights) {
          if (flight.length < 2) continue;
          const kept = simplifyPath(flight.map((q) => ({ t: (q.t / 1000) * TICK_HZ, px: Math.round(q.px), py: Math.round(q.py) })), PATH_TOLERANCE_PX, PATH_MAX_GAP_TICKS);
          const from = flight[0]!.t;
          const to = flight[flight.length - 1]!.t;
          const frames = within(track.shapes, from, to);
          const alts = within(track.alts, from, to);
          cmds.push({
            t: Math.floor(kept[0]!.t), p: 0, k: "shot", target: idx, real: true, silent: true,
            path: kept.flatMap((q) => [q.t, q.px, q.py]),
            ...(frames.length ? { frames } : {}),
            ...(alts.length ? { alts } : {}),
          });
        }
        continue;
      }
      let kept: { t: number; px: number; py: number }[];
      if (track.path && track.path.length > 1) {
        kept = simplifyPath(track.path.map((q) => ({ t: (q.t / 1000) * TICK_HZ, px: Math.round(q.px), py: Math.round(q.py) })), PATH_TOLERANCE_PX, PATH_MAX_GAP_TICKS);
      } else {
        // Standing still: where it was first seen, from its first frame to its
        // last (or its last sighting, if that is later).
        const s0 = track.samples[0]!;
        const sN = track.samples[track.samples.length - 1]!;
        const from = Math.min(s0.t, track.shapes?.[0]?.t ?? s0.t);
        const to = Math.max(sN.t, track.shapes?.[track.shapes.length - 1]?.t ?? sN.t);
        const px = Math.round(s0.px ?? s0.cellX * 24 + 12);
        const py = Math.round(s0.py ?? s0.cellY * 24 + 12);
        kept = [{ t: (from / 1000) * TICK_HZ, px, py }, { t: (to / 1000) * TICK_HZ + 1, px, py }];
      }
      cmds.push({
        t: Math.floor(kept[0]!.t), p: 0, k: "shot", target: idx, real: true, silent: true,
        path: kept.flatMap((q) => [q.t, q.px, q.py]),
        ...(track.shapes?.length ? { frames: track.shapes.flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]) } : {}),
        ...(track.alts?.length ? { alts: track.alts.flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]) } : {}),
      });
      continue;
    }
    for (const s of flying ? track.samples : track.samples.slice(0, 1)) {
    const px = s.px ?? s.cellX * 24 + 12;
    const py = s.py ?? s.cellY * 24 + 12;
    if (!inBounds(s.cellX, s.cellY)) continue;
    // Effects belong to nobody in the stream, so they are filed under slot 0;
    // the slot carries no meaning for them and they are drawn unremapped.
    //
    // A muzzle flash points where the gun points. MINIGUN.SHP is not one
    // animation but eight — 8 facings of 6 steps — so a flash needs a
    // direction, and the one place that is known for certain is the shooter's
    // own turret, which the recording gives as frames 32..63.
    //
    // The flash's own recorded frame is not usable for this: its values run to
    // 104 on a 48-frame file, so whatever they index it is not this sprite.
    // Reading them as frames scattered consecutive flashes across facings,
    // which is what made a firing buggy look like a spinning light.
    const layout = DIRECTIONAL_FLASHES.get(track.name as CombatEffect);
    const shooter = MUZZLE_FLASHES.has(track.name as CombatEffect)
      ? shooterAt(s.cellX, s.cellY, s.t)
      : undefined;
    const frame = layout ? flashFrameFrom(shooter?.facing, layout.steps) : undefined;
    cmds.push({ t: tick(s.t), p: 0, k: "fx", px: Math.round(px), py: Math.round(py), target: idx,
      ...(frame != null ? { shape: frame } : {}), real: true, silent: true });
    // A flash does say a *vehicle* fired, and when.
    //
    // The animation is attached to whoever made it — `anim->Attach_To(this)`
    // at the end of TechnoClass::Fire_At — so it is recorded standing on the
    // unit that fired. Both flashes this stream carries come off weapons that
    // recoil: MINIGUN is ANIM_GUN_N, the chain gun and the M60, and GUNFIRE is
    // ANIM_MUZZLE_FLASH, the tank cannons and the Artillery. The rockets and
    // the flame weapons, whose rounds are fuelled and therefore do not recoil,
    // are ANIM_NONE and leave no flash to be found.
    //
    // In a firefight `shooterAt` can hand a flash to a bystander a cell away,
    // which is the same risk the facing above already takes. Here it costs one
    // pixel on the wrong tank for one game frame.
    const firedBy = shooter && !INFANTRY_DOS[UNIT_BY_ASSET[shooter.track.name]!]
      ? trackRef.get(shooter.track)
      : undefined;
    const firedP = shooter ? slots.get(shooter.track.owner) : undefined;
    if (firedBy != null && firedP !== undefined) {
      cmds.push({ t: tick(s.t), p: firedP, k: "fire", ref: firedBy, real: true, silent: true });
    }
    // A flash does not say an infantryman fired.
    //
    // The weapon table in CONST.CPP gives each weapon its firing animation,
    // and the two that infantry carry here have none: WEAPON_M16, the
    // Minigunner's, is ANIM_NONE, and so is WEAPON_GRENADE. The MINIGUN art
    // these flashes are drawn from is ANIM_GUN_N, which is the chain gun that
    // vehicles mount, and GUNFIRE is ANIM_MUZZLE_FLASH off the tank cannons.
    // So a flash beside a Minigunner came from a Buggy shooting near him, and
    // starting his firing sequence on it invented a shot he never took — the
    // same mistake that had Harvesters and Engineers firing. Infantry firing
    // comes from the recorded frames alone, which is the game telling us
    // directly that it drew that man shooting.
    }
  }

  // Cargo planes, flown from their own recorded tracks.
  //
  // Each C17 track segment is one delivery run: the stream restates the plane
  // every frame it exists and recycles its key once the pass is over, so the
  // segmentation that separates unit lives separates passes too. Position and
  // altitude are both recorded, so neither the flight path nor the descent has
  // to be modelled.
  //
  // The plane's owner cannot come from the track. Every C17 in these files is
  // recorded under one house — 214 of 214 in the reference replay — because
  // the engine spawns the delivery aircraft rather than the player owning it,
  // so reading the track's house paints every plane the same colour and lands
  // a teal aircraft on a red airstrip. The airstrip it delivers to is the
  // real owner, and that is on the map: match each flight to the strip it
  // passes closest to.
  const strips = cmds.filter((c) => c.k === "place" && c.kind === "afld" && c.x != null && c.y != null);
  const ownerOfFlight = (samples: readonly { px?: number; py?: number }[], startTick: number, p: 0 | 1): 0 | 1 => {
    let best: 0 | 1 = p;
    let bestD = Infinity;
    for (const strip of strips) {
      if (strip.t > startTick) continue;                 // not built yet when this plane flew
      for (const sm of samples) {
        if (sm.px == null || sm.py == null) continue;
        const d = Math.abs(sm.px / CELL - strip.x!) + Math.abs(sm.py / CELL - strip.y!);
        if (d < bestD) {
          bestD = d;
          best = strip.p;
        }
      }
    }
    return bestD <= CARGO_STRIP_CELLS ? best : p;
  };
  // Every delivery is recorded twice.
  //
  // A cargo plane appears under two object keys at once: same house, same
  // take-off and landing times, same route, a pair of tracks that differ only
  // in key and by a sample or two. It is exact and it is structural — group
  // the C17 tracks of a match by house, start, end and origin and every group
  // has precisely two members, 55 and 93 and 3 of them across the replays
  // checked, never one and never three. Flying both put two planes on the
  // airstrip for every one delivery.
  const cargoSeen = new Set<string>();
  // Paired by when the pass ends, and by nothing else.
  //
  // The two copies stop being restated at the same moment, but neither of the
  // other things that once identified them survives the split: where a pass
  // begins depends on where that copy's own sampling happened to leave a gap,
  // which puts their starts as much as four seconds apart, and the copies do
  // not even fly the same line — one sits a cell or two off the other. Keying
  // on the end alone groups this replay's 187 passes into 101, and 84 of those
  // groups hold exactly the two copies expected.
  const cargoKey = (owner: number, pass: TrackSample[]): string =>
    `${owner}|${Math.round(pass[pass.length - 1]!.t / CARGO_PAIR_MS)}`;
  let cargoRef = 1;
  for (const track of inputs.objectTracks ?? []) {
    if (track.name !== CARGO_PLANE) continue;
    const fallback = slots.get(track.owner);
    if (fallback === undefined) continue;
    // With its every frame on record, a pass is one command: its path, its
    // frames and its height, placed at every drawing moment as a unit is.
    // Only the plane itself: each pass has a zero-strength twin flying a cell
    // below it, like an Apache's rotors, and whichever of the two was seen
    // first was the one drawn -- half the planes flew a cell off their line.
    if (track.path && track.path.length > 1) {
      if (track.samples.every((s) => !s.hp)) continue;
      const flights: { t: number; px: number; py: number }[][] = [[]];
      for (const q of track.path) {
        const cur = flights[flights.length - 1]!;
        const prev = cur[cur.length - 1];
        const first = cur[0];
        // A key flies pass after pass, each starting back at the map's edge.
        const back =
          prev && first && Math.hypot(q.px - prev.px, q.py - prev.py) > FLIGHT_BACK_PX &&
          (q.px - prev.px) * (prev.px - first.px) + (q.py - prev.py) * (prev.py - first.py) < 0;
        const leap = prev && q.t - prev.t >= FLIGHT_LEAP_GAP_MS && Math.hypot(q.px - prev.px, q.py - prev.py) > FLIGHT_LEAP_PX;
        if (prev && (q.t - prev.t > FLIGHT_GAP_MS || back || leap)) flights.push([q]);
        else cur.push(q);
      }
      const within = (list: { t: number; v: number }[] | undefined, from: number, to: number) =>
        (list ?? []).filter((q) => q.t >= from - FLIGHT_GAP_MS && q.t <= to).flatMap((q) => [(q.t / 1000) * TICK_HZ, q.v]);
      for (const flight of flights) {
        if (flight.length < 2) continue;
        const dup = `${track.owner}|${Math.round(flight[flight.length - 1]!.t / CARGO_PAIR_MS)}`;
        if (cargoSeen.has(dup)) continue;
        cargoSeen.add(dup);
        const kept = simplifyPath(flight.map((q) => ({ t: (q.t / 1000) * TICK_HZ, px: Math.round(q.px), py: Math.round(q.py) })), PATH_TOLERANCE_PX, PATH_MAX_GAP_TICKS);
        const from = flight[0]!.t;
        const to = flight[flight.length - 1]!.t;
        const frames = within(track.shapes, from, to);
        const alts = within(track.alts, from, to);
        cmds.push({
          t: Math.floor(kept[0]!.t), p: ownerOfFlight(flight, tick(from), fallback), k: "cargo", ref: cargoRef++, real: true, silent: true,
          path: kept.flatMap((q) => [q.t, q.px, q.py]),
          ...(frames.length ? { frames } : {}),
          ...(alts.length ? { alts } : {}),
        });
      }
      continue;
    }
    for (const flown of cargoPasses(track)) {
      const dup = cargoKey(track.owner, flown);
      if (cargoSeen.has(dup)) continue;
      cargoSeen.add(dup);
      // Read per pass, not per track: a recycled key can serve one player's
      // strip and then the other's, and the strip it flies to is what says
      // whose plane it is.
      const p = ownerOfFlight(flown, tick(flown[0]!.t), fallback);
      const ref = cargoRef++;
      let prevT: number | undefined;
      let lastPx = Number.NaN;
      let lastPy = Number.NaN;
      for (const s of flown) {
        if (Number.isFinite(lastPx) && Math.abs(s.px! - lastPx) + Math.abs(s.py! - lastPy) < PIXEL_WAYPOINT) continue;
        cmds.push({
          t: tick(prevT ?? (s.pt ?? s.t)),
          p,
          k: "cargo",
          ref,
          px: Math.round(s.px!),
          py: Math.round(s.py!),
          // Altitude rides in `target`, the leg's length in `id` — a cargo
          // waypoint has no other use for either.
          target: Math.max(0, Math.round(s.alt ?? FLIGHT_LEVEL)),
          id: Math.max(1, tick(s.pt ?? s.t) - tick(prevT ?? (s.pt ?? s.t))),
          real: true,
          silent: true,
        });
        prevT = s.pt ?? s.t;
        lastPx = s.px!;
        lastPy = s.py!;
      }
      // No position means the pass is over and the plane leaves the field.
      cmds.push({ t: tick(flown[flown.length - 1]!.t), p, k: "cargo", ref, real: true, silent: true });
    }
  }

  // Fall back to the sparse object-record sightings for harvesters only when
  // no track was decoded, so a replay that predates the track decode still
  // harvests from real positions rather than from the model.
  const harvesterTracks = new Map<string, DeltaSighting[]>();
  if (!(inputs.objectTracks ?? []).some((t) => t.name === "HARV")) {
    for (const s of inputs.deltaObjects ?? []) {
      if (s.name !== "HARV") continue;
      const key = s.owner + ":" + s.id;
      const a = harvesterTracks.get(key) ?? [];
      a.push(s);
      harvesterTracks.set(key, a);
    }
  }
  for (const track of harvesterTracks.values()) {
    const p = slots.get(track[0]!.owner);
    if (p === undefined) continue;
    const seen = [...track].sort((a, b) => a.t - b.t);
    const ref = unitRef++;
    let first = true;
    let lastX = -1;
    let lastY = -1;
    for (const s of seen) {
      const x = Math.round(s.cellX);
      const y = Math.round(s.cellY);
      if (!inBounds(x, y)) continue;
      if (first) {
        cmds.push({ t: tick(s.t), p, k: "spawn", kind: "harv", x, y, ref, real: true });
        first = false;
      } else if (x !== lastX || y !== lastY) {
        cmds.push({ t: tick(s.t), p, k: "move", kind: "harv", x, y, ref, real: true, silent: true });
      }
      lastX = x;
      lastY = y;
    }
  }

  // Real move orders. The replay records the flash the game draws where a
  // player clicked, which gives the moment and the destination but not which
  // unit was selected — that is chosen by the simulation. So the timing and
  // the target cell are decoded; only the choice of unit is not.
  // Ordering a repair is a press too: the flag stays up for the whole repair,
  // but the player clicked once to start it.
  // Orders aimed at an object. The game flashes what a player clicks as a
  // target, for that player only (TechnoClass::Clicked_As_Target), and the
  // flash is recorded; the click lands where the object stood at the time.
  for (const c of inputs.targetClicks ?? []) {
    const p7 = slots.get(c.owner);
    if (p7 === undefined) continue;
    let at: { cellX: number; cellY: number } | undefined;
    for (const tr of inputs.objectTracks ?? []) {
      if (tr.key !== c.key) continue;
      for (const s of tr.samples) {
        if (s.t > c.t + 1000) break;
        if (s.t >= c.t - 3000) at = s;
      }
      if (at) break;
    }
    if (!at || !inBounds(at.cellX, at.cellY)) continue;
    cmds.push({ t: tick(c.t), p: p7, k: "target", x: at.cellX, y: at.cellY, real: true });
  }

  // Repairs: which building, and for how long.
  //
  // The press alone does not say what was being repaired — the request carries
  // an object id the stream numbers its own way — but the game says it twice.
  // BuildingClass::Repair calls Clicked_As_Target as it turns repairing on, so
  // the building flashes for that player at the moment of the press, and the
  // flash is recorded. Of 28 presses, 27 have a flash within 0.4s.
  //
  // The end is the health itself. A repairing building gains REPAIR_STEP — 5
  // — every fifteen game frames, which is three times a second here, and stops
  // when it is whole, when the money runs out or when the player presses
  // again (Repair(-1) toggles). So the repair runs while its health is still
  // climbing in fives.
  for (const m of inputs.playerInputs ?? []) {
    if (m.code !== INPUT_CODE.STRUCTURE || m.event !== STRUCTURE_REQUEST.REPAIR) continue;
    const p9 = slots.get(m.owner);
    if (p9 === undefined) continue;
    const flash = (inputs.targetClicks ?? []).find((c) => c.owner === m.owner && Math.abs(c.t - m.t) <= REPAIR_FLASH_MS);
    const track = flash && (inputs.objectTracks ?? []).find((tr) => tr.key === flash.key && KIND_BY_ASSET[tr.name]);
    if (!track) continue;
    const at = track.samples.find((s) => s.t >= m.t - 3000) ?? track.samples[0];
    if (!at || !inBounds(at.cellX, at.cellY)) continue;
    // Follow the rises while they keep coming; the first real gap ends it.
    let until = m.t;
    let hp: number | undefined;
    for (const s of track.samples) {
      if (s.hp == null || s.t < m.t - 200) continue;
      if (s.t > until + REPAIR_STEP_GAP_MS) break;
      if (hp != null && s.hp > hp) until = s.t;
      hp = s.hp;
    }
    cmds.push({
      t: tick(m.t), p: p9, k: "repair", x: at.cellX, y: at.cellY,
      target: Math.max(1, tick(until) - tick(m.t)), real: true,
    });
  }

  // The players' own inputs. A click or a box carries its points in map
  // pixels; `target` packs the request code and event, `id` and `ref` a
  // box's second corner, or a control group's number.
  // Each house's units, for telling a drag box that took something from one
  // that took nothing. A box picks up only its owner's units — never
  // buildings, never the enemy's.
  const unitTracksOf = new Map<number, ObjectTrack[]>();
  for (const tr of inputs.objectTracks ?? []) {
    if (!UNIT_BY_ASSET[tr.name]) continue;
    (unitTracksOf.get(tr.owner) ?? unitTracksOf.set(tr.owner, []).get(tr.owner)!).push(tr);
  }
  /** Whether one of `owner`'s units stood inside the box (world pixels) at `t` ms. */
  const boxTakesAUnit = (owner: number, t: number, x1: number, y1: number, x2: number, y2: number): boolean => {
    const [lx, hx] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [ly, hy] = [Math.min(y1, y2), Math.max(y1, y2)];
    for (const tr of unitTracksOf.get(owner) ?? []) {
      const s = tr.samples;
      if (!s.length || s[0]!.t > t || s[s.length - 1]!.t < t - BOX_SIGHTING_MS) continue;
      // The last sighting at or before the box.
      let lo = 0, hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid]!.t <= t) lo = mid; else hi = mid - 1;
      }
      const q = s[lo]!;
      if (q.px == null || q.py == null) continue;
      if (q.px >= lx - BOX_SLACK_PX && q.px <= hx + BOX_SLACK_PX && q.py >= ly - BOX_SLACK_PX && q.py <= hy + BOX_SLACK_PX) return true;
    }
    return false;
  };

  for (const m of inputs.playerInputs ?? []) {
    const p8 = slots.get(m.owner);
    if (p8 === undefined) continue;
    const target = (m.code << 8) | m.event;
    const cmd: ReplayCommand = { t: tick(m.t), p: p8, k: "input", target, real: true, silent: true };
    if (m.code === INPUT_CODE.INPUT) {
      const c = inputCall({ data: m.data } as InputMessage);
      const ox = inputs.inputOrigin?.x ?? 0;
      const oy = inputs.inputOrigin?.y ?? 0;
      if (m.event !== INPUT_EVENT.SPECIAL_KEYS) {
        cmd.px = Math.max(0, c.x1 + ox);
        cmd.py = Math.max(0, c.y1 + oy);
        cmd.x = Math.floor(cmd.px / CELL);
        cmd.y = Math.floor(cmd.py / CELL);
      }
      if (m.event === INPUT_EVENT.AREA || m.event === INPUT_EVENT.AREA_ADDITIVE) {
        cmd.id = Math.max(0, c.x2 + ox);
        cmd.ref = Math.max(0, c.y2 + oy);
        if (!boxTakesAUnit(m.owner, m.t, c.x1 + ox, c.y1 + oy, c.x2 + ox, c.y2 + oy)) cmd.target! |= INPUT_EMPTY_BOX;
      } else if (m.event === INPUT_EVENT.SPECIAL_KEYS) {
        cmd.id = c.flags;
      }
    } else if (m.code === INPUT_CODE.CONTROL_GROUP) {
      cmd.id = m.data[0] ?? 0;
    } else if (m.code === INPUT_CODE.SIDEBAR) {
      const c = sidebarCall({ data: m.data } as InputMessage);
      cmd.id = c.id;
      if (m.event === SIDEBAR_REQUEST.PLACE) { cmd.x = c.cellX; cmd.y = c.cellY; }
    }
    cmds.push(cmd);
  }

  // Setting a control group is a real press, so it counts toward the action
  // rate. Recalling one does not reach the stream: it changes only what is
  // selected, not what any unit belongs to, so the count is assignments only.
  for (const g of inputs.controlGroups ?? []) {
    const p5 = slots.get(g.owner);
    if (p5 === undefined) continue;
    cmds.push({ t: tick(g.t), p: p5, k: "group", target: g.group, id: g.size, real: true });
  }

  for (const o of inputs.moveOrders ?? []) {
    const p4 = slots.get(o.owner);
    if (p4 === undefined) continue;
    const x = Math.round(o.cellX);
    const y = Math.round(o.cellY);
    if (!inBounds(x, y)) continue;
    // With real tracks in hand the click is only a click: the units are
    // already driving their recorded routes, so handing this destination to
    // whichever unit happens to be idle would drag one off its real path. An
    // unmatchable ref keeps the ring and the APM without touching anybody.
    const claimed = (inputs.objectTracks ?? []).length > 0;
    cmds.push({ t: tick(o.t), p: p4, k: "move", x, y, real: true, ...(claimed ? { ref: -1 } : {}) });
  }

  // Credits, filled in between the readings.
  //
  // Readings used to come only from the full sidebar dumps, about every 1.6
  // seconds; they now come every frame, and the filling below rarely has a
  // gap to fill. It stays for the frames the stream does skip. Replacing
  // the number outright at each one makes the counter jump in steps of
  // whatever was earned or spent in between — hundreds of credits at a time.
  // The real sidebar counts up and down continuously. The readings are the
  // truth and are kept exactly; the gap between two of them is walked across
  // in even steps, which is what the counter did while nobody was looking.
  const byPlayer = new Map<0 | 1, { t: number; credits: number }[]>();
  for (const c of inputs.creditSamples ?? []) {
    const p5 = slots.get(c.owner);
    if (p5 === undefined) continue;
    const list = byPlayer.get(p5) ?? [];
    // A reading arrives about every game frame, three to a tick here; the
    // last in each tick is the one that tick shows.
    const at = tick(c.t);
    const value = Math.max(0, Math.round(c.credits));
    if (list.length && list[list.length - 1]!.t === at) list[list.length - 1]!.credits = value;
    else list.push({ t: at, credits: value });
    byPlayer.set(p5, list);
  }
  for (const [p5, list] of byPlayer) {
    list.sort((x, y) => x.t - y.t);
    for (let i = 0; i < list.length; i++) {
      const from = list[i]!;
      // The command carries the value in `target`, which is the only u32 the
      // binary format already had room for.
      cmds.push({ t: from.t, p: p5, k: "credits", target: from.credits, real: true });
      const to = list[i + 1];
      if (!to) continue;
      const span = to.t - from.t;
      const step = to.credits - from.credits;
      if (span <= 1 || step === 0) continue;
      // One a tick, but never more steps than there are credits to move.
      const steps = Math.min(span - 1, Math.abs(step));
      for (let k = 1; k <= steps; k++) {
        const at = from.t + Math.round((span * k) / (steps + 1));
        if (at <= from.t || at >= to.t) continue;
        const value = Math.round(from.credits + (step * k) / (steps + 1));
        cmds.push({ t: at, p: p5, k: "credits", target: Math.max(0, value), real: true, silent: true });
      }
    }
  }

  // Close the short gaps between one waypoint and the next.
  //
  // A leg is given the time its own two sightings are apart, which leaves the
  // unit standing still whenever the next waypoint is issued a little later
  // than the last one finished. Those gaps are brief — a quarter of all pauses
  // are four ticks or fewer — but a sprite frozen for a fifth of a second in
  // the middle of a walk is exactly the stutter you see: glide, stop, glide.
  //
  // Only the short ones are closed. A long gap is the unit genuinely standing
  // there, and stretching a leg across that would have it creeping forward
  // when the recording says it had stopped.
  {
    const byRef = new Map<number, ReplayCommand[]>();
    for (const c of cmds) {
      if (c.k !== "move" || c.ref == null || c.px == null) continue;
      const list = byRef.get(c.ref) ?? [];
      list.push(c);
      byRef.set(c.ref, list);
    }
    for (const list of byRef.values()) {
      list.sort((x, y) => x.t - y.t);
      for (let i = 0; i < list.length - 1; i++) {
        const here = list[i]!;
        const gap = list[i + 1]!.t - here.t;
        const given = Math.max(1, here.target ?? 1);
        if (gap > given && gap - given <= WAYPOINT_GAP_TICKS) here.target = gap;
      }
    }
  }

  // Buildings that were sold, rather than destroyed.
  //
  // Nothing in the stream says "sold" outright, but the consequence is exact.
  // `TechnoClass::Refund_Amount` gives a human player half the raw cost back —
  // `if (House->IsHuman) cost /= 2` — so a sale is a building vanishing and
  // its owner's balance rising by half its price within a moment. Both halves
  // are decoded already: the structure's track ends, and the sidebar dump
  // carries the balance.
  //
  // It holds up. Across ten replays, 12 of the 180 structures that vanish
  // before the match ends are followed by a rise of half their cost; asking
  // the same question at moments they did not vanish answers yes once in 540.
  // The rest of the 180 were shot.
  //
  // Where the replay carries the players' own presses, though, the sale is on
  // record rather than inferred: CNC_Handle_Structure_Request's SELL. That is
  // the better half of the evidence, and it catches the sales the refund
  // cannot — a Refinery or Silo hands back the Tiberium it was holding as
  // well as half its price, and those are the two buildings players sell most
  // (29 of 67 measured sales).
  {
    const series = new Map<0 | 1, { t: number; credits: number }[]>();
    for (const c of inputs.creditSamples ?? []) {
      const owner = slots.get(c.owner);
      if (owner === undefined) continue;
      const list = series.get(owner) ?? [];
      list.push({ t: tick(c.t), credits: c.credits });
      series.set(owner, list);
    }
    for (const list of series.values()) list.sort((x, y) => x.t - y.t);
    // The presses themselves, where the replay has them.
    const sellPresses = new Map<0 | 1, number[]>();
    for (const m of inputs.playerInputs ?? []) {
      if (m.code !== INPUT_CODE.STRUCTURE || m.event !== STRUCTURE_REQUEST.SELL) continue;
      const owner = slots.get(m.owner);
      if (owner === undefined) continue;
      sellPresses.set(owner, [...(sellPresses.get(owner) ?? []), tick(m.t)]);
    }
    let lastTick = 0;
    for (const track of inputs.objectTracks ?? []) {
      for (const q of track.samples) {
        const at = tick(q.t);
        if (at > lastTick) lastTick = at;
      }
    }
    // A press sells one building, so a press is spent once. Without that, a
    // structure the recording followed under two keys is sold twice over.
    const spent = new Map<0 | 1, Set<number>>();
    const claimPress = (owner: 0 | 1, gone: number): boolean => {
      const used = spent.get(owner) ?? new Set<number>();
      const t = (sellPresses.get(owner) ?? []).find(
        (x) => !used.has(x) && x >= gone - SELL_PRESS_BEFORE_TICKS && x <= gone + SELL_PRESS_AFTER_TICKS,
      );
      if (t === undefined) return false;
      used.add(t);
      spent.set(owner, used);
      return true;
    };
    // Oldest first, so each press goes to the building that went with it.
    const goings = (inputs.objectTracks ?? [])
      .flatMap((track) => {
        const kind = KIND_BY_ASSET[track.name];
        const owner = slots.get(track.owner);
        if (!kind || owner === undefined || track.samples.length === 0) return [];
        const last = track.samples[track.samples.length - 1]!;
        return [{ kind, owner, last, gone: tick(last.t) }];
      })
      .sort((a, b) => a.gone - b.gone);
    for (const { kind, owner, last, gone } of goings) {
      // Still standing when the recording stops: nothing happened to it.
      if (lastTick - gone < STRUCTURE_GONE_TICKS) continue;
      // Their own press, if it is on record: the building went as they sold it.
      if (claimPress(owner, gone)) {
        cmds.push({ t: gone, p: owner, k: "sell", kind, x: last.cellX, y: last.cellY, real: true });
        continue;
      }
      const refund = BLDG_DEFS[kind].cost / 2;
      if (refund <= 0) continue;
      const list = series.get(owner);
      if (!list) continue;
      let before: number | undefined;
      let after: number | undefined;
      for (const x of list) {
        if (x.t <= gone) before = x.credits;
        else if (x.t <= gone + SELL_REFUND_TICKS) { after = x.credits; break; }
      }
      if (before == null || after == null) continue;
      // A Refinery or Silo also hands back what it was holding, so the match
      // is never exact for those; a tenth is enough for the rest.
      if (Math.abs(after - before - refund) > Math.max(8, refund * SELL_REFUND_TOLERANCE)) continue;
      cmds.push({
        t: gone, p: owner, k: "sell", kind, x: last.cellX, y: last.cellY, real: true,
      });
    }
  }

  // A building that was sold was not destroyed. Both come from the same
  // moment — its track ending — so the kill that moment would otherwise mean
  // is dropped in favour of the sale, and nobody is credited with it.
  {
    const sold = cmds.filter((c) => c.k === "sell");
    if (sold.length) {
      const isSale = (c: ReplayCommand) =>
        c.k === "kill" &&
        c.x != null &&
        sold.some((s) => s.p === c.p && s.x === c.x && s.y === c.y && Math.abs(s.t - c.t) <= SELL_PRESS_AFTER_TICKS);
      for (let i = cmds.length - 1; i >= 0; i--) if (isSale(cmds[i]!)) cmds.splice(i, 1);
    }
  }

  // A building whose key went to another object was gone by then: the game
  // hands a key on only once its holder is deleted. Most of these are already
  // down — sold, or caught by the track rules above — so each existing kill
  // or sale is matched to the nearest such building, once, and only the
  // buildings left over are new deaths. Without the once, one sale at a gun
  // turret stood in for its two neighbours as well. A leftover died at its
  // last sign of life: its last record, frame or sighting before the handover.
  {
    const frames = (inputs.objectTracks as ObjectTracks | undefined)?.structureFrames ?? [];
    const lastSeen = new Map<number, number[]>();
    for (const track of inputs.objectTracks ?? []) {
      const list = lastSeen.get(track.key) ?? [];
      for (const s of track.samples) list.push(s.t);
      lastSeen.set(track.key, list);
    }
    const gone: { p: 0 | 1; kind: EntityKind; x: number; y: number; dies: number; until: number }[] = [];
    for (const b of frames) {
      // A life with no frames was never drawn. Every real building is; key
      // 0xB001 alone takes a building's name and cell for a single record,
      // which read as the Airstrip it named passing its key on.
      if (b.until == null || !b.shapes.length) continue;
      const kind = KIND_BY_ASSET[b.name];
      if (!kind || !(kind in BLDG_DEFS)) continue;
      const p = slots.get(b.owner);
      if (p === undefined) continue;
      let at = Math.max(b.lastRecord, b.shapes[b.shapes.length - 1]?.t ?? 0);
      for (const t of lastSeen.get(b.key) ?? []) if (t > at && t < b.until) at = t;
      // The same building on the same ground is not gone: its key handed to
      // itself under the other house, which is a capture, or a second key
      // already following it on its very cell before this one let go. Only
      // that cell: turrets go up side by side, a cell apart.
      if (frames.some((o) => o !== b && o.name === b.name && o.lastRecord >= b.until! &&
        (o.key === b.key
          ? Math.abs(o.cellX - b.cellX) <= 1 && Math.abs(o.cellY - b.cellY) <= 1
          : o.cellX === b.cellX && o.cellY === b.cellY && o.shapes[0] != null && o.shapes[0].t <= at))) continue;
      gone.push({ p, kind, x: Math.round(b.cellX), y: Math.round(b.cellY), dies: tick(Math.min(at, b.until - 1)), until: tick(b.until) });
    }
    const pairs: { g: number; c: ReplayCommand; cost: number }[] = [];
    for (const c of cmds) {
      if ((c.k !== "kill" && c.k !== "sell") || c.ref != null || c.x == null || c.y == null) continue;
      gone.forEach((g, i) => {
        const cells = Math.max(Math.abs(c.x! - g.x), Math.abs(c.y! - g.y));
        if (c.p !== g.p || cells > HANDOVER_KILL_CELLS) return;
        if (c.t < g.dies - HANDOVER_KILL_SLACK_TICKS || c.t > g.until + HANDOVER_KILL_SLACK_TICKS) return;
        // Off its window counts against it, so does each cell away.
        const off = c.t < g.dies ? g.dies - c.t : c.t > g.until ? c.t - g.until : 0;
        pairs.push({ g: i, c, cost: off + cells * TICK_HZ * 5 });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const taken = new Set<ReplayCommand>();
    const handled = new Set<number>();
    for (const { g, c } of pairs) {
      if (taken.has(c) || handled.has(g)) continue;
      taken.add(c);
      handled.add(g);
    }
    gone.forEach((g, i) => {
      if (!handled.has(i)) cmds.push({ t: g.dies, p: g.p, k: "kill", kind: g.kind, x: g.x, y: g.y, real: true, silent: true });
    });
  }

  // A building that was sold says so in its own frames: the game plays its
  // build-up backwards, so its last frames count down to the first. One that
  // was destroyed ends on its damaged frames, or its door, or whatever it was
  // doing. Ten matches had 317 such count-downs; the rules above, reading
  // presses, refunds and tracks, had called 63 of them destroyed and missed
  // 132 altogether. So the frames decide: sold, from the moment the count
  // began, and no loss on that building around then.
  {
    const frames = (inputs.objectTracks as ObjectTracks | undefined)?.structureFrames ?? [];
    for (const b of frames) {
      const n = b.shapes.length;
      let down = 0;
      for (let i = n - 1; i > 0 && b.shapes[i]!.v < b.shapes[i - 1]!.v; i--) down++;
      if (down < SOLD_COUNTDOWN_FRAMES || b.shapes[n - 1]!.v > SOLD_LAST_FRAME) continue;
      const kind = KIND_BY_ASSET[b.name];
      if (!kind || !(kind in BLDG_DEFS)) continue;
      const p = slots.get(b.owner);
      if (p === undefined) continue;
      const x = Math.round(b.cellX), y = Math.round(b.cellY);
      // From its first step down: the frame it counts down from is the end
      // of its build-up, drawn when it was put down -- dated from that, a
      // Silo was sold before it was built and never went.
      const fromMs = b.shapes[n - down]!.t;
      const toMs = b.shapes[n - 1]!.t;
      // And quickly: a sale is the build-up run backwards, a second or two.
      if (toMs - fromMs > SOLD_COUNTDOWN_MS) continue;
      const from = tick(fromMs);
      const to = tick(toMs);
      // This building's own: of its kind, or on its very ground when the
      // command names none. Silos go up in rows two cells apart and are sold
      // together, and claiming every sale within two cells took the
      // neighbours' too, leaving them standing to the end.
      const here = (c: ReplayCommand) =>
        c.ref == null && c.p === p && c.x != null && c.y != null &&
        (c.kind != null ? c.kind === kind : Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1) &&
        Math.abs(c.x - x) <= HANDOVER_KILL_CELLS && Math.abs(c.y - y) <= HANDOVER_KILL_CELLS &&
        c.t >= from - SOLD_SLACK_TICKS && c.t <= to + SOLD_SLACK_TICKS;
      const off = (c: ReplayCommand) => Math.max(Math.abs(c.x! - x), Math.abs(c.y! - y));
      // The same building said twice sits on its cell, or a cell off for a
      // bigger one, whose reported cell drifts. Gun turrets and silos stand a
      // cell or two apart, and anything further than that is a neighbour's.
      const [fw, fh] = bldgFootprint(kind);
      const reach = fw * fh > 1 ? 1 : 0;
      const mine = cmds.filter((c) => (c.k === "kill" || c.k === "sell") && here(c) && off(c) <= reach);
      const sale = mine.filter((c) => c.k === "sell").sort((m, n) => off(m) - off(n))[0];
      if (sale) {
        sale.t = from;
        sale.kind = kind;
      } else cmds.push({ t: from, p, k: "sell", kind, x, y, real: true });
      for (const c of mine) if (c !== sale) cmds.splice(cmds.indexOf(c), 1);
    }
  }

  cmds.sort((a, b) => a.t - b.t);
  inferDeaths(cmds);
  return crowded.drop.size === 0 ? cmds : cmds.filter((c) => !crowded.drop.has(c));
}

/**
 * The death an infantryman plays, by what killed him: the warhead of the
 * weapon, as InfantryClass::Take_Damage switches on it (INFANTRY.CPP) — small
 * arms shoot him, high explosive blows him up, armour-piercing is the grenade
 * death, and fire, lasers and particle beams burn him. Each unit's weapon is
 * its primary in UDATA/IDATA/BDATA, carried to a warhead through the bullet
 * tables (CONST.CPP, BBDATA.CPP).
 */
const DEATH_BY_KILLER: Readonly<Partial<Record<EntityKind, (typeof DEATHS)[number]>>> = {
  e1: "gunDeath", jeep: "gunDeath", buggy: "gunDeath", apc: "gunDeath",
  e2: "explosionDeath", arty: "explosionDeath", mlrs: "explosionDeath", heli: "explosionDeath",
  gtwr: "explosionDeath", atwr: "explosionDeath",
  ltnk: "grenadeDeath", mtnk: "grenadeDeath", htnk: "grenadeDeath", e3: "grenadeDeath", bike: "grenadeDeath",
  stnk: "grenadeDeath", orca: "grenadeDeath", gun: "grenadeDeath",
  e4: "fireDeath", ftnk: "fireDeath", obli: "fireDeath",
};
/** How far back to look for the shot that killed him, in ticks. */
const KILLER_WINDOW_TICKS = 30;
/** And how far away the one who fired it may stand, in world pixels. */
const KILLER_REACH_PX = 8 * CELL;

/**
 * Give each infantry death the recording did not catch the death its killer's
 * weapon would have played.
 *
 * About half of all deaths are caught in their own frames, and those say which
 * it was. For the rest, the nearest enemy that fired in the two seconds
 * before, within eight cells, is taken for the killer. Checked against the
 * deaths that were caught, over four ladder replays: right for 136 of 186
 * that had anyone firing nearby, where calling every one a shooting is right
 * for about 56%. With nobody firing nearby the death stays unmarked, and the
 * simulation plays the commonest, a shooting.
 */
export function inferDeaths(cmds: ReplayCommand[]): void {
  const kindOf = new Map<number, EntityKind>();
  const pos = new Map<number, { t: number; x: number; y: number }[]>();
  for (const c of cmds) {
    if (c.ref == null || c.ref < 0) continue;
    if (c.k === "spawn" && c.kind) kindOf.set(c.ref, c.kind);
    if ((c.k === "spawn" || c.k === "move") && c.px != null && c.py != null) {
      (pos.get(c.ref) ?? pos.set(c.ref, []).get(c.ref)!).push({ t: c.t, x: c.px, y: c.py });
    }
  }
  const at = (ref: number, t: number) => {
    const list = pos.get(ref);
    if (!list) return undefined;
    let lo = 0, hi = list.length - 1;
    if (!list.length || list[0]!.t > t) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid]!.t <= t) lo = mid; else hi = mid - 1;
    }
    return list[lo];
  };
  const fires = cmds.filter((c) => c.k === "fire" && c.ref != null);
  let fi = 0;
  for (const k of cmds) {
    if (k.k !== "kill" || k.ref == null || k.target != null) continue;
    const victim = kindOf.get(k.ref);
    if (!victim || !INFANTRY_DOS[victim]) continue;
    const vp = at(k.ref, k.t);
    if (!vp) continue;
    while (fi < fires.length && fires[fi]!.t < k.t - KILLER_WINDOW_TICKS) fi++;
    let best: { kind: EntityKind; d: number } | null = null;
    for (let j = fi; j < fires.length && fires[j]!.t <= k.t; j++) {
      const f = fires[j]!;
      if (f.p === k.p) continue;
      const kind = kindOf.get(f.ref!);
      const sp = at(f.ref!, f.t);
      if (!kind || !sp) continue;
      const d = Math.hypot(sp.x - vp.x, sp.y - vp.y);
      if (d <= KILLER_REACH_PX && (!best || d < best.d)) best = { kind, d };
    }
    const death = best ? DEATH_BY_KILLER[best.kind] : undefined;
    if (death) k.target = DEATHS.indexOf(death);
  }
}

/** Replace a generated file's command stream with the real one. */
export function withRealCommands(file: ReplayFile, inputs: RealReplayInputs): ReplayFile {
  const real = commandsFromReal(inputs);
  if (!real.length) return file;

  // Keep generated movement and combat orders so the match still has life in
  // it, but drop every synthesised placement, deploy and unit queue — the
  // structures and the units are now known for real.
  // Generated movement is dropped when real orders were decoded: there is no
  // reason to keep invented destinations alongside the ones the players
  // actually clicked. Attacks stay, since the replay records no attack orders.
  const haveRealMoves = real.some((c) => c.k === "move");
  const kept = file.commands.filter(
    (c) =>
      c.k !== "place" &&
      c.k !== "deploy" &&
      c.k !== "queue" &&
      !(haveRealMoves && c.k === "move"),
  );
  return { ...file, commands: [...real, ...kept].sort((a, b) => a.t - b.t) };
}

/** Buildings, for deciding when a track ending means one was lost. */
const STRUCTURES: ReadonlySet<string> = new Set([
  "PROC", "FACT", "NUKE", "NUK2", "GUN", "AFLD", "HAND", "SILO", "WEAP",
  "POWR", "OBLI", "SAM", "HQ", "PYLE", "EYE", "TMPL", "GTWR", "ATWR", "FIX", "HPAD",
]);

/**
 * How well a structure has to have been followed before its track ending is
 * read as a loss, and how long the silence must last.
 */
const STRUCTURE_TRACKED_SAMPLES = 20;
const STRUCTURE_TRACKED_MS = 20_000;
const STRUCTURE_GONE_MS = 20_000;

/**
 * How far apart two reported cells can be and still be the same building. A
 * structure's cell drifts by about a cell in the stream, and a footprint is
 * two to three cells across.
 */
const STRUCTURE_SITE_CELLS = 2;

/**
 * How much of its health a structure must have lost by its last sighting for
 * that sighting to count as its destruction rather than the stream simply
 * losing interest.
 */
const STRUCTURE_DEAD_FRACTION = 0.6;
/** Health so near nothing that the building is gone, however briefly it was followed. */
const STRUCTURE_ZERO_FRACTION = 0.02;

/**
 * How much health has to reappear at a site before it counts as a new building
 * rather than the same one. Repair is gradual; a rebuilt structure arrives near
 * full in one step.
 */
const STRUCTURE_REBUILD_HP = 100;

/**
 * How far outside a building's footprint the last sighting of a unit that
 * drove into it may sit.
 *
 * One cell. The unit stops being exported as it goes in, so its last sighting
 * is on the approach: the harvester this was written for ends on 18,39 against
 * a Refinery whose own cell reads 19,39.
 */
const DOCK_RING = 1;


/**
 * How much health may reappear across a change of owner and still be the same
 * building.
 *
 * `BuildingClass::Captured` moves the house, the power, the drain and the
 * storage, and leaves `Strength` alone — so a capture joins at the health it
 * was already on. Measured on four of them: 898 to 898, 773 to 771, 845 and
 * 765 carried likewise. A building destroyed and rebuilt by the other player
 * on the same ground arrives near full instead, which is what this separates
 * it from.
 */
const STRUCTURE_CAPTURE_HP = 20;

/** A building the recording shows changing hands, and when. */
export interface StructureCapture {
  /** The house that lost it, and the house that took it. */
  from: number;
  to: number;
  name: string;
  cellX: number;
  cellY: number;
  /** First sighting under the new owner, in milliseconds of the recording. */
  at: number;
}

/**
 * Buildings an Engineer took.
 *
 * A building does not move and does not change type, so one record key
 * reporting the same structure on the same ground under a different house is
 * the game saying it changed hands. `readObjectTracks` already cuts a key
 * wherever the records change identity, which puts the two halves of a capture
 * in consecutive segments of one key.
 *
 * What separates that from a key recycled onto a rebuild is health.
 * `BuildingClass::Captured` leaves `Strength` where it was, so the halves join
 * at the health the building was already on; a rebuild follows a death, so the
 * first half ends at nothing and the second starts near full.
 *
 * Corroborated on every capture found so far — five, across three replays.
 * Each has an Engineer of the *taking* house on the map in the seconds before
 * the owner changes, and each joins at the health it was already on: 898 to
 * 898, 844 to 844, 773 to 771. The rule does not require the Engineer —
 * infantry tracks are not always there to be found, and the owner change is
 * the game stating the fact outright — but it is what confirmed the reading.
 *
 * Until this existed a captured building kept its first owner's colour for the
 * whole match, and its eventual destruction went unrecorded: `kill` looks for
 * a building of the house that lost it, and by then the house was the other
 * one.
 */
export function structureCaptures(tracks: readonly ObjectTrack[]): StructureCapture[] {
  const byKey = new Map<number, ObjectTrack[]>();
  for (const t of tracks) {
    if (!STRUCTURES.has(t.name)) continue;
    (byKey.get(t.key) ?? byKey.set(t.key, []).get(t.key)!).push(t);
  }
  const out: StructureCapture[] = [];
  for (const [, list] of byKey) {
    list.sort((a, b) => (a.samples[0]?.t ?? 0) - (b.samples[0]?.t ?? 0));
    for (let i = 1; i < list.length; i++) {
      const before = list[i - 1]!;
      const after = list[i]!;
      if (before.name !== after.name || before.owner === after.owner) continue;
      const last = before.samples[before.samples.length - 1];
      const first = after.samples[0];
      if (!last || !first) continue;
      // The same ground. A building's reported cell drifts by about a cell.
      if (
        Math.abs(last.cellX - first.cellX) > STRUCTURE_SITE_CELLS ||
        Math.abs(last.cellY - first.cellY) > STRUCTURE_SITE_CELLS
      ) {
        continue;
      }
      // Alive when it changed hands, and no healthier afterwards. Either
      // reading missing leaves it undecidable, so it is left alone.
      if (last.hp == null || first.hp == null) continue;
      if (last.hp <= 0) continue;
      if (first.hp > last.hp + STRUCTURE_CAPTURE_HP) continue;
      out.push({
        from: before.owner,
        to: after.owner,
        name: after.name,
        cellX: first.cellX,
        cellY: first.cellY,
        at: first.t,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A building the recording shows going away, and when. */
export interface StructureLoss {
  owner: number;
  name: string;
  cellX: number;
  cellY: number;
  /** When its track fell quiet, in milliseconds of the recording. */
  at: number;
}

/**
 * The placement orders that never became a building.
 *
 * A placement the game refused — the ground taken, the player's click on a
 * spot they could not build — is in the production records all the same, so
 * the viewer put down an Airstrip that never stood and kept it to the end.
 * Each order is matched to one building of its name and owner that went up
 * on its ground, nearest in time first, so an order placed twice on one spot
 * has one building between them and the spare is left over. Ground ranks
 * first, then time: order times and a building's first record can lie a
 * minute apart either way, so time only ranks the pairs and rules none out.
 */
function ordersNeverBuilt(orders: ReplayBuildOrders, lives: readonly StructureFrames[]): Set<unknown> {
  const out = new Set<unknown>();
  // Key 0xB001 borrows a standing building's name and cell for a single
  // record, never drawn. A building put down in the match's last seconds is
  // never drawn either, but nothing else stands on its ground.
  const real = lives.filter((b) => b.shapes.length || b.lastRecord > b.firstRecord || !lives.some((o) =>
    o !== b && o.key !== b.key && o.name === b.name && o.cellX === b.cellX && o.cellY === b.cellY &&
    o.firstRecord <= b.firstRecord && (o.until ?? Infinity) >= b.firstRecord));
  if (!real.length) return out;
  const pairs: { e: unknown; b: StructureFrames; cost: number }[] = [];
  const all: unknown[] = [];
  for (const [owner, list] of orders.byOwner) {
    for (const e of list) {
      if (e.name === "FACT" || e.cellX === null || e.cellY === null) continue;
      all.push(e);
      const at = e.completedAt ?? e.placedAt;
      for (const b of real) {
        if (b.name !== e.name || b.owner !== owner) continue;
        if (Math.abs(b.cellX - e.cellX) > PLACE_MATCH_CELLS || Math.abs(b.cellY - e.cellY) > PLACE_MATCH_CELLS) continue;
        // Its own cell before a neighbour: silos go up in rows two cells
        // apart, and by time alone an order took the silo next door.
        const cells = Math.max(Math.abs(b.cellX - e.cellX), Math.abs(b.cellY - e.cellY));
        pairs.push({ e, b, cost: cells * PLACE_CELL_COST_MS + Math.abs(b.firstRecord - at) });
      }
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  const built = new Set<unknown>();
  const taken = new Set<StructureFrames>();
  for (const { e, b } of pairs) {
    if (built.has(e) || taken.has(b)) continue;
    built.add(e);
    taken.add(b);
  }
  for (const e of all) if (!built.has(e)) out.add(e);
  return out;
}

/**
 * Structures the players lost.
 *
 * A building's track stopping well before the match does is that building
 * going away — destroyed or sold. Without this every structure ever built
 * stands to the final frame, which is why a base that really ended up with
 * two refineries was drawn with six.
 *
 * Only a building that was genuinely being followed counts. A structure is
 * restated when something about it changes, so a track of one or two
 * sightings means it was never tracked, not that it fell down — house 10's
 * Construction Yard has a single sighting at 5s and plainly survived.
 *
 * Exported because it is also what tells a building rebuilt on ground a
 * destroyed one used to hold from two buildings wrongly placed on top of one
 * another: without a death time the two look identical.
 */
export function structureLosses(
  tracks: readonly ObjectTrack[],
  inBounds: (x: number, y: number) => boolean,
): StructureLoss[] {
  const out: StructureLoss[] = [];
  const lastFrameOfMatch = Math.max(
    0,
    ...tracks.map((t) => t.samples[t.samples.length - 1]?.t ?? 0),
  );
  for (const track of tracks) {
    if (!STRUCTURES.has(track.name)) continue;

    // A building never moves, so every cell this track visited is a *different*
    // building on a recycled key. Splitting on position alone does not catch
    // that: the segmenter needs a jump of several cells, and a key reused on a
    // structure two cells away stays one track. Reading its last cell then
    // attributes the death to the wrong building entirely — it had a
    // Construction Yard being demolished at a gun turret's coordinates.
    const sites: {
      cellX: number; cellY: number; n: number; first: number; last: number; peak: number; final: number;
    }[] = [];
    for (const s of track.samples) {
      // Within a footprint of an existing site is the same building: a
      // structure's reported cell drifts by a cell, and treating each exact
      // cell as its own building split one Construction Yard into several.
      // Same place *and* not healthier than the building already standing
      // there. A key recycled onto a fresh structure on the same ground shows
      // up as health jumping back toward full, and merging those two lives
      // into one site mixed their peak and final readings — which is what left
      // the rule finding three losses where the per-site figures justify six.
      const near = sites.find(
        (q) =>
          Math.abs(q.cellX - s.cellX) <= STRUCTURE_SITE_CELLS &&
          Math.abs(q.cellY - s.cellY) <= STRUCTURE_SITE_CELLS &&
          !(s.hp != null && q.final > 0 && s.hp > q.final + STRUCTURE_REBUILD_HP),
      );
      const site = near ?? { cellX: s.cellX, cellY: s.cellY, n: 0, first: s.t, last: s.t, peak: 0, final: 0 };
      if (!near) sites.push(site);
      site.n++;
      if (s.t < site.first) site.first = s.t;
      if (s.t >= site.last) {
        site.last = s.t;
        if (s.hp != null) site.final = s.hp;
      }
      if (s.hp != null && s.hp > site.peak) site.peak = s.hp;
    }
    for (const site of sites) {
      if (!inBounds(site.cellX, site.cellY)) continue;
      // Read at nothing: destroyed, whatever else holds. The rules below are
      // for a building that merely went quiet, and they left out every
      // building that fell within twenty seconds of being built or of the
      // match ending — a rush, and the assault that won the game. Of 45
      // structures the score screens of seven matches count as destroyed,
      // they found 23; with this, 44.
      if (site.peak && site.final <= site.peak * STRUCTURE_ZERO_FRACTION) {
        out.push({ owner: track.owner, name: track.name, cellX: site.cellX, cellY: site.cellY, at: site.last });
        continue;
      }
      if (site.n < STRUCTURE_TRACKED_SAMPLES) continue;
      if (site.last - site.first < STRUCTURE_TRACKED_MS) continue;
      if (lastFrameOfMatch - site.last <= STRUCTURE_GONE_MS) continue;
      if (!inBounds(site.cellX, site.cellY)) continue;
      // Health decides it. A building that goes quiet at **full** health was
      // simply not being restated any more; one that goes quiet **damaged**
      // fell. Without this the same rule demolished both Construction Yards in
      // a match one player went on to win — the winner's yard is at 800 of 800
      // when it drops out of the stream, the loser's at 390.
      if (!site.peak) continue;
      if (site.final > site.peak * STRUCTURE_DEAD_FRACTION) continue;
      out.push({ owner: track.owner, name: track.name, cellX: site.cellX, cellY: site.cellY, at: site.last });
    }
  }
  return out;
}

/**
 * How long a harvester's track goes silent while it unloads a full load, in
 * game frames: the Refinery's 600, the 7 before it between the harvester's
 * last sighting and the Refinery taking it, and the 8 after it before the
 * harvester is seen driving out.
 *
 * 119 of 162 holes at a Refinery across four matches are exactly 615 frames,
 * and 4 more are within two of it.
 */
const UNLOAD_HOLE_FRAMES = { shortest: 600, longest: 720 } as const;

/** Game frames between the Refinery going idle and the harvester reappearing. */
const UNLOAD_RELEASE_FRAMES = 8;

/**
 * When a harvester was taken into a Refinery to unload, in recording ms.
 *
 * An unloading harvester is in limbo (UNIT.CPP:1819) and limboed objects are
 * not exported (DLLInterface.cpp:3382), so an unload is a hole in the
 * harvester's track at the Refinery. The hole is 615 game frames for a full
 * load — the Refinery's 600, plus 7 frames of the harvester silent on the pad
 * before it is taken and 8 before it is seen again — and anchoring on the far
 * end puts the start where the Refinery's own recorded frames put it for
 * every one of 119 docks.
 *
 * Only full-length holes are read as unloads. Shorter silences by a Refinery
 * are plentiful — the stream states only what changed, so a harvester waiting
 * on the apron says nothing — and where the Refinery was sampled during one it
 * was drawing its idle frames. A partial load would fall on a ladder twenty
 * frames a step below 615, and none of the matches measured has one.
 *
 * A hole running past 615 is anchored on its end all the same: the extra is
 * the harvester sitting silent on the pad before it was taken, which says
 * nothing about when the unload finished.
 */
export function recordedUnloads(
  samples: readonly { t: number; cellX: number; cellY: number }[],
  atRefinery: (x: number, y: number, t: number) => boolean,
): number[] {
  const unloadMs = refineryUnload(TIBERIUM_STEPS_PER_LOAD).total * (1000 / TICK_HZ);
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1]!;
    const after = samples[i]!;
    const frames = (after.t - before.t) / GAME_FRAME_MS;
    if (frames < UNLOAD_HOLE_FRAMES.shortest || frames > UNLOAD_HOLE_FRAMES.longest) continue;
    if (!atRefinery(before.cellX, before.cellY, before.t)) continue;
    out.push(after.t - UNLOAD_RELEASE_FRAMES * GAME_FRAME_MS - unloadMs);
  }
  return out;
}

/**
 * The building a unit went into and never came out of, if that building then
 * fell.
 *
 * A harvester unloading is attached to its Refinery and put in limbo
 * (UNIT.CPP:1819), so it stops being exported at all and its track ends on the
 * approach. If the Refinery is destroyed while it is in there the game deletes
 * it on the spot — BUILDING.CPP:1504, on RESULT_DESTROYED: "Destroy all
 * attached objects" — and the same runs at 4153 when the building is sold.
 * What the recording shows is a harvester driving up to a Refinery and never
 * coming out.
 *
 * So that is the whole of the evidence, and it is enough: a unit's last
 * sighting on or beside a building of its own side, and that building gone
 * afterwards. Across four matches it convicts exactly one unit — the harvester
 * that docked at 114.1s on 18,39 while the Refinery beside it stood at 14
 * health of 900 with ten seconds to live. Nothing else came near the rule.
 *
 * The death is dated to the building's, not to the last sighting: the unit was
 * alive inside it until then.
 */
export function tombFor(
  last: { t: number; cellX: number; cellY: number },
  owner: number,
  losses: readonly StructureLoss[],
): StructureLoss | undefined {
  return losses.find((l) => {
    if (l.owner !== owner || l.at < last.t) return false;
    const cells = BLDG_OCCUPY[KIND_BY_ASSET[l.name] ?? ""] ?? [[0, 0]];
    return cells.some(
      ([dx, dy]) =>
        Math.abs(l.cellX + dx - last.cellX) <= DOCK_RING &&
        Math.abs(l.cellY + dy - last.cellY) <= DOCK_RING,
    );
  });
}

/**
 * Buildings the ground says must already have gone.
 *
 * `Legal_Placement` will not let a structure go down on a cell another one
 * stands on, so a placement is proof that whatever held those cells before it
 * was gone by then. That is a rule of the game rather than an inference about
 * the recording, and it settles what the health-and-silence rule cannot.
 *
 * It has to, because that rule is deliberately cautious: a building must have
 * been followed for twenty sightings across twenty seconds before its track
 * ending is read as a loss, which is right — a structure sighted twice and
 * never mentioned again did not fall down. But a Silo that dies young is
 * sighted a handful of times and misses the gate, and then stands on the map
 * for the rest of the match with its replacement drawn on top of it. Every
 * such case measured had a track that went quiet just under one threshold or
 * the other: thirteen, fourteen, sixteen, eighteen, nineteen sightings, or
 * six, fifteen and nineteen seconds.
 *
 * It does not get the last word, though. Of twenty-two conflicts measured,
 * twelve have the older building never sighted again once the newer went up —
 * those are the deaths that slipped the gate. Nine have it sighted alive
 * afterwards, one of them a Refinery at 900 of 900 thirty-eight seconds later,
 * and those are not unnoticed deaths at all: they are placements in the wrong
 * place, and killing the building would hide a decoding fault behind a
 * base that looks reasonable. So the recording is asked first, and only a
 * death it does not contradict is written.
 *
 * The kill lands a tick before the placement, so the building being replaced
 * is the only one standing on that ground when it arrives.
 */
export function crowdedOut(
  cmds: readonly ReplayCommand[],
  seenAliveAfter: (p: 0 | 1, kind: string, x: number, y: number, after: number) => boolean,
): { kills: ReplayCommand[]; drop: ReadonlySet<ReplayCommand> } {
  const cells = (kind: string, x: number, y: number): string[] =>
    (BLDG_OCCUPY[kind] ?? [[0, 0]]).map(([dx, dy]) => `${x + dx},${y + dy}`);
  const placed = cmds
    .filter((c) => (c.k === "place" || c.k === "deploy") && c.x != null && c.y != null)
    .map((c) => ({
      cmd: c,
      t: c.t,
      p: c.p,
      x: c.x!,
      y: c.y!,
      kind: c.k === "deploy" ? "fact" : (c.kind ?? ""),
      held: cells(c.k === "deploy" ? "fact" : (c.kind ?? ""), c.x!, c.y!),
    }))
    .sort((a, b) => a.t - b.t);
  const killed = cmds.filter((c) => c.k === "kill" && c.x != null && c.y != null);
  const kills: ReplayCommand[] = [];
  const drop = new Set<ReplayCommand>();
  for (let i = 0; i < placed.length; i++) {
    const older = placed[i]!;
    // Already known to have gone, by its own track.
    if (killed.some((k) => k.p === older.p && older.held.includes(`${k.x},${k.y}`))) continue;
    for (let j = i + 1; j < placed.length; j++) {
      const newer = placed[j]!;
      if (newer.p !== older.p || newer.t <= older.t) continue;
      if (!newer.held.some((c) => older.held.includes(c))) continue;
      // Unless the recording disagrees. Nine of the twenty-two conflicts
      // measured have the older building sighted alive after the newer is
      // said to have gone up — a Refinery at 900 of 900 thirty-eight seconds
      // later — and those are not deaths that went unnoticed, they are
      // placements in the wrong place. Killing the building would hide a
      // decoding fault behind a plausible-looking base.
      if (seenAliveAfter(older.p, older.kind, older.x, older.y, newer.t)) {
        // The older one is provably still there, so the newer never stood on
        // this ground. Six such placements are left after every other rule has
        // run, and each has only the one sighting to its name — three of them
        // a Power Plant landing on the exact cell of a Barracks or a Silo the
        // recording keeps reporting alive. There is nowhere better to put it,
        // so it is not put anywhere: an absent building is incomplete, one
        // drawn through another is wrong. The item still appears in the
        // production queue, which is decoded separately and is not in doubt.
        drop.add(newer.cmd);
        continue;
      }
      kills.push({
        t: Math.max(1, newer.t - 1),
        p: older.p,
        k: "kill",
        x: older.x,
        y: older.y,
        real: true,
        silent: true,
      });
      break;
    }
  }
  return { kills, drop };
}
