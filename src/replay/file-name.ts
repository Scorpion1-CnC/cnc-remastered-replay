/**
 * What a saved replay's file name says about it.
 *
 * The game names each replay after the match it recorded, so the ladder's own
 * match id and the time it was played are sitting in the file name before a
 * single byte is read:
 *
 *   MOBIUS_TIBERIAN_DAWN_MULTIPLAYER_60_MAP.745903.7791351.1781570958.0.36.Replay
 *                                            ^product  ^match   ^unix time
 *
 * That matters because the file itself does not carry the players' names — its
 * header lists Steam ids — nor which end of the map each of them started on.
 * The ladder knows both, and the match id is the way to ask it.
 *
 * Browser-safe on purpose: the page that opens a replay from disk needs this,
 * and `local-replays.ts`, which does the same job over a directory, cannot go
 * in a browser because it reads the file system.
 */

export interface ReplayFileName {
  /** The ladder's id for the match, which `/matches/$id` also uses. */
  matchId: number;
  /** Seconds since epoch, as the game wrote it. */
  recordedAt: number;
  /** The leading slug, which names the map for the ladder's own maps. */
  slug: string;
}

const PATTERN = /^(.+?)_MAP\.\d+\.(\d+)\.(\d+)\./;

export function parseReplayFileName(file: string): ReplayFileName | null {
  const m = PATTERN.exec(file);
  if (!m) return null;
  const matchId = Number(m[2]);
  const recordedAt = Number(m[3]);
  if (!Number.isFinite(matchId) || !Number.isFinite(recordedAt)) return null;
  return {
    matchId,
    recordedAt,
    slug: m[1]!
      .replace(/^MOBIUS_TIBERIAN_DAWN_MULTIPLAYER_?/, "MULTIPLAYER_")
      .replace(/^MULTIPLAYER_(COMMUNITY_\d+)$/, "$1"),
  };
}
