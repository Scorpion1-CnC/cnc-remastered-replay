/**
 * Where each building sits on the map, and how much of it.
 *
 * Kept apart from the sprite tables because the replay decoder needs it and
 * must not drag in anything that fetches or decodes art: this module knows
 * cells and nothing else.
 */
import type { BldgKind } from "./types";

export const BLDG_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  fact: [3, 2], proc: [3, 3], powr: [2, 2], apwr: [2, 2], pyle: [2, 2], hand: [2, 3],
  weap: [3, 3], afld: [4, 2], hq: [2, 2], hpad: [2, 2], fix: [3, 3], silo: [2, 1],
  gtwr: [1, 1], atwr: [1, 2], gun: [1, 1], obli: [1, 2], sam: [2, 1], tmpl: [3, 3],
  eye: [2, 2], hosp: [2, 2], bio: [2, 2], miss: [3, 2],
};

export function bldgCenterCell(kind: string): readonly [number, number] {
  const box = BLDG_SIZE[kind];
  if (!box) return [0, 0];
  // 0x80 per cell of half-width, with a whole cell written as 0xFF, so the
  // division lands a cell short wherever the box side is even and small.
  const lept = (side: number): number => (side === 4 ? 512 : side * 128 - (side % 2 === 0 ? 1 : 0));
  return [Math.floor(lept(box[0]) / 256), Math.floor(lept(box[1]) / 256)];
}

/**
 * The cells each building actually stands on, as offsets from its top-left.
 *
 * Not the same thing as its size. A building's SIZE is the box it is drawn
 * and placed within; its OCCUPYLIST is which cells inside that box are
 * foundation, and BDATA.CPP gives the two separately. A Refinery is three by
 * three and stands on four of those nine:
 *
 *     0 1 0
 *     1 1 1
 *     0 0 0
 *
 * The Barracks is two by two and stands on its top row only; the Power Plant,
 * Communications Centre and Advanced Communications Centre on three of their
 * four; a Guard Tower's whole box is one cell but an Advanced Guard Tower's
 * two-cell box holds only its lower one.
 *
 * Transcribed from BDATA.CPP's own lists, which store cell offsets rather
 * than a grid: List010111000 is `{1, MCW*1, MCW*1+1, MCW*1+2}` with MCW the
 * map width, so each entry decodes to a column and a row.
 */
export const BLDG_OCCUPY: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  fact: [[0,0], [1,0], [2,0], [0,1], [1,1], [2,1]],                   // FACT, List32
  proc: [[1,0], [0,1], [1,1], [2,1]],                                 // PROC, List010111000
  powr: [[0,0], [0,1], [1,1]],                                        // NUKE, List1011
  apwr: [[0,0], [0,1], [1,1]],                                        // NUK2, List1011
  pyle: [[0,0], [1,0]],                                               // PYLE, List22_1100
  hand: [[0,1], [1,1], [1,2]],                                        // HAND, ListHand
  weap: [[0,1], [1,1], [2,1], [0,2], [1,2], [2,2]],                   // WEAP, ListWeap
  afld: [[0,0], [1,0], [2,0], [3,0], [0,1], [1,1], [2,1], [3,1]],     // AFLD, List42
  hq: [[0,0], [0,1], [1,1]],                                          // HQ, ComList
  hpad: [[0,0], [1,0], [1,1], [0,1]],                                 // HPAD, List2
  fix: [[1,0], [0,1], [1,1], [2,1], [1,2]],                           // FIX, ListFix
  silo: [[0,0], [1,0]],                                               // SILO, StoreList
  gtwr: [[0,0]],                                                      // GTWR, List1
  atwr: [[0,1]],                                                      // ATWR, List12
  gun: [[0,0]],                                                       // GUN, List1
  obli: [[0,1]],                                                      // OBLI, List12
  sam: [[0,0], [1,0]],                                                // SAM, List21
  tmpl: [[0,1], [1,1], [2,1], [0,2], [1,2], [2,2]],                   // TMPL, ListTmpl
  eye: [[0,0], [0,1], [1,1]],                                         // EYE, ComList
  hosp: [[0,0], [1,0], [1,1], [0,1]],                                 // HOSP, List2
  bio: [[0,0], [1,0], [1,1], [0,1]],                                  // BIO, List2
  miss: [[0,0], [1,0], [2,0], [0,1], [1,1], [2,1]],                   // MISS, List32
};

/**
 * Whether a building stands on one cell of its own box.
 *
 * A kind with no list stands on all of it — that is the safe reading for
 * anything not in the table, since every building the game builds is.
 */
export function bldgOccupies(kind: string, dx: number, dy: number): boolean {
  const list = BLDG_OCCUPY[kind];
  if (!list) return true;
  return list.some(([x, y]) => x === dx && y === dy);
}

/**
 * The cell a harvester stops on to unload at a Refinery: the one south-west
 * of the building's centre.
 *
 * `Mission_Harvest` scatters whatever is squatting there the moment it begins
 * — `Map[Adjacent_Cell(Coord_Cell(Center_Coord()), DIR_SW)].Incoming(0, true)`
 * (BUILDING.CPP:4506) — which is the game naming the ground the harvester is
 * about to take. On a three-by-three Refinery that is the bottom-left cell.
 *
 * Measured over four matches, a loaded harvester that has come to rest on a
 * Refinery is on this cell 99.9% of the time.
 */
export function dockCellOf(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return { x: x + (w >> 1) - 1, y: y + (h >> 1) + 1 };
}

/**
 * The name the replay's object records use for a building, to the kind used
 * here. Lives beside the tables it is a key into, because both the decoder
 * and the command builder need it and neither may import the other.
 */
export const KIND_BY_ASSET: Readonly<Record<string, BldgKind>> = {
  FACT: "fact", NUKE: "powr", NUK2: "apwr", PROC: "proc", SILO: "silo",
  HAND: "hand", PYLE: "pyle", AFLD: "afld", WEAP: "weap", HPAD: "hpad",
  FIX: "fix", HQ: "hq", EYE: "eye", TMPL: "tmpl", GUN: "gun", OBLI: "obli",
  SAM: "sam", GTWR: "gtwr", ATWR: "atwr", BIO: "bio", HOSP: "hosp", MISS: "miss",
};

/**
 * The cells a building of this asset name would stand on, given the cell the
 * recording reports for it.
 *
 * The recorded cell is where the building is *drawn* from, so the top-left is
 * that cell less the centre's own offset, and the footprint is its OCCUPYLIST
 * from there. Returns an empty list for anything that is not a building.
 */
export function occupiedCells(asset: string, cellX: number, cellY: number): string[] {
  const kind = KIND_BY_ASSET[asset];
  if (!kind) return [];
  const [ox, oy] = bldgCenterCell(kind);
  const x = Math.round(cellX) - ox;
  const y = Math.round(cellY) - oy;
  return (BLDG_OCCUPY[kind] ?? [[0, 0]]).map(([dx, dy]) => `${x + dx},${y + dy}`);
}
