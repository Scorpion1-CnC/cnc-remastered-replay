/**
 * A Remastered replay, summarised: npx tsx examples/summary.ts <file.Replay>
 *
 * The match header, each player's build order, how many units each side
 * fielded, and the score screen when the match reached one.
 */
import { readFileSync } from "node:fs";
import { extractReplayInfo } from "../src/replay/real-format";
import { readBuildOrdersFromProduction, readObjectTracks, readScoreboard } from "../src/replay/object-stream";
import { slotsByOwner } from "../src/replay/from-real";

const file = process.argv[2];
if (!file) throw new Error("usage: npx tsx examples/summary.ts <file.Replay>");
const raw = new Uint8Array(readFileSync(file));

const info = extractReplayInfo(raw);
if (!info) throw new Error("no replay header in that file");
const factions = [0, 1].map((i) => (String(info.playerList[i]?.faction) === "0" ? "GDI" : "NOD")) as [string, string];
console.log(`${info.mapName}, ${Math.round(info.durationMilliseconds / 1000)} s, ${info.playerList.map((p, i) => `${p.name} (${factions[i] ?? "?"})`).join(" vs ")}`);

// Which house in the object stream is which player: worked out from what
// each side built (and, in a mirror, from the spawn positions when known).
const orders = await readBuildOrdersFromProduction(raw, (o) => slotsByOwner(o, factions));
for (const [owner, builds] of orders.byOwner) {
  const list = builds.map((b) => `${b.name}@${b.queuedAt != null ? Math.round(b.queuedAt / 1000) + "s" : "?"}`).join(" ");
  console.log(`house ${owner} builds: ${list}`);
}

const tracks = await readObjectTracks(raw);
const units = new Map<number, Map<string, number>>();
for (const t of tracks) {
  const byName = units.get(t.owner) ?? units.set(t.owner, new Map()).get(t.owner)!;
  byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
}
for (const [owner, byName] of units) console.log(`house ${owner} objects: ${[...byName].map(([n, c]) => `${n} x${c}`).join(", ")}`);

const board = await readScoreboard(raw);
console.log(board?.totals ? `score screen: ${JSON.stringify(board.totals)}` : "no score screen in this replay");
