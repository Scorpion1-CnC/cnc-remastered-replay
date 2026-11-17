/**
 * Real C&C Remastered `.Replay` container — reverse engineered from live
 * samples fetched from replays.cnctdra.ea.com (no reference decoder existed;
 * this was derived by hypothesizing structure and checking it against real
 * bytes, then cross-validated against the cncstats API's own match records
 * for the exact same matches — mapName, both Steam IDs, and winner all
 * matched byte-for-byte across two independent samples of different
 * durations and maps).
 *
 * Confirmed container layout (offsets from file start):
 *   u32 sampleCount | u32 sampleCount (dup) | u32 table1ByteLength
 *   table1: sampleCount length-prefixed (u16 LE len + ASCII) strings —
 *     entries[0]="REPLAY_HEADER", entries[1]="JSON_HEADER" (section tags),
 *     the rest are ASCII decimal millisecond timestamps spanning the whole
 *     match, laid out in groups of ~101 samples at a flat 22ms step, with
 *     groups stored newest-first (each next group is ~2200ms earlier).
 *   table2: sampleCount x 20-byte binary records immediately after table1
 *     (index u32, two mid-range u32s, index-dup u32, checksum-looking u32) —
 *     a parallel per-sample network sync/desync table.
 *   Then zlib-framed chunks begin. The real match metadata (map name,
 *   duration, winner, player Steam IDs/factions/teams) lives in one of the
 *   first few chunks as a UTF-16LE JSON string `{"replayInfo":{...}}`,
 *   stored as a literal (uncompressed "stored" deflate block) rather than
 *   Huffman-coded — which is why it's byte-searchable directly in the raw
 *   file without needing a working deflate decoder for this part.
 *
 * This file reads the container and the match header. The frames that
 * follow (the game state, frame by frame) are decoded in object-stream.ts;
 * docs/RESEARCH-LOG.md tells how each part was worked out.
 */

import { inflateSyncFlush } from "./inflate";

/**
 * Match rules recorded in the replay's settings frame.
 *
 * These are the game's own field names, read verbatim out of the file —
 * not a reconstruction. Confirmed identical across independent ranked
 * matches, which is what a fixed ladder ruleset looks like.
 */
export interface RealMatchSettings {
  product_type?: string;
  /** Remastered game-speed index (ladder runs 5). */
  game_speed?: number;
  /** Tiberium ("ore") regrowth rate (ladder runs 3). */
  ore_regrows?: number;
  tech_level?: number;
  starting_units?: number;
  starting_credits?: number;
  bases?: boolean;
  crates?: boolean;
  shroud_regrows?: boolean;
  super_weapons?: boolean;
  production_queue?: boolean;
  redeploy_mcv?: boolean;
  capture_the_flag?: boolean;
  spawn_visceroids?: boolean;
  destroy_structures?: boolean;
  [key: string]: unknown;
}

export interface RealReplayPlayerInfo {
  name: string;
  ai: boolean;
  faction: string;
  team: 0 | 1;
}

export interface RealReplayInfo {
  matchName: string;
  mapName: string;
  winningTeam: 0 | 1;
  durationMilliseconds: number;
  playerList: RealReplayPlayerInfo[];
}

/** Byte offset (into `table1`) where the container's fixed 12-byte count header ends. */
export const CONTAINER_PREFIX_BYTES = 12;

/** Parallel per-sample sync record size in table2 (see file header comment). */
const SYNC_RECORD_BYTES = 20;

/**
 * Given just the leading bytes of a real `.Replay` file (must include at
 * least the first 12 bytes), computes how many total bytes need to be
 * fetched to reliably reach the real JSON header — used to do a cheap
 * two-stage ranged HTTP fetch instead of downloading the whole (often
 * 20-30MB) file just for metadata.
 */
export function computeHeaderFetchPlan(prefix: Uint8Array): { tableRegionEnd: number } | null {
  if (prefix.byteLength < 12) return null;
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const sampleCount = view.getUint32(0, true);
  const table1Bytes = view.getUint32(8, true);
  if (sampleCount <= 0 || sampleCount > 5_000_000 || table1Bytes <= 0 || table1Bytes > 50_000_000) return null;
  const tableRegionEnd = CONTAINER_PREFIX_BYTES + table1Bytes + sampleCount * SYNC_RECORD_BYTES;
  return { tableRegionEnd };
}

/**
 * Scans raw replay bytes for the UTF-16LE `{"replayInfo":...}` JSON blob and
 * parses it. `buf` should cover at least the region computed by
 * `computeHeaderFetchPlan` plus a generous margin (tens of KB) — the JSON
 * chunk sits shortly after the two per-sample tables, not exactly at their
 * boundary.
 */
export function extractReplayInfo(buf: Uint8Array): RealReplayInfo | null {
  const needle = utf16leBytes('{"replayInfo"');
  const start = indexOfBytes(buf, needle);
  if (start < 0) return null;

  const decoded = utf16leDecode(buf, start, Math.min(buf.byteLength, start + 8000));
  const jsonText = extractBalancedJson(decoded);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as { replayInfo?: RealReplayInfo };
    if (!parsed.replayInfo) return null;
    return parsed.replayInfo;
  } catch {
    return null;
  }
}

/**
 * Frame (chunk) container layout, confirmed on independent real replays.
 *
 * After the two per-sample tables the file is a tightly packed run of
 * `sampleCount` frames. The 20-byte records in the second table are the
 * frame directory: `{ u32 index, u32 byteLength, u32 fileOffset, … }`. The
 * offset chain is exact — `offset[i] + length[i] === offset[i+1]` held for
 * every record in both samples (19598/19598 and 9024/9024), and the final
 * frame ends precisely at EOF. That directory removes all guesswork about
 * where frames begin, which a scan for zlib magic bytes cannot do reliably
 * (compressed payloads contain those byte pairs by chance).
 *
 * Each frame is:
 *   'C' 'H' 0x02 0x01 | 0x11 0xFF 0xFF 0xFF | u32 hash | u32 flags
 *   u32 compressedLength | u32 ? | u32 ? | u32 0        (36-byte header)
 *   compressedLength bytes of zlib data
 *   a short uncompressed trailer
 *
 * The zlib payloads are **network-flushed and carry no end-of-stream
 * marker**, so a strict inflate (including the web `DecompressionStream`)
 * rejects all of them; they must be inflated with a sync-flush finish. With
 * that, 100% of frames decode — 19598/19598 and 9024/9024.
 *
 * The first frame is the lobby/settings frame and the second holds the
 * UTF-16LE `replayInfo` JSON; the rest are the per-frame game stream, whose
 * command encoding is still undecoded (see ASSETS.md).
 */
const CHUNK_HEADER_BYTES = 36;

function isChunkHeader(buf: Uint8Array, at: number): boolean {
  return buf[at] === 0x43 && buf[at + 1] === 0x48; // "CH"
}

/** Inflate a sync-flushed (unterminated) zlib payload. Server-only. */
/**
 * Read the match's rule settings out of its first frame.
 *
 * `buf` must start `sliceStart` bytes into the file and cover the frame
 * region; `chunkOffset` is the frame's absolute file offset, which equals
 * `computeHeaderFetchPlan().tableRegionEnd` — so the same ranged fetch that
 * already retrieves the JSON header covers this too, with no extra request.
 */
export async function extractMatchSettings(
  buf: Uint8Array,
  sliceStart: number,
  chunkOffset: number,
): Promise<RealMatchSettings | null> {
  const at = chunkOffset - sliceStart;
  if (at < 0 || at + CHUNK_HEADER_BYTES >= buf.byteLength) return null;
  if (!isChunkHeader(buf, at)) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const compressedLength = view.getUint32(at + 16, true);
  const start = at + CHUNK_HEADER_BYTES;
  if (compressedLength <= 0 || start + compressedLength > buf.byteLength) return null;

  const out = await inflateSyncFlush(buf.subarray(start, start + compressedLength));
  if (!out) return null;

  // The settings frame carries a plain ASCII JSON object among its fields.
  const text = new TextDecoder("latin1").decode(out);
  const open = text.indexOf('{"product_type"');
  if (open < 0) return null;
  const close = text.indexOf("}", open);
  if (close < 0) return null;
  try {
    return JSON.parse(text.slice(open, close + 1)) as RealMatchSettings;
  } catch {
    return null;
  }
}

function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

function utf16leDecode(buf: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i + 1 < end; i += 2) {
    const code = buf[i]! | (buf[i + 1]! << 8);
    out += String.fromCharCode(code);
  }
  return out;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function extractBalancedJson(text: string): string | null {
  if (text[0] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}
