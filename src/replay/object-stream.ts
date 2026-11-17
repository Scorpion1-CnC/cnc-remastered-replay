import { BLDG_OCCUPY, KIND_BY_ASSET, occupiedCells } from "../engine/footprint";
import { inflateSyncFlush } from "./inflate";

/**
 * Decoder for the C&C Remastered `.Replay` game stream.
 *
 * The container and framing are documented in
 * `docs/RESEARCH-LOG.md`, along with how each field below was
 * verified. In short: the file is a *state stream*, not a command log — it
 * records the game DLL's exported structs (`DLLInterface.h`) roughly every
 * 22ms, as ~20.8s keyframes plus deltas.
 *
 * Two record types matter here, and they are told apart by how the name is
 * written:
 *
 *   - `CNCSidebarEntryStruct` writes its asset name **once**. It carries the
 *     production queue: what is being built and how far along.
 *   - `CNCObjectStruct` writes its name **twice** (`TypeName` then
 *     `AssetName`). It is the object on the map, and it is the only place the
 *     **owner** appears.
 *
 * Neither alone is enough. The sidebar has accurate timing but no owner; the
 * object stream has the owner but is transmitted sparsely, so its first
 * sighting of a building can lag the real placement by tens of seconds. The
 * two are joined in {@link readBuildOrders}.
 *
 * Runs in node and in a browser: the payloads are sync-flushed, which is why
 * inflating goes through {@link inflateSyncFlush} rather than straight to
 * `node:zlib`.
 */

/** A production-queue observation from `CNCSidebarEntryStruct`. */
export interface SidebarSample {
  /** Milliseconds since the first frame. */
  t: number;
  /** Asset name, e.g. `NUKE`, `HAND`, `E1`. */
  name: string;
  /** `RTTIType`: 8 = BUILDINGTYPE, 4 = UNITTYPE, 2 = INFANTRYTYPE. */
  rtti: number;
  /** `StructType` / `UnitType` index within that RTTI category. */
  typeIndex: number;
  /** `DllObjectTypeEnum`: 15 = BUILDING_TYPE, 13 = UNIT_TYPE, 12 = INFANTRY_TYPE. */
  dllType: number;
  cost: number;
  /** Power provided (positive) or drained (negative). */
  power: number;
  /** 10 = actively building, 8 = listed but idle, 0 = done/unavailable. */
  state: number;
  /** Build progress 0..1023, meaningful only while `state === 10`. */
  progress: number;
}

/** An object-on-the-map observation from `CNCObjectStruct`. */
export interface ObjectSample {
  t: number;
  name: string;
  /** `DllObjectTypeEnum`: 4 = BUILDING, 2 = UNIT, 1 = INFANTRY, 5 = TERRAIN. */
  dllType: number;
  id: number;
  /**
   * True when the record caught the object mid-buildup — its `AssetName` was
   * the `*MAKE` variant. This is a direct observation of construction, so it
   * bounds placement far more tightly than a plain sighting.
   */
  underConstruction: boolean;
  /** House index. Distinct values separate the players. */
  owner: number;
  remapColor: number;
  /**
   * Footprint width and height. These are per *type*, not per instance —
   * NUKE reads (78,78), HAND (78,116), PROC (116,116), matching 2x2, 2x3 and
   * 3x3 cell footprints. An earlier version labelled them cellX/cellY, which
   * was wrong: every building of a type shared the same "position".
   */
  width: number;
  height: number;
  /** Raw record body, so position can be decoded once the offset is known. */
  body: Uint8Array;
}

/**
 * Map position packed into three bytes.
 *
 * ```
 * pos24 = b[k] | b[k+1] << 8 | (b[k+2] & 0x0F) << 16
 * y = pos24 >> 12                 // whole cells
 * x = (pos24 & 0xFFF) / 32        // cells, 1/32 precision
 * ```
 *
 * Verified against a real map: decoding every terrain object in a Heavy Metal
 * replay and pairing it with the `[Terrain]` section of the map's own .ini
 * reproduces **64 of 65** cells exactly (the one miss is a record whose
 * name pairing had drifted, not a decode error).
 */
export function decodeCell(body: Uint8Array, at: number): { x: number; y: number } {
  const v = (body[at] ?? 0) | ((body[at + 1] ?? 0) << 8) | (((body[at + 2] ?? 0) & 0x0f) << 16);
  return { x: (v & 0xfff) / 32, y: v >>> 12 };
}

/**
 * Where a record keeps its position when nothing precedes it.
 *
 * Terrain reads here, and so does a building whose occupy list is empty. See
 * {@link structureCellOffset} for what pushes it along.
 */
export const TERRAIN_CELL_OFFSET = 29;

/**
 * Where a building record keeps its cell: the occupy list, written inline.
 *
 * The offset is not fixed per type — a Gun Turret reads at 31, a Barracks at
 * 33, a Refinery at 37, an Airstrip at 45 — and this is why. A building
 * record carries the type's occupy list ahead of the position, one `short`
 * per cell, so the cell sits two bytes further along for every cell the
 * building covers:
 *
 *     at = TERRAIN_CELL_OFFSET + 2 * cells
 *
 *     gun 1 -> 31   silo 2 -> 33   pyle 2 -> 33   powr 3 -> 35
 *     hand 3 -> 35  proc 4 -> 37   hpad 4 -> 37   fact 6 -> 41
 *     weap 6 -> 41  afld 8 -> 45
 *
 * Ten types, ten hits, and terrain — which stands on no cells at all — is the
 * zero case that fixes where the count starts from. It also settles what
 * {@link findCellOffset} could only note as unexplained: the position does sit
 * at a constant place in the record, just not a constant number of bytes from
 * the start of it.
 *
 * The list comes from DLLInterface.cpp:3028, which walks
 * `building_type->Occupy_List()` to `REFRESH_EOL` — the same list the game
 * data gives {@link BLDG_OCCUPY}, so the count is already to hand and nothing
 * has to be searched for.
 *
 * Returns null for a name with no occupy list of ours — the civilian village
 * buildings, mostly — leaving those to the search.
 */
export function structureCellOffset(name: string): number | null {
  const kind = KIND_BY_ASSET[name];
  const occupy = kind ? BLDG_OCCUPY[kind] : undefined;
  return occupy ? TERRAIN_CELL_OFFSET + 2 * occupy.length : null;
}

/**
 * The cell a building record states, or null where it states none.
 *
 * Not every record carries one. DLLInterface.cpp:2985 zeroes
 * `OccupyListLength` and fills it only when `base_object == NULL`, so a
 * second draw call for the same building writes no occupy list — and, it
 * turns out, no position at the offset the list would have moved it to. Those
 * records read (0,0), which is not a cell any building stands on: TD's
 * playable rectangle is inset from the map edge, and across twenty replays no
 * tracked structure is ever at the corner.
 *
 * Reading them at {@link TERRAIN_CELL_OFFSET} instead — where a record with no
 * list should keep its position — was tried and is worse than reading nothing:
 * scored against the track records it added 116 wrong cells and not one right
 * one. So a sub-object draw contributes no position, and the building's other
 * sightings supply it.
 */
export function decodeStructureCell(
  name: string,
  body: Uint8Array,
  mapCells = 64,
): { x: number; y: number } | null {
  const at = structureCellOffset(name);
  if (at == null) return null;
  const c = decodeCell(body, at);
  if (!Number.isInteger(c.x)) return null;
  if (c.x < 0 || c.x >= mapCells || c.y < 0 || c.y >= mapCells) return null;
  if (c.x === 0 && c.y === 0) return null;
  return c;
}

/**
 * Find which offset holds an object type's position, with nothing to go on.
 *
 * A blind search: it scores an offset by the constraints a real position must
 * satisfy — on the map, on a whole cell, and different for different instances
 * of the same type — and takes the best. Types with only one or two instances
 * give it little to work with, so their positions are the least trustworthy,
 * and a type only one player built could be thrown out entirely for having a
 * single value where a single value is exactly right.
 *
 * **Buildings no longer come through here.** Their offset is not a guess any
 * more: it follows from the occupy list the record carries ahead of the
 * position, and {@link structureCellOffset} states it outright. Only the
 * civilian village buildings, which the game data here does not cover, are
 * still searched for — along with units, aircraft and animations, which have
 * no occupy list at all and are searched by {@link findMobileCellOffset}.
 *
 * That leaves one thing this comment used to get wrong worth keeping. Reading
 * the field at a single fixed offset for every type does not work, and
 * `_cellfixed.ts` shows why: score all of 24..52 across twelve replays on the
 * one thing a building cannot fail — it never moves, so every sighting of an
 * id must decode to the same cell — and the only offset scoring 100% yields a
 * per-replay constant. The recording is not writing `CNCObjectStruct`
 * verbatim; it writes the occupy list where the struct does not.
 */
export function findCellOffset(
  bodies: Uint8Array[],
  mapCells = 64,
  /** Optional base centroid; used to break ties when instances are few. */
  near?: { x: number; y: number },
  /**
   * Require whole-cell x. True for structures and terrain, which are grid
   * aligned. **False for units, aircraft and animations** — they stand and
   * explode between cells, and demanding a whole number there rejects the
   * real field and leaves the search to settle on a constant (every effect at
   * 0,0 was this bug).
   */
  wholeCell = true,
  /**
   * The owner of each body, in the same order.
   *
   * Only used to know whether a field that never varies is suspicious. Two
   * owners means at least two buildings and so at least two cells; one owner
   * may well be one building sighted twenty times, where a single value is
   * exactly what the position field should read.
   */
  owners?: readonly number[],
): number | null {
  let best: { at: number; score: number } | null = null;
  // 24..52 deliberately, though the body now runs to OBJECT_BODY_BYTES.
  // Widening the search to the full record regressed unit tracks badly:
  // this function scores an offset by how many distinct values it produces,
  // which stops discriminating once there are hundreds of candidates, and it
  // settled on wrong fields that happened to vary. Structures were unaffected
  // (all 23 cells identical either way). The fields past 64 are real and
  // worth identifying, but they need a positional criterion stronger than
  // "varies a lot" — track continuity, not distinct count.
  for (let at = 24; at <= 52; at++) {
    const ps = bodies.map((b) => decodeCell(b, at));
    if (ps.some((q) => q.x < 0 || q.x >= mapCells || q.y < 0 || q.y >= mapCells)) continue;
    if (wholeCell && ps.some((q) => !Number.isInteger(q.x))) continue;
    // A field that never varies is a constant, not a position -- but only
    // where something was standing in more than one place to begin with.
    //
    // Bodies are pooled by type across both players, so this used to reject on
    // sample count alone: four sightings, one value, discarded. That is the
    // normal shape of a type only one player builds. A Weapons Factory in a
    // GDI-versus-Nod game is built once and sighted twenty times, always at
    // the same cell, so the real offset was thrown out and the search settled
    // on whatever field happened to vary -- five Barracks at x=0, or no
    // offset at all and the structure left unplaced.
    const distinctOwners = owners ? new Set(owners).size : 2;
    if (new Set(ps.map((q) => `${q.x},${q.y}`)).size < 2 && distinctOwners > 1 && bodies.length > 3) continue;
    const distinct = new Set(ps.map((q) => `${q.x},${q.y}`)).size;
    // With one or two instances, "distinct" barely discriminates and several
    // offsets look equally valid. A structure belongs to a base, so prefer the
    // reading that lands near the owner's other buildings.
    let score = distinct * 100;
    if (near) {
      const d =
        ps.reduce((sum, q) => sum + Math.hypot(q.x - near.x, q.y - near.y), 0) / ps.length;
      score -= d;
    }
    if (!best || score > best.score) best = { at, score };
  }
  return best ? best.at : null;
}

/**
 * Pick a position offset for objects that move, by track continuity.
 *
 * {@link findCellOffset} scores an offset by how many distinct values it
 * yields. That works for structures, which never move, but it is the wrong
 * question for a unit: plenty of unrelated fields vary a lot. Vehicles and
 * aircraft consequently never resolved a sane position — BGGY tracks read as
 * three or four repeating constants.
 *
 * The right question is whether the values behave like a position over time:
 * between two sightings of the *same object* a few seconds apart, a real
 * position can only have changed as far as a unit can travel. A wrong field
 * jumps arbitrarily — and, critically, so does a field that never moves at
 * all, which is why MIN_TRAVEL below is not optional. Infantry resolve
 * cleanly this way (offset 29, 100% plausible, 27 distinct cells).
 *
 * `sightings` must be every record of one object type, in any order.
 */
export function findMobileCellOffset(
  sightings: { id: number; t: number; body: Uint8Array }[],
): number | null {
  /** Cells per second no TD ground unit exceeds, plus slack. */
  const MAX_CELLS_PER_SEC = 3;
  /**
   * A real position crosses ground; a near-constant field never does, and a
   * constant never breaks a speed limit either. Offset 86 looked like a
   * confirmed hit at "100% plausible over 47 pairs" until travel was
   * measured: 1.1 cells across a seven-minute match.
   *
   * Kept deliberately low. The heavy lifting against degenerate fields is now
   * done by the two-axis and not-the-id gates below, which reject them
   * outright; a high travel bar instead throws away real short-range units. A
   * harvester shuttling between refinery and tiberium travels 6.7 cells at
   * most in this match, and an 8-cell bar silently discarded every one.
   */
  const MIN_TRAVEL = 4;
  /**
   * Below this, no field describes movement well enough to be a position.
   *
   * Not 0.9. Object ids are recycled when a unit dies, so a track keyed on
   * owner and id still splices a dead unit onto its replacement now and then,
   * and each splice reads as one impossible jump. That is a property of the
   * data, not of the offset. With full stream coverage infantry score 87% —
   * 41 of 47 short-gap pairs — at an offset that puts **100%** of readings on
   * the map with 32 distinct x and 38 distinct y. A hard 90% threw that away.
   *
   * The gates that actually separate a position from a look-alike are the
   * in-bounds rate and the two-axis test; this one only needs to reject fields
   * that teleport constantly.
   */
  const MIN_PLAUSIBLE = 0.75;
  /** A position varies in BOTH axes. */
  const MIN_DISTINCT_PER_AXIS = 5;

  const tracks = new Map<number, { id: number; t: number; body: Uint8Array }[]>();
  for (const s of sightings) {
    const a = tracks.get(s.id) ?? [];
    a.push(s);
    tracks.set(s.id, a);
  }
  for (const v of tracks.values()) v.sort((a, b) => a.t - b.t);

  let best: { at: number; rank: number; distinct: number } | null = null;
  for (let at = 24; at + 3 <= OBJECT_BODY_BYTES; at++) {
    const distinct = new Set<string>();
    const xs = new Set<number>();
    const ys = new Set<number>();
    let mirrorsId = 0;
    let plausible = 0;
    let pairs = 0;
    let spread = 0;
    let inBounds = 0;
    let readable = 0;
    for (const raw of tracks.values()) {
      // Records near the end of a payload are cut short and decode to
      // nonsense. Drop those readings rather than rejecting the offset.
      const v: { t: number; x: number; y: number }[] = [];
      for (const s of raw) {
        if (s.body.length < at + 3) continue;
        readable++;
        const c = decodeCell(s.body, at);
        if (c.x < 0 || c.x > 63 || c.y < 0 || c.y > 63) continue;
        inBounds++;
        distinct.add(c.x.toFixed(1) + "," + c.y);
        xs.add(Number(c.x.toFixed(1)));
        ys.add(c.y);
        if (Math.abs(c.x - s.id) < 0.01) mirrorsId++;
        v.push({ t: s.t, x: c.x, y: c.y });
      }
      for (let i = 0; i + 1 < v.length; i++) {
        const dt = (v[i + 1]!.t - v[i]!.t) / 1000;
        const step = Math.hypot(v[i + 1]!.x - v[i]!.x, v[i + 1]!.y - v[i]!.y);
        if (step > spread) spread = step;
        // Only short gaps constrain speed: given a minute a unit can be
        // anywhere, and every offset would look plausible.
        if (dt > 10) continue;
        pairs++;
        if (step <= MAX_CELLS_PER_SEC * dt + 1.5) plausible++;
      }
    }
    if (readable < 8 || inBounds / readable < 0.95) continue;
    if (distinct.size < 6 || spread < MIN_TRAVEL) continue;
    // These two are what separate a position from a field that merely varies.
    // Without them the scan picked, for BGGY, a field whose y is always 0 and
    // whose x is the object id itself — id 13 decoding as x=13, id 33 as
    // x=33 — which scored well on distinct values and on travel.
    if (xs.size < MIN_DISTINCT_PER_AXIS || ys.size < MIN_DISTINCT_PER_AXIS) continue;
    if (mirrorsId > inBounds * 0.5) continue;
    // With too few closely-spaced sightings there is nothing to test speed
    // against. Rank those below anything that was actually measured rather
    // than discarding them: HARV and E4 are sampled that sparsely.
    const frac = pairs >= 4 ? plausible / pairs : null;
    if (frac !== null && frac < MIN_PLAUSIBLE) continue;
    const rank = frac ?? MIN_PLAUSIBLE - 0.01;
    if (!best || rank > best.rank || (rank === best.rank && distinct.size > best.distinct)) {
      best = { at, rank, distinct: distinct.size };
    }
  }
  return best ? best.at : null;
}export interface FrameInfo {
  index: number;
  /** Milliseconds since the first frame, after chronological sorting. */
  t: number;
  /** 0 = delta, 1 = keyframe. */
  kind: number;
  payload: Uint8Array;
}

const CHUNK_HEADER_BYTES = 36;
/** Frame directory record: `hash@2, frame@6, length@10, offset@14, index@18`. */
const DIR_RECORD_BYTES = 20;

interface DirEntry {
  index: number;
  length: number;
  offset: number;
}

function u32(d: Uint8Array, p: number): number {
  return ((d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0);
}

/**
 * Read the container header and frame directory.
 *
 * The directory's field offsets are two bytes further in than they look; the
 * tell for getting this wrong is a column of values like `65538 = (1<<16)|2`.
 * Correct offsets give an exact chain — `offset[i] + length[i] === offset[i+1]`
 * for every record, ending precisely at EOF.
 */
function readDirectory(buf: Uint8Array): DirEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(0, true);
  const tableOneBytes = view.getUint32(8, true);
  const base = 12 + tableOneBytes;
  const out: DirEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = base + i * DIR_RECORD_BYTES;
    if (o + DIR_RECORD_BYTES > buf.byteLength) break;
    out.push({
      index: i,
      length: view.getUint32(o + 10, true),
      offset: view.getUint32(o + 14, true),
    });
  }
  return out;
}

/**
 * What the game itself counted, from the chunk that holds the score screen.
 *
 * Every chunk in the container carries a kind byte, and almost all of them are
 * 0 — a game frame. A handful are 1, which are 168KB dumps of the whole world
 * about once a minute, and exactly one is 85: the end-of-match record. It
 * holds two JSON objects, the lobby's settings and the score screen, and it is
 * the only place the game's own totals appear. Everything else here is decoded
 * from what the players were shown; these are the numbers the game kept.
 *
 * `0` and `1` index the two players in the same order as the JSON header's
 * playerList, which `MPSteamPlayerIDs` ties down.
 */
export interface Scoreboard {
  /** The lobby settings: bases, crates, tech level, starting credits, speed. */
  settings: Record<string, unknown>;
  /**
   * The score screen, when the match reached one.
   *
   * Not every replay has it. The chunk is written either way, but a match that
   * ended by someone leaving carries the settings alone — of twenty ladder
   * replays, six have the totals.
   */
  totals: ScoreTotals | null;
}

/** The game's own end-of-match counts, per player. */
export interface ScoreTotals {
  /** Units each player destroyed, and structures, as the game counted them. */
  unitsKilled: [number, number];
  structuresKilled: [number, number];
  /** Credits each player harvested over the match. */
  gathered: [number, number];
  /** The score screen's own figures. */
  scores: [number, number];
  /** Steam ids, in the same order, which tie these to the header's players. */
  steamIds: [string, string];
  winner: 0 | 1 | null;
  durationMs: number;
  /** Everything the score screen carried, for anything not named above. */
  raw: Record<string, unknown>;
}

/** Pull the JSON objects out of a chunk of mixed binary and text. */
function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v: unknown = JSON.parse(text.slice(i, j + 1));
            if (v && typeof v === "object") out.push(v as Record<string, unknown>);
          } catch {
            // Not JSON after all; the chunk is mostly binary.
          }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** The score screen the game wrote at the end of the match, if it is there. */
export async function readScoreboard(bytes: Uint8Array): Promise<Scoreboard | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const e of readDirectory(bytes)) {
    const o = e.offset;
    if (o + CHUNK_HEADER_BYTES > bytes.byteLength) continue;
    const compressed = view.getUint32(o + 16, true);
    if (compressed <= 0 || o + CHUNK_HEADER_BYTES + compressed > bytes.byteLength) continue;
    const p = await inflateSyncFlush(
      bytes.subarray(o + CHUNK_HEADER_BYTES, o + CHUNK_HEADER_BYTES + compressed),
    );
    if (!p) continue;
    if (p[8] !== SCORE_CHUNK_KIND) continue;
    let text = "";
    for (const b of p) text += String.fromCharCode(b);
    const objects = jsonObjectsIn(text);
    const settings = objects.find((o2) => "tech_level" in o2);
    if (!settings) continue;
    const score = objects.find((o2) => "MPUnitsKilled0" in o2);
    if (!score) return { settings, totals: null };
    const num = (k: string): number => (typeof score[k] === "number" ? (score[k] as number) : 0);
    // Steam ids are seventeen digits, past what a double holds exactly, so
    // they are read from the text rather than from the parsed number — which
    // comes back rounded and matches nobody.
    const id = (k: string): string => new RegExp(`"${k}":(\\d+)`).exec(text)?.[1] ?? "";
    const won0 = num("MPWinners0") === 1;
    const won1 = num("MPWinners1") === 1;
    return {
      settings,
      totals: {
        unitsKilled: [num("MPUnitsKilled0"), num("MPUnitsKilled1")],
        structuresKilled: [num("MPStructuresKilled0"), num("MPStructuresKilled1")],
        gathered: [num("MPResourcesGathered0"), num("MPResourcesGathered1")],
        scores: [num("MPScores0"), num("MPScores1")],
        steamIds: [id("MPSteamPlayerIDs0"), id("MPSteamPlayerIDs1")],
        winner: won0 === won1 ? null : won0 ? 0 : 1,
        durationMs: num("TimeMilliseconds"),
        raw: score,
      },
    };
  }
  return null;
}

/** The chunk kind that carries the score screen; frames are 0, world dumps 1. */
const SCORE_CHUNK_KIND = 85;

/**
 * There is no chat in a replay, and there is no way to put it there.
 *
 * Worth writing down, because the file looks like it should have it. A match
 * whose chat is known — a recording of the player's own screen shows
 * "Scorpion1 (Nd): LOL" at eight seconds — was taken apart completely: all
 * 21,812 chunks inflated and searched for that text, in bytes and in UTF-16,
 * and for the player's name and the "(Nd):" the chat line wears. None of them
 * carries any of it. Every byte of the file is accounted for: the header and
 * its directory, then chunks, and the only readable text in the whole thing is
 * the JSON header and the score screen above.
 *
 * "LOL" does appear three times in the raw bytes, and each time it is inside a
 * deflate stream — 144, 300 and 4,089 bytes into three different frames —
 * whose inflated contents do not contain it. Compressed bytes are near enough
 * to random that three three-letter coincidences in 16MB is what chance
 * predicts.
 *
 * Nor is anything lost on the way: a replay downloaded from the ladder's host
 * is byte-identical to the one the game saved locally for the same match.
 *
 * The reason is in the game's own log. Chat travels as CLIENT_TO_SERVER_CHAT_-
 * MESSAGE and comes back as SERVER_TO_CLIENT_CHAT_MESSAGE — a network event
 * between the client and the match server, handled by the lobby layer. What a
 * replay stores is the simulation's event stream, which chat never enters.
 * The local logs record that a message was sent, with a timestamp, and not
 * what it said.
 */

/**
 * Inflate every frame, in chronological order.
 *
 * Two things bite here. The payloads are network sync-flushed and carry no
 * end-of-stream marker, so they need `Z_SYNC_FLUSH` — a strict inflate
 * rejects all of them. And frames are stored in reverse-chronological groups
 * of ~101, so the stream must be sorted by the timestamp in the payload
 * before it means anything.
 *
 * A replay is read by a dozen readers, and inflating it is most of what each
 * of them costs — a fourteen-minute match is sixty megabytes of frames. So the
 * frames are inflated once per file and shared. Nothing that reads them
 * changes them.
 */
export function readFrames(bytes: Uint8Array): Promise<FrameInfo[]> {
  let hit = framesOf.get(bytes);
  if (!hit) {
    hit = inflateFrames(bytes);
    framesOf.set(bytes, hit);
  }
  return hit;
}

const framesOf = new WeakMap<Uint8Array, Promise<FrameInfo[]>>();

/**
 * Let the server answer others while a replay decodes.
 *
 * Decoding is ten seconds of work for a long match, and an `await` on
 * something already done never lets go of the thread: a probe timer set to
 * fire every 10ms did not fire once in the whole of it. So every loop over the
 * frames calls this, and once the decode has held the thread for BREATH_MS it
 * steps aside for whatever else is waiting.
 */
export async function breathe(): Promise<void> {
  const now = performance.now();
  if (now - lastBreath < BREATH_MS) return;
  await new Promise<void>(yieldThread);
  lastBreath = performance.now();
}

/**
 * Step aside for whatever else the thread has to do.
 *
 * `setImmediate` is node's, and is what the server wants: it runs after I/O
 * rather than behind a timer. A browser has no such thing, and the decode runs
 * there too now — on the page that opens a replay from disk — where yielding
 * matters more, not less, because the thread it is holding is the one drawing
 * the window. `setTimeout(0)` is the portable stand-in; browsers clamp nested
 * timers to about 4ms, which is the right order next to BREATH_MS anyway.
 */
function yieldThread(resolve: () => void): void {
  if (typeof setImmediate === "function") setImmediate(resolve);
  else setTimeout(resolve, 0);
}

const BREATH_MS = 15;
let lastBreath = 0;

async function inflateFrames(bytes: Uint8Array): Promise<FrameInfo[]> {
  const dir = readDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: FrameInfo[] = [];
  for (const e of dir) {
    await breathe();
    // Frame 0 is the lobby/settings record and frame 1 the JSON header;
    // neither carries a game timestamp, and including them stretches the
    // measured duration wildly.
    if (e.index < 2) continue;
    const o = e.offset;
    if (o + CHUNK_HEADER_BYTES > bytes.byteLength) continue;
    if (bytes[o] !== 0x43 || bytes[o + 1] !== 0x48) continue; // "CH"
    const compressed = view.getUint32(o + 16, true);
    const start = o + CHUNK_HEADER_BYTES;
    if (compressed <= 0 || start + compressed > bytes.byteLength) continue;
    const payload = await inflateSyncFlush(bytes.subarray(start, start + compressed));
    if (!payload || payload.length < 12) continue;
    frames.push({ index: e.index, t: u32(payload, 0), kind: payload[8]!, payload });
  }
  frames.sort((a, b) => a.t - b.t);
  const t0 = frames.length ? frames[0]!.t : 0;
  for (const f of frames) f.t -= t0;
  return frames;
}

/** Read `count` bits LSB-first starting at `bitOff` within `d` from `base`. */
function readBits(d: Uint8Array, base: number, bitOff: number, count: number): number | null {
  const v = readBitsLE(d, base * 8 + bitOff, count);
  return v < 0 ? null : v;
}

/** One record inside a frame payload. */
/**
 * Walk a delta frame's sections.
 *
 * The payload is a **bitstream, LSB-first**, and sections are packed
 * contiguously in bits rather than padded to byte boundaries:
 *
 *     section := u24 bitLength || bitLength bits
 *     record  := marker:8 || key:16 || type:16 || payload
 *
 * Stepping this in whole bytes desynchronises the moment any section's length
 * is not a multiple of eight, which is most of them. Byte-stepping reaches
 * **7%** of the payload and finds 7 record types; bit-stepping reaches
 * **52.4%**, consumes 12,828 of 18,308 frames to their final bit, and finds
 * **12** — including five that byte alignment could never land on.
 *
 * With the resync in {@link findChainStart} for frames that carry a prefix,
 * this reaches **98.2%** of the payload — 18,275 of 18,308 frames consumed to
 * their final bit, 1.74M sections.
 */
/**
 * Does a chain starting here consume the payload exactly?
 *
 * A correct start swallows every bit; a wrong one hits a zero length or runs
 * past the end. That makes the framing self-verifying, which is what lets the
 * resync below trust an offset it had to search for.
 */
function chainConsumes(payload: Uint8Array, startBit: number): { ok: boolean; sections: number } {
  const totalBits = payload.length * 8;
  let pos = startBit;
  let sections = 0;
  while (pos + 24 <= totalBits) {
    const bits = readBitsLE(payload, pos, 24);
    if (bits <= 0 || pos + 24 + bits > totalBits) return { ok: false, sections };
    sections++;
    pos += 24 + bits;
  }
  return { ok: totalBits - pos < 8, sections };
}

/**
 * Where a frame's section chain really begins.
 *
 * Most frames start at {@link DELTA_SECTION_START}. About 30% do not: they
 * carry a variable-length prefix first, and their first length field reads
 * zero. Those were written off as unframeable, which is what capped coverage
 * at 52% — and since they are the *larger* frames, they held closer to half
 * the payload.
 *
 * There is no length field for that prefix that has been identified, so the
 * start is found by search, which is safe here because the chain is
 * self-verifying: an offset is accepted only if its chain consumes the payload
 * to the final bit. Of 5,480 such frames, 5,447 resolve; the median prefix is
 * 840 bits. The result is checkable — sections recovered this way are of a
 * known record type **99.5%** of the time, against 100% for frames that never
 * needed it.
 */
function findChainStart(payload: Uint8Array): number {
  const base = DELTA_SECTION_START * 8;
  if (chainConsumes(payload, base).ok) return base;
  const limit = Math.min(payload.length * 8 - 24, base + 4096);
  for (let s = base; s < limit; s++) {
    const r = chainConsumes(payload, s);
    if (r.ok && r.sections >= 2) return s;
  }
  // A few frames carry a longer prefix -- the biggest ones, keyframes among
  // them: in three matches 64 frames found no chain in the first 4096 bits,
  // 6% of all the data, and searching the rest of the frame found it in 39
  // (median 6,358 bits in), their records 95.6% of known kinds -- the
  // keyframe dumps, field deltas and object records that were being lost.
  for (let s = limit; s < payload.length * 8 - 24; s++) {
    const r = chainConsumes(payload, s);
    if (r.ok && r.sections >= 2) return s;
  }
  return -1;
}

export function readDeltaSections(payload: Uint8Array): readonly DeltaSection[] {
  // Six readers walk every frame's chain; finding where it starts is a search.
  let hit = deltaSectionsOf.get(payload);
  if (!hit) {
    hit = walkDeltaSections(payload);
    deltaSectionsOf.set(payload, hit);
  }
  return hit;
}

export interface DeltaSection {
  type: number;
  key: number;
  marker: number;
  bits: number;
  at: number;
}

const deltaSectionsOf = new WeakMap<Uint8Array, readonly DeltaSection[]>();

function walkDeltaSections(payload: Uint8Array): DeltaSection[] {
  const out: DeltaSection[] = [];
  const totalBits = payload.length * 8;
  const start = findChainStart(payload);
  if (start < 0) return out;
  let pos = start;
  while (pos + 24 <= totalBits) {
    const bits = readBitsLE(payload, pos, 24);
    if (bits <= 0 || pos + 24 + bits > totalBits) break;
    const at = pos + 24;
    if (bits >= 40) {
      out.push({
        marker: readBitsLE(payload, at, 8),
        key: readBitsLE(payload, at + 8, 16),
        type: readBitsLE(payload, at + 24, 16),
        bits,
        at,
      });
    }
    pos = at + bits;
  }
  return out;
}

/**
 * Read `n` bits (up to 32) at bit position `pos`, least-significant bit
 * first; -1 if any of them lies outside `d`.
 *
 * A byte at a time, not a bit: this is under every section header, sidebar
 * entry and chain probe in the file, and read bit by bit it was a third of
 * the time it took to open a replay.
 */
export function readBitsLE(d: Uint8Array, pos: number, n: number): number {
  if (n <= 0) return 0;
  if (pos < 0 || (pos + n - 1) >> 3 >= d.length) return -1;
  if (n > 24) return readBitsLE(d, pos, 16) + readBitsLE(d, pos + 16, n - 16) * 0x10000;
  const i = pos >> 3;
  const shift = pos & 7;
  // At most 24 bits past a 7-bit offset: four bytes hold them all. Bytes past
  // the end read as undefined, which | turns to 0 — and none of them is needed.
  const word = (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24)) >>> shift;
  return (n === 32 ? word : word & ((1 << n) - 1)) >>> 0;
}

/** Where a delta payload's section chain begins. */
export const DELTA_SECTION_START = 17;

/**
 * The record types the delta stream contains, read with correct bit framing.
 * Types are little-endian here, so 0x3781 is the same record the byte-aligned
 * scan called 0x8137.
 *
 * | type | count | bits | what it is |
 * |------|------:|-----:|------------|
 * | 0x3781 | 1,034,245 | 64 | sequence counter, keyed by stream; payload is `count << 8 \| 0x20` |
 * | 0x5781 | 32,140 | 431 | periodic |
 * | 0xb801 | 12,373 | 710 | object and sidebar records, one side |
 * | 0x9801 | 12,302 | 710 | the same, other side |
 * | 0x7781 | 5,470 | 934 | object records — where MOVEFLSH lives |
 * | 0x1701 | 4,119 | 344 | heartbeat |
 * | 0x9701 | 3,873 | 344 | heartbeat |
 * | 0x2208 | 68 | 187 | **unidentified**, marker 0x05, paired with 0x2403 |
 * | 0x2403 | 68 | 1024 | **unidentified**, emitted with 0x2208 |
 * | 0x2602 | 51 | 962 | **unidentified** |
 * | 0x0602 | 27 | 962 | **unidentified** |
 * | 0x6602 | 2 | 922 | **unidentified** |
 */
/**
 * The per-object movement record. Variable length (54 distinct lengths in one
 * match), keyed by object, emitted every frame the object exists.
 */
export const TRACK_RECORD_TYPE = 0x5781;

/** The record types that serialize a CNCObjectStruct. */
const OBJECT_RECORD_TYPES = new Set([0xb801, 0x9801, 0x7781]);

/**
 * Where a section's object record starts, in bits, or -1 for none.
 *
 * Besides the restatements above, two kinds of section carry a record a few
 * bits in: 0x2403 (2 bits) and every 0x?602 (4, the top three bits varying).
 * They are where an object is first named, at its creation. The restatements
 * come every few tens of seconds, so without these a new object taking a
 * recycled key went under the key's previous name until its first one: a
 * Buggy flown in to an Airstrip, on a key a Harvester had held, was drawn as
 * a Harvester; a Community 7 Apache was read as the C-17 that took its key
 * minutes later. Measured on five replays: 95-100% of these sections hold a
 * record at that shift (bot/harness/replay_decode.h, ObjectShift).
 */
export function objectRecordShift(type: number): number {
  if (OBJECT_RECORD_TYPES.has(type)) return 0;
  if (type === 0x2403) return 2;
  if ((type & 0x1fff) === 0x0602) return 4;
  return -1;
}

export const DELTA_RECORD_TYPES = [
  0x3781, 0x5781, 0xb801, 0x9801, 0x7781, 0x1701, 0x9701,
  0x2208, 0x2403, 0x2602, 0x0602, 0x6602,
] as const;

export interface FrameSection {
  /** Bit offset of the section body, relative to the start of the payload. */
  bitOff: number;
  /** Length of the body in bits. */
  bits: number;
}

/**
 * Split a frame payload into its sections.
 *
 * The payload is a chain of records, each introduced by a **24-bit
 * little-endian bit-length**, and the chain lands exactly on the frame's
 * declared bit count. This is why nothing at a fixed byte offset ever worked:
 * records are bit-aligned and only the strings inside them are byte-aligned.
 *
 * The chaining is not a coincidence of a permissive parser. On 400 sampled
 * frames it consumes the payload **exactly 400/400** times, while the same
 * parse over byte-shuffled payloads succeeds **0/400** and over random bytes
 * **0/400**. Section counts also track the object population over a match
 * (1 -> 24 -> 81 -> 163 -> 187), and only ~22 distinct section lengths occur
 * across a whole game — a fixed schema, not free-form data.
 *
 * Returns null when the chain does not land exactly, which happens for the
 * ~30% of frames carrying data past the declared bit length.
 */
export function parseSections(payload: Uint8Array, declaredBits: number, base = 0): FrameSection[] | null {
  const out: FrameSection[] = [];
  let off = 0;
  while (off < declaredBits) {
    if (out.length > 20000) return null;
    const len = readBits(payload, base, off, 24);
    if (len === null || len === 0) return null;
    out.push({ bitOff: off + 24, bits: len });
    off += 24 + len;
  }
  return off === declaredBits ? out : null;
}

/** Copy a section's body out as bytes, realigning it to a byte boundary. */
export function readSection(payload: Uint8Array, sec: FrameSection): Uint8Array {
  const nb = Math.ceil(sec.bits / 8);
  const out = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) out[i] = readBits(payload, 0, sec.bitOff + i * 8, 8) ?? 0;
  return out;
}

/**
 * Per-frame layout differs between deltas and keyframes.
 *
 * A keyframe puts its payload bit-length at byte 13 and starts its payload at
 * byte 21; a delta uses byte 9 and byte 17. Reading a keyframe with the delta
 * layout finds nothing, which is why keyframes appeared to contain no records
 * at all until this was noticed.
 */
/** Payload base offset that marks a keyframe rather than a delta. */
export const KEYFRAME_BASE = 21;

export function payloadLayout(payload: Uint8Array): { base: number; bits: number } {
  const keyframe = payload[8] === 1;
  return keyframe
    ? { base: 21, bits: u32(payload, 13) }
    : { base: 17, bits: u32(payload, 9) };
}

/** Record type carrying one player's production. There is one per side. */
/**
 * The sidebar types this decoder used to assume. Kept only as the historical
 * pair; see {@link productionSideByType} for why they cannot be hardcoded.
 */
export const PRODUCTION_RECORD_TYPES = [0x01b8, 0x0198] as const;
/** Every sidebar section type observed shares this high byte. */
const PRODUCTION_TYPE_HIGH_BYTE = 0x01;
/** Sidebar entries a type must yield before it is taken for a player's. */
const PRODUCTION_MIN_ENTRIES = 20;

/**
 * Read a section body starting `shift` bits into it.
 *
 * Sidebar entries inside a production record are packed at **arbitrary bit
 * alignments**, not on byte boundaries. Scanning only the natural alignment
 * recovered exactly one asset name (HAND) out of a whole match; scanning all
 * eight recovers the rest — NUKE, PROC, AFLD, E1, E4 and the others.
 */
export function readSectionShifted(
  payload: Uint8Array,
  base: number,
  sec: FrameSection,
  shift: number,
): Uint8Array {
  const nb = Math.ceil(sec.bits / 8) + 1;
  const out = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) out[i] = readBits(payload, base, sec.bitOff + shift + i * 8, 8) ?? 0;
  return out;
}

/** True for the uppercase-alphanumeric bytes asset names are made of. */
function isNameByte(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
}

function readName(d: Uint8Array, p: number, len: number): string | null {
  let s = "";
  for (let k = 0; k < len; k++) {
    const c = d[p + k]!;
    if (!isNameByte(c)) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Sidebar production entries in one frame.
 *
 * Validation is structural. An earlier version keyed off the byte preceding
 * the length prefix, having seen `0x80` in one sample — that byte is not a
 * signature (it also takes 0x82, 0x87, ...) and filtering on it silently
 * discarded whole structures, the power plant among them.
 */
export function parseSidebarEntries(d: Uint8Array): SidebarSample[] {
  const out: SidebarSample[] = [];
  for (let p = 4; p + 24 < d.length; p++) {
    const len = u32(d, p);
    if (len < 2 || len > 8 || p + 4 + len + 18 > d.length) continue;
    const name = readName(d, p + 4, len);
    if (name === null) continue;
    let q = p + 4 + len;
    const rtti = d[q]! | (d[q + 1]! << 8);
    const typeIndex = d[q + 2]! | (d[q + 3]! << 8);
    const dllType = d[q + 4]! | (d[q + 5]! << 8);
    q += 7; // + SuperWeaponType
    const cost = d[q]! | (d[q + 1]! << 8);
    const power = u32(d, q + 2) | 0;
    const packed = d[q + 8]! | (d[q + 9]! << 8);

    if (rtti !== 2 && rtti !== 4 && rtti !== 6 && rtti !== 8) continue;
    if (dllType < 12 || dllType > 15) continue;
    if (rtti === 8 && dllType !== 15) continue;
    if (rtti === 4 && dllType !== 13) continue;
    if (cost < 20 || cost > 5000) continue;
    if (power < -200 || power > 400) continue;

    // Progress packs a state into the high bits: 0..1023 is the real range.
    out.push({
      t: 0,
      name,
      rtti,
      typeIndex,
      dllType,
      cost,
      power,
      state: packed >> 10,
      progress: packed & 0x3ff,
    });
    p += 3 + len;
  }
  return out;
}

/**
 * Objects on the map in one frame.
 *
 * Found by the double-name signature: `CNCObjectStruct` begins with
 * `TypeName` and `AssetName`, which for every object seen so far are the
 * same string, written twice with its own length prefix each time. Nothing
 * else in the stream looks like that, which makes it a reliable anchor.
 */
/** How much of each object record to keep. See the note in parseObjects. */
export const OBJECT_BODY_BYTES = 220;

export function parseObjects(d: Uint8Array): ObjectSample[] {
  const out: ObjectSample[] = [];
  for (let p = 0; p + 12 < d.length; p++) {
    const len = u32(d, p);
    if (len < 2 || len > 8) continue;
    if (p + 4 + len + 4 + len + 16 > d.length) continue;
    const first = readName(d, p + 4, len);
    if (first === null) continue;
    const q = p + 4 + len;
    const len2 = u32(d, q);
    // TypeName and AssetName are separate 16-char fields in CNCObjectStruct
    // and they are NOT always equal: while a structure is going up, the asset
    // is its buildup art (AFLD -> AFLDMAKE). Requiring them equal threw those
    // away, and they are the one record that pins a real placement moment.
    if (len2 < 2 || len2 > 16 || q + 4 + len2 + 16 > d.length) continue;
    const second = readName(d, q + 4, len2);
    if (second === null) continue;

    const body = q + 4 + len2;
    const dllType = d[body]! | (d[body + 1]! << 8);
    // 1 INFANTRY, 2 UNIT, 3 AIRCRAFT, 4 BUILDING, 5 TERRAIN, 6 ANIM, 7 BULLET
    if (dllType < 1 || dllType > 7) continue;
    out.push({
      t: 0,
      name: first,
      /** True while the object is showing its buildup art (`*MAKE`). */
      underConstruction: second !== first && second.endsWith("MAKE"),
      dllType,
      id: u32(d, body + 2),
      owner: d[body + 9]!,
      remapColor: d[body + 10]!,
      width: d[body + 11]!,
      height: d[body + 12]!,
      // 220, not 64. A CNCObjectStruct is far longer than the header fields
      // read above, and cutting the body at 64 truncated real cell fields off
      // the end of every record — offsets 68, 76, 80, 85, 86, 90, 91 and 99
      // all decode as in-bounds map cells and were simply not being kept.
      // Vehicles and aircraft never resolved a sane position because theirs
      // lay past the cut.
      body: d.subarray(body, Math.min(d.length, body + OBJECT_BODY_BYTES)),
    });
    p = body;
  }
  return out;
}

/** One structure a player put down, with when it was queued and where it went. */
export interface BuildEvent {
  /** House index from the object stream. */
  owner: number;
  name: string;
  /** `StructType` index, when the sidebar half was matched. */
  typeIndex: number | null;
  /** Milliseconds from match start at which production *began*, if known. */
  queuedAt: number | null;
  /**
   * Milliseconds at which the sidebar item finished, if known.
   *
   * This is when the structure reaches the map. A building is queued, builds
   * in the sidebar, and only then does the player put it down, so `queuedAt`
   * is several build-times too early: in the reference replay a Refinery is
   * queued at 17s and does not exist until 30s.
   */
  completedAt: number | null;
  /** Milliseconds at which the object was first seen on the map. */
  placedAt: number;
  /** True when the only sighting was in a keyframe, so the time is an upper bound. */
  placedAtIsUpperBound: boolean;
  /** Map cell, or null when the position offset could not be resolved. */
  cellX: number | null;
  cellY: number | null;
  cost: number | null;
}

/** Structures only one faction can build, used to identify a side. */
const NOD_ONLY = new Set(["HAND", "AFLD", "OBLI", "SAM", "TMPL"]);
const GDI_ONLY = new Set(["PYLE", "WEAP", "ATWR", "GTWR", "EYE"]);

/**
 * Which faction a side played, from what only that faction can build.
 * Returns null for a mirror matchup, where nothing distinguishes them.
 */
export function factionOf(structures: { name: string }[]): "GDI" | "NOD" | null {
  let nod = 0;
  let gdi = 0;
  for (const s of structures) {
    if (NOD_ONLY.has(s.name)) nod++;
    if (GDI_ONLY.has(s.name)) gdi++;
  }
  if (nod > 0 && gdi === 0) return "NOD";
  if (gdi > 0 && nod === 0) return "GDI";
  return null;
}

export interface ReplayBuildOrders {
  /** House index -> that player's structures, in build order. */
  byOwner: Map<number, BuildEvent[]>;
  /** Every production ramp seen, for the timeline/APM views. */
  production: SidebarSample[];
  /** Units and infantry seen on the map, with their owner. */
  units: UnitEvent[];
  /** Explosions, fires and weapon flashes, in time order. */
  effects: EffectEvent[];
  durationMs: number;
}

/** `DllObjectTypeEnum` values that appear in the object stream. */
export const DLL_INFANTRY = 1;
export const DLL_UNIT = 2;
export const DLL_AIRCRAFT = 3;

/**
 * Objects the engine spawns, which no player controls.
 *
 * `C17` is the cargo plane that flies a finished vehicle in to the airstrip.
 * It is a delivery animation, not a unit: it cannot be selected, ordered or
 * killed, and counting it as an aircraft put six phantom planes in the unit
 * list and sent the position search hunting for a flight path that is scripted
 * rather than recorded.
 *
 * It is still useful. Every C17 flight coincides with a vehicle production
 * completion to within two seconds, which makes it an independent check on the
 * production stream — two unrelated signals agreeing:
 *
 *     flight #0 127s -> BGGY completion -2s      flight #1 145s -> -0s
 *     flight #2 130s ->  0s                      flight #4 150s -> -0s
 *     flight #3 143s -> -0s                      flight #5 242s -> -0s
 */
export const ENGINE_SPAWNED_ASSETS: ReadonlySet<string> = new Set(["C17"]);
export const DLL_BUILDING = 4;
export const DLL_TERRAIN = 5;
export const DLL_ANIM = 6;
export const DLL_BULLET = 7;

/** Structures only. Walls are included: sandbag crawling is real play. */
const STRUCTURE_DLL_TYPE = DLL_BUILDING;

/** A unit or infantry squad seen on the map, with its owner. */
export interface UnitEvent {
  owner: number;
  name: string;
  /** 1 = infantry, 2 = vehicle, 3 = aircraft. */
  dllType: number;
  id: number;
  /** Milliseconds at which it was first seen. */
  firstSeen: number;
  cellX: number | null;
  cellY: number | null;
}

/**
 * A visual event — an explosion, fire, or weapon flash.
 *
 * These are `ANIM` records. Most are owned by the neutral house (0xFE); the
 * ones carrying a player's house index are that player's doing.
 */
/**
 * The animation C&C draws at the destination when a move order is given.
 *
 * `ANIM_MOVE_FLASH` in the original engine. Unlike the combat and fire
 * animations — which all carry owner 0xfe, `HOUSE_NONE` — this one carries a
 * real house, so it attributes an order to a player.
 */
export /**
 * A flash restated within this long is the same order still on screen.
 *
 * Picked the way the selection window was, from the valley in the data. Gaps
 * between two appearances of one flash id are bimodal: 141 of them fall in
 * 70-140ms — the flash surviving into the next frame — then 11 in 140-300ms,
 * then everything else at 300ms and beyond. Orders counted plateau across
 * that valley (231 at 200ms, 228 at 300ms), so anything in it works.
 *
 * An earlier 2000ms guess sat far past the valley and merged a third of the
 * real clicks away — 154 orders where there were 231. That matters here
 * because repeat clicking is a real part of how fast someone is playing, and
 * this stream does record it.
 */
const FLASH_SAME_ORDER_MS = 200;
const MOVE_ORDER_ANIM = "MOVEFLSH";

/** A move order, as the flash drawn where the player clicked. */
export interface OrderFlash {
  /** Milliseconds into the match. */
  t: number;
  owner: number;
  /** The cell the order was given on. */
  cellX: number;
  cellY: number;
}

/**
 * Where a MOVEFLSH keeps its cell, and why it needs masking.
 *
 * The position sits at the same offset every other animation uses, but its
 * y field always carries bit 7 set — the raw values run 132..174 where the
 * map is 64 cells — so read straight it lands off the map and looks like
 * nonsense. Masking to six bits gives 4..61, and the x half is a whole cell
 * in **153 of 153** records, which chance would manage at (1/32)^153.
 */
const MOVE_FLASH_CELL_OFFSET = 29;
const CELL_MASK = 0x3f;

/**
 * Read move orders out of the stream.
 *
 * This is the only player *command* found anywhere in a `.Replay`. The file is
 * a state stream — it records what the game drew, not what was pressed — so
 * there is no command log to read. But a move order draws something, and that
 * drawing is an object like any other, timestamped and owned.
 *
 * The destination decodes too, once the y field is masked (see
 * MOVE_FLASH_CELL_OFFSET). Verified against ground truth: for each order, the
 * distance to the nearest later sighting of a unit belonging to that same
 * player averages **8.68 cells**, against **13.12 +- 0.45** when the order
 * cells are shuffled between orders — z = -9.8. The orders really do say
 * where that player's units then went.
 *
 * In the sample match this yields 108 orders for one player and 45 for the
 * other — 18.8 and 8.2 per minute. That is a floor on real actions, not APM:
 * it counts move orders only, and misses selections, attack orders, and
 * everything done through the sidebar.
 */
export async function readOrderFlashes(bytes: Uint8Array): Promise<OrderFlash[]> {
  const frames = await readFrames(bytes);
  const out: OrderFlash[] = [];
  /** When and where each flash object was last seen, so one order is counted once. */
  const lastFlashAt = new Map<string, { t: number; x: number; y: number }>();
  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === KEYFRAME_BASE) continue;
    for (const ob of objectsInFrame(f.payload)) {
      if (ob.dllType !== DLL_ANIM || ob.name !== MOVE_ORDER_ANIM) continue;
      // Neutral-owned effects are explosions and muzzle flashes, not orders.
      if (ob.owner === HOUSE_NONE) continue;
      if (ob.body.length < MOVE_FLASH_CELL_OFFSET + 3) continue;
      const at = MOVE_FLASH_CELL_OFFSET;
      const packed =
        ob.body[at]! | (ob.body[at + 1]! << 8) | ((ob.body[at + 2]! & 0x0f) << 16);
      const cellX = (packed & 0xfff) / 32;
      const cellY = (packed >> 12) & CELL_MASK;
      if (cellX < 0 || cellX > 63) continue;
      // One order, not one frame.
      //
      // The flash is an object with a life of its own, and it is restated for
      // as long as it is on screen, so counting every appearance counts a
      // single click 1.8 times over — and unevenly, 1.82 for one player
      // against 1.45 for the other in the same match, which is worse than a
      // flat inflation because it distorts the comparison between them.
      //
      // The object's own id separates them. Ids are recycled heavily (20 of
      // them cover 208 orders), so an id seen again after a gap is a new
      // order rather than the same one continuing.
      const key = `${ob.owner}:${ob.id}`;
      const seen = lastFlashAt.get(key);
      lastFlashAt.set(key, { t: f.t, x: cellX, y: cellY });
      // The game reuses a player's flash object from one click to the next,
      // so the same object seen again inside the window is the same order —
      // unless it has moved. A flash that jumps to another cell is a second
      // click, however soon after the first: 13 of them in one match were
      // being merged into the order before.
      if (seen !== undefined && f.t - seen.t <= FLASH_SAME_ORDER_MS && seen.x === cellX && seen.y === cellY) continue;
      out.push({ t: f.t, owner: ob.owner, cellX, cellY });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface EffectEvent {
  t: number;
  name: string;
  owner: number;
  cellX: number | null;
  cellY: number | null;
}

/** Animations that mean something was destroyed or is burning. */
export const DESTRUCTION_ANIMS = new Set([
  "FBALL1",
  "FRAG1",
  "NAPALM1",
  "FIRE1",
  "FIRE2",
  "FIRE3",
  "FIRE4",
  "ART_EXP1",
  "VEH_HIT1",
  "VEH_HIT2",
  "VEH_HIT3",
]);

/**
 * Reconstruct per-player build orders.
 *
 * The owner comes from the object stream and the timing from the sidebar
 * stream, because neither carries both. Object records are sent sparsely, so
 * a building's first sighting can be much later than its placement; the
 * sidebar's `state === 10` ramp for the same asset is used to recover when
 * production actually started, taking the latest ramp that began before the
 * object was seen.
 */
export async function readBuildOrders(bytes: Uint8Array): Promise<ReplayBuildOrders> {
  const frames = await readFrames(bytes);
  const production: SidebarSample[] = [];
  const objects: ObjectSample[] = [];
  for (const f of frames) {
    await breathe();
    for (const s of parseSidebarEntries(f.payload)) production.push({ ...s, t: f.t });
    // Keyframes restate the whole world, so an object first "appearing" in
    // one proves only that it exists by then. They are still needed for
    // completeness — dropping them loses structures entirely — so they are
    // kept and flagged, with delta sightings preferred for timing.
    for (const o of parseObjects(f.payload)) objects.push({ ...o, t: f.t, fromKeyframe: f.kind === 1 } as ObjectSample & { fromKeyframe: boolean });
  }

  // Production ramps: consecutive state-10 samples for one asset.
  interface Ramp {
    name: string;
    start: number;
    end: number;
    typeIndex: number;
    cost: number;
  }
  const ramps: Ramp[] = [];
  const open = new Map<string, Ramp & { last: number }>();
  for (const s of production) {
    if (s.state !== 10) continue;
    const cur = open.get(s.name);
    if (cur && s.t - cur.end <= 1200 && s.progress >= cur.last - 60) {
      cur.end = s.t;
      cur.last = s.progress;
    } else {
      if (cur) ramps.push(cur);
      open.set(s.name, {
        name: s.name,
        start: s.t,
        end: s.t,
        last: s.progress,
        typeIndex: s.typeIndex,
        cost: s.cost,
      });
    }
  }
  for (const r of open.values()) ramps.push(r);

  // Earliest sighting per structure, preferring delta frames for the time.
  const firstSeen = new Map<string, { o: ObjectSample; t: number; kf: boolean }>();
  for (const o of objects as (ObjectSample & { fromKeyframe: boolean })[]) {
    if (o.dllType !== STRUCTURE_DLL_TYPE) continue;
    const key = `${o.owner}:${o.id}:${o.name}`;
    const cur = firstSeen.get(key);
    if (!cur) { firstSeen.set(key, { o, t: o.t, kf: o.fromKeyframe }); continue; }
    // A buildup sighting beats everything: it proves the structure was being
    // placed at that instant. Otherwise a delta beats a keyframe, and earlier
    // beats later.
    if (o.underConstruction && !cur.o.underConstruction) {
      firstSeen.set(key, { o, t: o.t, kf: o.fromKeyframe });
    } else if (!cur.o.underConstruction) {
      if ((cur.kf && !o.fromKeyframe) || (cur.kf === o.fromKeyframe && o.t < cur.t))
        firstSeen.set(key, { o, t: o.t, kf: o.fromKeyframe });
    }
  }

  // Solve the position offset once per building type, from every sighting of
  // every instance of that type — more samples make the search sharper.
  const bodiesByName = new Map<string, Uint8Array[]>();
  /** Who owned each body, so a never-varying field can be judged (see below). */
  const ownersByName = new Map<string, number[]>();
  for (const o of objects) {
    if (o.dllType !== STRUCTURE_DLL_TYPE) continue;
    const list = bodiesByName.get(o.name) ?? [];
    list.push(o.body);
    bodiesByName.set(o.name, list);
    const own = ownersByName.get(o.name) ?? [];
    own.push(o.owner);
    ownersByName.set(o.name, own);
  }
  // Every type a player can build is placed by {@link structureCellOffset},
  // which reads the offset off the occupy list instead of searching for it.
  // What is left is the civilian village, and those are searched for as
  // before: the well-populated types on their own, the rest against the base
  // their owner's other buildings stand in.
  //
  // The search is what left five recorded losses with no building to pin them
  // on. A type sighted a handful of times gives it too little to work with and
  // it settles on a field that is not the position at all -- five Barracks
  // reading x=0, a Weapons Factory at (6,0) -- so the loss had nothing within
  // reach to belong to.
  const cellOffset = new Map<string, number | null>();
  for (const [name, bodies] of bodiesByName) {
    if (structureCellOffset(name) != null) continue;
    if (bodies.length >= 6) {
      cellOffset.set(name, findCellOffset(bodies, 64, undefined, true, ownersByName.get(name)));
    }
  }
  /** Where a record says its building stands, or null where it says nothing. */
  const cellOf = (o: { name: string; body: Uint8Array }): { x: number; y: number } | null => {
    if (structureCellOffset(o.name) != null) return decodeStructureCell(o.name, o.body);
    const at = cellOffset.get(o.name);
    return at == null ? null : decodeCell(o.body, at);
  };
  // Where each owner's base sits, from everything placed so far.
  const centroid = new Map<number, { x: number; y: number }>();
  {
    const acc = new Map<number, { x: number; y: number; n: number }>();
    for (const o of objects) {
      if (o.dllType !== STRUCTURE_DLL_TYPE) continue;
      const c = cellOf(o);
      if (!c) continue;
      const a = acc.get(o.owner) ?? { x: 0, y: 0, n: 0 };
      acc.set(o.owner, { x: a.x + c.x, y: a.y + c.y, n: a.n + 1 });
    }
    for (const [own, a] of acc) if (a.n) centroid.set(own, { x: a.x / a.n, y: a.y / a.n });
  }
  // The sparse remainder, anchored to their owner's base.
  for (const [name, bodies] of bodiesByName) {
    if (cellOffset.has(name) || structureCellOffset(name) != null) continue;
    const owner = objects.find((o) => o.name === name && o.dllType === STRUCTURE_DLL_TYPE)?.owner;
    cellOffset.set(
      name,
      findCellOffset(bodies, 64, owner != null ? centroid.get(owner) : undefined, true, ownersByName.get(name)),
    );
  }

  const byOwner = new Map<number, BuildEvent[]>();

  // Assign production ramps to structures under the one constraint that
  // actually holds: a structure existed *before* it was seen, so its sighting
  // is an upper bound on its build time, never an estimate of it.
  //
  // Object sightings are sparse — a keyframe every ~20.8s plus the occasional
  // delta — so a building can go unseen for a minute after it went up. Using
  // the sighting as the time reported a first Hand of Nod at 1:26 in a match
  // where it was plainly built around 0:20.
  //
  // Matching is done across both players at once, earliest sighting first,
  // each taking the earliest unclaimed ramp that started before it was seen.
  // Ramps carry no owner, so they cannot be split by player up front; going in
  // sighting order is what keeps each side's ramps landing on that side's
  // structures.
  /**
   * A fallback cell per structure, from any of its records that states one.
   *
   * The sighting a structure is dated by is chosen for its *time* — the
   * earliest, preferring a buildup frame — and that record need not be one
   * that carries a position. A second draw call for the same building carries
   * no occupy list and no cell, and where that was the earliest sighting the
   * structure came out unplaced, which is a recorded loss with nothing to
   * belong to.
   *
   * Only consulted when the dated record itself says nothing. A building never
   * moves, so the cell most of its records agree on is its cell; taking a
   * majority rather than the first reading keeps an id that has been recycled
   * onto a second building from handing its cell to the first.
   */
  const cellById = new Map<string, { x: number; y: number }>();
  {
    const votes = new Map<string, Map<string, number>>();
    for (const o of objects) {
      if (o.dllType !== STRUCTURE_DLL_TYPE) continue;
      const c = cellOf(o);
      if (!c) continue;
      const key = `${o.owner}:${o.id}:${o.name}`;
      const v = votes.get(key) ?? new Map<string, number>();
      v.set(`${c.x},${c.y}`, (v.get(`${c.x},${c.y}`) ?? 0) + 1);
      votes.set(key, v);
    }
    for (const [key, v] of votes) {
      const top = [...v].sort((a, b) => b[1] - a[1])[0];
      if (!top) continue;
      const [x, y] = top[0].split(",");
      cellById.set(key, { x: Number(x), y: Number(y) });
    }
  }

  const allStructures = [...firstSeen.values()].sort((x, y) => x.t - y.t);
  const claimed = new Set<Ramp>();
  const rampFor = new Map<ObjectSample, Ramp>();
  for (const { o, t } of allStructures) {
    let best: Ramp | null = null;
    for (const r of ramps) {
      if (r.name !== o.name || claimed.has(r)) continue;
      if (r.start > t) continue; // it cannot have been built after it was seen
      if (!best || r.start < best.start) best = r;
    }
    if (best) {
      claimed.add(best);
      rampFor.set(o, best);
    }
  }

  for (const { o, t, kf } of allStructures) {
    const best = rampFor.get(o) ?? null;
    const list = byOwner.get(o.owner) ?? [];
    list.push({
      owner: o.owner,
      name: o.name,
      typeIndex: best?.typeIndex ?? null,
      queuedAt: best?.start ?? null,
      completedAt: best?.end ?? null,
      placedAt: t,
      placedAtIsUpperBound: kf,
      ...(() => {
        const c = cellOf(o) ?? cellById.get(`${o.owner}:${o.id}:${o.name}`);
        return c ? { cellX: c.x, cellY: c.y } : { cellX: null, cellY: null };
      })(),
      cost: best?.cost ?? null,
    });
    byOwner.set(o.owner, list);
  }
  for (const list of byOwner.values()) {
    // Order by the best time known for each structure: the matched ramp
    // where there is one, the sighting otherwise. Because every ramp is
    // constrained to start before its structure was seen, this cannot put a
    // building ahead of one genuinely built earlier.
    list.sort((a, b) => (a.queuedAt ?? a.placedAt) - (b.queuedAt ?? b.placedAt));
  }

  // Units carry the owner byte at the same offset as buildings, so they can
  // be attributed directly. Their position offset is solved per type the same
  // way, since it shifts with the record's variable-length arrays.
  const unitBodies = new Map<string, Uint8Array[]>();
  for (const o of objects) {
    if (o.dllType !== DLL_INFANTRY && o.dllType !== DLL_UNIT && o.dllType !== DLL_AIRCRAFT) continue;
    if (ENGINE_SPAWNED_ASSETS.has(o.name)) continue;
    const list = unitBodies.get(o.name) ?? [];
    list.push(o.body);
    unitBodies.set(o.name, list);
  }
  const unitOffset = new Map<string, number | null>();
  for (const [name, bodies] of unitBodies) unitOffset.set(name, findCellOffset(bodies, 64, undefined, false));

  const units: UnitEvent[] = [];
  const unitSeen = new Set<string>();
  for (const o of objects) {
    if (o.dllType !== DLL_INFANTRY && o.dllType !== DLL_UNIT && o.dllType !== DLL_AIRCRAFT) continue;
    if (ENGINE_SPAWNED_ASSETS.has(o.name)) continue;
    const key = `${o.owner}:${o.id}:${o.name}`;
    if (unitSeen.has(key)) continue;
    unitSeen.add(key);
    const at = unitOffset.get(o.name);
    const c = at == null ? null : decodeCell(o.body, at);
    units.push({
      owner: o.owner,
      name: o.name,
      dllType: o.dllType,
      id: o.id,
      firstSeen: o.t,
      cellX: c ? c.x : null,
      cellY: c ? c.y : null,
    });
  }
  units.sort((a, b) => a.firstSeen - b.firstSeen);

  const effectBodies = new Map<string, Uint8Array[]>();
  for (const o of objects) {
    if (o.dllType !== DLL_ANIM) continue;
    const list = effectBodies.get(o.name) ?? [];
    list.push(o.body);
    effectBodies.set(o.name, list);
  }
  const effectOffset = new Map<string, number | null>();
  for (const [name, bodies] of effectBodies)
    effectOffset.set(name, findCellOffset(bodies, 64, undefined, false));

  const effects: EffectEvent[] = [];
  for (const o of objects) {
    if (o.dllType !== DLL_ANIM) continue;
    const at = effectOffset.get(o.name);
    const c = at == null ? null : decodeCell(o.body, at);
    effects.push({ t: o.t, name: o.name, owner: o.owner, cellX: c ? c.x : null, cellY: c ? c.y : null });
  }
  effects.sort((a, b) => a.t - b.t);

  return {
    byOwner,
    production,
    units,
    effects,
    durationMs: frames.length ? frames[frames.length - 1]!.t : 0,
  };
}


/** One item a player put into production, with the side it belongs to. */
/**
 * Where a delta frame's object record keeps its position.
 *
 * Keyframe records put it at {@link TERRAIN_CELL_OFFSET} (29); delta records
 * put it at 35. Calibrated against three structures whose cells were already
 * known from independent decoding — the first power plant and both Hands of
 * Nod — and offset 35 is the only one of the fifty scanned that reproduces
 * all three exactly and simultaneously: (52,13), (20,45), (54,16).
 */
export const DELTA_CELL_OFFSET = 35;

/**
 * Copy a section's bits into a byte-aligned buffer, LSB-first.
 *
 * Only 2% of sections happen to start on a byte boundary, which is why
 * scanning the raw payload for records found so few of them: the other 98%
 * are bit-shifted and their name fields do not read as ASCII until they are
 * realigned here.
 */
export function sectionBytes(payload: Uint8Array, at: number, bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits / 8));
  if ((at & 7) === 0) {
    out.set(payload.subarray(at >> 3, (at >> 3) + out.length));
    return out;
  }
  for (let i = 0; i < bits; i++) {
    const b = at + i;
    const byte = payload[b >> 3];
    if (byte === undefined) break;
    if ((byte >> (b & 7)) & 1) out[i >> 3]! |= 1 << (i & 7);
  }
  return out;
}

/** Every object record in a delta frame, read through the section framing. */
export function objectsInFrame(payload: Uint8Array): readonly ObjectSample[] {
  // Two readers want every frame's objects; parsing them is the costly part.
  let hit = objectsOf.get(payload);
  if (!hit) {
    hit = parseFrameObjects(payload);
    objectsOf.set(payload, hit);
  }
  return hit;
}

const objectsOf = new WeakMap<Uint8Array, readonly ObjectSample[]>();

function parseFrameObjects(payload: Uint8Array): ObjectSample[] {
  const out: ObjectSample[] = [];
  for (const s of readDeltaSections(payload)) {
    // Object records run ~700-950 bits; the 64-bit sequence counters that
    // dominate the stream cannot hold one.
    if (s.bits < 200) continue;
    for (const ob of parseObjects(sectionBytes(payload, s.at, s.bits))) out.push(ob);
  }
  return out;
}

/** One object as a delta frame reported it. */
export interface DeltaSighting {
  /** Milliseconds into the match. */
  t: number;
  name: string;
  owner: number;
  id: number;
  dllType: number;
  cellX: number;
  cellY: number;
  underConstruction: boolean;
}

/**
 * Read object records out of the delta frames.
 *
 * This is where the timing actually lives. A match is 21 keyframes and 18,308
 * deltas; object records were only ever read from the keyframes, which are
 * 20.8s apart, so every position was "where this stood at the next keyframe",
 * up to 20.8s after it was placed.
 *
 * The deltas were assumed undecodable because their *section* framing does not
 * parse. But {@link parseObjects} scans raw bytes for the record signature and
 * never needed the framing — it simply was never handed a delta payload. Doing
 * so yields 3,365 object records against 14 from the keyframes.
 *
 * Records are byte-aligned: scanning all eight bit alignments finds two extra
 * records in ninety seconds, which is noise, so alignment scanning is not
 * worth its cost here.
 *
 * The position offset is **per object type**, not fixed: 31 for a Gun Turret,
 * 35 for a power plant or Hand of Nod, 37 for a refinery, 41 for a
 * Construction Yard, 45 for an airstrip. Reading every type at one offset is
 * what limited this to power plants and Hands of Nod — a refinery decoded to a
 * constant (66,0), out of bounds, and was dropped. The offsets are recovered
 * by {@link findCellOffset} with no ground truth, because a correct offset
 * gives each instance of a type a different cell while a wrong one collapses
 * them all onto one value.
 *
 * Note most name hits in deltas are *not* these records — they are sidebar
 * production entries, which carry a name, a cost and a climbing progress byte
 * (a Hand of Nod reads 0x012c = 300 credits, its real price). Those are read
 * by {@link readProduction}; {@link parseObjects} correctly rejects them,
 * since they have one name field where an object record has two.
 */
export async function readDeltaObjects(bytes: Uint8Array): Promise<DeltaSighting[]> {
  const frames = await readFrames(bytes);
  // Collect first, decode second: the position offset has to be calibrated
  // per object type, and that needs every instance of the type in hand.
  const byType = new Map<string, { t: number; ob: ObjectSample }[]>();
  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === KEYFRAME_BASE) continue;
    for (const ob of objectsInFrame(f.payload)) {
      // The cargo plane is engine-spawned and its flight is scripted, not
      // recorded — calibration settles on a near-constant field and reports
      // every delivery at the same spot. See ENGINE_SPAWNED_ASSETS.
      if (ENGINE_SPAWNED_ASSETS.has(ob.name)) continue;
      const key = ob.dllType + ":" + ob.name;
      const list = byType.get(key) ?? [];
      list.push({ t: f.t, ob });
      byType.set(key, list);
    }
  }
  const out: DeltaSighting[] = [];
  for (const [key, list] of byType) {
    await breathe();
    const dllType = Number(key.slice(0, key.indexOf(":")));
    // Structures never move, so "which offset yields the most distinct cells"
    // identifies their position. That question is wrong for anything mobile —
    // plenty of unrelated fields vary — so those are scored on whether the
    // values move like a position instead. See findMobileCellOffset.
    // A building states its own offset through its occupy list; only the
    // types the game data does not cover are left to be searched for.
    const ruled =
      dllType === DLL_BUILDING && structureCellOffset(key.slice(key.indexOf(":") + 1)) != null;
    const at = ruled
      ? -1
      : dllType === DLL_BUILDING
        ? findCellOffset(
            list.map((r) => r.ob.body),
            64,
            undefined,
            true,
          )
        : findMobileCellOffset(
            // Key the track on owner AND id. Ids are not unique across
            // players, so keying on id alone splices two different units into
            // one track — which reads as teleporting and fails the speed test
            // that decides whether an offset is a position at all. With few
            // sightings that rarely bit; with full stream coverage it rejected
            // infantry outright, at an offset giving 100% in-bounds cells.
            list.map((r) => ({ id: r.ob.owner * 65536 + r.ob.id, t: r.t, body: r.ob.body })),
          );
    if (at === null) continue;
    for (const { t, ob } of list) {
      const c = ruled ? decodeStructureCell(ob.name, ob.body) : decodeCell(ob.body, at);
      if (!c) continue;
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      if (c.x < 0 || c.x > 63 || c.y < 0 || c.y > 63) continue;
      out.push({
        t,
        name: ob.name,
        owner: ob.owner,
        id: ob.id,
        dllType: ob.dllType,
        cellX: c.x,
        cellY: c.y,
        underConstruction: ob.underConstruction,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
/**
 * Sidebar entry states, as the stream uses them.
 *
 * `readProduction` only ever looked at BUILDING and threw the rest away,
 * which hid the one that says an item actually finished.
 */
export const SIDEBAR_BUILDING = 10;
/**
 * Emitted the moment an item completes. Every one of the 137 in the sample
 * match lands within 3s of a production run ending — **zero** orphans — and
 * runs carrying one peaked at 990 of a possible 1013 against 903 for runs
 * without.
 *
 * Its *absence* does not prove a cancellation, though: the scan misses some,
 * and runs that plainly finished at 1013 of 1013 can lack a marker. Treat a
 * run as cancelled only when it also stopped short on progress.
 */
export const SIDEBAR_COMPLETED = 9;

/**
 * Bit offset of the position inside a 0x5781 record, and how it is packed.
 *
 * `position := 13 bits at bit 40;  x = v & 0x7f,  y = v >> 7`
 *
 * Note this is **not** the engine's `CELL`: `XY_Cell` in FUNCTION.H packs
 * `(y << 6) | x` with a 6-bit X. The DLL's wire format gives X seven bits, so
 * the shift is 7. Reading it with the engine's macro halves every Y.
 *
 * Verified against structures, which never move and whose cells are already
 * decoded from the object records: 131 of 162 structure keys across six
 * unrelated replays land exactly on a decoded structure of their own type.
 * A random 13-bit value would land on one of ~20 known cells 0.5% of the time.
 */
export const TRACK_POS_BIT = 40;
export const TRACK_POS_BITS = 13;

/**
 * Where the selection flag sits in a 0x5781 record, and how to find it.
 *
 * `OBJECT.CPP` keeps both `IsSelectedMask |= (1 << house)` and a plain
 * `IsSelected` bool; this is the bool, which is why it is not house-exclusive
 * and why every scan gated on exclusivity missed it.
 *
 * Its bit offset is **not fixed**. It reads at 154 in one match, 155, 156 and
 * 158 in others — something ahead of it in the record varies in width. A
 * hardcoded 154 therefore decodes selection in the match it was found on and
 * silently reports none everywhere else, which is exactly what it did.
 *
 * So the bit is located per replay by its signature instead, which is sharp
 * enough to be unambiguous: carried by commandable units and essentially never
 * by structures or effects, held for several consecutive frames rather than
 * blinking, and reaching group sizes. Where that matches it hits 98.8% to 100%
 * on units; where nothing matches, the replay reports no selection rather than
 * inventing some.
 *
 * Confirmed against the game: at 4:06 in the Heavy Metal replay the decode
 * says Ronaldo-r9 has 15 buggies and 2 riflemen flagged, and the in-game
 * replay at that moment shows a block of buggies under selection brackets.
 */
const SELECT_BIT_SEARCH_LO = 140;
const SELECT_BIT_SEARCH_HI = 210;

/** Units a player actually commands — what selection lands on. */
/**
 * Everything a player can select, taken from the game's own type tables.
 *
 * UDATA.CPP, IDATA.CPP, BDATA.CPP and the aircraft types between them list
 * every INI name in Tiberian Dawn. The hand-written set this replaces was
 * missing the Engineer, the Apache, the Helipad, the civilians and the cargo
 * plane, which made a correct selection bit look like it was firing on
 * rubbish — one bit read 37% "on units" purely because 1,425 of its hits were
 * E2, an Engineer.
 */
const COMMANDABLE = new Set([
  // UDATA.CPP
  "APC", "ARTY", "BGGY", "BIKE", "BOAT", "FTNK", "HARV", "HTNK", "JEEP",
  "LST", "LTNK", "MCV", "MHQ", "MLRS", "MSAM", "MTNK", "NTNK", "STNK",
  "RAPT", "STEG", "TREX", "TRIC", "VICE",
  // IDATA.CPP
  "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "CHAN",
  "E1", "E2", "E3", "E4", "E5", "E6", "RMBO",
  // the aircraft types
  "A10", "C17", "HELI", "ORCA", "TRAN",
  // BDATA.CPP, less the walls and the civilian village pieces
  "AFLD", "ARCO", "ATWR", "BIO", "EYE", "FACT", "FIX", "GUN", "HAND",
  "HOSP", "HPAD", "HQ", "MISS", "NUK2", "NUKE", "OBLI", "PROC", "PYLE",
  "SAM", "SILO", "TMPL", "WEAP", "WEAP2",
]);

interface SelectionProbe {
  key: number;
  t: number;
  at: number;
  bits: number;
  payload: Uint8Array;
}

/**
 * The bit carrying `IsSelected`, or null when this replay shows none.
 * See {@link SELECT_BIT_SEARCH_LO} for why this is a search and not a constant.
 */
function findSelectionBit(probes: SelectionProbe[], nameOf: (key: number) => string): number | null {
  if (probes.length < 2000) return null;
  const byKey = new Map<number, SelectionProbe[]>();
  for (const r of probes) (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(r);

  let best: { bit: number; score: number } | null = null;
  for (let bit = SELECT_BIT_SEARCH_LO; bit <= SELECT_BIT_SEARCH_HI; bit++) {
    let set = 0;
    let total = 0;
    let onUnit = 0;
    for (const r of probes) {
      if (bit + 1 > r.bits) continue;
      total++;
      if (readBitsLE(r.payload, r.at + bit, 1) !== 1) continue;
      set++;
      if (COMMANDABLE.has(nameOf(r.key))) onUnit++;
    }
    if (!total || !set) continue;
    const frac = set / total;
    if (frac < 0.005 || frac > 0.3) continue;
    const unit = onUnit / set;
    if (unit < 0.9) continue;

    // A selection is held, not blinked.
    const runs: number[] = [];
    for (const [, rs] of byKey) {
      let cur = 0;
      for (const r of rs) {
        if (bit + 1 > r.bits) continue;
        if (readBitsLE(r.payload, r.at + bit, 1)) cur++;
        else if (cur) { runs.push(cur); cur = 0; }
      }
      if (cur) runs.push(cur);
    }
    if (runs.length < 20) continue;
    runs.sort((a, b) => a - b);
    // Two consecutive frames, not three. Several replays hold a selection for
    // a median of exactly two records, and a stricter gate rejected an
    // otherwise textbook candidate — 99.7% on units, 4,596 runs, 46 at once.
    if (runs[runs.length >> 1]! < 2) continue;

    // And it reaches group sizes.
    const concurrent = new Map<number, Set<number>>();
    for (const r of probes) {
      if (bit + 1 > r.bits) continue;
      if (!readBitsLE(r.payload, r.at + bit, 1)) continue;
      const w = Math.floor(r.t / 300);
      (concurrent.get(w) ?? concurrent.set(w, new Set()).get(w)!).add(r.key);
    }
    let atOnce = 0;
    for (const s of concurrent.values()) if (s.size > atOnce) atOnce = s.size;
    if (atOnce < 4) continue;

    const score = unit * atOnce;
    if (!best || score > best.score) best = { bit, score };
  }
  return best ? best.bit : null;
}

/**
 * The record carrying the object's render position, and where its fields sit.
 *
 * 0x3781 is a field delta with an 8-bit change mask at bit 40. Fields follow in
 * mask-bit order, each present only when its bit is set:
 *
 *     bit0  21 bits  PositionX, in pixels
 *     bit1  21 bits  PositionY, in pixels
 *     bit2  16 bits  X in leptons
 *     bit3  16 bits  Y in leptons
 *
 * So X is at bit 48, and Y at bit 69 when X is present or bit 48 when it is
 * not. These are `CNCObjectStruct.PositionX/PositionY` — the game's own draw
 * coordinates, at 1/24 of a cell instead of the whole cell 0x5781 reports.
 */
/**
 * Bit offset of `CNCObjectStruct.RemapColor` in an object record body.
 *
 * `PlayerColorType` (DEFINES.H): NONE -1, GOLD 0, LTBLUE 1, RED 2, GREEN 3,
 * ORANGE 4, BLUE 5. Reads cleanly on the sample match — house 8 is GOLD on all
 * 803 of its records, house 10 LTBLUE on all 1,027, and effects NONE on all
 * 13,450 — which is exactly what the game shows: Ronaldo-r9 in tan/gold and
 * IIIIIIIIIIII in light blue.
 *
 * The body is bit-packed, so this is a bit offset, not a byte one.
 */
export const OBJECT_REMAP_COLOR_BIT = 81;

/** The `PlayerColorType` each house played in, keyed by house. */
export async function readHouseColors(bytes: Uint8Array): Promise<Map<number, number>> {
  const frames = await readFrames(bytes);
  const votes = new Map<number, Map<number, number>>();
  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === KEYFRAME_BASE) continue;
    for (const s of readDeltaSections(f.payload)) {
      if (!OBJECT_RECORD_TYPES.has(s.type)) continue;
      for (const ob of parseObjects(sectionBytes(f.payload, s.at, s.bits))) {
        const c = readBitsLE(ob.body, OBJECT_REMAP_COLOR_BIT, 8);
        if (c < 0 || c > 5) continue;            // -1/255 is REMAP_NONE
        const m = votes.get(ob.owner) ?? new Map<number, number>();
        m.set(c, (m.get(c) ?? 0) + 1);
        votes.set(ob.owner, m);
      }
    }
  }
  const out = new Map<number, number>();
  for (const [house, m] of votes) out.set(house, [...m].sort((a, b) => b[1] - a[1])[0]![0]);
  return out;
}

export const DELTA_RECORD = 0x3781;
const DELTA_POS_X_BIT = 48;
const DELTA_POS_FIELD_BITS = 21;

/**
 * Field widths for the 0x3781 change mask, in bit order.
 *
 *   bit0 PositionX px | bit1 PositionY px | bit2 X leptons | bit3 Y leptons
 *   bit4 Altitude | bit5 animation frame | bit6 draw order | bit7 unused
 *
 * The frame stamp is a further 32 bits present whenever bit0 or bit1 is set,
 * and it sits **after bits 0 to 4 and before bits 5 to 7** — reading it as the
 * record's last 32 bits gives the right modal value and garbage elsewhere.
 *
 * These widths reproduce the length of every mask exactly: zero mismatches
 * across 77 to 143 distinct masks in each of five replays.
 */
const DELTA_FIELD_BITS = [21, 21, 16, 16, 16, 16, 32, 5] as const;

/** Bit offset of one mask field inside a 0x3781 record, or -1 if absent. */
export function deltaFieldOffset(mask: number, field: number): number {
  let at = 48;
  for (let b = 0; b <= 4; b++) {
    if (b === field) return (mask >> b) & 1 ? at : -1;
    if ((mask >> b) & 1) at += DELTA_FIELD_BITS[b]!;
  }
  if (mask & 3) at += 32;
  for (let b = 5; b <= 7; b++) {
    if (b === field) return (mask >> b) & 1 ? at : -1;
    if ((mask >> b) & 1) at += DELTA_FIELD_BITS[b]!;
  }
  return -1;
}

/**
 * Altitude at cruise, from the engine's `FLIGHT_LEVEL`. Ground objects read
 * exactly 0 in every sample; only aircraft carry anything else.
 */
export const FLIGHT_LEVEL = 256;

/**
 * Bit offset of `Strength` — current health — in a 0x5781 record.
 *
 * Identified by matching its per-type peak against the game's own numbers in
 * UDATA.CPP: a buggy peaks at exactly 140, a harvester at 600, a refinery at
 * 900, infantry at 70, a power plant at 400. It is the only 16-bit field in
 * the record that does. It falls under fire and rises only on repair — 3,296
 * steps down against 670 up — and the last value before a unit's track ends is
 * a median of **0**, which is that unit dying.
 *
 * Unlike the selection flag this one does not move between replays.
 */
export const TRACK_STRENGTH_BIT = 134;

/**
 * `ControlGroup`, one byte, 255 when the object is in no group.
 *
 * Found by its neighbour rather than by searching for it. `VisibleFlags` is
 * an `unsigned int` whose "all" value is 0xffffffff, and a 32-bit read at bit
 * 240 is all-ones in every record on every replay — so the byte the struct
 * puts immediately before it is this. An earlier pass concluded the field was
 * not serialised at all; it was simply being looked for in the object records
 * rather than in the movement stream, the same mistake that hid selection.
 */
/**
 * Bits 182 to 189 of a 0x5781 record are not read.
 *
 * Bit 182 was taken for IsRepairing, which the struct does put there: it
 * fires on buildings and on nothing else. It is not the repair flag, though.
 * It runs on Refineries and Silos in a cycle whose gaps are a flat 13.2s
 * match after match, it matches neither the stored Tiberium the sidebar
 * reports nor the moment money jumps, and it gave about 87 repairs a match in
 * replays where the players sent 27 repair requests. So the shipped struct
 * has fields here the released header does not, and this is one of them.
 *
 * Repairs come from the players own presses instead, which the input stream
 * carries exactly: STRUCTURE_REQUEST.REPAIR.
 */

/**
 * `FlashingFlags` in a 0x5781 record: one bit per house, from bit 190.
 *
 * TechnoClass::Clicked_As_Target (TECHNO.CPP:1846) sets it when a player
 * clicks an object "in order to make it the target of a move or attack", and
 * only for that player's house (FlasherClass::Get_Flashing_Flags). So a bit
 * coming on is one player's order aimed at that object: an attack, a unit
 * sent onto another, a Harvester sent to a Refinery.
 *
 * Found by where it lands rather than guessed. The struct puts it just after
 * IsRepairing (182) and the two flags beside it, and a scan of bits 183-231
 * finds exactly two that fire in short bursts — a median 154ms, a few flashes
 * — on units and buildings alike: 196 and 197 in a match between houses 6
 * and 7, and 195 and 198 in one between houses 5 and 8. Those are 190 plus
 * the house, as the selection mask is 150 plus the house.
 */
export const FLASH_MASK_BASE = 190;

/** A player clicking an object as the target of an order. */
export interface TargetClick {
  t: number;
  /** The clicking player's house, as `owner` values count them (house x 2). */
  owner: number;
  /** The record key of the object clicked. */
  key: number;
}

/**
 * Every time a player clicked an object as an order's target.
 *
 * The rising edge of that player's flash bit. The flash runs a few frames, so
 * clicking the same object again before it ends shows as one click.
 */
export async function readTargetClicks(bytes: Uint8Array, owners: readonly number[]): Promise<TargetClick[]> {
  const frames = await readFrames(bytes);
  const houses = [...new Set(owners.map((o) => Math.floor(o / 2)))];
  const was = new Map<string, boolean>();
  const out: TargetClick[] = [];
  for (const f of frames) {
    await breathe();
    for (const sec of readDeltaSections(f.payload)) {
      if (sec.type !== TRACK_RECORD_TYPE) continue;
      for (const h of houses) {
        const bit = FLASH_MASK_BASE + h;
        if (bit + 1 > sec.bits) continue;
        const on = readBitsLE(f.payload, sec.at + bit, 1) === 1;
        const k = `${sec.key}:${h}`;
        if (on && !was.get(k)) out.push({ t: f.t, owner: h * 2, key: sec.key });
        was.set(k, on);
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- Player input -------------------------------------------------------------
//
// Past the section chain a frame may carry the inputs the players sent the game
// that frame: about one frame in six. Each is one call into the game DLL —
// CNC_Handle_Input, and the sidebar, structure, unit and control group
// requests beside it (DLLInterface.h) — framed as a 16-byte header
//
//     [id u32][length u32 = bytes + 0x10000][bits u32][u32 0]
//
// and a body of \`bits\` bits that repeats the id, then, three bits in, a 24-bit
// sequence number, an 8-bit request code and the call's arguments. For
// CNC_Handle_Input (code 0x1f) those are the event, the Ctrl/Alt/Shift flags,
// and x1, y1, x2, y2 in map pixels.
//
// Nothing in a message says which player sent it. Each player numbers their own
// messages, though, and the two counts are stored interleaved; see
// splitSenders.

/**
 * A request code, and for 0x1f the event, as the game's enums name them.
 *
 * The codes run 0x0f + 0x10 per call in the order DLLInterface.h declares the
 * handlers: Input first at 0x1f, then Structure, Unit, Sidebar, SuperWeapon,
 * ControlGroup. Two of those are checkable on their own — control group (0x6f)
 * carries a group number, sidebar (0x4f) a buildable and a cell — and both sit
 * where that order puts them, which fixes the rest. Structure is 0x2f and unit
 * 0x3f, the way round the declarations have them, not the other way: 0x2f is
 * the one whose requests make a building vanish (see STRUCTURE_REQUEST).
 */
export const INPUT_CODE = {
  INPUT: 0x1f,
  STRUCTURE: 0x2f,
  UNIT: 0x3f,
  SIDEBAR: 0x4f,
  SUPER_WEAPON: 0x5f,
  CONTROL_GROUP: 0x6f,
  SELECTION: 0x9f,
} as const;

/**
 * CNC_Handle_Structure_Request's types — repairing and selling.
 *
 * These are the header's own numbering, and what the buildings do after says
 * so. Over ten matches a sell-start or a sell is followed within twelve
 * seconds by one of that player's buildings disappearing 86 times out of 111
 * and 95 out of 117; a repair-start or repair almost never is, and is followed
 * by a building of theirs gaining health instead.
 *
 * Each repair or sell is two presses: one on the sidebar button, which sends
 * the START, and one on the building, which sends the request with its id.
 */
export const STRUCTURE_REQUEST = {
  REPAIR_START: 1,
  REPAIR: 2,
  SELL_START: 3,
  SELL: 4,
  CANCEL: 5,
} as const;

/**
 * CNC_Handle_Unit_Request's types, as DLLInterface.h numbers them.
 *
 * These carry no arguments at all — not even which units — so each one is read
 * from what the player's selection does next. The key that sent it is never in
 * the replay either: the client turns whatever is bound into a numbered
 * request, so a player who has moved guard onto B sends the same 4 as one
 * leaving it on G.
 *
 * SCATTER is much the most common, about twenty-five a match in bursts right
 * after a drag-select, and the player these replays belong to confirms that is
 * him spamming his scatter key.
 *
 * STOP and GUARD_MODE are told apart by the Harvester. Selected_Guard_Mode
 * issues only to units where `Can_Player_Fire()` holds, so a Harvester is
 * skipped; Selected_Stop issues to anything that `Can_Player_Move()`. Over
 * forty matches, every moving Harvester selected at a 5 stopped — 7 of 7,
 * against 48% stopping anyway — and neither of the two at a 4 did.
 *
 * SELECT_NEXT and SELECT_PREVIOUS are the header's ordering, unmeasured: they
 * are rare and change only what is selected.
 */
export const UNIT_REQUEST = {
  SCATTER: 1,
  SELECT_NEXT: 2,
  SELECT_PREVIOUS: 3,
  GUARD_MODE: 4,
  STOP: 5,
} as const;

/**
 * CNC_Handle_Sidebar_Request's types as the shipped game numbers them, which
 * is not quite the released header's numbering.
 *
 * Measured, each from something that can be checked:
 *  - 1 starts construction. It carries the buildable type — 2 infantry, 4
 *    vehicle, 8 building — and lands on a production run starting.
 *  - 2 holds and 3 cancels: both only ever fall inside a run, and the runs
 *    3 lands on are mostly ones that never finish.
 *  - 4 opens placement. Buildings only, no cell, and its count equals 5 plus 6
 *    exactly in every match: each attempt ends one way or the other.
 *  - 5 abandons placement, 6 places. Only 6 carries a cell, and it lands on a
 *    real placement 45 times out of 46.
 *  - 9 queues another of the same thing and 10 takes one off the queue. 9 runs
 *    in long repeats, which is a player clicking an icon over and over.
 */
export const SIDEBAR_REQUEST = {
  START_CONSTRUCTION: 1,
  HOLD_CONSTRUCTION: 2,
  CANCEL_CONSTRUCTION: 3,
  START_PLACEMENT: 4,
  CANCEL_PLACEMENT: 5,
  PLACE: 6,
  QUEUE_ANOTHER: 9,
  CANCEL_QUEUED: 10,
} as const;

/**
 * CNC_Handle_Input's events as they arrive. The shipped game numbers them one
 * past the released source from SELECT_AT_POSITION on — something was added
 * after SELL_AT — so select-at is 9, command-at 10, and 11 the one that carries
 * key flags and no position.
 *
 * Which ones a player sends depends on their controls. Legacy controls send
 * the raw clicks (2, 3, 4) and the game decides what they mean. Modern
 * controls decide in the client and send "select here" (9) or "command here"
 * (10): a player on modern controls gives every order as a 10 and never sends
 * a right click at all.
 */
export const INPUT_EVENT = {
  LEFT_CLICK: 2,
  RIGHT_DOWN: 3,
  RIGHT_CLICK: 4,
  AREA: 5,
  AREA_ADDITIVE: 6,
  SELL_AT: 7,
  SELECT_AT: 9,
  COMMAND_AT: 10,
  SPECIAL_KEYS: 11,
} as const;

export interface InputMessage {
  t: number;
  /** Which of the two senders' counters it continues, 0 or 1; see splitSenders. */
  sender: 0 | 1;
  seq: number;
  code: number;
  /** For CNC_Handle_Input the event; for the other requests their request type. */
  event: number;
  /**
   * The call's arguments after the event, as packed. Read with the helpers
   * below: CNC_Handle_Input packs flags (1 byte) then x1, y1, x2, y2 (4 bytes
   * each); the sidebar request object type and id (4 each) then cell x, y (2
   * each); the control group request the group (1).
   */
  data: Uint8Array;
}

const le = (d: Uint8Array, o: number, n: number) => {
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + (d[o + i] ?? 0);
  return v;
};
const s32 = (d: Uint8Array, o: number) => le(d, o, 4) | 0;

/** A CNC_Handle_Input call: key flags and up to two points, in map pixels. */
export function inputCall(m: InputMessage): { flags: number; x1: number; y1: number; x2: number; y2: number } {
  return { flags: m.data[0] ?? 0, x1: s32(m.data, 1), y1: s32(m.data, 5), x2: s32(m.data, 9), y2: s32(m.data, 13) };
}

/** A sidebar request: what was asked for and, when placing, the cell. */
export function sidebarCall(m: InputMessage): { type: number; id: number; cellX: number; cellY: number } {
  return { type: le(m.data, 0, 4), id: le(m.data, 4, 4), cellX: le(m.data, 8, 2), cellY: le(m.data, 10, 2) };
}

const INPUT_MAX_BITS = 4096;

/** Every input message in the replay, in time order, with its sender's counter. */
export async function readInputs(bytes: Uint8Array): Promise<InputMessage[]> {
  const frames = await readFrames(bytes);
  const raw: Omit<InputMessage, "sender">[] = [];
  for (const f of frames) {
    await breathe();
    const { base, bits } = payloadLayout(f.payload);
    const p = f.payload;
    const endByte = Math.ceil((base * 8 + bits) / 8);
    for (let o = Math.max(0, endByte - 2); o + 21 <= p.length; o++) {
      const id = u32(p, o);
      const len = u32(p, o + 4);
      const b = u32(p, o + 8);
      if (id === 0 || id === 0xffffffff || len >>> 16 !== 1 || u32(p, o + 12) !== 0) continue;
      if (b === 0 || b > INPUT_MAX_BITS || u32(p, o + 16) !== id) continue;
      if (o + 16 + Math.ceil(b / 8) > p.length) continue;
      const body = (o + 20) * 8;
      const end = (o + 16) * 8 + b;
      const data: number[] = [];
      for (let at = body + 51; at + 8 <= end; at += 8) data.push(readBitsLE(p, at, 8));
      raw.push({
        t: f.t,
        seq: readBitsLE(p, body + 3, 24),
        code: readBitsLE(p, body + 35, 8),
        event: readBitsLE(p, body + 43, 8),
        data: Uint8Array.from(data),
      });
      o += 15 + Math.ceil(b / 8);
    }
  }
  raw.sort((a, b) => a.t - b.t);
  const seq = raw.map((m) => m.seq);
  // Where the two players use different controls, their clicks say whose
  // they are, and the split is made to agree with them (see controlsOf).
  const scheme = raw.map((m) => controlsOf(m.code, m.event));
  const legacy = scheme.filter((x) => x === "legacy").length;
  const modern = scheme.filter((x) => x === "modern").length;
  const who =
    legacy >= SCHEME_MIN_CLICKS && modern >= SCHEME_MIN_CLICKS
      ? splitSenders(seq, scheme.map((x) => (x === "legacy" ? 0 : x === "modern" ? 1 : -1)))
      : splitSenders(seq);
  return raw.map((m, i) => ({ ...m, sender: who[i]! }));
}

/**
 * Which control scheme a message could only have come from, or null.
 *
 * The Remastered offers two. With modern controls the client has already
 * decided what a click means and sends CNC_Handle_Input's select-at (9) or
 * command-at (10); with legacy controls it sends the raw buttons — left click
 * (2), right press (3), right click (4) — and lets the game decide. Nothing in
 * the file records the setting (not the header, not the lobby settings), but
 * a player's clicks give it away: of 194 players in 97 ladder replays, 185
 * sent one kind almost only, and the rest were two players dealt each other's
 * messages (see splitSenders).
 */
export function controlsOf(code: number, event: number): Controls | null {
  if (code !== INPUT_CODE.INPUT) return null;
  if (event === 2 || event === 3 || event === 4) return "legacy";
  if (event === 9 || event === 10) return "modern";
  return null;
}

export type Controls = "legacy" | "modern";

/** Clicks of each kind a match must hold before they are trusted to part the players. */
const SCHEME_MIN_CLICKS = 20;

/**
 * A player's control scheme, from the clicks they sent: whichever kind is
 * nine in ten of them, or null when there are too few to say.
 */
export function controlsOfPlayer(inputs: readonly { code: number; event: number }[]): Controls | null {
  let legacy = 0;
  let modern = 0;
  for (const m of inputs) {
    const c = controlsOf(m.code, m.event);
    if (c === "legacy") legacy++;
    else if (c === "modern") modern++;
  }
  const total = legacy + modern;
  if (total < SCHEME_MIN_CLICKS) return null;
  if (modern >= total * 0.9) return "modern";
  if (legacy >= total * 0.9) return "legacy";
  return null;
}

/**
 * Split a run of sequence numbers into the two senders' counters.
 *
 * Each player counts their own messages, so the run is two increasing
 * sequences shuffled together. Of all the ways to deal the messages into two
 * increasing piles, this finds the one with the smallest total of the steps
 * inside each pile — a counter goes up by one per message sent, so the right
 * split keeps its steps small. Exact, by dynamic programming over "the last
 * message of the other pile" and which pile the latest message is in.
 *
 * The counters alone can be ambiguous: two players sending at the same rate
 * keep their counters within a few of each other, and then either pile will
 * take either message and still rise. `anchor`, where given, says which pile
 * a message belongs in (0 or 1; -1 for no opinion) — a player's control scheme
 * does (see controlsOf) — and a message dealt against it costs
 * ANCHOR_PENALTY, enough to settle a tie but not to force a stray click into
 * a pile its counter plainly does not fit. In 7982008 this moved 190 of each
 * player's messages back to them.
 *
 * Returns 0 or 1 per message. Without anchors which pile is which player is
 * for the caller to settle from what the messages do; with them, pile 0 is
 * the one anchor 0 points at.
 */
export function splitSenders(seq: readonly number[], anchor?: readonly (0 | 1 | -1)[]): (0 | 1)[] {
  const n = seq.length;
  if (!n) return [];
  const START = 1; // cost of opening a pile
  const BIG = 1e12;
  const miss = (i: number, pile: 0 | 1) => {
    const a = anchor?.[i] ?? -1;
    return a === -1 || a === pile ? 0 : ANCHOR_PENALTY;
  };
  type State = { cost: number; from: number };
  // Key: (last message of the other pile + 1) * 2 + pile of the latest message.
  const key = (j: number, pile: 0 | 1) => (j + 1) * 2 + pile;
  let prev = new Map<number, State>();
  for (const pile of [0, 1] as const) prev.set(key(-1, pile), { cost: START + miss(0, pile), from: -1 });
  const trail: Map<number, State>[] = [prev];
  for (let i = 1; i < n; i++) {
    const next = new Map<number, State>();
    const put = (k: number, cost: number, from: number) => {
      const e = next.get(k);
      if (!e || cost < e.cost) next.set(k, { cost, from });
    };
    for (const [k, st] of prev) {
      const pile = (k % 2) as 0 | 1;
      const j = Math.floor(k / 2) - 1;
      // i joins message i-1's pile; the other pile still ends at j.
      const d = seq[i]! - seq[i - 1]!;
      put(key(j, pile), st.cost + (d > 0 ? d : BIG) + miss(i, pile), k);
      // i joins the other pile; message i-1 now ends the other one.
      const other = (1 - pile) as 0 | 1;
      const d2 = j < 0 ? START : seq[i]! - seq[j]!;
      put(key(i - 1, other), st.cost + (j < 0 || d2 > 0 ? d2 : BIG) + miss(i, other), k);
    }
    // Keep the search small: the best few hundred states are plenty.
    if (next.size > 400) {
      prev = new Map([...next].sort((a, b) => a[1].cost - b[1].cost).slice(0, 400));
    } else prev = next;
    trail.push(prev);
  }
  // Walk back from the cheapest end.
  let [k] = [...prev].sort((a, b) => a[1].cost - b[1].cost)[0]!;
  const pile = new Array<0 | 1>(n);
  for (let i = n - 1; i >= 0; i--) {
    pile[i] = (k % 2) as 0 | 1;
    if (i === 0) break;
    k = trail[i]!.get(k)!.from;
  }
  if (!anchor) {
    // Unanchored, the labels mean nothing; keep the old habit of the last
    // message being pile 0, which callers' tests were written against.
    if (pile[n - 1] === 1) for (let i = 0; i < n; i++) pile[i] = pile[i] === 0 ? 1 : 0;
  }
  return pile;
}

/** What dealing a message against its control scheme costs, in counter steps. */
const ANCHOR_PENALTY = 40;

/**
 * Which player each sender pile is, as house owner values.
 *
 * Settled by what the messages did. A sidebar place request names a cell, and
 * the build orders say who put a structure down there a moment later: in three
 * ladder replays every one of 59-90 placements put each pile on one house and
 * the other pile on the other, without exception. Where no placement matches,
 * starts of production do the same job against each side's production runs.
 */
export function inputSenders(
  inputs: readonly InputMessage[],
  orders: ReplayBuildOrders & { runs: readonly ProductionRun[]; sideToOwner: ReadonlyMap<0 | 1, number> },
): Map<0 | 1, number> {
  const votes = [new Map<number, number>(), new Map<number, number>()];
  const placed = [...orders.byOwner].flatMap(([owner, list]) =>
    list
      .filter((e) => e.placedAt != null && e.cellX != null && e.cellY != null)
      .map((e) => ({ owner, t: e.placedAt!, x: Math.round(e.cellX!), y: Math.round(e.cellY!) })),
  );
  for (const m of inputs) {
    if (m.code !== INPUT_CODE.SIDEBAR || m.event !== 6) continue;
    const c = sidebarCall(m);
    const hit = placed.find((p) => Math.abs(p.t - m.t) < 3000 && Math.abs(p.x - c.cellX) <= 2 && Math.abs(p.y - c.cellY) <= 2);
    if (hit) votes[m.sender]!.set(hit.owner, (votes[m.sender]!.get(hit.owner) ?? 0) + 1);
  }
  // Production starts: a sidebar request to build, and a run starting on one
  // side within half a second.
  const runs = orders.runs.flatMap((r) => {
    const owner = orders.sideToOwner.get(r.side);
    return owner === undefined ? [] : [{ owner, t: r.start }];
  });
  for (const m of inputs) {
    if (m.code !== INPUT_CODE.SIDEBAR || m.event !== 1) continue;
    const near = runs.filter((r) => Math.abs(r.t - m.t) < 500);
    if (new Set(near.map((r) => r.owner)).size !== 1) continue;
    votes[m.sender]!.set(near[0]!.owner, (votes[m.sender]!.get(near[0]!.owner) ?? 0) + 0.25);
  }
  const owners = [...orders.byOwner.keys()];
  const out = new Map<0 | 1, number>();
  const score = (pile: 0 | 1, owner: number) => votes[pile]!.get(owner) ?? 0;
  if (owners.length === 2) {
    const [a, b] = owners as [number, number];
    const straight = score(0, a) + score(1, b);
    const crossed = score(0, b) + score(1, a);
    if (straight === crossed) return out;
    out.set(0, straight > crossed ? a : b);
    out.set(1, straight > crossed ? b : a);
  }
  return out;
}

export const CONTROL_GROUP_BIT = 232;
/** The value meaning "not in a group". */
export const CONTROL_GROUP_NONE = 255;
/** Assignments landing this close together are one press of one key. */
const CONTROL_GROUP_PRESS_MS = 200;

/** One press of ctrl+N: the moment, the house, the key, and how many units. */
export interface ControlGroupPress {
  t: number;
  owner: number;
  group: number;
  size: number;
}

/**
 * Every control group a player set during the match.
 *
 * Assigning a group writes the same number onto every selected unit at once,
 * so a press is a set of units of one house taking one new value together.
 * Recalling a group is invisible here — it changes only what is selected, not
 * what any unit belongs to.
 */
export async function readControlGroups(bytes: Uint8Array): Promise<ControlGroupPress[]> {
  const frames = await readFrames(bytes);
  const nameKnown = new Map<number, number>();
  const rows: { key: number; t: number; owner: number; v: number }[] = [];
  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === -1) continue;
    for (const sec of readDeltaSections(f.payload)) {
      if (OBJECT_RECORD_TYPES.has(sec.type)) {
        for (const ob of parseObjects(sectionBytes(f.payload, sec.at, sec.bits))) {
          if (ob.owner !== HOUSE_NONE && !nameKnown.has(sec.key)) nameKnown.set(sec.key, ob.owner);
        }
        continue;
      }
      if (sec.type !== TRACK_RECORD_TYPE) continue;
      if (CONTROL_GROUP_BIT + 8 > sec.bits) continue;
      const v = readBitsLE(f.payload, sec.at + CONTROL_GROUP_BIT, 8);
      if (v < 0) continue;
      const owner = nameKnown.get(sec.key);
      if (owner === undefined) continue;
      rows.push({ key: sec.key, t: f.t, owner, v });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const prev = new Map<number, number>();
  const presses = new Map<string, { t: number; owner: number; group: number; keys: Set<number> }>();
  for (const r of rows) {
    const was = prev.get(r.key);
    prev.set(r.key, r.v);
    if (was === undefined || was === r.v || r.v === CONTROL_GROUP_NONE) continue;
    const k = `${Math.floor(r.t / CONTROL_GROUP_PRESS_MS)}:${r.owner}:${r.v}`;
    const e = presses.get(k) ?? { t: r.t, owner: r.owner, group: r.v, keys: new Set<number>() };
    e.keys.add(r.key);
    presses.set(k, e);
  }
  return [...presses.values()]
    .map((e) => ({ t: e.t, owner: e.owner, group: e.group, size: e.keys.size }))
    .sort((a, b) => a.t - b.t);
}

/**
 * `ShapeIndex` — the sprite frame — is 0x3781 mask bit 5, and for a vehicle
 * the frame *is* the facing: 32 steps, counter-clockwise from north.
 *
 * The DLL never exports a usable rotation (`new_object.Rotation = 0` on the
 * main path), so this is where facing lives. Measured against the direction
 * units actually travelled, `shape % 32` read counter-clockwise agrees at
 * **0.809** for buggies and **0.915** for harvesters, where every other
 * reading — 8 or 16 steps, either direction — sits at 0.03 to 0.16.
 */
export const VEHICLE_SHAPE_FACINGS = 32;

/**
 * Infantry sequences from IDATA.CPP as `[start, jump]`, enough to recover the
 * facing a recorded frame was drawn at. A frame is `start + facing * jump +
 * stage`, so the facing falls out of whichever sequence the frame lands in.
 *
 * Verified against the recording: the facing this yields agrees with the
 * direction infantry actually travelled at **0.930**, and 89.6% of frames land
 * in the walk cycle with 1.2% outside any sequence.
 */
const INFANTRY_SEQUENCES: readonly (readonly [number, number])[] = [
  [0, 1], [8, 1], [16, 6], [64, 8], [128, 2], [144, 4], [176, 2], [192, 8],
];

/** The facing an infantry sprite frame was drawn at, or null if it is not a directional pose. */
export function infantryFacingFromShape(shape: number): number | null {
  for (const [start, jump] of INFANTRY_SEQUENCES) {
    const span = 8 * jump;
    if (shape >= start && shape < start + span) return Math.floor((shape - start) / jump);
  }
  return null;
}

/** One object's movement, sampled every frame it appeared in. */
export interface ObjectTrack {
  /** The record key, which is the object's identity within the stream. */
  key: number;
  /** Which life of that key this is; a key is reused after its object dies. */
  segment: number;
  name: string;
  owner: number;
  samples: {
    t: number;
    cellX: number;
    cellY: number;
    selected: boolean;
    /** Render position in world pixels, when the frame carried one. */
    px?: number;
    py?: number;
    /**
     * Height above the ground, 0 to {@link FLIGHT_LEVEL}. Aircraft only —
     * every ground object reads exactly 0.
     */
    alt?: number;
    /** Current health. Zero means the object was destroyed. */
    hp?: number;
    /** Control group, 255 when in none. */
    group?: number;
    /** Sprite frame. For a vehicle, `shape % 32` is its facing. */
    shape?: number;
    /**
     * When `px`/`py` came from a reading taken at a different moment than the
     * sample, the moment that reading was actually taken. Timing movement by
     * this rather than by `t` keeps a leg's distance and duration on the same
     * clock.
     */
    pt?: number;
  }[];
  /**
   * Every position the game drew this object at, in world pixels, from the
   * per-object update records (0x3781): one entry each frame it moved.
   *
   * The samples above are the movement records' (0x5781), a median 330ms
   * apart, and only borrow the nearest of these. This is the full path, the
   * one Remastered's own replay player moves the unit along.
   */
  path?: { t: number; px: number; py: number }[];
  /**
   * Every sprite frame the game drew it with, as it changed (field 5 of the
   * same records): the facing a vehicle turned through frame by frame, where
   * the samples carry one every few hundred milliseconds.
   */
  shapes?: { t: number; v: number }[];
  /** Height above the ground at every frame it changed, 0..FLIGHT_LEVEL. Aircraft only. */
  alts?: { t: number; v: number }[];
}

/**
 * Faster than this and the object cannot have travelled there, so the key has
 * been recycled onto a new object. A buggy — the fastest ground unit in TD —
 * runs about 2.5 cells/s in these recordings and the cargo plane about 7.5.
 */
const TRACK_MAX_CELLS_PER_SEC = 12;

const TRACK_MIN_JUMP_CELLS = 4;

/** A mask bit fires on commandable objects and almost nothing else. */
const SELECT_MASK_UNIT_PURITY = 0.95;
/** Fewest times a neighbouring bit must fire to be read as another house's. */
const SELECT_MASK_MIN_SETS = 20;
/**
 * Bit 0 of `IsSelectedMask`. A house's own bit is this plus its index, and
 * the index is the object records' owner byte halved.
 */
const SELECT_MASK_BASE = 150;
/** How strongly a house's bit must favour that house's own objects. */
const SELECT_MASK_OWN_HOUSE = 0.6;
/** Selections needed before the hold test means anything. */
const SELECT_MASK_MIN_RUNS = 30;
/**
 * How long a selection must typically last. Houses that decode cleanly hold
 * one for 1.3-1.6s; a bit that means something else lasts a single sample,
 * which is 150-500ms depending on how often the object is restated.
 */
const SELECT_MASK_MIN_HOLD_MS = 700;
/**
 * Or how many of its flips must come in company.
 *
 * Holding is not the only thing a real selection does. A player spamming
 * control groups — 2, 3, 2, 3 — flips every unit in both groups several times
 * a second, and each flip lands in the same frame as the rest of its group's.
 * Match 1771496 has exactly that: a house whose bit held a median 176ms,
 * rejected as noise, with 95% of its 4,819 flips shared with another unit in
 * the same frame, against 90% for the opponent who held for 1.6s. Noise on
 * one object at a time has no reason to line up across a group.
 *
 * Over 40 ladder replays the houses that pass on holding group 73-93% of
 * their flips, and the ones that miss the hold by a little (a median 528-682ms)
 * group 71-76%, every hit on something selectable and 88-97% on their own
 * units. The line sits below all of them. With it, every house of all 85
 * cached ladder replays decodes — 163 of them, selected 3.6-34.5% of the time,
 * a median 15.4% — where 14 of the first 25 had one player reading nothing.
 */
const SELECT_MASK_MIN_GROUPED = 0.6;

/**
 * How far a pixel reading may sit from the cell reported for the same object
 * before it is treated as belonging to a different object. A sample and its
 * pixel reading can be up to 250ms apart, and the fastest ground unit covers
 * about a cell in that time, so the allowance has to clear that.
 */
const PIXEL_CELL_AGREE_CELLS = 1.5;

/** `HOUSE_NONE` — the owner animations and other unowned objects carry. */
const HOUSE_NONE = 0xfe;
/**
 * How far an object must appear to move for that step to be read as the key
 * passing to a different object rather than the same one driving.
 */
const HANDOVER_JUMP_CELLS = 2;
/** How long after its first record a new object's first position may come. */
const HANDOVER_LATE_MS = 2000;

/**
 * Cut a key's samples into one segment per object that used it.
 *
 * Without this, a key that outlives its unit splices two units into one track,
 * which reads as a unit teleporting across the map. Segmenting drops the
 * impossible steps for real units to near zero while leaving effect objects —
 * muzzle flashes, shell impacts — as the many short segments they really are.
 */
export function segmentTrack(samples: { t: number; cellX: number; cellY: number; selected: boolean; px?: number; py?: number; pt?: number; alt?: number; hp?: number; shape?: number; group?: number }[]): typeof samples[] {
  const out: typeof samples[] = [];
  let cur: typeof samples = [];
  // Health in this segment: its best, and the last reading if it was low.
  let peak = 0;
  let low: { cellX: number; cellY: number; hp: number } | null = null;
  const cut = () => {
    out.push(cur);
    cur = [];
    peak = 0;
    low = null;
  };
  for (const s of samples) {
    const prev = cur[cur.length - 1];
    if (prev) {
      // Only a real distance covered impossibly fast means a new object. A
      // long silence does not: the stream simply does not restate every object
      // in every frame, and splitting on that alone cut standing buildings
      // into hundreds of pieces.
      const dt = (s.t - prev.t) / 1000;
      const d = Math.abs(s.cellX - prev.cellX) + Math.abs(s.cellY - prev.cellY);
      if (d >= TRACK_MIN_JUMP_CELLS && d / Math.max(0.05, dt) > TRACK_MAX_CELLS_PER_SEC) cut();
      // Or a unit all but dead, then whole again somewhere else. The key was
      // freed by the death and handed straight to a new unit — a factory
      // building constantly takes keys as fast as they come free — and the
      // two had been read as one unit that drove home and healed. Nothing in
      // TD heals like that: infantry never do, and a Repair Bay mends a
      // vehicle standing on it, where its low reading was taken too.
      //
      // Measured as the rise, not against the best the key has read: a key
      // can pass along several units before this, and its best can be an
      // earlier one's. In match 7675940 a Recon Bike (160) held the key
      // first, so a Buggy (140) read at 3 and then whole by its Airstrip
      // never reached 90% of 160 -- and the dying Buggy slid 26 cells to the
      // Airstrip and drove on at full health.
      // A zero, though, can be a reading of nothing on a live unit, so from
      // one the new reading has to be whole against the key's best as before.
      else if (low && s.hp != null && Math.abs(s.cellX - low.cellX) + Math.abs(s.cellY - low.cellY) > HANDOVER_HEAL_CELLS &&
        (low.hp > 0 ? s.hp - low.hp >= s.hp * HANDOVER_RISE : s.hp >= peak * HANDOVER_WHOLE)) cut();
    }
    cur.push(s);
    if (s.hp != null) {
      if (s.hp > peak) peak = s.hp;
      low = s.hp <= peak * HANDOVER_LOW ? { cellX: s.cellX, cellY: s.cellY, hp: s.hp } : null;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Health that marks one unit dying and another taking its key: this little of
 * the best it had, then this much at a spot this far away. Of the tracks that
 * did this in six scored ladder replays, the count per match came within a
 * few of the deaths the score screen had and the viewer did not — 59 of 59 in
 * one.
 */
const HANDOVER_LOW = 0.25;
/** From a low reading, the new one must be at least twice it: the rise is half the new reading. */
const HANDOVER_RISE = 0.5;
const HANDOVER_WHOLE = 0.9;
const HANDOVER_HEAL_CELLS = 5;

/**
 * Dense per-object movement, read from the 0x5781 records.
 *
 * This is the stream the viewer wants. The object records (0xb801 / 0x9801 /
 * 0x7781) report an object only when something about it is restated, which is
 * two or three times in a whole match for a harvester — not enough to drive
 * anything, which is why unit movement had to be modelled. 0x5781 carries a
 * position every frame the object exists, 12x to 86x more samples per replay,
 * so movement can come from the recording instead.
 *
 * Object identity and name come from the key, which 185 of 186 keys share with
 * the object records; the name is the one those records use most for that key.
 */
/**
 * Tracks, plus the pixel origin measured on the way: what has to be added to a
 * recorded pixel position to put it in world pixels. The players' inputs are
 * in the same recorded space and need it too (see readInputs).
 */
export type ObjectTracks = ObjectTrack[] & {
  origin?: { x: number; y: number };
  /** Every building's frames over its life, by its records (with `paths`). */
  structureFrames?: StructureFrames[];
};

/** One building's life: what and whose it was, its centre cell, and every frame it was drawn with. */
export interface StructureFrames {
  key: number;
  name: string;
  owner: number;
  cellX: number;
  cellY: number;
  shapes: { t: number; v: number }[];
  /**
   * When the next object took this building's key, in ms: the building was
   * gone -- destroyed or sold -- by then. Absent while it held the key to the
   * end of the recording.
   */
  until?: number;
  /** Its first record, in ms: when it went up, or when the recording first named it. */
  firstRecord: number;
  /** Its last record, in ms. */
  lastRecord: number;
}

export async function readObjectTracks(bytes: Uint8Array, opts: { paths?: boolean } = {}): Promise<ObjectTracks> {
  const frames = await readFrames(bytes);
  const idByKey = new Map<number, { names: Map<string, number>; owners: Map<number, number>; ownerAt: { t: number; owner: number; name: string; cell?: { x: number; y: number } | null }[] }>();
  const samplesByKey = new Map<number, { t: number; cellX: number; cellY: number; selected: boolean; px?: number; py?: number; pt?: number; alt?: number; hp?: number; shape?: number; group?: number }[]>();
  const pixelsByKey = new Map<number, { t: number; px: number; py: number }[]>();
  const lastPosByKey = new Map<number, { x: number; y: number }>();   // (a coordinate is sent only when it changes)
  const shapeByKey = new Map<number, { t: number; v: number }[]>();
  const altByKey = new Map<number, { t: number; v: number }[]>();
  const probes: (SelectionProbe & { sample: { selected: boolean } })[] = [];

  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === KEYFRAME_BASE) continue;
    for (const s of readDeltaSections(f.payload)) {
      const shift = objectRecordShift(s.type);
      if (shift >= 0) {
        for (const ob of parseObjects(sectionBytes(f.payload, s.at + shift, s.bits - shift))) {
          const e = idByKey.get(s.key) ?? { names: new Map<string, number>(), owners: new Map<number, number>(), ownerAt: [] as { t: number; owner: number; name: string }[] };
          e.names.set(ob.name, (e.names.get(ob.name) ?? 0) + 1);
          e.owners.set(ob.owner, (e.owners.get(ob.owner) ?? 0) + 1);
          e.ownerAt.push({ t: f.t, owner: ob.owner, name: ob.name, ...(opts.paths && ob.dllType === 4 ? { cell: decodeStructureCell(ob.name, ob.body) } : {}) });
          idByKey.set(s.key, e);
        }
      } else if (s.type === DELTA_RECORD) {
        // Each field is collected on its own. A record is a *delta*: it carries
        // only what changed, so one that reports a new sprite frame without
        // moving has no position pair. Requiring a position before reading
        // anything threw those away and left shape and altitude on 18% of
        // samples — which is why the turret pairing and the unit death rule
        // were both starved of data.
        const mask = readBitsLE(f.payload, s.at + 40, 8);
        // A field is sent only when it changed: a unit moving along one axis
        // sends that coordinate alone, and the other is the one it last sent.
        // Taking positions only from records carrying both dropped 46.5% of
        // all position changes (x alone 192,718, y alone 108,850, both
        // 346,768 in one match) -- the "samples every 11 to 40 frames" that
        // made units glide and jump. With the last value carried over, every
        // step the game drew is here, as it plays the replay itself.
        if (mask & 3) {
          const last = lastPosByKey.get(s.key);
          const rx = mask & 1 ? readBitsLE(f.payload, s.at + DELTA_POS_X_BIT, DELTA_POS_FIELD_BITS) : (last?.x ?? -1);
          const ry =
            mask & 2
              ? readBitsLE(f.payload, s.at + DELTA_POS_X_BIT + (mask & 1 ? DELTA_POS_FIELD_BITS : 0), DELTA_POS_FIELD_BITS)
              : (last?.y ?? -1);
          if (mask & 1 && rx >= 0) lastPosByKey.set(s.key, { x: rx, y: last?.y ?? -1 });
          if (mask & 2 && ry >= 0) lastPosByKey.set(s.key, { x: lastPosByKey.get(s.key)?.x ?? -1, y: ry });
          if (rx >= 0 && ry >= 0) {
            (pixelsByKey.get(s.key) ?? pixelsByKey.set(s.key, []).get(s.key)!).push({ t: f.t, px: rx, py: ry });
          }
        }
        const so = deltaFieldOffset(mask, 5);
        if (so >= 0 && so + 16 <= s.bits) {
          const v = readBitsLE(f.payload, s.at + so, 16);
          if (v >= 0) (shapeByKey.get(s.key) ?? shapeByKey.set(s.key, []).get(s.key)!).push({ t: f.t, v });
        }
        const ao = deltaFieldOffset(mask, 4);
        if (ao >= 0 && ao + 16 <= s.bits) {
          const v = readBitsLE(f.payload, s.at + ao, 16);
          if (v >= 0) (altByKey.get(s.key) ?? altByKey.set(s.key, []).get(s.key)!).push({ t: f.t, v });
        }
      } else if (s.type === TRACK_RECORD_TYPE) {
        const v = readBitsLE(f.payload, s.at + TRACK_POS_BIT, TRACK_POS_BITS);
        if (v < 0) continue;
        const cellX = v & 0x7f;
        const cellY = v >> 7;
        if (cellX > 63 || cellY > 63) continue;
        // Selection is filled in below, once the record layout has been probed
        // and every object has a name to test the candidate bits against.
        const hp =
          s.bits > TRACK_STRENGTH_BIT + 16
            ? readBitsLE(f.payload, s.at + TRACK_STRENGTH_BIT, 16)
            : undefined;
        // The control group the unit is in, 255 for none (see CONTROL_GROUP_BIT).
        const group = s.bits >= CONTROL_GROUP_BIT + 8 ? readBitsLE(f.payload, s.at + CONTROL_GROUP_BIT, 8) : undefined;
        const sample = {
          t: f.t, cellX, cellY, selected: false, hp: hp === undefined || hp > 5000 ? undefined : hp,
          ...(group !== undefined && group >= 0 ? { group } : {}),
        };
        (samplesByKey.get(s.key) ?? samplesByKey.set(s.key, []).get(s.key)!).push(sample);
        probes.push({ key: s.key, t: f.t, at: s.at, bits: s.bits, payload: f.payload, sample });
      }
    }
  }

  const nameOf = (key: number): string => {
    const names = idByKey.get(key)?.names;
    if (!names || !names.size) return "?";
    return [...names].sort((a, b) => b[1] - a[1])[0]![0];
  };
  // Who held each key, and when.
  //
  // The engine recycles object ids, so a key is not an object — it is a slot
  // that different objects occupy in turn. Every question about identity has
  // to be asked at a moment, not of the key as a whole.
  const runsByKey = new Map<number, { name: string; owner: number; from: number; prev: number }[]>();
  for (const [key, id] of idByKey) {
    // Animations count as tenures too.
    //
    // An explosion or a muzzle flash is an object and takes a key like any
    // other. Filtering them out as unowned left their samples with no
    // identity, so they were swept into whichever unit claimed the key next —
    // 21% of all samples predate their key's first *owned* record, and the
    // records sitting in that gap are FIRE3 and PIFF. Keeping them means
    // those samples stay with the animation instead of putting a phantom unit
    // wherever something blew up.
    const events = id.ownerAt.slice().sort((a, b) => a.t - b.t);
    const runs: { name: string; owner: number; from: number; prev: number }[] = [];
    let last = -1;
    for (const e of events) {
      const cur = runs[runs.length - 1];
      if (cur && cur.name === e.name && cur.owner === e.owner) { last = e.t; continue; }
      // `prev` is the last record of the tenure being replaced: the handover
      // happened somewhere in (prev, from], not at `from`.
      runs.push({ name: e.name, owner: e.owner, from: e.t, prev: last < 0 ? e.t : last });
      last = e.t;
    }
    runsByKey.set(key, runs);
  }

  // Put each handover where the position actually jumps.
  //
  // The object records only bracket it. They restate an object every few tens
  // of seconds while the movement stream samples it constantly, so dating a
  // handover at the first record carrying the new identity leaves a long tail
  // of samples still credited to the previous object — and therefore read
  // against the previous player's selection bit. Measured against the mask,
  // 51.0% of selections within 15s of a handover were the other player's,
  // versus 9.2% away from one.
  //
  // Inside the bracket the recording says where the handover is: one object
  // moves continuously, and the next object to take the key is somewhere
  // else. The largest step in the window is the changeover. That brings
  // near-handover cross-firing to 8.9%, level with the 11.6% seen on keys
  // that never change hands at all.
  //
  // The window runs a little past the new identity's first record, because
  // the new object's first position can come a frame or more after the record
  // announcing it. Stopping at the record missed the real jump: in match
  // 8077359 one house's MCV drove a cell, its key passed to the other house's
  // harvester across the map, and with the harvester's first sample just
  // outside the window the MCV's one-cell step was taken as the changeover --
  // a teal harvester rolling out beside a red MCV at 0:10.
  for (const [key, runs] of runsByKey) {
    if (runs.length < 2) continue;
    const cs = samplesByKey.get(key);
    if (!cs || cs.length < 2) continue;
    cs.sort((a, b) => a.t - b.t);
    for (let i = 1; i < runs.length; i++) {
      // Not before the previous object's own arrival, which may itself have
      // been placed a frame after its record, and not into the next object's.
      // In match 8059483 a Buggy's birth record and its first position were
      // 22ms apart; the Harvester that took the key next claimed that arrival
      // as its own, and the Buggy came off the airstrip as a Harvester.
      //
      // Nor just after the old identity's last record: a position that lands
      // a frame after a record is still the object that record named. In
      // match 8034219 a fresh Buggy came down on an airstrip a frame after a
      // record naming the Buggy before it, and the Harvester that took the
      // key 40s later claimed that landing as its own.
      const prev = runs[i]!.prev;
      const hi = runs[i]!.from;
      const lo = Math.max(prev + Math.min(HANDOVER_LATE_MS, (hi - prev) / 2), i > 1 ? runs[i - 1]!.from : -Infinity);
      if (!(hi > lo)) continue;
      const reach = Math.min(hi + HANDOVER_LATE_MS, runs[i + 1]?.from ?? Infinity);
      let bestT = hi;
      let bestD = -1;
      for (let j = 1; j < cs.length; j++) {
        const a = cs[j - 1]!;
        const b = cs[j]!;
        if (b.t <= lo || b.t > reach) continue;
        const d = Math.abs(b.cellX - a.cellX) + Math.abs(b.cellY - a.cellY);
        if (d > bestD) { bestD = d; bestT = b.t; }
      }
      if (bestD >= HANDOVER_JUMP_CELLS) runs[i]!.from = bestT;
    }
  }
  const tenureAt = (key: number, t: number): { name: string; owner: number } | undefined => {
    const runs = runsByKey.get(key);
    if (!runs || !runs.length) return undefined;
    let held = runs[0]!;
    for (const r of runs) { if (r.from > t) break; held = r; }
    return held;
  };
  const ownerOf = (key: number, t: number): number | undefined => tenureAt(key, t)?.owner;
  // Each house's selection bit is computed, not searched for.
  //
  // DLLInterface.h declares `unsigned int IsSelectedMask` — one bit per
  // house, since every player in a multiplayer game has their own selection.
  // The owner byte on the object records is always even and halves into 4..9,
  // which is exactly TD's HOUSE_MULTI1..HOUSE_MULTI6, so the mask is indexed
  // by house and each player's bit is `SELECT_MASK_BASE + owner / 2`.
  //
  // Checked against every house of eight replays, the predicted bit fires on
  // that house's own objects 66-93% of the time, and once the selectable set
  // was taken from the game's type tables rather than hand-written it fires
  // on selectable objects essentially always.
  //
  // Computing it rather than searching matters for the quiet player: a search
  // needs enough selections to recognise the field, so a player who rarely
  // selected anything used to end up with no selection decoded at all.
  const housesSeen = new Set<number>();
  for (const pr of probes) {
    const owner = ownerOf(pr.key, pr.t);
    if (owner !== undefined) housesSeen.add(owner);
  }
  const bitForOwner = new Map<number, number>();
  for (const owner of housesSeen) {
    const bit = SELECT_MASK_BASE + Math.floor(owner / 2);
    let set = 0;
    let named = 0;
    let onSelectable = 0;
    let onOwnHouse = 0;
    for (const pr of probes) {
      if (bit + 1 > pr.bits) continue;
      if (readBitsLE(pr.payload, pr.at + bit, 1) !== 1) continue;
      set++;
      const id = tenureAt(pr.key, pr.t);
      if (!id) continue;
      named++;
      if (COMMANDABLE.has(id.name)) onSelectable++;
      if (id.owner === owner) onOwnHouse++;
    }
    // The bit still has to behave: fire on things that can be selected, and
    // on this house's own objects rather than the opponent's.
    //
    // Judged over the hits that can be identified, not over all of them. Some
    // keys are never named by any object record, and counting those against
    // the bit is scoring it on our own gaps: three houses failed the purity
    // test at 94.5%, 92.4% and 84.1% purely on 58-216 unnamed hits each, and
    // every one of them reads 100.0% once the unnamed are set aside.
    if (set < SELECT_MASK_MIN_SETS || named === 0) continue;
    if (onSelectable / named < SELECT_MASK_UNIT_PURITY) continue;
    if (onOwnHouse / named < SELECT_MASK_OWN_HOUSE) continue;

    // And it has to be held, in time rather than in samples.
    //
    // Purity cannot tell selection from noise, because noise can be pure: a
    // bit that fires at random on this house's own units passes every test
    // above. What separates them is how long the flag stays up. A player
    // holds a selection for well over a second — 1.3 to 1.6s across the
    // houses that decode cleanly — while a bit that means something else
    // flickers on for exactly one sample and is gone by the next.
    //
    // One house read 2,890 selections of a median 176ms against a sampling
    // interval of 198ms, which is not a person clicking; the same replay's
    // other house read 1,584ms. Judged on purity alone the noise passed.
    const runs: number[] = [];
    // Flips by frame, for the grouping test.
    const flipsAt = new Map<number, number>();
    {
      const byKey = new Map<number, { t: number; on: boolean }[]>();
      for (const pr of probes) {
        if (bit + 1 > pr.bits) continue;
        const on = readBitsLE(pr.payload, pr.at + bit, 1) === 1;
        (byKey.get(pr.key) ?? byKey.set(pr.key, []).get(pr.key)!).push({ t: pr.t, on });
      }
      for (const [, list] of byKey) {
        list.sort((a, b) => a.t - b.t);
        for (let i = 1; i < list.length; i++) {
          if (list[i]!.on !== list[i - 1]!.on) flipsAt.set(list[i]!.t, (flipsAt.get(list[i]!.t) ?? 0) + 1);
        }
        let start = -1;
        for (const q of list) {
          if (q.on) { if (start < 0) start = q.t; }
          else if (start >= 0) { runs.push(q.t - start); start = -1; }
        }
      }
    }
    if (runs.length < SELECT_MASK_MIN_RUNS) continue;
    runs.sort((a, b) => a - b);
    let flips = 0;
    let grouped = 0;
    for (const n of flipsAt.values()) {
      flips += n;
      if (n > 1) grouped += n;
    }
    const held = runs[runs.length >> 1]! >= SELECT_MASK_MIN_HOLD_MS;
    if (!held && !(flips > 0 && grouped / flips >= SELECT_MASK_MIN_GROUPED)) continue;

    bitForOwner.set(owner, bit);
  }
  // A replay whose houses do not fit the computed layout falls back to
  // finding one bit by signature, which is what this did before the layout
  // was worked out.
  const selectionBit = bitForOwner.size ? [...bitForOwner.values()][0]! : findSelectionBit(probes, nameOf);
  if (selectionBit !== null) {
    for (const pr of probes) {
      // Asked at the probe's own moment: a key that served one player and
      // later the other would otherwise spend half its life reading the wrong
      // player's mask bit, which put brackets on the opponent's units.
      const owner = ownerOf(pr.key, pr.t);
      // An object is selected when its own owner's bit is set. A player can
      // click an enemy unit to inspect it, which sets that player's bit on an
      // object they do not own; showing that would put brackets on the other
      // side's units.
      // A house with no bit of its own reads nothing, rather than borrowing
      // another house's. Borrowing was silently reporting near-zero selection
      // for that player — 0.4% of samples against their opponent's 10.9% in
      // the same match — which reads as someone who never selected anything.
      // Absent data should look absent.
      const bit = owner !== undefined ? bitForOwner.get(owner) : selectionBit;
      if (bit === undefined || bit === null) continue;
      if (bit + 1 > pr.bits) continue;
      if (readBitsLE(pr.payload, pr.at + bit, 1) === 1) pr.sample.selected = true;
    }
  }

  // The recorded pixel origin is offset from the renderer's world space by a
  // constant. Rather than hard-code it, measure it here: every pixel sample is
  // paired with the cell reported for the same object at the same moment, and
  // the median difference is the origin. Self-calibrating, so it holds if the
  // map or the game's own origin ever differs.
  for (const [, a] of pixelsByKey) a.sort((x, y) => x.t - y.t);
  const CELL_PX = 24;
  const offX: number[] = [];
  const offY: number[] = [];
  for (const [key, ps] of pixelsByKey) {
    const cs = samplesByKey.get(key);
    if (!cs) continue;
    for (let i = 0; i < ps.length; i += 17) {
      const p = ps[i]!;
      let best: (typeof cs)[number] | undefined;
      let bd = Infinity;
      for (const c of cs) {
        const d = Math.abs(c.t - p.t);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best || bd > 200) continue;
      offX.push(best.cellX * CELL_PX + CELL_PX / 2 - p.px);
      offY.push(best.cellY * CELL_PX + CELL_PX / 2 - p.py);
    }
  }
  const median = (v: number[]) => (v.length ? v.slice().sort((a, b) => a - b)[v.length >> 1]! : 0);
  const originX = median(offX);
  const originY = median(offY);

  // Attach the nearest pixel reading to each sample.
  for (const [key, cs] of samplesByKey) {
    const ps = pixelsByKey.get(key);
    if (!ps || !ps.length) continue;
    for (const c of cs) {
      let lo = 0, hi = ps.length - 1, bi = -1, bd = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const d = ps[mid]!.t - c.t;
        if (Math.abs(d) < bd) { bd = Math.abs(d); bi = mid; }
        if (d < 0) lo = mid + 1; else hi = mid - 1;
      }
      if (bi < 0 || bd > 250) continue;
      const px = ps[bi]!.px + originX;
      const py = ps[bi]!.py + originY;
      // The two fields describe the same object at the same moment, so they
      // have to agree. When a key is recycled they need not: a reading up to
      // 250ms away can belong to the next object to use the key, and taking
      // it put a harvester somewhere it had never been. Cell is the field
      // that was verified exact, so it decides.
      if (Math.abs(px / CELL_PX - 0.5 - c.cellX) > PIXEL_CELL_AGREE_CELLS) continue;
      if (Math.abs(py / CELL_PX - 0.5 - c.cellY) > PIXEL_CELL_AGREE_CELLS) continue;
      c.px = px;
      c.py = py;
      // The reading's own time, not the sample's. A sample can be paired with
      // a reading up to 250ms away, so timing a leg by the sample clock while
      // measuring it by the pixel clock reports a speed neither one supports:
      // harvesters, whose readings are sparsest, came out at 3.7x the speed
      // the game's unit table allows while buggies read correctly.
      c.pt = ps[bi]!.t;
    }
  }

  // Shape and altitude are attached from their own series, so a sample keeps
  // them even when that frame carried no position.
  const nearestValue = (series: { t: number; v: number }[] | undefined, t: number): number | undefined => {
    if (!series || !series.length) return undefined;
    let lo = 0;
    let hi = series.length - 1;
    let bi = -1;
    let bd = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = series[mid]!.t - t;
      if (Math.abs(d) < bd) { bd = Math.abs(d); bi = mid; }
      if (d < 0) lo = mid + 1; else hi = mid - 1;
    }
    return bi >= 0 && bd <= 400 ? series[bi]!.v : undefined;
  };
  for (const [, a] of shapeByKey) a.sort((x, y) => x.t - y.t);
  for (const [, a] of altByKey) a.sort((x, y) => x.t - y.t);
  for (const [key, cs] of samplesByKey) {
    const sh = shapeByKey.get(key);
    const al = altByKey.get(key);
    if (!sh && !al) continue;
    for (const c of cs) {
      const v = nearestValue(sh, c.t);
      if (v !== undefined) c.shape = v;
      const a = nearestValue(al, c.t);
      if (a !== undefined) c.alt = a;
    }
  }

  // The full path of one tenure: the key's pixel readings over the tenure's
  // time, each checked against the cell the nearest movement sample put it
  // in, the same test that guards the readings the samples borrow.
  const pathFor = (key: number, run: { t: number; cellX: number; cellY: number }[]): ObjectTrack["path"] => {
    const ps = pixelsByKey.get(key);
    if (!ps || !ps.length || !run.length) return undefined;
    const from = run[0]!.t;
    const to = run[run.length - 1]!.t;
    let i = 0;
    let lo = 0;
    let hi = ps.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ps[mid]!.t < from) lo = mid + 1; else hi = mid; }
    const path: { t: number; px: number; py: number }[] = [];
    for (let k = lo; k < ps.length && ps[k]!.t <= to; k++) {
      const p = ps[k]!;
      while (i + 1 < run.length && Math.abs(run[i + 1]!.t - p.t) <= Math.abs(run[i]!.t - p.t)) i++;
      const c = run[i]!;
      const px = p.px + originX;
      const py = p.py + originY;
      if (Math.abs(px / CELL_PX - 0.5 - c.cellX) > PIXEL_CELL_AGREE_CELLS) continue;
      if (Math.abs(py / CELL_PX - 0.5 - c.cellY) > PIXEL_CELL_AGREE_CELLS) continue;
      path.push({ t: p.t, px, py });
    }
    return path.length ? path : undefined;
  };

  // Height over one tenure, where it changed; nothing for a ground object,
  // which reads 0 throughout.
  const altsFor = (key: number, run: { t: number }[]): ObjectTrack["alts"] => {
    const all = altByKey.get(key);
    if (!all || !all.length || !run.length) return undefined;
    const from = run[0]!.t;
    const to = run[run.length - 1]!.t;
    const out: { t: number; v: number }[] = [];
    for (const q of all) {
      if (q.t > to) break;
      if (q.t < from) continue;
      if (out.length && out[out.length - 1]!.v === q.v) continue;
      out.push({ t: q.t, v: q.v });
    }
    return out.some((q) => q.v > 0) ? out : undefined;
  };

  // The frames over one tenure, each kept only where it changed.
  const shapesFor = (key: number, run: { t: number }[]): ObjectTrack["shapes"] => {
    const all = shapeByKey.get(key);
    if (!all || !all.length || !run.length) return undefined;
    const from = run[0]!.t;
    const to = run[run.length - 1]!.t;
    const out: { t: number; v: number }[] = [];
    for (const q of all) {
      if (q.t > to) break;
      if (q.t < from) continue;
      if (out.length && out[out.length - 1]!.v === q.v) continue;
      out.push({ t: q.t, v: q.v });
    }
    return out.length ? out : undefined;
  };

  const top = <T,>(m: Map<T, number> | undefined): T | undefined =>
    m && m.size ? [...m].sort((a, b) => b[1] - a[1])[0]![0] : undefined;

  const out: ObjectTrack[] = [];
  for (const [key, samples] of samplesByKey) {
    const id = idByKey.get(key);
    const fallbackName = top(id?.names);
    const fallbackOwner = top(id?.owners);
    // A key the object records never named cannot be placed on the map with
    // any confidence about what it is, so it is left out rather than guessed.
    if (fallbackName === undefined || fallbackOwner === undefined) continue;
    samples.sort((a, b) => a.t - b.t);

    // Identity comes from the records, per tenure, not per key.
    //
    // The engine recycles object ids: 79 of 173 keys in the reference replay
    // report more than one owner over their life, and one key runs a house 10
    // MCV and then a house 8 harvester. Voting on the key gives every tenure
    // the identity of whichever object held it longest, which is how each
    // side's starting harvester ended up at the opposing spawn and how a
    // player's buggies came off the other player's airstrip.
    //
    // The movement stream only carries positions under the key; the object
    // records are what say who and what. So the samples are cut wherever the
    // records change identity, and each piece takes the identity in force
    // over it. A vehicle never changes house in TD, so a change of either
    // name or owner is a different object.
    const identityAt = (t: number) => tenureAt(key, t) ?? { name: fallbackName, owner: fallbackOwner };

    let seg = 0;
    for (const part of segmentTrack(samples)) {
      // Split the piece again wherever the identity in force changes.
      let run: typeof part = [];
      let runId: { name: string; owner: number } | undefined;
      const flush = () => {
        if (!run.length || !runId) return;
        const path = opts.paths ? pathFor(key, run) : undefined;
        const shapes = opts.paths ? shapesFor(key, run) : undefined;
        const alts = opts.paths ? altsFor(key, run) : undefined;
        out.push({ key, segment: seg++, name: runId.name, owner: runId.owner, samples: run, ...(path ? { path } : {}), ...(shapes ? { shapes } : {}), ...(alts ? { alts } : {}) });
        run = [];
      };
      for (const sample of part) {
        const here = identityAt(sample.t);
        if (runId && (here.name !== runId.name || here.owner !== runId.owner)) flush();
        runId = here;
        run.push(sample);
      }
      flush();
    }
  }
  // Every building's frames over its whole life, from its own records.
  //
  // Buildings go quiet in the movement records after a sample or two, and
  // some are never sampled there at all -- a match's first Power Plants and a
  // Hand of Nod had no track -- but each is restated in the object records,
  // which say what it is, whose, and where. A life runs from its first record
  // to the first record of anything else on the key.
  const structureFrames: StructureFrames[] = [];
  if (opts.paths) {
    for (const [key, id] of idByKey) {
      const recs = id.ownerAt.slice().sort((a, b) => a.t - b.t);
      const shapes = shapeByKey.get(key) ?? [];
      for (let i = 0; i < recs.length; ) {
        const r = recs[i]!;
        let cell = r.cell ?? null;
        let j = i + 1;
        while (j < recs.length && recs[j]!.name === r.name && recs[j]!.owner === r.owner) {
          const c = recs[j]!.cell;
          if (c && cell && (c.x !== cell.x || c.y !== cell.y)) break;
          cell ??= c ?? null;
          j++;
        }
        const to = j < recs.length ? recs[j]!.t : Infinity;
        if (cell && BLDG_OCCUPY[KIND_BY_ASSET[r.name] ?? ""]) {
          const life: { t: number; v: number }[] = [];
          for (const q of shapes) {
            if (q.t < r.t) continue;
            if (q.t >= to) break;
            if (life.length && life[life.length - 1]!.v === q.v) continue;
            life.push({ t: q.t, v: q.v });
          }
          structureFrames.push({ key, name: r.name, owner: r.owner, cellX: cell.x, cellY: cell.y, shapes: life, firstRecord: r.t, lastRecord: recs[j - 1]!.t, ...(j < recs.length ? { until: to } : {}) });
        }
        i = j;
      }
    }
  }
  if (opts.paths) splitRebirths(out, structureFrames);
  const sorted: ObjectTracks = out.sort((a, b) => (a.samples[0]?.t ?? 0) - (b.samples[0]?.t ?? 0));
  if (opts.paths) sorted.structureFrames = structureFrames;
  sorted.origin = { x: originX, y: originY };
  return sorted;
}

/** How far a full path must leap in one step to be two lives, in pixels. */
const REBIRTH_JUMP_PX = 72;
/** Health at most this share of the life's best reads as dying. */
const REBIRTH_LOW = 0.25;
/** Health at least this share of the life's best reads as whole. */
const REBIRTH_WHOLE = 0.9;
/** How far ahead of its first position a new life's first record can land, in ms. */
const REBIRTH_LEAD_MS = 100;
/** How near its factory, in cells, a new unit appears. */
const REBIRTH_FACTORY_CELLS = 3;
/** How near a carrier a passenger steps out, in pixels, and when, in ms. */
const REBIRTH_CARRIER_PX = 48;
const REBIRTH_CARRIER_MS = 1500;
const REBIRTH_INFANTRY = new Set(["E1", "E2", "E3", "E4", "E6"]);
const REBIRTH_FACTORIES: Record<string, readonly string[]> = {
  infantry: ["PYLE", "HAND"],
  vehicle: ["WEAP", "AFLD"],
  harvester: ["WEAP", "PROC"],
};
const REBIRTH_UNITS = new Set([
  ...REBIRTH_INFANTRY, "MCV", "HARV", "JEEP", "BGGY", "BIKE", "LTNK", "MTNK", "HTNK", "FTNK", "STNK", "ARTY", "MLRS", "MSAM", "APC",
]);

/**
 * Cut a unit's track where one life ended and the next began under the same
 * key, owner and type.
 *
 * Identity splits a key's tenures, and health and distance split some more,
 * but a Minigunner shot dead and the next one out of the same Barracks are
 * one track to both: same name, same house, often the same key. Played as one
 * the man walked through his death, vanished, and turned up at the Barracks
 * whole -- and the death was never counted: a match's score screen had about
 * thirty more losses per player than the recording had lives.
 *
 * The full path gives it away. It has a point every frame the unit moves, so
 * a leap of three cells in one step is the unit off the map and back. A
 * passenger does that too, so one stepping out beside its side's APC or
 * Chinook is left alone. Otherwise it is a new unit when it comes back whole
 * after being hurt, or whole beside a factory of its house. Measured over ten
 * ladder matches, 59 leaps land at a factory whole and 51 more come back whole
 * from low; 51 beside a carrier, unchanged, were rides.
 */
function splitRebirths(out: ObjectTrack[], lives: readonly StructureFrames[]): void {
  const carriers = out.filter((t) => (t.name === "APC" || t.name === "TRAN") && t.path?.length);
  const nearCarrier = (owner: number, t: number, px: number, py: number) =>
    carriers.some((c) => c.owner === owner && c.path!.some((q) => Math.abs(q.t - t) < REBIRTH_CARRIER_MS && Math.hypot(q.px - px, q.py - py) < REBIRTH_CARRIER_PX));
  const atFactory = (name: string, owner: number, t: number, px: number, py: number) => {
    const kinds = REBIRTH_FACTORIES[REBIRTH_INFANTRY.has(name) ? "infantry" : name === "HARV" ? "harvester" : "vehicle"]!;
    const cx = px / 24, cy = py / 24;
    return lives.some((b) => b.owner === owner && kinds.includes(b.name) && b.firstRecord <= t && (b.until ?? Infinity) >= t &&
      Math.abs(b.cellX - cx) <= REBIRTH_FACTORY_CELLS && Math.abs(b.cellY - cy) <= REBIRTH_FACTORY_CELLS);
  };
  const cut = <Q extends { t: number }>(list: Q[] | undefined, at: number, before: boolean): Q[] | undefined => {
    if (!list) return undefined;
    const part = list.filter((q) => (before ? q.t < at : q.t >= at));
    return part.length ? part : undefined;
  };
  for (let n = 0; n < out.length; n++) {
    const tr = out[n]!;
    if (!REBIRTH_UNITS.has(tr.name) || !tr.path || tr.path.length < 2) continue;
    const p = tr.path;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!, b = p[i]!;
      if (Math.hypot(b.px - a.px, b.py - a.py) < REBIRTH_JUMP_PX) continue;
      // The new life's first record lands a frame or two before its first
      // position, so the cut is a little ahead of the leap -- never before
      // the old life's last position.
      const at = Math.max(a.t + 1, b.t - REBIRTH_LEAD_MS);
      const before = tr.samples.filter((q) => q.t < at);
      const after = tr.samples.filter((q) => q.t >= at);
      if (!before.length || !after.length) continue;
      const hpBefore = [...before].reverse().find((q) => q.hp != null)?.hp;
      // Its first reading after: a unit is restated when its health changes,
      // so a new one may not read again for a while.
      const hpAfter = after.find((q) => q.hp != null)?.hp;
      if (hpAfter == null) continue;
      // Whole by the best either life read: a life seen only once it was
      // already hurt never read whole before the leap.
      const peak = Math.max(hpAfter, ...before.map((q) => q.hp ?? 0));
      if (peak <= 0) continue;
      if (nearCarrier(tr.owner, b.t, b.px, b.py)) continue;
      // Dead or dying before the leap and stronger after it: nothing heals
      // off the map, so that is the next unit -- often already shot by the
      // time it is restated, which happens only when its health changes.
      const dying = hpBefore != null && hpBefore <= peak * REBIRTH_LOW && hpAfter > hpBefore;
      const whole = hpAfter >= peak * REBIRTH_WHOLE;
      const wasHurt = hpBefore != null && hpBefore < peak * REBIRTH_WHOLE;
      if (!dying && !(whole && (wasHurt || (tr.name !== "HARV" && atFactory(tr.name, tr.owner, b.t, b.px, b.py))))) continue;
      const head: ObjectTrack = { ...tr, samples: before, path: p.slice(0, i) };
      const shapesA = cut(tr.shapes, at, true), altsA = cut(tr.alts, at, true);
      if (shapesA) head.shapes = shapesA; else delete head.shapes;
      if (altsA) head.alts = altsA; else delete head.alts;
      const tail: ObjectTrack = { ...tr, segment: tr.segment + 1, samples: after, path: p.slice(i) };
      const shapesB = cut(tr.shapes, at, false), altsB = cut(tr.alts, at, false);
      if (shapesB) tail.shapes = shapesB; else delete tail.shapes;
      if (altsB) tail.alts = altsB; else delete tail.alts;
      out[n] = head;
      out.push(tail);
      break; // the tail is checked again in its own turn
    }
  }
}


/** A player's credit balance at one instant. */
export interface CreditSample {
  /** Milliseconds into the match. */
  t: number;
  /** Production side, as {@link PRODUCTION_RECORD_TYPES} indexes it. */
  side: 0 | 1;
  /**
   * The money the player has, as the sidebar shows it: cash plus the
   * Tiberium in storage (HouseClass::Available_Money, HOUSE.CPP:1747).
   */
  credits: number;
  /** Cash alone. The starting 10000 lives here. */
  cash: number;
  /**
   * Harvested Tiberium in storage. A Harvester's unload lands here, and
   * spending draws on it before the cash (HouseClass::Spend_Money).
   */
  tiberium: number;
  /** Storage: 1000 a Refinery and 1500 a Silo. Tiberium past it is lost. */
  capacity: number;
}

/** A little-endian run of bits from a section's bytes, lowest bit first. */
function bitsAt(b: Uint8Array, at: number, n: number): number {
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 2 + (((b[(at + i) >> 3] ?? 0) >> ((at + i) & 7)) & 1);
  return v;
}

/**
 * Read each player's credit balance.
 *
 * Credits live in the sidebar records, the full-state dumps that follow a
 * 0x2403 marker and the ordinary ones alike. Each opens with a
 * row of 20-bit whole numbers: cash at bit 120, then the sidebar's counter
 * (140), stored Tiberium (160) and storage capacity (180). What the game
 * shows as the player's money is cash plus Tiberium.
 *
 * The cash was first read as 16.16 fixed point from bit 104. Its whole part
 * is the same number in all 870 dumps checked; the "fraction" was the low end
 * of the field before it. And cash alone is not the balance: a Harvester's
 * unload goes into Tiberium, so read that way the money never rose when one
 * docked.
 *
 * Four independent checks on the cash:
 *
 * * it opens at exactly **10000.00** in both series, the ladder's starting
 *   balance, arrived at without being looked for
 * * it **drains at the construction billing rate**: over intervals where
 *   exactly one item was building, observed drop against that item's
 *   cost-per-second runs at a median ratio of **1.05** and **1.22**
 * * it sits pinned at 0 for a player who has spent everything, then spikes
 * * those spikes land on exact TD half-cost refunds — 2500 (Construction
 *   Yard or MCV), 300 (Gun Turret), 150 (Power Plant or Hand of Nod)
 *
 * An earlier pass concluded credits were absent from the file. That search
 * only ever looked at the ordinary sidebar records; the full dumps had not
 * been framed yet.
 */
export async function readCredits(bytes: Uint8Array): Promise<CreditSample[]> {
  const frames = await readFrames(bytes);
  // The same two types production uses, discovered the same way, so a credit
  // sample's side means the same thing as a build order's. Hardcoding the
  // pair here failed on exactly the replays production failed on.
  await warmSidebarSections(frames);
  const sideByType = productionSideByType(frames);
  const out: CreditSample[] = [];
  for (const f of frames) {
    await breathe();
    if (payloadLayout(f.payload).base === KEYFRAME_BASE) continue;
    for (const s of readDeltaSections(f.payload)) {
      const side = sideByType.get(((s.type & 0xff) << 8) | (s.type >> 8));
      if (side === undefined) continue;
      // Every sidebar record opens with the balance, not only the full dumps:
      // one replay has 213 dumps a side and 36,282 ordinary records, near
      // enough one a game frame. They were skipped on a belief that an
      // ordinary record was too short to reach it; at 700-2800 bits, all of
      // them do. Reading them all is what lets the counter move the moment a
      // Harvester unloads rather than up to 1.6 seconds later.
      if (s.bits < 200) continue;
      const b = sectionBytes(f.payload, s.at, s.bits);
      // Tiberium and capacity were found against the rules rather than
      // guessed: capacity reads 1000 a Refinery and 1500 a Silo, and Tiberium
      // never once exceeds it, over 870 dumps in four replays (_tibcheck.ts).
      if (b.length < 25) continue;
      const cash = bitsAt(b, 120, 20);
      const tiberium = bitsAt(b, 160, 20);
      const capacity = bitsAt(b, 180, 20);
      // A record laid out some other way reads as nonsense here; the storage
      // rule throws it out.
      if (capacity % 500 !== 0 || tiberium > capacity) continue;
      out.push({ t: f.t, side, credits: cash + tiberium, cash, tiberium, capacity });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Refunds, which is what a sale looks like from the outside.
 *
 * TD pays back half the build cost, so a rise in the balance that lands on an
 * exact half-cost is a building being sold. Harvester income cannot be
 * confused with it: a full load is 700, which is not half of anything
 * buildable.
 *
 * Reported with the candidates rather than a single answer, because several
 * buildings share a cost — 2500 is both a Construction Yard and an MCV, 150 is
 * a Power Plant or a Hand of Nod.
 */
export function findRefunds(
  samples: CreditSample[],
): { t: number; side: 0 | 1; amount: number; candidates: string[] }[] {
  const HALF_COST: Record<string, number> = {
    FACT: 2500, MCV: 2500, PROC: 1000, AFLD: 1000, HPAD: 750, SAM: 375,
    HQ: 400, GUN: 300, NUKE: 150, HAND: 150, SILO: 75, CYCL: 37, BRIK: 50, SBAG: 25,
  };
  const out: { t: number; side: 0 | 1; amount: number; candidates: string[] }[] = [];
  for (const side of [0, 1] as const) {
    const mine = samples.filter((s) => s.side === side);
    for (let i = 1; i < mine.length; i++) {
      const rise = mine[i]!.credits - mine[i - 1]!.credits;
      if (rise < 20) continue;
      const amount = Math.round(rise);
      const candidates = Object.entries(HALF_COST)
        .filter(([, half]) => Math.abs(half - amount) <= 1)
        .map(([name]) => name);
      if (!candidates.length) continue;
      out.push({ t: mine[i]!.t, side, amount, candidates });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface ProductionRun {
  /** 0 or 1 — which of the two production record types this came from. */
  side: 0 | 1;
  name: string;
  cost: number;
  /** Milliseconds from match start when production began. */
  start: number;
  /** Milliseconds when it finished (or was last seen building). */
  end: number;
  /** Peak progress reached, 0..1023. Near 1023 means it completed. */
  peak: number;
  samples: number;
  /**
   * Whether the item finished. False means the player cancelled it: the run
   * stopped without the completion marker the stream emits on finishing.
   */
  completed: boolean;
}

/**
 * Per-player production, read from the two production record types.
 *
 * This is the real build order: which side, which item, and when production
 * actually began — not inferred from when a finished building was first
 * noticed on the map. Verified against a player's own recollection of a match,
 * including counts they were sure of ("4 minigunners"): the decode returns
 * power plant 0:05, Hand of Nod 0:11, refinery 0:16, exactly four E1 at
 * 0:17/0:19/0:21/0:24, then flamethrowers, second refinery, second power
 * plant, third refinery, airstrip at 1:01.
 */
/**
 * The two section types carrying this replay's sidebar, one per player.
 *
 * These are not fixed. Every replay uses exactly two, and which two varies:
 * 0x0138+0x01b8, 0x01f8+0x0138, 0x01f8+0x01d8, 0x0198+0x01f8 have all been
 * seen, each file carrying none of the others. Hardcoding 0x01b8 and 0x0198
 * therefore decoded both players in some replays, one player in others and
 * neither in the rest — 17 of 35 sampled files produced no build order at
 * all, and where the unrecognised type was the GDI player's, that player's
 * buildings never appeared on the map.
 *
 * So the type is found by content instead. Every candidate is checked by
 * whether its bytes parse as sidebar entries, which is decisive: the two real
 * types yield thousands each and nothing else yields any.
 *
 * Sides are numbered by sorting the two types ascending, which is arbitrary
 * but stable — {@link mapSidesToOwners} resolves which player a side really
 * is by matching completions against the object records. It matters only that
 * every reader of this replay numbers them the same way, which is why credits
 * and production share this function.
 */
export function productionSideByType(frames: readonly { t: number; payload: Uint8Array }[]): Map<number, 0 | 1> {
  // Credits and production both ask, of the same frames; the scan is costly.
  const hit = sidesOf.get(frames);
  if (hit) return hit;
  const sides = findProductionSides(frames);
  sidesOf.set(frames, sides);
  return sides;
}

const sidesOf = new WeakMap<object, Map<number, 0 | 1>>();

/**
 * A frame's sidebar-shaped sections, each with the entries found at every one
 * of the eight bit alignments it might sit at.
 *
 * Both finding which types are the production sides and reading production
 * need exactly this, and it is the costly part of both, so it is worked out
 * once per frame.
 */
function sidebarSections(payload: Uint8Array): readonly { type: number; shifts: readonly SidebarSample[][] }[] {
  const hit = sidebarSectionsOf.get(payload);
  if (hit) return hit;
  const out: { type: number; shifts: SidebarSample[][] }[] = [];
  const { base, bits } = payloadLayout(payload);
  const secs = parseSections(payload, bits, base);
  for (const sec of secs ?? []) {
    const head = readSectionShifted(payload, base, sec, 0);
    if (head.length < 5) continue;
    // Big-endian on purpose: the type constants are written in the order the
    // bytes read on screen (0x81 0x37 -> 0x8137).
    const type = (head[3]! << 8) | head[4]!;
    // Cheap gate before the expensive parse. Every sidebar type seen so far
    // has 0x01 as its high byte, and this cuts 97% of sections — the object
    // stream alone is well over a million of them per replay.
    if (type >> 8 !== PRODUCTION_TYPE_HIGH_BYTE) continue;
    const shifts: SidebarSample[][] = [];
    for (let shift = 0; shift < 8; shift++) {
      shifts.push(parseSidebarEntries(shift === 0 ? head : readSectionShifted(payload, base, sec, shift)));
    }
    out.push({ type, shifts });
  }
  sidebarSectionsOf.set(payload, out);
  return out;
}

/**
 * Parse every frame's sidebar sections ahead of the synchronous search for the
 * production sides, a breath at a time. See breathe.
 */
async function warmSidebarSections(frames: readonly { payload: Uint8Array }[]): Promise<void> {
  for (const f of frames) {
    await breathe();
    sidebarSections(f.payload);
  }
}

const sidebarSectionsOf = new WeakMap<Uint8Array, readonly { type: number; shifts: readonly SidebarSample[][] }[]>();

function findProductionSides(frames: readonly { t: number; payload: Uint8Array }[]): Map<number, 0 | 1> {
  const entriesByType = new Map<number, number>();
  for (const f of frames) {
    for (const sec of sidebarSections(f.payload)) {
      let n = 0;
      for (const entries of sec.shifts) n += entries.length;
      if (n) entriesByType.set(sec.type, (entriesByType.get(sec.type) ?? 0) + n);
    }
  }
  const ranked = [...entriesByType]
    .filter(([, n]) => n >= PRODUCTION_MIN_ENTRIES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([type]) => type)
    .sort((a, b) => a - b);
  return new Map(ranked.map((type, i) => [type, i as 0 | 1]));
}
export async function readProduction(bytes: Uint8Array): Promise<ProductionRun[]> {
  const frames = await readFrames(bytes);
  await warmSidebarSections(frames);
  const sideByType = productionSideByType(frames);
  const samples: (ProductionRun & { pct: number })[] = [];
  /** Completion markers, matched onto runs once they are grouped. */
  const completions: { side: 0 | 1; name: string; t: number }[] = [];
  for (const f of frames) {
    await breathe();
    for (const sec of sidebarSections(f.payload)) {
      const side = sideByType.get(sec.type);
      if (side === undefined) continue;
      // Entries sit at arbitrary bit alignments; scan all eight and dedupe.
      const seen = new Set<string>();
      for (const entries of sec.shifts) {
        for (const e of entries) {
          if (e.state === SIDEBAR_COMPLETED) {
            completions.push({ side, name: e.name, t: f.t });
            continue;
          }
          if (e.state !== SIDEBAR_BUILDING) continue;
          const k = `${e.name}:${e.progress}`;
          if (seen.has(k)) continue;
          seen.add(k);
          samples.push({
            side,
            name: e.name,
            cost: e.cost,
            start: f.t,
            end: f.t,
            peak: e.progress,
            pct: e.progress,
            samples: 1,
            completed: false,
          });
        }
      }
    }
  }
  samples.sort((a, b) => a.start - b.start);
  // Group consecutive rising progress for one asset on one side into a run.
  const runs: (ProductionRun & { pct: number })[] = [];
  for (const s2 of samples) {
    const open = runs.filter((r) => r.side === s2.side && r.name === s2.name).pop();
    if (open && s2.start - open.end < 2500 && s2.pct >= open.pct - 60) {
      open.end = s2.start;
      open.pct = s2.pct;
      if (s2.pct > open.peak) open.peak = s2.pct;
      open.samples++;
    } else {
      runs.push({ ...s2 });
    }
  }
  /**
   * Progress runs 0..1013. The bar is set at 90%, not at the top, because the
   * scan samples rather than watches: plenty of runs are last seen at 984 or
   * 994 and then finish unobserved. Genuine abandonments are nowhere near —
   * they stop at 5%, 10%, 24%, 56%, 57%, 68%. There is a clear gap between
   * the two populations and the threshold sits in it.
   */
  const PROGRESS_COMPLETE = Math.round(1013 * 0.9);
  for (const r of runs) {
    // Two independent signals, because neither alone is sufficient. The
    // completion marker is definitive when present — all 137 in the sample
    // match land within 3s of a run ending, with no orphans — but the scan
    // does not catch every one, and several runs that plainly finished
    // (peaking at 1013 of 1013) carry no marker. Progress covers those.
    const marked = completions.some(
      (c) => c.side === r.side && c.name === r.name && Math.abs(c.t - r.end) < 3000,
    );
    r.completed = marked || r.peak >= PROGRESS_COMPLETE;
  }
  return runs
    .filter((r) => r.samples >= 3)
    .map(({ pct: _pct, ...r }) => r)
    .sort((a, b) => a.start - b.start);
}


/**
 * Map each production record side onto the house index used by object records.
 *
 * Production records identify a side by which of the two record types carried
 * them; object records identify one by an owner byte. Neither names the other.
 * They are joined by causality: when a build completes, that player's object
 * appears on the map shortly afterwards, so the owner whose matching structure
 * shows up soonest after each completed run wins the vote.
 */
export function mapSidesToOwners(
  runs: ProductionRun[],
  objects: { owner: number; name: string; t: number }[],
  /**
   * Which slot each owner plays in, if something already knows.
   *
   * Only consulted when the votes cannot separate two pairings. That happens:
   * one replay here votes 0:8=5 0:18=1 1:8=5 1:18=1, which scores six either
   * way round, and picking by owner number is a coin toss that decides which
   * player owns every building on the map.
   */
  slotOf?: ReadonlyMap<number, 0 | 1>,
): Map<0 | 1, number> {
  const votes = new Map<string, number>();
  for (const r of runs) {
    if (r.peak < 900) continue; // only completed builds imply a new object
    let best: { owner: number; dt: number } | null = null;
    for (const o of objects) {
      if (o.name !== r.name) continue;
      const dt = o.t - r.end;
      if (dt < -2000 || dt > 60000) continue;
      if (!best || dt < best.dt) best = { owner: o.owner, dt };
    }
    if (!best) continue;
    const k = `${r.side}:${best.owner}`;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  // The two sides are two different players, so the pairing is chosen as a
  // pair rather than a side at a time.
  //
  // Taking each side's own best vote independently lets both land on the same
  // owner, and then one player's entire build list is filed under the other
  // and none of their structures is ever placed. It happens because the votes
  // are noisy: a finished build is matched to the nearest object of that name
  // within a minute, and in a mirror match both players build the same things
  // at similar times, so a fair number of votes go to the wrong house. Of the
  // replays to hand it broke two — one voting 0:16=6 0:18=4 1:16=4 1:18=3,
  // where the greedy pick sends both sides to 16, and one voting 0:14=6
  // 1:14=27 1:12=1, where both go to 14.
  //
  // Scoring whole pairings and refusing to use one owner twice fixes both and
  // leaves every healthy replay on the answer it already had.
  const out = new Map<0 | 1, number>();
  const owners = [...new Set([...votes.keys()].map((k) => Number(k.split(":")[1])))].sort(
    (a, b) => a - b,
  );
  const score = (side: 0 | 1, owner: number): number => votes.get(`${side}:${owner}`) ?? 0;
  // A pairing the hint agrees with beats one it does not, but only as a
  // tie-break: the votes decide first, and the hint speaks when they cannot.
  const agrees = (a: number, b: number): number =>
    slotOf === undefined ? 0 : (slotOf.get(a) === 0 ? 1 : 0) + (slotOf.get(b) === 1 ? 1 : 0);
  let best: { a: number; b: number; total: number; agree: number } | null = null;
  for (const a of owners) {
    for (const b of owners) {
      if (a === b) continue;
      const total = score(0, a) + score(1, b);
      const agree = agrees(a, b);
      if (!best || total > best.total || (total === best.total && agree > best.agree)) {
        best = { a, b, total, agree };
      }
    }
  }
  if (best) {
    out.set(0, best.a);
    out.set(1, best.b);
    return out;
  }
  // Only one house was ever voted for — nothing to pair, so the side that
  // voted keeps it and the other stays unmapped.
  for (const side of [0, 1] as const) {
    let bestOwner: number | null = null;
    let bestN = 0;
    for (const owner of owners) {
      const n = score(side, owner);
      if (n > bestN) { bestN = n; bestOwner = owner; }
    }
    if (bestOwner !== null) out.set(side, bestOwner);
  }
  return out;
}

/**
 * The build order, with production timing and map placement joined.
 *
 * Timing comes from the production records — the moment the item actually
 * entered the queue — and position and ownership from the object records.
 * This supersedes the older path that inferred a build time from when a
 * finished structure was first *noticed*, which ran tens of seconds late.
 */
export async function readBuildOrdersFromProduction(
  bytes: Uint8Array,
  /**
   * Works out which slot each owner plays in, from the owner-keyed orders the
   * object records give. Used only to settle a tied side-to-owner pairing.
   */
  slotHint?: (orders: ReplayBuildOrders) => ReadonlyMap<number, 0 | 1>,
): Promise<
  ReplayBuildOrders & {
    runs: ProductionRun[];
    sideToOwner: Map<0 | 1, number>;
    /** Every delta sighting, so callers can follow an object over time. */
    deltaObjects: DeltaSighting[];
  }
> {
  const [runs, orders, deltas] = await Promise.all([
    readProduction(bytes),
    readBuildOrders(bytes),
    readDeltaObjects(bytes),
  ]);
  // Fold the delta sightings into each owner's candidate pool. A keyframe
  // sighting says "this stood here at the next 20.8s boundary"; a delta
  // sighting says "this stood here now". Where both see the same structure the
  // delta is earlier by construction, so the earliest sighting per cell wins.
  const fromDeltas = new Map<string, BuildEvent>();
  for (const d of deltas) {
    if (d.dllType !== DLL_BUILDING) continue;
    const cx = Math.round(d.cellX);
    const cy = Math.round(d.cellY);
    const key = d.owner + ":" + d.name + ":" + cx + "," + cy;
    const prev = fromDeltas.get(key);
    if (prev && prev.placedAt <= d.t) continue;
    fromDeltas.set(key, {
      owner: d.owner,
      name: d.name,
      typeIndex: null,
      queuedAt: null,
      completedAt: null,
      placedAt: d.t,
      placedAtIsUpperBound: false,
      cellX: cx,
      cellY: cy,
      cost: 0,
    });
  }
  for (const e of fromDeltas.values()) {
    const list = orders.byOwner.get(e.owner) ?? [];
    // Replace a keyframe sighting of the very same structure, rather than
    // adding a duplicate the pairing could claim twice.
    const same = list.findIndex(
      (o) => o.name === e.name && o.cellX === e.cellX && o.cellY === e.cellY,
    );
    if (same >= 0) {
      if (list[same]!.placedAt > e.placedAt) list[same] = { ...list[same]!, placedAt: e.placedAt };
    } else {
      list.push(e);
    }
    orders.byOwner.set(e.owner, list);
  }
  for (const list of orders.byOwner.values()) list.sort((a, b) => a.placedAt - b.placedAt);
  const objs: { owner: number; name: string; t: number }[] = [];
  for (const [owner, list] of orders.byOwner)
    for (const e of list) objs.push({ owner, name: e.name, t: e.placedAt });
  const sideToOwner = mapSidesToOwners(runs, objs, slotHint?.(orders));

  const byOwner = new Map<number, BuildEvent[]>();
  const claimed = new Set<BuildEvent>();
  /**
   * Ground each owner's already-paired buildings stand on.
   *
   * A cell holds one building — Legal_Placement says so — and that is the last
   * thing separating a sighting that belongs to this run from one that belongs
   * to a different building of the same type. Ten pairings measured put a
   * structure on cells another of that player's was still standing on, with
   * the recording showing the older one alive: one a Refinery reading full
   * health thirty-eight seconds after another was said to have gone up on it.
   *
   * It only breaks ties, and deliberately so. A building really can be put up
   * on ground a destroyed one used to hold, and there the occupied sighting is
   * the true one with nothing to prefer over it — so a clash is a reason to
   * pick a different candidate, never a reason to pick none.
   */
  const held = new Map<number, Set<string>>();
  /**
   * How far either side of a completion a sighting may still be that building.
   *
   * Sightings land a beat after the building appears — across this match the
   * gap runs 1.9 to 5.9 seconds — so the window is not tight, but it is a
   * window: it has to be wide enough to catch the sighting that belongs here
   * and narrow enough to leave the next building's alone.
   */
  const SIGHTING_SLACK_MS = 2000;
  // Each base starts as just its Construction Yard, and grows as runs are
  // matched to cells. See the pairing note below for why that is tracked.
  const baseCells = new Map<number, { x: number; y: number }[]>();
  for (const [owner, list] of orders.byOwner) {
    const fact = list.find((e) => e.name === "FACT" && e.cellX !== null && e.cellY !== null);
    if (fact) baseCells.set(owner, [{ x: fact.cellX!, y: fact.cellY! }]);
  }
  // When the *next* one of these an owner builds finishes.
  //
  // A sighting later than that belongs to the later building, not this one.
  // Without the bound a run can reach arbitrarily far forward for a cell that
  // happens to sit nearer the base: in match 7983909 Scorpion1's second
  // Refinery finished at 47476 and was given a sighting from 448470 — seven
  // minutes of base-building later — which put it two cells from his first,
  // overlapping it, when every other Refinery in that game is three apart.
  const nextEnd = new Map<ProductionRun, number>();
  {
    const byKey = new Map<string, ProductionRun[]>();
    for (const r of runs) {
      if (!r.completed) continue;
      const owner = sideToOwner.get(r.side);
      if (owner === undefined) continue;
      const key = `${owner}:${r.name}`;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.end - b.end);
      for (let i = 0; i < list.length; i++) {
        nextEnd.set(list[i]!, list[i + 1]?.end ?? Number.POSITIVE_INFINITY);
      }
    }
  }
  /**
   * Which sighting belongs to which run, decided across the whole match.
   *
   * Structures of one type finish in order and are sighted in order, so a run
   * and its sighting cannot cross: if one finished before another, its
   * sighting came first too. That makes this a sequence alignment, and the
   * cheapest alignment is the one to take rather than whatever the first run
   * happens to grab.
   *
   * Pairing one run at a time is what made that matter. A run took the
   * candidate nearest its base, and the run after it was left with whatever
   * remained -- sometimes a sighting half a minute late, because the earlier
   * run had claimed the one that arrived on time.
   */
  const assigned = new Map<ProductionRun, BuildEvent>();
  {
    /** Leaving a run with no sighting, in the same units as lag. */
    const SKIP_RUN_MS = 120_000;
    const byGroup = new Map<string, { runs: ProductionRun[]; events: BuildEvent[] }>();
    for (const r of runs) {
      if (!r.completed) continue;
      const owner = sideToOwner.get(r.side);
      if (owner === undefined) continue;
      const key = owner + ":" + r.name;
      const g = byGroup.get(key) ?? { runs: [], events: [] };
      g.runs.push(r);
      byGroup.set(key, g);
    }
    for (const [owner, list] of orders.byOwner) {
      for (const e of list) {
        const g = byGroup.get(owner + ":" + e.name);
        if (g) g.events.push(e);
      }
    }
    for (const g of byGroup.values()) {
      g.runs.sort((a, b) => a.end - b.end);
      g.events.sort((a, b) => a.placedAt - b.placedAt);
      const n = g.runs.length;
      const m = g.events.length;
      // best[i][j] is the least cost of placing runs i.. among sightings j..
      const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
      const move: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) best[i]![m] = best[i + 1]![m]! + SKIP_RUN_MS;
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          // 0 leaves the sighting -- it may belong to a structure this pairing
          // cannot see, one built before the recording or captured.
          let cost = best[i]![j + 1]!;
          let step = 0;
          const skip = SKIP_RUN_MS + best[i + 1]![j]!;
          if (skip < cost) {
            cost = skip;
            step = 1;
          }
          const lag = g.events[j]!.placedAt - g.runs[i]!.end;
          if (lag >= -SIGHTING_SLACK_MS) {
            const take = Math.abs(lag) + best[i + 1]![j + 1]!;
            if (take < cost) {
              cost = take;
              step = 2;
            }
          }
          best[i]![j] = cost;
          move[i]![j] = step;
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        const step = move[i]![j];
        if (step === 2) {
          assigned.set(g.runs[i]!, g.events[j]!);
          i++;
          j++;
        } else if (step === 1) i++;
        else j++;
      }
    }
  }
  // Runs are paired oldest-first, because each pairing constrains the next.
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    const owner = sideToOwner.get(r.side);
    if (owner === undefined) continue;
    // A cancelled item was never built, so it must not claim a cell or appear
    // in the build order. This is where several of the "no cell" entries came
    // from: a run with no structure to pair with, because the player stopped
    // paying for it.
    if (!r.completed) continue;
    // Which structure of this type the run is, and so which sighting, was
    // settled by the alignment above.
    //
    // Choosing one run at a time is what this replaces. Sightings are sparse
    // and arrive in no dependable order, so picking by earliest handed a
    // player's first Refinery the cell of a late expansion half the map away.
    // Picking by nearest to the base fixed that and cost something else: a
    // run took the candidate beside it and left the run after it a sighting
    // half a minute late, because the one that arrived on time was gone.
    const anchors = baseCells.get(owner) ?? [];
    const taken = held.get(owner) ?? new Set<string>();
    const cellsOf = (e: BuildEvent): string[] =>
      e.cellX === null || e.cellY === null ? [] : occupiedCells(e.name, e.cellX, e.cellY);
    // The alignment above has already said which sighting is this run's, so
    // the search here is gone. What is kept is the upper bound: a sighting
    // later than the next of its type belongs to that one, whatever the
    // alignment made of it.
    const chosen = assigned.get(r) ?? null;
    const match =
      chosen !== undefined &&
      chosen !== null &&
      !claimed.has(chosen) &&
      chosen.placedAt <= (nextEnd.get(r) ?? Number.POSITIVE_INFINITY) + SIGHTING_SLACK_MS
        ? chosen
        : null;
    if (match) {
      claimed.add(match);
      for (const c of cellsOf(match)) taken.add(c);
      held.set(owner, taken);
      if (match.cellX !== null && match.cellY !== null) {
        anchors.push({ x: match.cellX, y: match.cellY });
        baseCells.set(owner, anchors);
      }
    }
    const list = byOwner.get(owner) ?? [];
    list.push({
      owner,
      name: r.name,
      typeIndex: null,
      queuedAt: r.start,
      completedAt: r.end,
      placedAt: match?.placedAt ?? r.end,
      placedAtIsUpperBound: match === null,
      cellX: match?.cellX ?? null,
      cellY: match?.cellY ?? null,
      cost: r.cost,
    });
    byOwner.set(owner, list);
  }
  // A Construction Yard is never produced — it is an MCV unpacking — so it
  // never appears in the production records. Carry it across from the object
  // records, which do see it, or the reconstruction has no base to build from.
  //
  // Its own sighting is useless as a time: the yard sits in the base all match
  // and is typically first reported minutes late (219s and 379s in the sample
  // replay, for yards that existed from the opening). What does pin it down is
  // that nothing can be produced without one, so the owner's first production
  // start is an upper bound on the deploy — and a tight one, since the first
  // power plant goes into the queue as soon as the yard is down. That also
  // reads a moved MCV correctly: a player who drives before unpacking simply
  // starts producing later, and the deploy follows.
  for (const [owner, list] of orders.byOwner) {
    for (const e of list) {
      if (e.name !== "FACT") continue;
      const produced = byOwner.get(owner) ?? [];
      const firstQueued = produced.reduce(
        (min, p) => Math.min(min, p.queuedAt ?? p.placedAt),
        Number.POSITIVE_INFINITY,
      );
      produced.push({ ...e, queuedAt: Number.isFinite(firstQueued) ? firstQueued : 0 });
      byOwner.set(owner, produced);
    }
  }

  // The yard is timed from the first production start, so it ties with the
  // first building queued; it has to sort ahead of it, being what made that
  // production possible.
  for (const list of byOwner.values())
    list.sort(
      (a, b) =>
        (a.queuedAt ?? 0) - (b.queuedAt ?? 0) ||
        (a.name === "FACT" ? -1 : 0) - (b.name === "FACT" ? -1 : 0),
    );
  // Fall back to the sighting-based orders if production yielded nothing, so a
  // replay that does not decode still produces something rather than nothing.
  if (byOwner.size === 0) return { ...orders, runs, sideToOwner, deltaObjects: deltas };
  return { ...orders, byOwner, runs, sideToOwner, deltaObjects: deltas };
}
