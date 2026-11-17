# Command & Conquer Remastered (Tiberian Dawn) replay decoder

How a Remastered `.Replay` file works, and TypeScript code that reads one: the match header, both players, every unit and building over the whole match, production and build orders, every click and key, the score screen, and the logic that turns all of it into a replay you can play back.

This is the decoder behind a fan-made replay viewer and ladder site for Tiberian Dawn, inspired by [cwal.gg](https://cwal.gg) for StarCraft. It is not affiliated with EA. No game data is included.

---

## The one thing to understand first

A StarCraft replay is a list of the players' commands. To watch it, the game runs the match again from those commands, and gets the same result because the simulation is deterministic.

A Remastered replay is not that. It is a **recording of the game state**. In the Remastered, the actual game is still the 1995 C&C code, running as a separate module (the TiberianDawn DLL, whose source EA released under the GPL). The new client with the HD graphics knows no game rules at all: every frame it asks the old engine what is on the map (`CNC_Get_Game_State`) and draws the answer. The replay is that answer, saved roughly every 22 ms and compressed.

So a `.Replay` holds, frame by frame, what the engine reported:
- every object on the map (type, owner, position, facing, health)
- each player's sidebar (what is being built, and how far along)
- every input each player sent (clicks, keys, control groups)
- and at the end, the score screen.

Nobody documented the format; everything here was worked out from real files, checked against recordings of the same matches and against the ladder's own records. `docs/RESEARCH-LOG.md` is the full journal of how.

Why EA did it this way is a guess (they never said), but it follows from the design: saving the stream the client already receives is almost free, and playback needs no game logic. Re-running commands would have needed the old engine to be bit-for-bit deterministic, and it is not: it draws random numbers in places that differ between runs, so a command replay drifts into a different match. (Trying it with the real engine confirms this.) It would also break every old replay at each balance patch. The cost is size: 10 to 120 MB per replay instead of a few KB.

---

## The file, layer by layer

### 1. Container (`src/replay/real-format.ts`)

All numbers little-endian.

```
u32 sampleCount
u32 sampleCount            (repeated)
u32 table1ByteLength
table1   sampleCount strings, each u16 length + ASCII:
           "REPLAY_HEADER", "JSON_HEADER", then one timestamp (ms) per frame
table2   sampleCount x 20-byte records (a per-frame sync table)
then     a frame directory and the frames themselves
```

The timestamps are a clue to a trap you meet next: they come in groups of about 101 at a flat 22 ms step, and the groups are stored **newest first**.

### 2. Frames (`readFrames` in `src/replay/object-stream.ts`)

The frame directory holds 20-byte records: frame number, length, offset, index. The field offsets are two bytes further in than they look (the tell for getting it wrong is a column of values like `65538 = (1<<16)|2`); read correctly, `offset[i] + length[i] == offset[i+1]` for every record, ending exactly at the end of the file.

Each frame is a chunk starting with `"CH"`, a 36-byte header (compressed length at +16), then zlib data. That data was written with a **sync flush** and never closed, so a strict inflater rejects it; `src/replay/inflate.ts` reads it in Node and in a browser.

- Frame 0 is the lobby/settings record, frame 1 the match header: a UTF-16LE JSON string `{"replayInfo":{...}}` with the map, length, winner and both players (Steam ids, factions, teams).
- Every other frame starts with its time (u32 ms at offset 0) and its kind (byte 8: 1 = keyframe, 0 = delta). **Sort them by that time** before anything else.
- Keyframes restate everything, about every 20.8 seconds; deltas carry what changed. The body starts at bit 21 (keyframes) or 17 (deltas), followed by its length in bits (`payloadLayout`).

### 3. Records: the engine's own structs

The frame bodies are the DLL's exported structs from `DLLInterface.h` in EA's GPL source, bit-packed. Two matter most, and they are told apart by how the name is written:

- **`CNCSidebarEntryStruct`** writes its asset name **once**. One per buildable per player: what it is, cost, power, a state (10 building, 8 listed, 0 done) and progress 0..1023, packed as `state << 10 | progress`. It has accurate timing but **no owner**.
- **`CNCObjectStruct`** writes its name **twice** (type name, then asset name). It is the object on the map, and the **only place the owner appears**, along with position, shape (facing) and strength.

Sidebar entries sit at **arbitrary bit alignments**, not on byte boundaries: scanning only byte-aligned positions found one building name in a whole match, scanning all eight bit shifts finds them all.

Owners are house numbers (10 and 12 in a typical ladder match); 254 is the neutral house the engine uses for effects (explosions, muzzle flashes, fire).

### 4. Inputs (`readInputs`, `inputSenders`)

Every input a player sent is in the stream, tagged with a sender. The codes follow the order of the DLL's handler functions: `0x1F` input (clicks), `0x2F` structure (sell/repair), `0x3F` unit (stop, guard, scatter...), `0x4F` sidebar (queue/place), `0x5F` super weapon, `0x6F` control group, and `0x9F` the client reporting its selection after a click. `inputSenders` works out which sender is which house.

### 5. Score screen (`readScoreboard`)

The last chunk holds the lobby settings and, when the match reached a score screen, the game's own totals: units and structures killed, credits gathered, score, winner, Steam ids. Not every replay has the totals: a match that ended by someone leaving carries only the settings.

---

## Traps worth knowing before you start

- **Frames are out of order** (newest-first groups). Sort by the frame's own time.
- **The production record types are not fixed.** Which sidebar record belongs to which player has to be worked out per file (`productionSideByType`).
- **Buildings go quiet.** The engine stops reporting a building that does not change, so you cannot tell death from silence by absence alone; deaths are worked out from where the next object with that id appears.
- **Ids are reused** after an object dies. An `ObjectTrack` is one life of one id (`segment`).
- **There are no "created" records.** A thing simply starts appearing; a sold building just stops.
- **Turrets are separate objects.** A Buggy is two ids: the hull (frames 0..31) and the turret (32..63, strength always 0). Spawn both and you get a second Buggy on every real one.
- **In a Nod mirror nothing says whose base is whose.** Factions settle a mixed matchup; a mirror needs the ladder's spawn positions (`slotsByOwner`).
- **Delivery planes and move flashes are objects too** (`C17`, `MOVEFLSH`): engine animations, not units.

---

## The code

```
src/replay/real-format.ts    container + match header
src/replay/object-stream.ts  frames, records, objects over time, production, inputs, score screen
src/replay/inflate.ts        zlib with sync flush, Node or browser
src/replay/file-name.ts      the match id and time in a .Replay's file name
src/replay/from-real.ts      decoded data -> a playable replay (deaths, sales, captures, paths...)
src/replay/cargo-passes.ts   the airstrip's delivery plane
src/engine/apm.ts            APM from the replay's inputs, counted the way StarCraft does
src/engine/*.ts              the tables from-real and apm need (unit and building data, sprite frames)
docs/RESEARCH-LOG.md         how every part was found and checked, dead ends included
```

The main entry points:

| Function | Gives |
|---|---|
| `extractReplayInfo(bytes)` | map, length, winner, players |
| `readBuildOrdersFromProduction(bytes, slots)` | each house's build order with times, units seen |
| `readObjectTracks(bytes, { paths: true })` | every object's life: positions, facings, strength |
| `readInputs(bytes)` + `inputSenders(...)` | every input, and which house sent it |
| `readTargetClicks(bytes, owners)` | clicks on objects (attack, harvest...) |
| `readScoreboard(bytes)` | settings and the score screen |
| `slotsByOwner(orders, factions, spawns?)` | which house is which ladder seat |
| `withRealCommands(scaffold, decoded)` | the playable replay the viewer runs |

Everything runs in Node and in a browser with no dependencies.

### Try it

```
npm install
npx tsx examples/summary.ts path/to/file.Replay
```

prints the map, players, both build orders, every object per house, and the score screen. Ladder replays live in `Documents\CnCRemastered\Replays`, and the ladder's are downloadable from EA's replay server.

---

## License

MIT, see `LICENSE`. EA's GPL source of the TiberianDawn DLL was used as a reference for the struct layouts; none of it is included.
