> **About this file.** This is the research journal kept while the format was being decoded, in the order things were found. Early sections are sometimes overturned by later ones (look for SOLVED / CRACKED headings), and it mentions research scripts (`_name.ts`) that are not part of this repository. For the short tour, start with the README; come here for how each fact was found and checked.

# `.Replay` container — what is decoded, and how it was verified

Research scripts for decoding C&C Remastered `.Replay` files. Run against a
local replay directory (defaults to `Documents/CnCRemastered/Replays`):

```bash
node scripts/replay-research/dec.mjs          # container + frame directory + inflation
node scripts/replay-research/strict.mjs       # type descriptors per frame
node scripts/replay-research/prod.mjs         # sustained production runs
```

## Decoded and verified

**Container.** `u32 sampleCount | u32 sampleCount | u32 table1ByteLength`,
then `table1`: `sampleCount` length-prefixed ASCII strings. Entry 0 is
`REPLAY_HEADER`, entry 1 `JSON_HEADER`; the rest are per-frame millisecond
timestamps.

**Frame directory** (`table2`, immediately after `table1`, 20 bytes each):

| offset | size | field |
| --- | --- | --- |
| 0 | 2 | unknown |
| 2 | 4 | hash |
| 6 | 4 | frame number |
| 10 | 4 | byte length |
| 14 | 4 | file offset |
| 18 | 2 | index |

Verified: `offset[i] + length[i] === offset[i+1]` for **6202/6202** records,
and the final frame ends exactly at EOF. Getting these field offsets wrong by
two bytes is easy and silently produces garbage — the tell is a column of
values like `65538 = (1<<16)|2`.

**Frame framing.** `'C' 'H'` + a 36-byte header (compressed length at +16),
then zlib. The payloads are network sync-flushed and carry no end-of-stream
marker, so a strict inflate rejects every one of them; they need
`Z_SYNC_FLUSH`. With that, **6202/6202** frames inflate.

**Frame payload.** Starts with a `u32` millisecond timestamp matching that
frame's `table1` string. Frames are stored in reverse-chronological groups of
~101 (each group ~4422ms earlier than the last), so **the stream must be
sorted by this timestamp** before use. Sorted, the timestamps span exactly the
match duration reported in the JSON header, at a flat 22ms step.

**Object type descriptor.** Embedded in frames as:

```
0x80 | u32 nameLen | ASCII name | u16 RTTIType | u16 typeIndex | u16 flags | u16 cost
```

The `0x80` prefix byte is what makes this findable without false positives.
Both enums match EA's GPL release (`TIBERIANDAWN/DEFINES.H`) exactly —
`RTTI_BUILDINGTYPE = 8`, and `typeIndex` is `StructType`:

| name | typeIndex | StructType | cost | TD cost |
| --- | --- | --- | --- | --- |
| WEAP | 0 | STRUCT_WEAP | — | — |
| PROC | 7 | STRUCT_REFINERY | 2000 | 2000 |
| SILO | 8 | STRUCT_STORAGE | 150 | 150 |
| HPAD | 9 | STRUCT_HELIPAD | 1500 | 1500 |
| SAM | 10 | STRUCT_SAM | 750 | 750 |
| AFLD | 11 | STRUCT_AIRSTRIP | 2000 | 2000 |
| NUK2 | 13 | STRUCT_ADVANCED_POWER | 700 | 700 |
| PYLE | 15 | STRUCT_BARRACKS | 300 | 300 |
| FIX | 17 | STRUCT_REPAIR | 1200 | 1200 |
| HAND | 19 | STRUCT_HAND | 300 | 300 |

Ten independent enum matches and nine independent cost matches, on data that
was never fitted to them.

**Production activity.** A descriptor repeats across consecutive frames while
that item sits in a production queue, preceded by a counter that decrements
by a fixed step per frame. Run lengths line up with real queue times — a Hand
of Nod run measures 4.7s against a measured ladder queue time of 4.73s.

## Not yet decoded

- **Player attribution.** Both players' production shares one stream and the
  house/owner field has not been located, so a run cannot yet be assigned to a
  side. This is the blocker for a real per-player build order.
- **Command semantics.** Whether a descriptor run marks queue-start,
  placement, or simply per-frame sidebar state is not established. Single
  appearances cluster at 0:08-0:13 in every match, which looks like the
  buildable list being registered rather than anything the player did.
- The bulk of each frame is an undecoded bit-packed payload.

Until player attribution is solved, the viewer's build-order panel stays
empty rather than showing a guess.

## Attempted and ruled out: recovering the owner without the owner field

Two approaches were tried and both failed. Recording them so they are not
retried.

**1. Owner as a fixed byte near the descriptor.** Using the 83 GDI-vs-Nod
replays as ground truth (HAND/AFLD/OBLI/SAM/TMPL are unambiguously Nod;
PYLE/WEAP/ATWR/GTWR/EYE unambiguously GDI), every byte offset within 64 bytes
before and 16 bytes after the descriptor was tested for a value that is
constant per faction within a match and differs between factions.

Result: **no candidate in any of 16 matches.** (`owner2.mjs`.) One offset
scores 100% separation — `post[+2]` — but that is the descriptor's own
`typeIndex`, which separates HAND=19 from PYLE=15 trivially and is circular.
This is consistent with the payload being bit-packed: only the strings are
byte-aligned, so neighbouring fields sit at variable bit positions.

**2. Two-colouring the production overlap graph.** In TD each player has one
structure build queue, so two overlapping structure runs must belong to
different players — attribution as graph colouring, no owner field needed.

Result: **fails for lack of connectivity.** (`attrib.mjs`, `iso.mjs`.) The
graph is bipartite in 70/78 matches, but that is meaningless: 87-100% of runs
are *isolated*, giving ~67 connected components for ~68 runs. Colouring is
only defined within a component, so isolated runs all take colour 0 and no
identity can propagate between components. Agreement with faction ground
truth: **0/78**. The descriptors are far too sparse to overlap — a typical
match yields ~50-120 runs spread over 6000+ frames.

There are also no house-name strings (`GoodGuy`, `BadGuy`, `Multi1`, …)
anywhere in the frame stream (`houses.mjs`), so houses are numeric.

**Conclusion.** Player attribution cannot be recovered from the byte-aligned
strings alone. The only remaining route is decoding the bit-packed frame
payload itself.

## What the frame payload actually is

The payload is **serialised C&C Remastered DLL interface structs** — the same
structs the game DLL exports to its frontend, declared in
`TIBERIANDAWN/DLLInterface.h` of the GPL release. This was not guessed; the
byte layout matches the header field for field.

The record that carries a type name is `CNCSidebarEntryStruct`:

```
0x80 | u32 nameLen | AssetName | u16 BuildableType | u16 BuildableID
     | u16 Type | u8 SuperWeaponType | u16 Cost | s32 PowerProvided
     | u16 BuildTime | u16 Progress
```

Four independent cross-checks, none of them fitted to the data:

- `BuildableType` is `RTTIType` — 8 = `RTTI_BUILDINGTYPE`, 4 = `RTTI_UNITTYPE`.
- `BuildableID` is `StructType`/`UnitType`. Ten structures match `DEFINES.H`
  exactly (WEAP=0 … HAND=19), as do units (LTNK=2, HARV=10, ARTY=11, BIKE=17).
- `Type` is `DllObjectTypeEnum`: the value 15 seen on every structure is
  `BUILDING_TYPE`, and 13 on every unit is `UNIT_TYPE`.
- `Cost` and `PowerProvided` match the real game: costs 150/300/700/750/1200/
  1500/2000, and Drain values -10 (SILO, HPAD, GTWR), -20 (HAND, PYLE, GUN),
  -30 (PROC, WEAP, FIX, AFLD), +200 (NUK2), 0 for units.

**The frames are delta-encoded.** A typical frame is 138-2000 bytes and
consecutive frames share long identical prefixes; each match also contains
~10 keyframes of ~120KB, the first of which is the initial game state. An
entry is only re-transmitted while it is *changing* — which is why a run of
consecutive frames carrying an entry corresponds to an item actively
building, and why `Progress` rises monotonically within a run (verified;
runs that appear non-monotonic are two consecutive builds of the same type
merged by the gap tolerance).

`CNCSidebarStruct` — which wraps these entries and holds `Credits`,
`PowerProduced`, `PowerDrained` — is **per player**, so player attribution is
present in the stream. It is just not reachable without decoding the delta
framing, because the sidebar block header sits at a variable position.

## Also ruled out

- **Attribution by position within a frame.** If both players' sidebars were
  emitted in a fixed order, a duplicated name would appear in frames where
  both build the same type. Duplicates occur in **5 of 41366** frames, so
  there is no usable ordering signal.

## What is left

One thing: the delta framing — the bitmask or tag scheme that says which
fields of which struct are present in a given frame. Everything else is
known. With it, both blockers fall at once: entries become attributable to a
player (via the enclosing `CNCSidebarStruct`), and coverage becomes complete
rather than the fraction that happens to be byte-aligned and findable today.

Without it, extracted build orders are real but **incomplete** — they miss
structures whose entries never surfaced in a findable position, so they must
not be shown as if they were the player's full build.

## Delta framing: what is now known

**The replay is not a command log.** TD's multiplayer is deterministic
lockstep over `EventClass`, whose bitfield carries `Frame:27` and `ID:4`
(the house index) — so if that stream were present, attribution would be
free. It is not. Establishing that took three passes, and the first two were
wrong; the sequence is recorded here because the failure modes are easy to
repeat.

*Pass 1 (wrong).* Scan for candidate event bytes, recover `Frame`, correlate
against the frame's real timestamp. Result r = -0.013, concluded "byte
noise". **Both halves of that were wrong.** Random chance predicts
~45 candidates — (10/256 type bytes) x (1/2 for id<=7) x (72000/2^27 for a
plausible frame) over ~4.3M byte positions — and 60377 were observed, 1300x
above chance, so "noise" was simply false. Worse, the test could not have
detected what it claimed to rule out: a few hundred real events among 60000
false positives would leave r indistinguishable from zero.

*Pass 2 (also wrong, opposite direction).* Re-run as a proper hypothesis
test — does a candidate's recovered `Frame` match *its own* frame's position
in time, versus a permutation null? Result: **z = 32.7 at 15fps**, 7-11x
enrichment, apparently decisive evidence that the event stream exists.

*Pass 3 (the actual answer).* Localise the hits. **251 of 361 came from a
single frame** — the 98KB keyframe at t=0.0s — and 335 of 361 from two
frames in the first 100ms. At t~0 the expected frame number is 0, so the
test degenerates into counting `u32` values near zero, and a 98KB keyframe
is mostly zeros. The permutation null gave shuffled frames a *nonzero*
expectation, manufacturing the enrichment.

*Control.* Drop the first 10 seconds and all keyframes, then repeat:

| replay | rate | observed | null | z |
| --- | --- | --- | --- | --- |
| ...888920 | 15fps | 20 | 21.9 +- 6.8 | **-0.3** |
| ...213500 | 15fps | 21 | 28.4 +- 5.4 | **-1.4** |
| ...440429 | 15fps | 25 | 56.0 +- 8.4 | **-3.7** |

No signal in any of three independent replays. The conclusion (no event
stream; the file is a state stream) stands — but on this evidence, not on
pass 1's reasoning.

**Chunk header** (17 bytes, confirmed):

| offset | size | field |
| --- | --- | --- |
| 0 | 4 | timecode (ms; matches the `table1` string for this frame) |
| 4 | 4 | zero |
| 8 | 1 | **type** — 0 = delta, 1 = keyframe |
| 9 | 4 | **payload length in bits** |
| 13 | 4 | zero for type 0; a small varying number for type 1 |

`ceil(bits/8) == frameLength - 17` holds exactly for **78-88%** of type-0
frames (`bitlen.mjs`, `types.mjs`). Type-1 keyframes are the ~120KB full
snapshots, 7-17 per match; the first one chronologically is the initial game
state.

**Unresolved: the remaining 12-22%.** These type-0 frames carry data past
the end of the declared bitstream. Two hypotheses were tested and both
failed:

- *A second length-prefixed section.* Brute-forcing every offset in the
  trailing region for a u32 that accounts for the remainder (as bits or as
  bytes) explains **1 of 728** frames (`sec2.mjs`). It is not a chained
  section.
- *An appendix for variable-length records.* If strings were appended after
  the bitstream because they cannot be bit-packed, trailing data would
  coincide with sidebar entries. It does not: 637 of 728 trailing frames
  contain no entry at all, and entries are found **inside** the declared
  bitstream region more often than in the trailing region (230 vs 111)
  (`corr.mjs`).

So the bit-length field describes something real for most frames but is not
the whole story. That is the open question.

## The per-frame trailer — a second compressed stream (previously discarded)

Every frame carries **two** independent zlib streams. The early notes
described what followed the main payload as "a short uncompressed trailer"
and it was ignored from then on. It is neither short nor uncompressed: it is
72-82 bytes per frame, ~500KB across a 4.3MB replay, and it is the frame's
structural descriptor.

The 36-byte chunk header self-describes it. Profiling all nine u32 fields:

| offset | value |
| --- | --- |
| 0 | `'C' 'H' 0x02 0x01` (constant) |
| 4 | `0xFFFFFF11` (constant) |
| 8 | per-frame hash (all 6202 distinct) |
| 12 | 8 (constant) |
| 16 | compressed length of the main payload |
| 20 | compressed length + 8 |
| 24 | **trailer length - 32** |
| 28, 32 | 0 |

**Inflating the trailer.** It begins `78 9c`, but every standard inflate
fails with `invalid stored block lengths`, which is what led to it being
written off. The stream ends at a `00 00 FF FF` sync-flush marker and is then
zero-padded to its allotted size; the decoder chokes on the padding, not the
data. Truncate at the marker and inflate with `Z_SYNC_FLUSH` and **6202 of
6202** succeed.

**Contents: a `(u32 key, u32 value)` list**, 18 distinct keys, always a
multiple of 8 bytes. Verified meanings:

- **`0x70` — extra-section count.** Its high bit is set exactly when the main
  payload carries data past its declared bit-length, and its low bits give
  how many extra sections there are. Contingency on one replay: 728 flagged
  and trailing, 0 flagged and not trailing. Across six replays the flag
  agrees with the payload **99.9%** of the time.
- **`0x6e` — one entry per extra section.** `count(0x6e)` equals the low bits
  of `0x70` for **100.0%** of frames in every replay tested (6157/6157,
  13717/13717, 15230/15230, 8271/8271, 13221/13221, 9390/9390).
- **`0x73` — keyframe payload size.** Appears exactly once per type-1
  keyframe and never otherwise: 7/7, 15/15, 17/17, 10/10, 14/14, 11/11.

This is the answer to "how does a frame declare its own structure", which is
what the delta framing was missing. The 12-22% of frames that would not parse
are not malformed — they declare extra sections in a stream that was being
thrown away.

**Still open:** what a `0x6e` value *means* per section (values 52-301; they
are not byte sizes — they do not sum to the remaining length), and therefore
where each extra section begins. Frames with exactly one extra section
(`sec3.mjs`) show a header-like shape at the boundary — `[u32][4 zero bytes]
[u8][u32][4 zero bytes]`, mirroring the main 17-byte header — but its
bit-length field does not account for the remainder, so the layout is not yet
settled.

## A filter bug that was hiding structures (found via player ground truth)

A player who knows the game stated that every ladder match opens the same
way: MCV select, deploy, **power plant queued first, on every map**. The
extractor had never once reported a power plant. That was not a quirk of the
data — it was a bug here.

`parseEntries` required the byte immediately before a sidebar entry's length
prefix to be `0x80`. That byte is not a signature and is not constant:

```
... 80 | 04 00 00 00 | "HAND" | 08 00 13 00 ...
... 82 | 04 00 00 00 | "NUKE" | 08 00 0c 00 ...
... 87 | 04 00 00 00 | "NUKE" | 08 00 0c 00 ...
```

Filtering on it silently discarded every entry that happened to be preceded
by anything else. Replacing it with structural validation (BuildableType in
{2,4,6,8}, a matching `DllObjectTypeEnum`, plausible cost and power) raised
the distinct-name count from 18 to 25 and recovered the power plant, whose
fields then validate perfectly: `BuildableID = 12 = STRUCT_POWER`, cost 300,
power **+100**. The newly recovered names all check out too — E1 100, E2 160,
E4 200, E6 500 (all `dll = 12 = INFANTRY_TYPE`), HQ 1000 / -40 power,
GTWR 500 / -10, GUN 600 / -20.

Lesson: a filter invented from one example is a filter that quietly deletes
data. The domain expert's "that can't be right" was the only thing that
surfaced it.

## Keyframe cadence — and how to tell a restatement from a real build

Keyframes land at a fixed **20.8-second** interval in every replay
(0.0, 20.8, 41.6, 62.4, 83.2, ...), and they restate full state. An entry
seen only at those times means "this exists", not "this was just built".

That is a distinction, not a dismissal. Walls are the case that makes it
matter: sandbag *crawling* — chaining cheap walls toward the opponent to
extend build radius — is real ladder play, so SBAG/CYCL/BRIK are signal, not
noise. Splitting wall entries by which frame carried them separates the two
cleanly (`sbag.mjs`):

| time | entry | frame |
| --- | --- | --- |
| 15.9s | CYCL | delta only — real build |
| 20.8s | SBAG | touches keyframe — restatement |
| 29.9s | SBAG | delta only — real build |
| 41.6s / 62.4s | SBAG | touches keyframe — restatement |
| 65.8s, 79.9s | CYCL | delta only — real build |
| 131.1s, 138.1s | SBAG | delta only — real build |

So the rule is: **delta-only entries are player activity; keyframe-time
entries are state.** Crawl progress is readable from the delta-only wall
entries, which arrive steadily through the match.

## Honest status of build-order extraction

Recall is still poor. Entries are found in keyframes at ~3-4 per frame but in
delta frames at only **~0.09 per frame**, so most production is still missed:
the opening power plant is queued around 0:02-0:07 in every match (the Hand
of Nod run beginning at 7.3s with a 4.7s duration is consistent with a power
plant finishing right before it) yet no NUKE entry is recovered in that
window. What is being read is whatever happens to be byte-aligned and
findable, not the full stream. Build orders must therefore still not be
presented as complete.

## The Progress field is packed: `state << 10 | progress`

`CNCSidebarEntryStruct.Progress` is not a raw counter. Its values cluster at
8192 / 9216 / 10240 (0x2000 / 0x2400 / 0x2800) and ramp upward from there,
which resolves as:

```
state    = value >> 10
progress = value & 0x3FF        // 0 .. 1023
```

Verified: the maximum low-10-bits value observed across a whole match is
**1013**, comfortably inside 0..1023 and never exceeding it. State 10 is
"actively building" and accounts for 828 of 978 samples; states 8, 9, 0 and
12 also occur. A completed item is a state-10 ramp running 0 -> ~1013.

This is what makes a unit *countable*: each build is one ramp, so the number
of ramps is the number of units produced.

## Ground truth from the player, and what it fixed

The player identified two of their own ladder replays and described the
opening. Three things came out of it:

1. **The first ~9 seconds with no sidebar entries are correct, not missing
   data.** The MCV is being *moved* before deploying; no sidebar exists until
   it deploys. An earlier note here treated the absent opening power plant as
   a decoding failure — it was a bad model of the opening.
2. **The account assumption was wrong.** The most frequent Steam ID in the
   replay folder is not necessarily the folder's owner; this player uses a
   smurf (`76561198024709287`). Any analysis that labels "the player" by
   picking the most common ID is unsound.
3. **The opening reads correctly, end to end.** The player first recalled
   "~7 flamethrowers", then corrected it to "3, and then I placed the
   helipad". The decoded opening matches the correction exactly:

   | time | item | state | peak | reading |
   | --- | --- | --- | --- | --- |
   | 0:09.3 - 0:14.0 | HAND | 10 | 99% | completed |
   | 0:16.2 - 0:18.1 | E4 | 10 | 87% | flamer 1 |
   | 0:18.4 - 0:20.7 | E4 | 10 | 98% | flamer 2 |
   | 0:20.8 - 0:23.1 | E4 | 10 | 99% | flamer 3 |
   | 0:23.2 - 0:23.5 | E4 | 10 | **14%** | started, abandoned |
   | 0:28 - 0:37 | PROC | 10 | 28->71% | refinery |
   | 0:46.5 | HPAD | 10 | 90% | helipad |
   | 0:55 - 1:01 | E3 | 10 | 85-99% | rocket infantry |

   Three flamers, a fourth cut off at 14% (the player switching production),
   then refinery and helipad. Sequence, counts and the abandoned queue all
   agree with the player's own account of the game.

   Recall is still not uniform — the Apache that followed the helipad yields
   only a single HELI sample — so per-item counts remain unsafe to publish
   as totals. But the opening build order is now readable and verified.

Also confirmed from the same data: the filename encodes the map, with no
parsing needed — `COMMUNITY_3` = Elevation, `COMMUNITY_7` = Tournament
Desert, `COMMUNITY_6` = Tournament Middle Camp, `COMMUNITY_5` = Quarry,
`COMMUNITY_4` = Heavy Metal, `MULTIPLAYER_60` = Monkey in the Middle,
`MULTIPLAYER_1` = Green Acres. `UGC_*` files are custom-map games.

## Sidebar entry states

The `state` nibble (`Progress >> 10`) takes values 0, 8, 9, 10, 12. Two are
solid:

- **10 = actively building.** The low 10 bits run 0 -> ~1013 over exactly the
  item's real queue time. This is the only state that yields a progress ramp,
  and it is how builds are counted.
- **8 = present in the sidebar, not building** (`prog` always 0).

**0 is not yet pinned down.** It looks like a completion marker in some
places — the helipad goes `state 10 @ 90%` at 0:46.7 then `state 0` at 0:48.1,
and the Apache that followed appears exactly once, as `state 0` at 2:36,
matching the player's account that the Apache completed. But HPAD also shows
`state 0` at 0:41.5, *before* it was built, and again later, so "completed" is
too simple. Counting completions as a 10 -> 0 transition finds only 2 events
in a match where far more finished, because it needs both samples captured
back to back.

## Coverage

In the Green Acres match, **96 of 195 seconds** carry at least one entry, with
silent gaps of 6s, 8s and 17s. During an actual build, sampling is dense —
a ~2 second flamethrower yields ~100 samples, roughly one per 22ms frame — so
recall inside a build is near total. The gaps are between builds. That makes
build *sequence* and *timing* reliable, while per-item lifetime totals are not
yet trustworthy.

## SOLVED: player attribution, via CNCObjectStruct

There are **two** record types in the stream, and only one was known before:

1. `CNCSidebarEntryStruct` — a **single** length-prefixed name, then
   BuildableType / BuildableID / cost / power / progress. This is the
   production sidebar.
2. `CNCObjectStruct` — the **same name written twice** back to back
   (`char TypeName[]` then `char AssetName[]`), then the object's own fields.
   This is the actual object on the map, and it is where `Owner` lives.

The double-name is the signature that makes it findable:

```
04 00 00 00 "NUKE" 04 00 00 00 "NUKE" 04 00 01 00 00 00 00 20 03 0a 02 4e 4e ...
                                       ^^^^^ dll=4 BUILDING
                                             ^^^^^^^^^^^ int ID
                                                            ^^ ^^ Owner, RemapColor
                                                                  ^^ ^^ CellX, CellY
```

Body layout (offsets from the end of the second name):

| offset | field |
| --- | --- |
| 0 | `u16` DllObjectTypeEnum (4 = BUILDING, 2 = UNIT, 5 = TERRAIN) |
| 2 | `u32` ID |
| 9 | **Owner** |
| 10 | RemapColor |
| 11, 12 | CellX, CellY |

Grouping every building record by `Owner` splits a Nod-vs-Nod match cleanly
into two players. Verified against the player's own account of a Heavy Metal
match, given before any of this was extracted:

| player's account | decoded, owner 0x0a | |
| --- | --- | --- |
| power plant first | 0:12 NUKE, first building | correct |
| then Hand of Nod | 0:46 HAND | correct |
| 4 power plants | NUKE x4 | correct |
| airfield | AFLD x1 | correct |
| three turrets | GUN x3 | correct |
| 5 refineries | PROC x4 | one short |
| opponent went air into a 2nd air | owner 0x08 has AFLD **x2** | correct |

The opponent's two airfields against the player's one is the decisive check:
it was volunteered in advance and falls straight out of the owner byte.

This also explains why the opening power plant appeared "missing" for so
long. It was never absent — buildings are announced in the *object* stream,
and every search up to this point had been looking only at the sidebar
stream.

## Shipped into the app

`src/lib/replay/object-stream.ts` is the TypeScript port of everything above:
container, framing, sync-flush inflation, chronological sort, sidebar entries
and object records. `src/lib/replay/local-replays.ts` finds a match's replay
on disk — the ladder's own links are Glacier-archived, but the game keeps
every replay locally and **the filename carries the match id**, so a match
page can find its own replay with no download and no upload step.

`getBuildOrdersFn` joins the two streams and the viewer's Build order panel
renders the result. When there is no local file for a match id, the panel says
so instead of inventing an order.

Two things the join has to get right:

- **Timing comes from the sidebar, not the object stream.** Object records are
  sent sparsely, so a building's first sighting can trail its placement by
  tens of seconds — a Hand of Nod that the sidebar shows building at 0:14 was
  not seen as an object until 0:46. Each structure claims the latest *unclaimed*
  sidebar ramp for its asset that began before it was seen; claiming is
  one-to-one, because four refineries are four builds and letting them share a
  ramp stamped them all with one time.
- **Sides are named only when the replay identifies them.** In a mixed
  matchup, faction-exclusive structures (HAND/AFLD/OBLI/SAM/TMPL vs
  PYLE/WEAP/ATWR/GTWR/EYE) pin each side to a player. In a Nod mirror nothing
  does, so the sides stay "A" and "B" rather than being guessed.

Verified live on ladder match 7833598 (Green Acres, GDI vs Nod):

```
FLY (NOD, 11)                    gl hf gg wp (GDI, 8)
~0:16 Power Plant                ~1:02 Construction Yard
 0:40 Refinery                    1:02 Refinery
 0:49 Hand of Nod                ~1:46 Weapons Factory
 0:50 Refinery                    2:04 Refinery
 0:57 Refinery                   ~3:28 Barracks
 1:08 Power Plant                ~5:33 Power Plant
 1:19 Hand of Nod                ~8:40 Power Plant
 1:58 Refinery                   ~11:47 Barracks
~2:05 Helipad
~2:06 Turret
~4:51 Airstrip
```

Power plant first for the Nod player, as the ladder opening requires. A `~`
marks a time known only from the object stream, so it is an upper bound.

## SOLVED: map position

Position is packed into three bytes of the object record:

```
pos24 = b[k] | b[k+1] << 8 | (b[k+2] & 0x0F) << 16
y = pos24 >> 12              // whole cells
x = (pos24 & 0xFFF) / 32     // cells, 1/32 precision
```

**Verified against a real map.** Decoding every terrain object in a Heavy
Metal replay and pairing each with the `[Terrain]` section of that map's own
`.ini` (objects are created in map load order, so object id indexes the ini
list) reproduces **64 of 65 cells exactly**. The single miss is a record whose
name pairing had drifted near the end of the list, not a decode error.

**`k` is the occupy list.** It shifts by object type — terrain reads at 29, a
turret at 31, a power plant or Hand of Nod at 35, a refinery at 37, an airstrip
at 45 — and what shifts it is the building's occupy list, written into the
record ahead of the position at one `short` per cell:

    k = 29 + 2 * cells

    gun 1 -> 31   silo 2 -> 33   pyle 2 -> 33   powr 3 -> 35
    hand 3 -> 35  proc 4 -> 37   hpad 4 -> 37   fact 6 -> 41
    weap 6 -> 41  afld 8 -> 45

Ten types fit it, and terrain — which stands on no cells — is the zero case
that fixes where the count starts. The list itself is DLLInterface.cpp:3028,
which walks `building_type->Occupy_List()` to `REFRESH_EOL`; the same list the
game data gives `BLDG_OCCUPY`, so nothing needs searching for.

This is not `CNCObjectStruct` written out verbatim — that declares
`OccupyList` fixed-size and *after* `CellX`/`CellY`. `_cellfixed.ts` rules out
the fixed-offset reading independently: score every offset on the one thing a
building cannot fail — it never moves, so every sighting of an id must decode
to the same cell — and the only offset scoring 100% yields a per-replay
constant.

**Not every record states a cell.** DLLInterface.cpp:2985 fills the occupy list
only when `base_object == NULL`, so a second draw call for the same building
writes none, and no position at the offset the list would have moved it to.
Those read (0,0) and are taken as stating nothing; the building's other
sightings supply the cell. Reading them at 29 instead — where a record with no
list should keep its position — was measured and is worse than reading nothing:
116 wrong cells and not one right one.

**Scored against the track records**, whose layout is fixed and not in
question, the rule reads a real cell 1784 times against the old blind search's
1605, and a wrong one 300 times against 736. At the level of build events,
agreement with the tracks goes from 79.3% to 86.0%. It is what closed the last
of the recorded structure losses that had no building to be pinned on: 67 of 72
before, 72 of 72 after.

`findCellOffset` still solves `k` from the data for the civilian village
buildings, whose footprints the game data here does not carry, and a second
pass anchors the sparse ones to their owner's base centroid (a Construction
Yard belongs near its own buildings).

**Checked against the player's account.** They stated they spawned top-right
and the opponent bottom-left. Decoded centroids:

| owner | centroid | corner |
| --- | --- | --- |
| 0x0a | (51, 24) | top-right |
| 0x08 | (24, 46) | bottom-left |

with every structure of each side clustering around it — the player's turrets
at (47,22) (50,36) (40,45), the opponent's refineries at (17,45) (23,44)
(25,48). Spawn corners were volunteered before any of this was extracted.

### A methodological note

An earlier pass here "confirmed" a position field with correlation **1.000**
across five terrain types. That was wrong: it sorted the decoded values and
the true cells independently and correlated the two sorted arrays, which
forces r≈1 for *any* field that varies monotonically. It is the same mistake
as the event-stream test earlier in this document. Correlation between
independently sorted sequences measures nothing; the fix was to establish a
real pairing (via load order) and check exact equality instead.

## Feeding real positions into the simulation

`src/lib/replay/from-real.ts` converts decoded build orders into the
simulation's command stream, so a match plays back on the base each side
actually built rather than a synthesised layout. Structure placements and the
Construction Yard deploy come from the replay; unit activity still comes from
the generator, because unit production carries no owner.

Three things this exposed:

- **The simulated economy was vetoing real history.** The `place` handler
  refused any structure the player "couldn't afford" according to our
  harvesting model. Applied to decoded placements that silently dropped
  structures the match demonstrably had — a player's fourth refinery vanishing
  because our credit estimate disagreed. Commands decoded from a replay now
  carry `real: true` and bypass that check: they are ground truth, and an
  approximation must not overrule them.
- **Don't invent a Construction Yard.** When no `FACT` record appears for a
  side, an earlier version anchored a yard at that side's centroid. It both
  blocked real placements (the sim rejects structures overlapping it) and can
  be flatly wrong — the opponent in the test match had *sold their MCV*, so
  they genuinely had no yard.
- **The yard is a deploy, not a build.** Its own object record is usually seen
  long after it existed, so it is emitted at t=0 rather than at its sighting.

Result on the test match (Heavy Metal, Nod mirror): **25 of 25** structures
placed at their decoded cells, with centroids (51,24) and (24,46) — the
top-right and bottom-left spawns the player described.

## Units, effects, and what could not be read

**Units carry the owner.** `DllObjectTypeEnum` 1/2/3 (infantry, vehicle,
aircraft) put the house index at the same offset as buildings, so unit
attribution needed no new work once the object record was understood — 108
units in the test match, all attributed, all positioned. They are fed to the
simulation as a `spawn` command: a unit read from a replay was on the map, so
it is placed directly rather than queued through a factory it may not have
come from and paid for out of an economy that cannot cover it.

**Position for units and effects is sub-cell.** `findCellOffset` originally
required whole-cell x, which is right for structures and terrain and wrong for
anything that stands or explodes between cells; it rejected the real field and
settled on a constant, putting every effect at (0,0). It now takes a
`wholeCell` flag, and refuses to return an offset whose value never varies.

**Destruction is readable.** `ANIM` records carry names, owner and position:
FIRE3 x103, FRAG1 x37, NAPALM1 x8, FBALL1 x2 in the test match, plus MINIGUN
and GUNFIRE muzzle flashes and MOVEFLSH (the flash under a move order). The
162 destruction effects that resolve a position cluster near one base —
10 near the losing side's, 0 near the winner's.

### Not readable

- **Credits.** `CNCSidebarStruct` has a `Credits` field, but nothing in the
  frames holds a credit-like series: no fixed offset carries a bounded,
  smoothly-changing value across frames (`credits3.mjs`), and no offset
  relative to a sidebar entry does either (`credits2.mjs`). Frames are deltas,
  so nothing sits still. Harvesting therefore remains simulated.
- **Selling.** Structure sightings are far too sparse to infer a disappearance
  — most structures are seen 1-4 times in a whole match, so "last seen" tracks
  sampling, not destruction or sale. A sold building and one simply not
  re-transmitted look identical.

### Build order: why sightings order it, not ramps

Production ramps come from the sidebar stream, which has **no owner**. When
both players build the same structure their ramps interleave and a ramp can be
claimed by the wrong side. Object sightings do carry the owner. So a player's
build is ordered by their own sightings, and a ramp is used only to refine the
displayed time — and only when it does not contradict that order.

An earlier version matched each structure to the *latest* ramp before its
sighting, which pushed everything late: in a four-refinery build the third
refinery was reported as the first and the two genuinely-first ones lost their
ramps entirely. Reported by the player from the game's own replay.

## How much of the file is actually being read

A fair question from the player: the game's own replay viewer reconstructs the
match exactly, so the data must all be in there — nothing in 40MB is junk.
That is right, and worth quantifying.

| | |
| --- | --- |
| delta frames | 18,308 |
| total decompressed delta payload | **39.8 MB** |
| median delta frame | 2,054 bytes |
| records this decoder extracts | ~2,800 |

So the decoder reads a rounding error of the file. Everything above — build
orders, positions, owners — comes from the fraction that happens to be
**byte-aligned**: the length-prefixed asset-name strings and the fields
immediately around them.

### Why the rest resists

The named record (`TypeName` + `AssetName` written twice) is an object's
**introduction**. Per-frame updates afterwards do not repeat the name, and
they are not at fixed offsets:

- Two delta frames 22ms apart differ in **1356 of 1697 bytes**. Almost nothing
  changes semantically in 22ms, so the encoding must be variable-length: one
  field changing size shifts everything after it.
- It is not a whole-frame bit shift either — shifting a frame by 1-7 bits
  gives a longest matching run of 9 bytes at *every* shift (`bitshift.mjs`).
  The frames genuinely carry different record sets, and their lengths differ
  (1995 vs 1666 bytes for neighbours).
- Entropy is 5.16 bits/byte with 30% zeros: structured, densely packed, not a
  plain struct dump.

There is a fixed per-frame header — the sequence `00 01 1E 1A 01 98 20 04 00`
occurs exactly once in 453 of 500 sampled frames — but the per-object update
records after it are still unread.

### What this costs, concretely

Exact queue and deploy times. The sidebar stream gives production ramps but
carries no owner; the object stream gives owners but only introductions. A
structure's reported time is therefore the earliest ramp that provably
precedes its introduction, which is an upper bound, not the moment the player
clicked. Reading the per-object update records would replace every estimate in
this document with the real value.

## Attempt to crack the per-object update records — characterised, not solved

**The payload is a genuine bitstream.** The `bits` field is not a byte count
dressed up: across 12,828 exact-fit delta frames it is divisible by 8 in only
**1,702**. Payloads end mid-byte. That is the root cause of every fixed-offset
failure in this document, and it explains why only the length-prefixed strings
were ever readable — the encoder byte-aligns for those and for nothing else.

**There is no fixed record size.** A promising early signal — common payload
lengths separated by repeating gaps of 88 and 53 bits — did not survive a
larger sample. Across all exact-fit frames there are **9,708 distinct payload
lengths in 12,828 samples**, and the histogram of differences between lengths
is flat (16:3817, 28:3809, 12:3783, 13:3779, … all within 3%). No preferred
record size exists. Fitting `length = header + a*A + b*B` over the best
candidate sizes explains only 2,506 of 9,708 lengths — barely better than
chance for a two-parameter fit.

Flat difference histogram plus continuously varying lengths means fields are
themselves variable-width: a per-record field bitmask, bit-level varints, or
entropy coding. Not a packed struct with a fixed layout.

**Also ruled out.** Frames are not a bit-shifted copy of their predecessor
(shifting 1-7 bits gives a longest match of 9 bytes at every shift), and
anchoring on a known unit's decoded position finds only coincidental matches
in neighbouring frames, with dense repeating-nibble context around them rather
than struct fields.

### What would actually be needed

The game DLL is GPL and gave up its struct definitions, which is how the
introduction records were decoded. The *serialiser* lives in the closed-source
frontend, so there is no reference for the bit grammar. Cracking it means
recovering a variable-width field encoding from data alone — feasible in
principle, given known object IDs and positions to validate against, but a
different order of work from everything above.

Until then the honest position stands: build order, ownership and placement
are real; **times are upper bounds**, because they come from the earliest
production ramp that provably precedes an object's introduction rather than
from the moment the player clicked.

## Second dig: what the source told us, and what it ruled out

Following the player's suggestion to go back to the source, and to look where
nothing had been looked yet.

### From the GPL source

`CNC_Get_Game_State(GameStateRequestEnum, uint64 player_id, buffer, size)` is
how the frontend pulls state, and it fills **plain C structs** into a buffer —
`GAME_STATE_LAYERS`, `SIDEBAR`, `PLACEMENT`, `DYNAMIC_MAP`, `SHROUD`,
`OCCUPIER`, `PLAYER_INFO`, `STATIC_MAP`. The DLL does no packing; whatever
packs the replay lives in the closed frontend.

The input side is what a command log would be made of, and the enums are
known: `SidebarRequestEnum` (START_CONSTRUCTION=0, HOLD=1, CANCEL=2,
START_PLACEMENT=3, **PLACE=4**, CANCEL_PLACE=5, CLICK_REPAIR=6, …),
`InputRequestEnum`, `StructureRequestEnum` (…SELL_START=3, **SELL=4**),
`ControlGroupRequestEnum` (CREATE/TOGGLE/ADDITIVE). "Power plant queued at
0:05" is `SIDEBAR_REQUEST_START_CONSTRUCTION`; "deployed at 0:10" is
`SIDEBAR_REQUEST_PLACE`.

### Ruled out this pass

- **Player id as a binary u64.** Those request functions take a `uint64
  player_id`, and earlier searches only looked for Steam IDs as ASCII. Searched
  as little-endian u64 across every frame: **0 occurrences** (`pid.mjs`). Input
  requests are not recorded with the raw player id.
- **LCW / Format80.** Westwood's own compression, already implemented in this
  repo. Applied at several payload offsets it produces output *smaller* than
  input in every attempt — not LCW (`_lcw` probe).
- **Keyframes as object lists.** A 131KB keyframe holds **10 named records,
  0.6% of its bytes** (`kf.mjs`). Keyframes are dominated by the static map
  (`CNCMapDataStruct.StaticCells`), not objects — which is also why they grow
  from 131KB to 165KB as a match fills in.

### Found this pass

Compact **nameless instance records** exist, carrying a position in the same
24-bit encoding verified against the map file. Located by the recurring
sequence `08 00 00 80 89` with a position three bytes ahead:

```
[pos24 : 3B][tag : 1B][b4 : 1B][08 00 00 80 89][00 00][2B]
```

Two independent confirmations that the position is real: `c0 06 81` decodes to
**(54,16)**, and `20 d2 42` to **(17,45)** — both structures whose positions
were already verified by other means. The record count tracks the object count
across a match (1 → 4 → 7 → 14 → 21).

The `tag` byte tracks ownership. Against structures whose owner was already
known: `0x41` on (54,16) and (48,34), both owner `0x0a`; `0x42` on (17,45) and
(23,44), both owner `0x08`.

**Still incomplete**: this signature finds ~21 records in a keyframe that
should describe well over a hundred objects, so it is one shape of record among
several rather than the general grammar. The find is real but partial.

## Third dig: the tag/b4 trail, and what it actually was

Following the tag/b4 pairs back with a wider window resolved what those
"nameless instance records" were: **the tail of a named record**. Widening the
context by 48 bytes shows `48 41 4E 44` — "HAND" — twice, just before them.
The position sits 35 bytes past the end of the second name, exactly where
`findCellOffset` had already placed it. No new record shape; one confirmation
that the existing parse is right.

The `tag` byte does track ownership: `0x41` on two structures owned by `0x0a`,
`0x42` on two owned by `0x08`. It is a re-encoding of the owner already read
at offset 9, not new information.

### Ruled out

- **Names longer than 8 characters.** `CNC_OBJECT_ASSET_NAME_LENGTH` is 16, and
  the parser capped at 8, so this looked like a real gap. It is not: TD uses
  8.3 filenames and no asset name in a full match exceeds 8 characters.
  Raising the cap changed nothing (3867 records, 368 objects, either way).
- **Keyframes hiding objects.** A keyframe holds 10-35 named object records,
  and that is genuinely all the objects alive at that moment — 368 distinct
  objects across a whole match, ~3867 records, ~10 sightings each. The rest of
  a 165KB keyframe is the static map, not hidden objects.

### Found: `*MAKE` is a real placement timestamp

`TypeName` and `AssetName` are separate fields and are **not always equal**.
While a structure is going up, its asset is the buildup art — `AFLD` becomes
`AFLDMAKE`. The parser required the two names to match and threw those records
away.

That record is a *direct observation of construction in progress*, which bounds
placement far more tightly than a plain sighting. Catching them:

| owner | structure | buildup seen | plain sighting | gain |
| --- | --- | --- | --- | --- |
| 0x0a | PROC | 2:30 | 2:51 | 21s earlier |
| 0x08 | FACT | 3:39 | never | new structure |
| 0x08 | AFLD | 5:37 | 4:35 | — |
| 0x0a | GUN | 6:20 | never | new structure |

Two structures that were previously invisible now appear, including the
opponent's second Construction Yard at (17,51) — consistent with the player's
account that their opponent sold an MCV and redeployed.

`ObjectSample.underConstruction` now carries this, and a buildup sighting
outranks every other sighting when choosing a placement time.

### Still not cracked

The 39.8 MB of delta payload remains unread. The named-record stream is now
essentially fully extracted, so the missing per-frame state — and with it the
exact "queued at 0:05, placed at 0:10" — lives entirely in that bitstream.

## CRACKED: the delta payload framing

The payload is a **chain of length-prefixed sections**:

```
payload := section*
section := u24 bitLength (LSB-first)  ||  bitLength bits of body
```

The chain lands exactly on the frame's declared bit count. Sections are
**bit-aligned**, which is the whole reason nothing at a fixed byte offset ever
worked, and why only the strings — which the encoder byte-aligns — were ever
readable.

**Null-tested before being believed**, having been burned twice earlier in this
document:

| parse | result |
| --- | --- |
| real payloads | **400 / 400** exact |
| byte-shuffled payloads, same declared length | 0 / 400 |
| random bytes, same declared length | 0 / 400 |

Applied to a whole match:

| | |
| --- | --- |
| delta frames parsing exactly | **12,828 of 18,308 (70.1%)** |
| sections recovered | **1,104,738** |
| payload bits inside section bodies | **84%** |
| delta payload now structured | **20.7 MB** of 39.8 MB |

For comparison, everything before this point in the document was built from
about **2,800** byte-aligned records.

Section lengths are a schema, not free-form: the ten commonest account for the
bulk — 48 bits (476,295), 80, 64, 117, 154, 149, 133, 223, 96, 186 — and a
sampled window uses only ~22 distinct lengths.

### The 48-bit section

The commonest record has a rigid shape, constant across all 476,295 instances:

```
01 | b1 | b2 | 81 37 | 00
```

Byte 0 is always `0x01`, bytes 3-4 are always `0x3781` (a type id), byte 5 is
always zero. Only `b1` and `b2` carry data. `b2` spans **0..63 with 62 distinct
values** — and the test map is 62x62, so it is almost certainly a cell
coordinate. `b1` spans 1..254 with 155 distinct values; read as `b1/4` it puts
72% of records within 25 cells of one of the two decoded base centroids, the
best of the divisors tried, but that is suggestive rather than proven, and only
242 distinct `(b1,b2)` pairs occur in a whole match, which is fewer than free
positions would give.

So: **the framing is solved and the payload is structured; the field semantics
of individual record types are not yet.** `parseSections` and `readSection` in
`object-stream.ts` expose the sections for that work.

### 48-bit record: decoded as a per-object update

```
byte 0   0x01      constant across all 476,295 instances
byte 1-2 key       unique object identifier
byte 3-4 0x3781    constant — record type marker
byte 5   0x00      constant
```

**Bytes 1-2 are an object key, not a coordinate.** Evidence:

- A key **never repeats inside a single frame**: 0 collisions in 2,000 frames.
  One record per object per frame is exactly what an identifier does and what a
  coordinate would not.
- The set of distinct keys grows **monotonically** over the match
  (22 → 49 → 101 → 161 → 201 → 242) and then stops, the way an object roster
  accumulates. 242 total, against 368 objects seen in named records — the
  difference being terrain and transient animations, which are named but do not
  get per-frame updates.

Two coordinate readings were tested and rejected:

- **Tiberium cells.** The map has 734 tiberium cells and the best cell encoding
  put 44 of 242 keys on one — **18.2%**, which is precisely the base rate
  (734/4096 = 18%). Chance, not signal.
- **Free map positions.** Only 242 distinct pairs occur in a whole match, far
  too few for the positions of ~100 moving objects.

So the commonest record in the stream — 43% of all 1.1M sections — is a
minimal per-object update carrying an object key and a type marker, with the
changed state presumably in the longer sibling records (80, 64, 117, 154 bits)
that share the same frame.

## The record grammar

Every section in the delta stream has the same head:

```
record := 0x01 | key : u16 | type : u16 | payload
```

`key` identifies the thing being described; `type` says what kind of record it
is. Byte 0 is `0x01` on every one of the 1.1M sections examined.

### Record types observed in one match

| type | records | distinct keys | what it is |
| --- | --- | --- | --- |
| `0x8137` | 1,034,245 | 268 | per-object update (48/64/80/117 bits) |
| `0x8157` | 32,140 | 181 | larger per-object update (~415-455 bits) |
| `0x8177` | 5,470 | 180 | **object introduction** — 5,137 carry asset names |
| `0x01b8` | 12,373 | **1** | per-player production (see below) |
| `0x0198` | 12,302 | **1** | per-player production, the other side |
| `0x0117` | 4,119 | **1** | per-player **dynamic map** |
| `0x0197` | 3,873 | **1** | per-player dynamic map, the other side |

The singletons come in **pairs** — one record per player, once per frame. That
is what `CNC_Get_Game_State` looks like from the outside: it is called per
player, and fog means each side gets a different view.

**`0x0117` / `0x0197` are `GAME_STATE_DYNAMIC_MAP`.** Their payloads name
`TI1`-`TI12` (tiberium overlay stages), `CR1`-`CR5` (craters) and `SC1`-`SC6`
(scorch marks) — tiberium growing and being harvested, and the marks combat
leaves behind.

**`0x01b8` / `0x0198` carry production**, with a rising build progress in the
same packed `state<<10 | progress` form found earlier:

```
type 0x01b8, key 0x780c:  t=11.2s  HAND cost=300 state=10 progress 9 -> 19 -> 38
type 0x0198, key 0x1e1a:  t=15.0s  HAND cost=300 state=10 progress 9 -> 19 -> 28
```

**This is production attributed to a player by construction** — the record type
*is* the side — and the timing is far better than anything inferred from object
sightings:

| | old (from object sightings) | from the production record |
| --- | --- | --- |
| first Hand of Nod, side A | ~0:46 | **0:11** |
| first Hand of Nod, side B | 0:14 | **0:14** |

The player's objection that "a first Hand of Nod at 1:26 is simply not
possible" was right, and this is where the real answer was.

### Still open

The production records surface only `HAND` (plus one `E3`) in this match, so
they are one factory's queue rather than the whole sidebar — the Construction
Yard's building queue has not been located among the types yet. Field offsets
inside the larger payloads are also still read by byte-scanning rather than
from a known layout.

## Keyframes use a different header

Keyframes were not parsing into sections at all, because their header differs
from a delta's:

| | delta (type 0) | keyframe (type 1) |
| --- | --- | --- |
| payload bit length | `u32 @ 9` | **`u32 @ 13`** |
| payload starts at | byte 17 | **byte 21** |

With that, **21 of 21** keyframes chain exactly, and they contain the same
record types as the deltas (`0x8137` x1898, `0x8157`, `0x01b8`, `0x0198`,
`0x8177`, `0x0117`, `0x0197`), roughly 97 sections per keyframe. A short tail
of one-off type codes at the end of each keyframe suggests the chain drifts
before the end, so keyframe parsing is close but not exact.

## Tested: are the sidebar tabs separate record types?

The player pointed out that the Remastered sidebar has production tabs —
buildings, infantry, vehicles/aircraft, superweapons — and suggested the
missing building queue is one of them. That predicts several sidebar record
types per player, each carrying a homogeneous class of asset names.

**It does not hold in this replay.** Across deltas and keyframes there are
exactly **12 record types**, and the two per-player production records mention
only `HAND` (342 and 100 times, plus a single `E3`) in 12,373 and 12,302
records. A buildings tab would contain `NUKE`, `PROC` and `AFLD`; none appear
in any record type.

Two readings survive and cannot yet be separated:

1. The sidebar's full entry list is bit-packed inside those records, and the
   name scan only recovers byte-aligned strings — so only some names surface.
2. `0x01b8`'s key `0x780c` identifies **one specific Hand of Nod**, and the
   record is that building's own production state rather than a sidebar tab.

Reading 2 fits the counts: `0x01b8` shows four complete `HAND` ramps
(0:11, 2:36, 3:17, 3:24) against three Hands of Nod built by that player.

Either way the timing these records give is far better than anything inferred
from object sightings — first Hand of Nod at **0:11** rather than ~0:46 — and
it is attributed to a side by the record type itself.

## SOLVED: the real build order

Two bugs, both suggested by the player, were hiding the entire sidebar.

**1. Sidebar entries are packed at arbitrary bit alignments.** Reading a
production record only on its natural byte alignment recovered exactly one
asset name in a whole match (`HAND`). Re-scanning the same records at all eight
bit shifts recovers the rest:

| shift | names found |
| --- | --- |
| 0 | HAND |
| 1 | **NUKE**, GUN, E4 |
| 4 | BGGY, E1 |
| 5 | **PROC** |
| 6 | **AFLD**, E4 |
| 7 | E1 |

**2. Cascading filters.** The scan advanced `p += 3 + len` after a match *and*
after a validation failure, so a rejected false positive would skip past a real
entry behind it — one filter hiding data from the next. The scan now never
skips.

### Result, checked against the player's own account

The player described their Heavy Metal build before any of this was readable.
Decoded, side 0:

| player's account | decoded | |
| --- | --- | --- |
| power plant first | **0:05 NUKE** | correct |
| then Hand of Nod | **0:11 HAND** | correct |
| "4-5 minigunner-flamer, sure it was 4 minies" | **E1 x4** at 0:17, 0:19, 0:21, 0:24 | correct, exactly four |
| flamers | E4 x5, 0:26-0:38 | correct |
| ref, ref | 0:16, 0:29 PROC | correct |
| 2nd power plant | 0:42 NUKE | correct |
| 3rd ref | 0:48 PROC | correct |
| airfield | **1:01 AFLD** | correct |
| 3rd power plant | 1:44 NUKE | correct |
| 4th ref, 5th ref | 1:52, 2:20 PROC | correct |
| 4th power plant | 2:30 NUKE | correct |
| hon, hon | 2:36, 3:17 HAND | correct |

And side 1, against "he went 3 ref air into 2nd air": refineries at 0:20, 0:35
and 0:49, then the airstrip at 1:07.

`readProduction()` in `object-stream.ts` returns these runs — side, asset, cost,
start, end, peak progress — 213 of them in this match. This is the actual
per-player build order with real queue times, not an inference from when a
finished building was first noticed.

## The Construction Yard, and why decoded structures must not be killed

A Construction Yard never appears in the production records, because it is
never produced: every player starts with an MCV, drives it somewhere, and
unpacks it. It has to be carried across from the object records instead.

Its own sighting is useless as a timestamp. The yard sits in the base for the
whole match, so the stream first reports it long after it existed — 219s and
379s in the sample replay, for yards that were standing in the opening.

What does pin it down is a constraint rather than an observation: nothing can
be produced without a yard, so the owner's **first production start bounds the
deploy**, and bounds it tightly, since the first power plant is queued as soon
as the yard is down. That gives 0:05 and 0:09 in the sample — and it reads a
moved MCV correctly with no special case, because a player who relocates before
unpacking simply starts producing later. The MCV is ordered to the yard cell at
t=0 and deploys there, so the drive is shown rather than teleported.

Separately: synthesised combat was deleting decoded structures. The generated
`kill` command falls back to "the other player's Construction Yard" when it
carries no entity id, so the reconstruction was demolishing a real base
mid-match — player 1 finished with 6 of its 10 decoded structures, yard
included. Snapshots drop dead entities (`capture()` filters on `alive`), so the
losses left no trace to find; they simply were not there at the end.

The replay does not record what destroyed what, so `kill()` now refuses to
destroy a structure flagged `real`. Deleting one would replace ground truth
with an invented event. Both bases now survive at 17/17 and 10/10.

## Naming the two sides

The owner byte in an object record is the house **shifted left one bit**. Every
sampled match uses exactly `0x8` and `0xa`, which are `HOUSE_MULTI1` (4) and
`HOUSE_MULTI2` (5) from `DEFINES.H` — 8 and 10 are not valid house indices, but
4 and 5 are, and they are the first two multiplayer houses.

That matters because houses are handed out in the order players appear in the
replay's own `replayInfo` JSON, and that list identifies each player by Steam
ID — the same id the ladder API reports. So the chain

    owner byte >> 1  ->  house  ->  playerList index  ->  Steam ID  ->  ladder name

names each decoded base outright, with nothing guessed.

The previous rules were guesses, and wrong. Faction-exclusive structures only
separate a mixed matchup, and Nod mirrors are the most common ladder game; the
fallback ("whoever built first is player one") swapped both players' names on a
real match. Those heuristics now only run for a replay whose player list cannot
be read or matched to the header.

## Pairing a production run to the cell it was built on

Production records give the type and the timing; object records give the cell.
Joining them by *earliest sighting* is wrong, and visibly so: sightings are
sparse and arrive in no dependable order, so a player's first refinery could be
handed the cell of a late expansion refinery half the map away. The build order
read correctly and every cell was one that player really built on — but the
wrong one came first, and the base appeared to start outside its own buildable
area instead of growing outward.

The game rules that out. A structure can only be placed within reach of the
base already standing, so a cell far from the base at that moment cannot be
what just finished. Runs are now paired oldest-first, each taking the candidate
closest to the base *as it stands at that point*, with earliest sighting only
breaking ties. Each pairing extends the base and constrains the next.

Measured over the sample match, reach-to-nearest-building per placement is 0-7
and mostly 3 — adjacency, for footprint corners — where the old pairing put a
first refinery 8 cells out with nothing near it.

## Is there a "place building at (cell,cell) at time T" record?

Asked directly, and worth answering with evidence rather than assumption,
because the original engine does have one: `EVENT_PLACE` in `EVENT.CPP` carries
an `RTTIType` and a `CELL`.

**Not in this file.** Scanned all 1,106,790 parsed sections (17.6MB of section
bytes) for a `CELL` u16 in every candidate packing, against a control set of
random non-building cells of the same size and coordinate range:

| encoding  | real-cell matches | control matches | ratio |
|-----------|------------------:|----------------:|------:|
| `y<<6\|x` |             8,512 |           5,880 |  1.45 |
| `y<<7\|x` |             5,694 |          10,081 |  0.56 |
| `x<<6\|y` |             9,027 |           9,494 |  0.95 |

Two of the three score at or *below* chance. Any given u16 occurs ~270 times by
accident in 17.6MB, so per-type "1.0 hits per section" results are what noise
looks like — as is the fact that the scan finds 14,854 distinct section "types"
when only four are real (`0x3700`, `0x0001`, `0x4000`, `0xbc29`).

That fits what the container is. This is a recording of the **state stream** the
game DLL sends its frontend — the records decode as `CNCObjectStruct` and
`CNCSidebarEntryStruct`, the DLL's own structures — not a command log. It
records what the game *displayed*, not what the player *pressed*. That is also
why it is 39.8MB where a BroodWar command log is ~100KB.

**But the substance of the question is right**, and the numbers say where the
limit actually is:

    frames = 18,329 over 407s
    keyframes =     21   (3.1MB), spaced 20.8s apart
    deltas    = 18,308  (39.8MB), still undecoded

Object records — name, owner, and cell, which *is* "what, whose, and where" —
live in the keyframes. So every position we have is where a building stood at
**the next keyframe after it was placed**, up to 20.8s late. That is the whole
reason placement times ran late, sightings are sparse (3-14 per structure), and
the run-to-cell pairing needed the build-reach constraint to order them.

Cracking the delta frames would give placements at the stream's native ~22ms
resolution and make the pairing heuristic unnecessary. That remains the prize.

## Cracking the delta frames

The deltas were written off as undecodable because their *section* framing does
not parse. That was the wrong conclusion from a true observation.

`parseObjects` scans raw bytes for the record signature — `u32 len | TypeName |
u32 len | AssetName | body` — and never needed section framing at all. It had
simply never been handed a delta payload; the pipeline fed it `readSection`
output, and `parseSections` fails on deltas. Passing the raw delta payload
straight in works:

    delta object records:    3,293   (30 buildings, 104 units, 46 infantry)
    keyframe object records:    14

**Position sits at body offset 35 in a delta, not 29.** Calibrated against
three structures whose cells were already known independently — the first power
plant and both Hands of Nod. Of the fifty offsets scanned, 35 is the only one
reproducing all three exactly and simultaneously: (52,13), (20,45), (54,16).

Records are byte-aligned. Scanning all eight bit alignments across ninety
seconds found 212 records against 210 — noise, so alignment scanning is not
worth its cost here.

### What the name hits in deltas mostly are

Searching deltas for asset names finds far more hits than there are object
records (HAND: 155). Most are **sidebar production entries**, not objects — one
name field where an object record has two, followed by the cost and a progress
byte that climbs frame to frame:

    04 00 00 00 "HAND" 08 00 13 00 0f 00 00 2c 01 ... 09 ...
                                        ^^^^^ 0x012c = 300 credits
                                                       ^^ progress, 0->9->19->28

300 is the Hand of Nod's real price. `readProduction` already reads these, and
`parseObjects` is right to reject them.

### What this bought

Delta sightings are folded into each owner's candidate pool, earliest-per-cell
winning. Placement evidence tightens sharply where a delta caught the structure:

    NUKE @52,13   queued 6s, 5s build -> placed 12s   (was: next keyframe)
    HAND @20,45   queued 15s          -> placed 26s
    PROC @25,48   queued 49s          -> placed 67s

Coverage is 10 of 26 structures, so the rest still fall back to keyframe
sightings and the build-reach pairing constraint still earns its place. Queue
times were already exact from the production stream and are unchanged — this
improves the *evidence for pairing*, not the displayed timing.

Getting the remaining 16 structures means finding why a creation record is
emitted for some objects and not others. That is the next thread.

## There are no creation records — and why sold structures vanish

The delta object records are **not** creation events. They are a sparse,
irregular re-send of object state:

* 23 distinct buildings, each seen 1-5 times across a 7-minute match
* gaps up to 300s (`NUKE#1` appears at 12s, 26s, then not again until 338s)
* mildly clustered near keyframes — 448 records within 1s of one, against
  ~130-180 per second thereafter — but spread across the whole stream

So a structure's first sighting is whenever the rotation happened to include
it, not when it was built. That is the whole answer to "why do only some
objects get creation records": none of them do.

It also explains the structures that never appear at all. An object has to be
re-sent at least once to be seen, so **one sold or destroyed before its turn in
the rotation is never transmitted** — no cell, no placement, nothing to draw.
That is why owner 0xa has 7 refinery production runs but only 4 decoded cells.

### Object ids are allocation order, and they prove it

The id on each record is a global allocation counter, and it lines up exactly
with production completion order:

| id | object | owner | completed |
|---:|--------|-------|----------:|
| 0 | FACT | 0xa | (MCV deploy) |
| 1 | NUKE | 0xa | 10s |
| 2 | FACT | 0x8 | (MCV deploy) |
| 3 | NUKE | 0x8 | 14s |
| 4 | HAND | 0xa | 16s |
| 5 | HAND | 0x8 | 20s |
| **6** | **missing** | **0xa** | **28s — a refinery** |
| 7 | PROC | 0x8 | 32s |
| 8 | PROC | 0xa | 41s |
| **9** | **missing** | **0x8** | **47s — a refinery** |
| 10 | NUKE | 0xa | 47s |
| 11 | PROC | 0xa | 60s |
| **12** | **missing** | **0x8** | **61s — a refinery** |
| 13 | AFLD | 0xa | 103s |

The two Construction Yards take ids 0 and 2, the two opening power plants 1 and
3, the two Hands of Nod 4 and 5 — the players interleave in exact completion
order, with no exceptions in the sequence.

The gaps below the highest id seen (28) are **6, 9, 12, 20, 21, 22, 27**. Id 6
is owner 0xa's first refinery, completed at 28s — the one that player sold.
It is not that the decoder missed it; it was never transmitted.

This makes the missing structures *identifiable*: the id sequence says exactly
which production run each gap belongs to, so their type, owner and timing are
all known. Only the cell is not, and the replay does not contain it. No
position is invented for them here.

The same ordering is also an exact replacement for the build-reach pairing
heuristic wherever a gap's neighbours are both seen — that is the next change,
not a guess to make hastily.

## APM: removed, not fixed

The APM readout was counting real actions per minute over an **invented**
command stream. `apmEvents` counts every command the simulation executes, and
apart from the ~26 decoded placements those commands come from the generator.
Correct arithmetic, fabricated input.

It cannot be computed from this file. There are no player commands in a
`.Replay` — it is a state stream recording what the game drew, not what was
pressed. Selection in particular is frontend UI state the DLL never sees:
scanning all 64 body bytes of every object with 4+ sightings, the most active
flag-like field changes 96 times in a whole match, where a player at 100+ APM
selects units hundreds of times. Nothing in the records moves at selection
frequency.

So the readout is gone rather than patched. A verified *lower bound* is
available later if wanted — every production queue-start is a real click with
an exact decoded timestamp, as is every placement — but it would badly
undercount, and it has to be labelled a floor. An unlabelled fabricated number
looked authoritative and was not.

Movement is a different case. Move *orders* do not exist to be found, but
observed unit positions do: of 75 distinct mobile objects, 54 are seen more
than once and 38 genuinely change position. Infantry tracks read as real paths
(`E1#1`: 18,48 -> 29,38 -> 39,24 -> 41,45 -> 49,40 -> 57,30 -> 58,13). Cargo
plane and buggy tracks still bounce between three or four constants, which is
the per-type position offset being wrong for those types — the same bug that
hid the refineries, fixable the same way.

## Move orders: the record body was being truncated

Prompted by the observation that the *game's own* replay viewer shows a
selected unit's move order. That does not imply a command log — in Remastered
the viewer draws it from the object's navigation destination, which is a
**state field on the object**, not a recorded command. So it should be in the
records already being read.

It was, and it was being cut off. `parseObjects` kept `body + 64` bytes. A
`CNCObjectStruct` is far longer: the records run to at least **220 bytes**, and
offsets 68, 76, 80, 85, 86, 90, 91 and 99 all decode as in-bounds map cells.
Every one of them was being discarded before anything could look at it. That is
also the likely reason vehicles and aircraft never resolved a sane position —
theirs lies past the cut, which is why C17 and BGGY tracks read as three or
four repeating constants.

`OBJECT_BODY_BYTES` is now 220. Structures are unaffected: all 23 decoded cells
are identical before and after.

**A destination field is not yet confirmed.** Testing whether a unit moves
*toward* each candidate field between consecutive sightings:

    offset 86   approach +14.81 cells (n=14)
    offset 68   approach  +9.68 cells (n=27)
    offset 41   approach  +7.08 cells (n=18)
    offset 91   approach  -1.78 cells (n=27)

Strongly positive for 86 and 68, but the samples are small and no permutation
null has been run. Treat as a lead, not a finding.

### A dead end worth recording

Widening `findCellOffset`'s search to the whole 220-byte body **regressed unit
tracks**. It scores an offset by how many distinct values it yields, which
stops discriminating across hundreds of candidates; infantry that had read as a
real path (`E1#1`: 18,48 -> 29,38 -> 39,24 -> ... -> 58,13) collapsed to
(6,0),(4,0),(3,0). The search stays at 24..52.

Identifying the fields past 64 needs a stronger criterion than "varies a lot" —
track continuity (small step between consecutive sightings of one object) is
the right measure, and picking position that way is the prerequisite for
confirming the destination field.

## Track continuity scoring — and offset 86 disconfirmed

`findCellOffset` scores an offset by how many distinct values it produces.
That identifies a structure's position (structures never move) but is the wrong
question for a unit, where plenty of unrelated fields vary.

`findMobileCellOffset` asks instead whether the values *behave* like a
position: between two sightings of the same object a few seconds apart, a real
position can only have changed as far as that unit can travel.

**Offset 86 is not the position field, and not a destination either.** It had
looked confirmed at "100% plausible steps over 47 pairs" for both C17 and BGGY.
It is a near-constant: its total travel across the whole seven-minute match is
**1.1 cells**. A field that never moves never breaks a speed limit, so it
scores perfectly on plausibility alone. The earlier "+14.81 cells approach"
that made it look like a navigation target was the same artifact measured from
a wrong position offset.

Two guards now prevent that class of error:

* `MIN_TRAVEL` — a position must cross real ground over a match
* `MIN_PLAUSIBLE` — below 90% physically-possible steps, no field is accepted

With a permutation null (field drawn from a random other record of the same
type) **no destination field survives** either: offset 68 z=-0.1, 41 z=1.5,
91 z=-2.4, 80 z=2.0 across nine candidates — exactly the spread chance
produces. There is no navigation-target field in these records.

### Where unit positions stand

| type | result |
|---|---|
| E1 infantry | **offset 29**, 100% plausible, 49.5 cells travelled, 27 distinct cells |
| C17 aircraft | best candidate 74% (offset 24, only 10 cells travelled) — rejected |
| BGGY vehicle | best candidate 55% — rejected |
| E4, HARV | too few records to score |

Aircraft were retested with a 15 cells/s cap in case the ground limit was
unfair to them; they still do not resolve. So infantry paths are real and
decoded; vehicles and aircraft are dropped rather than given invented
positions. Their position is either encoded differently or carried in a record
shape not yet parsed — that is the open thread, not a tuning problem.

## C17 is not an aircraft — correcting the previous section

The C17 is the cargo plane that flies a finished vehicle in to the airstrip.
It is a delivery animation the engine spawns, not a unit: it cannot be
selected, ordered or killed. Treating it as player aircraft put six phantom
planes in the unit list and, worse, sent the position search hunting for a
flight path that is *scripted rather than recorded* — which is why no offset
ever produced a coherent C17 track and why the section above spent its effort
on the wrong object. `ENGINE_SPAWNED_ASSETS` now excludes it.

It is still worth reading, because it independently confirms the production
decoding. Every C17 flight coincides with a vehicle completion:

    flight #0  127s -> BGGY completion  -2s
    flight #2  130s ->                   0s
    flight #3  143s ->                  -0s
    flight #1  145s ->                  -0s
    flight #4  150s ->                  -0s
    flight #5  242s ->                  -0s

Two unrelated signals — the sidebar production stream and a delivery animation
in the object stream — agreeing to within two seconds. That is the strongest
check yet that the production timings are right.

So the open problem is narrower than stated above: **BGGY** is the only mobile
type that genuinely fails to resolve a position (best candidate 55%). Infantry
resolve cleanly at offset 29. Aircraft as a category were never the issue,
because the only "aircraft" in the sample was not one.

## BGGY: cracked, and the answer is that it has no position

The buggy records carry **no positional field at all**. Scanning every offset
in the 220-byte record for a value that stays on the map and varies in *both*
axes returns nothing for BGGY, while E1, HARV and E4 all resolve immediately at
offset 29.

What had been scoring 55-73% and looking like a near-miss was two impostor
fields:

* **offset 25** — `y` always 0, and `x` is the **object id itself**: id 13
  decodes as x=13, id 33 as x=33, id 19 as x=19. It scored well on distinct
  values and on travel because ids are many and spread out.
* **offset 41** — another flat field, y always 0, x alternating 0 and 35.

Neither is a position, and no amount of speed-cap tuning was ever going to fix
that. The gap was in the test, not the data: a position varies in **two**
axes, and nothing was checking the second one.

Also ruled out along the way: unit ids are **not** globally unique (41 distinct
ids across 52 owner:id pairs — 11 ids used by both players), so tracks are
keyed on owner and id together. Keying that way made BGGY's score slightly
*worse*, which is itself evidence the field was never positional.

### Gates now in findMobileCellOffset

| gate | what it rejects |
|---|---|
| both axes vary (>=5 distinct each) | `y`-always-0 fields — the BGGY trap |
| x never equals the object id | the id field masquerading as a position |
| MIN_TRAVEL = 4 | constants (offset 86 travels 1.1 cells all match) |
| MIN_PLAUSIBLE = 0.9, when measurable | fields that teleport |
| speed test skipped when pairs < 4 | ranks sparse types below measured ones rather than discarding them |

`MIN_TRAVEL` is deliberately low. The two-axis and not-the-id gates do the real
work; a high travel bar instead discards genuine short-range units. At 8 it was
silently dropping every harvester, which shuttles at most 6.7 cells here.

### Result

Emitted with real positions: **E1 (35), HARV (22), E4 (11)** — all at offset
29. Harvester tracks read correctly, including round trips
(`HARV 77s(57,10) -> 130s(59,5) -> 150s(57,10)`) and each sitting in its own
owner's base. That matters beyond units: harvesting is currently simulated, and
these are the real positions to replace it with.

BGGY is dropped, correctly — 58 of 96 units have no recorded position, and an
invented one would be worse than none. All 23 structure cells unchanged
throughout.

## Harvesting driven by real positions

Harvesting was modelled end to end: the simulation picked a Tiberium patch,
drove there, and credited the owner. The replay does record where each
harvester actually was, so those cells drive it now.

* `HARV` sightings are grouped per harvester and emitted as a `spawn` at the
  first, then a `move` for every later cell it was seen in.
* Identity is **owner + id**, never id alone: unit ids are not unique across
  players (11 are shared in the sample match).
* The simulation **adopts** the harvester its refinery already produced rather
  than adding a second one. A refinery hands over a harvester the moment it
  finishes, so by the time the replay first sees that harvester the model has
  already built it; adopting keeps the count right and hands its steering over
  to the replay.
* `tickHarvest` skips patch-picking and return-routing for a harvester with a
  `ref`. It still fills up while standing on Tiberium and still unloads on
  reaching a refinery — so the income is produced by where the harvester
  really was.

Two things this does **not** do, stated plainly:

* **Credits are still modelled.** No credit total has been found in the
  replay, so `HARVEST_VALUE` remains an assumption. What changed is that the
  movement feeding it is real, not that the number is.
* **The routes are coarse.** 22 sightings across 9 harvesters means two or
  three waypoints each, so a harvester mostly holds position between them
  rather than shuttling continuously. That is the sampling rate of the object
  stream, not a decode limitation — and it is what the replay actually says.

Measured: 11 harvester spawns and 4 move orders; every harvester in the
simulation is replay-driven (3 for one player, 6 for the other).

### Two format bugs found on the way

`encodeReplay` never encoded `real`, so a binary round-trip silently dropped
the flag marking a command as decoded ground truth — a real placement would
have faced the modelled credit check, and a real structure could have been
destroyed by synthesised combat. The viewer reads the JSON replay rather than
the binary, so nothing was broken in practice, but the binary was not faithful.
`real` is now flag bit 5, `ref` is bit 4.

The per-command buffer budget was 24 bytes while a command carrying
kind + x/y + id + target needs 28. Nothing emitted that combination, so it
never overflowed — it was one command shape away. Now 32, which is the true
maximum.

## Credits: not in the file

Searched for, and not found. What was tried:

* **The starting value.** `u32 == 10000` does not occur *anywhere* in the
  first keyframe, nor anywhere in the first eight seconds. If credits were
  transmitted as an int, the opening balance would be sitting there.
* **House records.** No `Multi1`, `Multi2`, `GoodGuy`, `BadGuy`, `Neutral` or
  `Special` string appears in the stream, so there is no
  `CNCPlayerInfoStruct`-style record carrying a name and a balance.
* **The sidebar header.** `CNCSidebarStruct` holds `Credits` alongside the
  entries we already read, so the bytes ahead of those entries were the best
  candidate. Across all 442 sections that carry sidebar entries, no offset in
  the first 40 bytes holds a value starting near 10000.
* **File-wide.** `u32 == 10000` does occur 177 times against 0.01 expected by
  chance, so the value means something — but the first is at t=56s, not t=0,
  and the context is a byte-identical constant block (`a0 73 0b 00` = 750000
  next to it, repeating unchanged across frames). A constants table, not a
  balance that moves.

So credits remain modelled. Everything below is the model, chosen to match the
game's behaviour rather than to imitate a number we cannot read.

### Income is paid per docking

`HARVEST_VALUE` is 100 and a harvester holds 7 bails, so a full load unloads
for **700** — the Tiberian Dawn figure. Income therefore arrives in whole loads
at the moment a harvester docks, not as a per-tick trickle. Measured totals are
all exact multiples of 700 (700, 1400, 2800, 3500, 4200 ...), which is the
check that it is really docking-driven.

Because harvester *movement* is decoded (see the previous section), the income
follows where the harvesters actually were.

### Construction is billed while it builds

Placement no longer takes the full price up front. The cost is carried on the
entity as `owed` and drawn down each tick in proportion to that tick's build
progress, so a structure has cost exactly its price by the time it completes
and the readout falls steadily across the construction — as it does in game:

    0s 10000 | 6s 9983 | 8s 9856 | 12s 9649 | 20s 9400 | 30s 7850

### The counter rolls

`useRollingCredits` eases the displayed figure toward the true one instead of
snapping, starting from 0 — so a match opens with the counter spinning up to
10,000, and every payment and harvester load slides in. The step is
proportional with a floor, so large changes move fast and small ones still
land.

## Match pages for games the ladder never saw

`getMatchFn` and `getReplayFn` both required a ladder row, so a match with no
row rendered "Match not found" while its `.Replay` sat on disk, fully
decodable. Custom games are never ranked and so never appear in the ladder API
at all; old matches age out of the current season the same way.

`matchFromLocalReplay` builds the record from the file instead. Everything it
needs is in the replay's own `replayInfo`: map, duration, winning team, both
factions and both Steam IDs. Names are resolved from the players table by Steam
ID, so a custom game between two ranked players shows their aliases; an id the
ladder does not know falls back to **the id itself** rather than an invented
name. The ladder row still wins whenever there is one — this is a fallback,
not an override.

Verified on match 1695071, a 2021 game absent from the current season:
Green Acres, `76561198135963477` vs Peasy, NOD vs NOD, Peasy victory, 7:00 —
one alias resolved, one id shown plainly.

Worth recording: match 7967023 turned out to be a **ladder** match after all,
not a custom one. Its earlier "Match not found" was a race with the initial
seed, not a missing row, and the fallback is not what serves it — confirmed by
instrumenting the fallback and seeing it never fire for that id. Its winner
therefore comes from the ladder, which is authoritative.

## The house-order identity rule was wrong — retracted

An earlier section claimed the owner byte is the house shifted left one bit,
and that houses are handed out in the replay's `playerList` order, so
`owner >> 1` indexed straight into that list. **That is false**, and it named
the wrong player as the wrong base.

Tested across 18 local replays with **mixed factions**, where the answer is
independently known because only Nod builds a Hand of Nod and only GDI a
Barracks:

    lower house = playerList[0]  (ascending):  12
    lower house = playerList[1]  (descending):  6

Chance. Inverting the rule would only have overfit to one match. The premise
fails too: the owner bytes across those replays are 0x8, 0xa, 0xe, 0x10 and
0x12 — houses 4, 5, 7, 8 and 9 — so players are assigned arbitrary multiplayer
slots, not the first two in list order.

### What replaced it

Three rules, strongest first:

1. **Faction** — decisive in a mixed matchup, and the basis of the test above.
2. **Spawn location** — the ladder reports a per-player spawn index. Nod
   mirrors are the most common ladder game and faction says nothing there, so
   the two decoded bases are ordered west to east and paired against the two
   players ordered by that index.
3. **First build** — last resort, keeping the sides at least self-consistent.

The west-to-east ordering is **calibrated, not proven**. It rests on one match
with independent ground truth: the player's own account of holding the
top-right base, agreeing with the ladder's winner and with that base's decoded
build order (PP, HON, ref, ref, PP, ref, airstrip). A second confirmed mirror
match could overturn it, and the code says so.

Verified end to end on match 7967023:

    Ronaldo-r9    (location 0):  9 structures, centroid (22,46) = BOTTOM-LEFT
    IIIIIIIIIIII  (location 1): 17 structures, centroid (51,23) = TOP-RIGHT

### Also corrected

That match is a **ladder** match, not a custom game as recorded earlier. Its
ladder row gives `p1 = 76561198209647660 (Ronaldo-r9, location 0)` and
`p2 = 76561198690298449 (IIIIIIIIIIII, location 1)`, winner `...449`. The
replay's own `winningTeam` agrees, which also confirms `winningTeam` indexes
the `team` field rather than the player list.

## Identity, settled: the Construction Yard sits on the spawn waypoint

The west-to-east rule from the previous section was **wrong**, and testing it
is what found the right answer.

Validated against 10 mixed-faction matches (faction gives the answer
independently — only Nod builds a Hand of Nod, only GDI a Barracks), pulled
from the live ladder API and paired with local replay files:

| rule | correct | wrong |
|---|---:|---:|
| house index -> `playerList` order | 12 | 6 (of 18 — chance) |
| bases ordered west-to-east vs `location` | 3 | 7 |
| **Construction Yard nearest reported waypoint** | **10** | **0** |

`location` is not a left-right ordinal. It is an **index into the map's start
waypoints**, which is why Heavy Metal matches report 0/1 or 2/3 depending on
which corners were assigned, and Green Acres reports 1, 2, 4 and 7. Ordering
two players by that number means nothing.

What it does mean is exact. A Construction Yard is an MCV unpacked on the spot,
so it stands on the waypoint, and the yards land essentially on top of them:

    yard (49,48) -> waypoint (49,49)      yard (13,31) -> waypoint (13,32)
    yard (14,13) -> waypoint (14,14)      yard  (9,13) -> waypoint  (9,14)
    yard (51,53) -> waypoint (51,54)      yard (50,31) -> waypoint (50,32)

The waypoints were already in the repo — `map-data.ts` carries them per map,
read from the same `.ini` files that verified the terrain decode. Heavy Metal:
`0:(13,52) 1:(50,11) 2:(49,49) 3:(14,14) 4:(10,34) 5:(53,29)`.

Crucially this **works in a mirror**, because it never consults faction. That
was the whole failing case.

Verified end to end on match 7967023, a Nod mirror:

    Ronaldo-r9    (location 0):   9 structures, centroid (22,46) = BOTTOM-LEFT
    IIIIIIIIIIII  (location 1):  17 structures, centroid (51,23) = TOP-RIGHT

Rule order is now waypoint, then faction (for a replay with no usable waypoint
data), then first-build order as a last resort.

## Orders, destruction, selling, selection — what is actually there

Four separate questions, three separate answers.

### Move orders: found

`MOVEFLSH` is `ANIM_MOVE_FLASH`, the animation C&C draws where you click to
order a move. It is an object like any other in the stream — timestamped, and
crucially **owned**: every combat and fire animation carries owner `0xfe`
(`HOUSE_NONE`), while MOVEFLSH carries a real house. So it attributes an order
to a player.

This is the only player *command* found anywhere in the file, and it exists
only because the order draws something. Measured:

    owner 0xa: 108 orders, 38s..383s = 18.8/min
    owner 0x8:  45 orders, 38s..369s =  8.2/min

    per minute  0xa:  19 17 20 23 10 10  9
                0x8:  11  9  4  7  5  4  5

Only the timing is trustworthy. The destination cell does **not** decode: the
best candidate offset across the whole 220-byte record puts 68% of values on
the map, where a real position field manages 100%. No cell is reported rather
than a wrong one. `readOrderFlashes` returns time and owner.

This is a floor on real actions, not APM — move orders only, missing
selections, attack orders and everything done through the sidebar.

### Destruction: partial

The animations are there (FIRE3 x83, FRAG1 x32, FIRE2 x11, NAPALM1 x8,
FBALL1 x2) but only **NAPALM1** yields a confident position — offset 29, 100%
in bounds. FIRE3 manages 55%, FRAG1 69%, FIRE2 91% on 11 records, FBALL1
nothing. Fire animations most likely hang off a parent object rather than
carrying their own cell, which is why they have no position to find.

The eight located events land on the losing player's base:

    0x8 FACT @17,51 -> explosions at 97s
    0x8 NUKE @19,48 -> explosion at 129s
    0x8 AFLD @23,51 -> explosion at 129s

### Selling: not solved

The intended test was sound — a structure that stops being seen *with* an
explosion at its cell was killed, one that stops with nothing there was sold.
It cannot run: it needs both reliable destruction positions (we have 8) and
reliable disappearance times (sightings are far too sparse). Not attempted
further rather than guessed at.

### Selection: not in the file, confirmed properly this time

The earlier negative was weak — it scanned 64-byte truncated bodies. Repeated
across the full 220 bytes, the one field shaped like a two-player
`IsSelectedMask` is offset 6, values {0,1,2,3}. It is not selection:

    owner 0xa  n=159   0:54  1:55  2:23  3:27
    owner 0x8  n=171   0:48  1:59  2:19  3:45

A selection mask uses a different bit per player. Both owners show the same
spread, so it is some per-object state, not who has it selected. Split by class
it reads 0/1 only for infantry and almost always 0 for buildings, which is not
selection-shaped either.

That fits what the container is. Selection is frontend UI state; the DLL never
sees it, so the state stream cannot record it.

## Infantry animation states

Infantry had two states and one of them was wrong. The code read

    frame = 8 + stage * 8 + facing

which strides through the stand-guard and prone blocks, so infantry never
played their walk cycle at all, and there was no firing pose.

The engine's `DoControls` table lays each sequence out as
`frame = start + facing * jump + stage`, with the eight facings consecutive:

| sequence | frames |
|---|---|
| stand ready | 0..7 |
| stand guard | 8..15 |
| prone | 16..23 |
| **walk** (6 per facing) | 24..71 |
| **fire** (8 per facing) | 72..135 |

E1 carries 532 frames, so the whole table is present. `firing` is now passed
from the renderer (`state === "attack"` with a live target) and falls back to
the standing frame per facing when a sprite lacks the sequence — an Engineer
has no firing pose.

## Vehicles come from the factory that built them

Decoded units were emitted as `spawn` commands at the cell where the object
stream first *noticed* them, which is not where they were produced. Nod
delivers vehicles by cargo plane onto the airstrip, so this dropped buggies at
arbitrary points on the map with no plane and no airstrip involved.

The simulation already had the delivery path — `startDelivery` flies a C17 in
when an `afld` finishes a vehicle — it just never ran, because nothing was
queued. Vehicle production is now fed from the decoded runs instead: each run
becomes a `queue` command at the real moment it entered production, carrying
`real: true` so the modelled economy cannot veto a purchase that happened.

Measured: 143 real queue commands, and spawns reduced to infantry and
harvesters (whose positions and routes *are* decoded). Cargo planes are in
flight at 21 of 35 sampled moments, and at 2:30 every buggy on the map sits
within 8 cells of its own airstrip rather than scattered.

One number to treat with suspicion: 143 buggy runs in a 6:43 match is a lot,
and run detection groups rising progress samples, so it may be over-counting.
The timings are right; the count deserves a second look.

## Selection: still not found, and the search is not converging

The observation that the game's own replay viewer shows selections is correct
and means it is in the file somewhere. Three searches have failed:

1. Toggling small-valued fields across the 64-byte body — nothing at selection
   frequency (this one was on truncated records, so it was weak).
2. The full 220-byte body, testing the prediction that a selection mask uses a
   **different bit per player**: the one candidate, offset 6 with values
   {0,1,2,3}, shows the same distribution for both owners
   (0xa: 0:54 1:55 2:23 3:27, 0x8: 0:48 1:59 2:19 3:45), so it is per-object
   state, not who has it selected. No field anywhere in the record has the
   owner-correlated shape.
3. Brute-force record enumeration on the `0x01 | key | type` grammar, which
   yields 22,381 distinct "types" — false positives from scanning every 0x01
   byte, not a taxonomy.

The blocker is framing, not searching. `parseSections` does not parse delta
frames, so records inside them can only be found by signature scanning, which
cannot distinguish a real record boundary from a coincidental `0x01`. Framing
the deltas properly is the prerequisite for any further decode here — and it
would also settle sell events, which the engine records as `SELL`/`SELLCELL`
event types.

### Verified against the sprite itself

Rendering the frames the picker selects, for one facing:

    idle  frame 2
    walk  frames 36 37 38 39 40 41   -- legs cycling
    fire  frames 88 89 90 91 92 93 94 95   -- muzzle flash on alternating frames

The walk row is visibly a walk and the fire row visibly a muzzle flash, which
is what confirms the `DoControls` offsets are right rather than merely
in-range. Frame selection per state:

    idle   0  1  2  3  4  5  6  7          (facing, one frame each)
    walk  24 30 36 42 48 54 60 66          (facing x 6 stride)
    fire  72 80 88 96 104 112 120 128      (facing x 8 stride)

and each cycles within its own block (walk 36->41 then back to 36; fire
88->95 then back to 88).

### Correction: the walk block starts at 8, not 24

The 24 in the first pass came from memory of the engine table, not from the
sprite, and it was wrong. Measured against the SHP itself:

Frame-to-frame silhouette differences spike at block boundaries. For a walk
starting at 8 with six frames per facing, the boundaries fall at 13, 19, 25,
31, 37, 43, 49 and 55 and average a difference of **26.4** against a baseline
near 22. For a walk starting at 24 the implied boundaries average **15.4** —
*below* baseline, meaning 24 does not sit on block boundaries at all.

Rendering the two candidates as eight rows of six confirmed it: the start-8
rows each hold one direction with the legs cycling, while the start-24 rows mix
directions and run past the end of the walk data.

The firing block is unaffected — boundaries every eight frames from 72 (79, 87,
95, 103, 111) at differences of 47-57, the cleanest signal in the sprite.

Final layout, all eight facings present in each:

    idle   0..7     one frame per facing
    walk   8..55    frames = 8 + facing * 6 + stage
    fire  72..135   frames = 72 + facing * 8 + stage

The original code had the right starting frame but a step-major stride
(`8 + stage * 8 + facing`), which hopped between directions instead of walking
one and never reached two of the eight facings.

### The real bug: infantry were being handed a 32-step facing

Infantry sequences are stored for **eight** facings, and `UNIT_DEFS` already
declares `facings: 8` for them — but `spawn` set every new entity's facing to
`player === 0 ? 8 : 24`, the 32-step compass values for east and west. Run
through `facing % 8` those both collapse to **0, north**, and turn arithmetic
on a 32-step value inside an 8-step system never recovers.

`facingFor` now derives the starting facing from the unit's own facing count,
so a rifleman starts at 2 or 6 where a tank starts at 8 or 24. Measured across
a full match, infantry now occupy all eight facings (0..7) and vehicles the
32-step compass.

There is no missing north animation. `facingFromDelta` uses `atan2(dx, -dy)`,
so 0 is north and the count runs clockwise — matching the SHP's frame order —
and rendering facing 0 shows the rifleman from behind, walking (frames 8..13)
and firing with the muzzle flash pointing away (frames 72..79). What looked
like a missing direction was every unit being stuck on the wrong one.

### There is no animation ini for Tiberian Dawn

Worth recording, since it is the obvious thing to look for. The only `.ini`
files in the asset set are the **maps** (terrain, overlay, waypoints — the
source of the spawn waypoints used for player identity). TD has no `art.ini`
or `rules.ini`; those belong to Tiberian Sun and Red Alert 2. Sequence layout
lives in the engine:

* infantry — the `DoControls` table in `INFANTRY.CPP`
* buildings — `_anims[]` in `BDATA.CPP` (transcribed earlier for the refinery,
  Construction Yard and radar cycles)

So the choice is EA's source or the sprite itself. Quoting the table from
memory produced two wrong layouts; measuring the SHP produced the right one in
a single pass.

## Vehicle sprites: what each SHP actually contains

Audited every vehicle sprite against its unit definition, by measuring how much
sprite each 32-frame block holds. A turret layer is a small overlay; a second
body state is nearly as large as the first:

| sprite | frames | block 0..31 | block 32..63 | reading |
|---|---:|---:|---:|---|
| bggy | 64 | 225px | **9px** | body + turret |
| jeep | 64 | 249px | **9px** | body + turret |
| ltnk | 64 | 191px | 78px | body + turret |
| mtnk / htnk | 64 | - | - | body + turret |
| harv | 64 | 510px | **497px** | body + **second body state** |
| apc | 38 | 282px | 291px (x6) | body + a 6-frame animation |
| bike / ftnk / stnk / arty / mcv | 32 | - | - | body only |
| msam | 96 | 265px | 141px | body + turret + a third block |
| mlrs | 128 | 265px | 114px | body + turret + two more |

Everything already lined up with its definition except the **Harvester**.

### The Harvester was missing its digging pose

Its second block is not a turret — the frames are the same 32 directions with
the collection arms swung out and the scoop lowered, which is why they measure
497px against 510px for driving. They were never drawn.

They now render while the harvester is actually collecting — arrived at the
cell it was sent to and loading there, rather than merely en route:

    driving  frames  0,  8, 16, 24
    digging  frames 32, 40, 48, 56

### Corrections to my own audit

The Buggy is **not** missing a turret. An earlier pass reported
`bggy turret=false` — that grep matched the *asset* name, while the unit key is
`buggy`, which has carried `turret: true` all along. Its 9px second block is a
turret layer and was already being drawn.

The APC's six extra frames and the extra blocks on MSAM/MLRS are real but
unused. The APC's are presumably a door sequence for unloading infantry, which
the simulation does not model, so nothing is drawn for them rather than
guessing at what they depict.

### The digging pose needed a state to trigger on

Wiring the frames was not enough. `tickHarvest`'s replay-driven branch — added
when harvester movement was taken from the decoded tracks — never set
`e.state`, so those harvesters sat in `"idle"` for the whole match. The render
condition keys on `state === "harvest"`, so the digging frames could never have
appeared for exactly the harvesters whose movement is real.

That branch now sets the state it is actually in: `harvest` when standing on
Tiberium at its destination, `move` while still travelling, `idle` otherwise.
Sampled every five seconds across the match:

    harvest: 76   return: 32   move: 93   idle: 369

with the first dig at 40s on cell (49,21). Before the fix, `harvest` would have
been 0 for every replay-driven harvester.

## Every vehicle sprite runs counter-clockwise

The Harvester looked like it was driving backwards, dragging its scoop. It was
— and so was everything else on wheels.

Vehicle SHPs index their facings **counter-clockwise**, opposite to the
engine's facing count. North and south agree either way, which is exactly what
hid it: only the east/west halves are swapped. Confirmed by eye on three
sprites at the four cardinal facings:

* Light Tank turret — facing 8 (east) has the barrel pointing **west**;
  facing 24 (west) points **east**
* Medium Tank turret — the same
* Buggy body — the same
* Harvester — the clearest, because the scoop is unmistakable

`vehicleFrameIndex` now maps every vehicle body and turret through
`(facings - facing) % facings`.

C17.SHP was already indexed this way, with a comment calling it "opposite to
the vehicle sprites". That had it backwards: the plane is not the exception,
it is the only case where the error was obvious enough to catch, because a
cargo plane flying tail-first is hard to miss while a tank barrel pointing the
wrong way along one axis is not. That comment is corrected.

## Harvesting stopped after a dock or two

Two causes, both real.

**Waypoints run out.** The object stream gives a harvester two or three
sightings in a whole match. Once a replay-driven harvester reached its last
decoded cell it parked for good. It now rejoins the model when its waypoints
are spent — heads for the refinery when full, picks a patch when empty — and
the next decoded waypoint overrides that again. Measured across the match:

    before   harvest: 76    idle: 369
    after    harvest: 143   idle: 13   (docking observed to 400s of 403)

**It also now reverses in.** A Harvester backs into the refinery bay rather
than driving in nose-first, so on beginning its unload it turns to face back
out the way it came.

## The army stood still

`pickIdle` uses `find`, which always returns the *first* match — so a single
vehicle per player received every order in the generated stream and the rest
never moved. It now prefers a unit that is actually idle, which spreads the
orders across the army.

It also falls back to any fighter when the requested type has none. The
generated stream names the unit types its own build order would have produced;
real production is whatever the players actually built, which in this match is
almost entirely Buggies, so orders for other types found nobody.

    before   0% of buggies moving
    after    42% moving at any sample, 129 of 136 moved at least once

Worth being clear about what this is: unit *movement* remains synthesised,
because the replay has no move orders in it. What changed is that the
synthesised orders now reach the real army instead of one vehicle.

## Move orders: decoded, destination and all

An earlier section concluded the MOVEFLSH destination "does not decode" —
"the best candidate offset puts 68% of values on the map where a real position
field manages 100%". That was wrong, and the reason is instructive: the field
is at the *same* offset every other animation uses (29). It was rejected
because its **y always carries bit 7 set**. Raw values run 132..174 on a
64-cell map, so read straight they are off the map and look like noise.

Masked to six bits they run 4..61, and the x half decodes to a **whole cell in
153 of 153 records** — chance would manage that at (1/32)^153.

### Verified against ground truth

Whole-numbered cells could still be some other field. So: for each order, how
far is the nearest *later* sighting of a unit belonging to that same player?

    real order cells      8.68 cells   (n=153)
    cells shuffled        13.12 +- 0.45
    z = -9.8

The orders predict where that player's units subsequently went, four and a
half cells better than chance, against a null standard deviation of 0.45.

### What is now real

`readOrderFlashes` returns time, owner and destination cell. Those are fed to
the simulation as move commands, and the **generated movement is dropped
entirely** when real orders decode — there is no reason to keep invented
destinations beside the ones the players actually clicked.

    159 move commands, every one decoded from the replay
    0s  p1 -> (50,10)   0s  p0 -> (17,51)    (the two MCVs)
    38s p1 -> (32,17)   38s p0 -> (27,34)
    buggies: 46% in motion at any sample, 133 of 136 move at least once

**The one thing still not decoded is which unit was selected.** The replay
records the click, not the selection, so the simulation still chooses which
unit answers each order. Timing and destination are real; unit assignment is
not.

This also revives the APM question honestly: these are real, timestamped
player actions — 108 for one player against 45 for the other — and would
support a genuine lower bound, still missing selections, attack orders and
sidebar clicks.

## Selection: a negative worth trusting

Four searches now, the last two properly designed. It is not recoverable from
these records, and the reason is sampling, not technique.

### What was tested

1. Small-valued fields toggling across the 64-byte body — weak, the bodies
   were truncated at the time.
2. The full 220-byte body, predicting that a mask uses **a different bit per
   player**. The one candidate, byte 6 with values {0,1,2,3}, shows the same
   distribution for both owners, so it is per-object state.
3. Every **bit** rather than every byte — 1,760 positions — since the move
   order taught that a field can hide behind an unexpected high bit. 1,229 bits
   pass a naive "toggles sometimes" filter, which is what high-entropy bytes do.
4. Those 1,760 bits against real ground truth: **is this bit set on a unit
   whose player has just given a move order?** That is what selection means.

Test 4 needed one correction mid-flight. Byte 9 bit 1 scored z=5.4 — but byte 9
*is* the owner field (`0xa` = 1010, `0x8` = 1000, so bit 1 separates the two
players), and owner 0xa gave 108 of the 153 orders. Controlling for owner, the
best of all 1,760 bits is **z = 3.6**, which is the expected maximum from that
many tests. Nothing survives.

### Why it cannot work

    distinct mobile objects        96
    sightings per object (median)   2
    gap between sightings of one object   median 23.5s, mean 45.9s

    orders issued   owner 0xa every 1.5s, owner 0x8 every 3.2s

An object is observed roughly **once every 24 seconds**, while a player selects
and orders every **1.5 seconds**. Even if the bit is in the record, the stream
samples it about sixteen times too slowly to associate a selection with
anything. The move order decoded because a MOVEFLSH is its own object with its
own timestamp — the event is the record. Selection is a *state*, and states are
only as visible as the sample rate.

### What is left untried

One hypothesis remains untested: selection may not live on the object at all
but in a separate per-player record holding a list of selected object ids.
That would be a short list of small integers changing several times a second,
and finding it needs the delta section framing that `parseSections` still
cannot do — the same blocker as sell events.

## The delta frames are framed — and selection is definitively not there

Asked whether the filters were hiding it, and whether the move order could be
traced backwards. Both were the right questions.

### Reading backwards from a move order

Anchoring on a MOVEFLSH record and dumping the bytes in front of it shows the
framing directly:

    b6 03 00 | 01 | 15 06 | 81 77 | 08 00 00 00 "MOVEFLSH" | 08 00 00 00 "MOVEFLSH" | ...
    ^u24 bits  ^marker ^key  ^type

`b6 03 00` is 950 bits — 119 bytes, the size of the record that follows.

### The framing

    section := u24 bitLength || ceil(bitLength/8) bytes
    record  := 0x01 || key:u16 || type:u16 || payload

Walked from byte 17 — exactly the `base` `payloadLayout` already reported —
every section body begins with the `0x01` marker in **10,933 of 10,933**
sections across 1,193 frames. Started anywhere else the chain collapses within
a section or two. `readDeltaSections` now does this.

This was the blocker behind every earlier dead end. Without framing, looking
for a record meant scanning for `0x01` bytes, which in bit-packed data yields
**22,381 phantom types**. Framed properly the stream contains **seven**:

| type | count | size | what it is |
|------|------:|-----:|------------|
| 0x8137 | 27,599 | 64 bits | per-frame tick with a counter |
| 0x0198 | 12,264 | 938 bits | object and sidebar records, side one |
| 0x01b8 | 3,132 | 938 bits | the same, side two |
| 0x0117 | 255 | 344 bits | heartbeat: constant key `4b 05`, counter, zero padding |
| 0x8157 | 213 | 378 bits | periodic; median 770ms from the nearest order, only 43/213 within 200ms, and no byte separates the two players |
| 0x0197 | 190 | 344 bits | heartbeat, as 0x0117 |
| 0x8177 | 183 | 934 bits | object records — where MOVEFLSH lives |

### The negative is now structural

Every one of the seven is accounted for: object and sidebar state, two
heartbeats, a periodic record, and a tick counter. **None of them is
selection**, and there is no eighth.

That is a different claim from the earlier ones. Before, it was "I searched
the object bodies and found nothing above chance" — an absence of evidence in
one place. Now the whole stream is enumerated, so it is evidence of absence.

The sampling argument still holds independently: objects are re-sent about once
every 24 seconds while a player selects every 1.5 seconds, so even a selection
bit on the object record could not have been resolved.

Sell events fall to the same conclusion — there is no event record type in the
stream to carry them.

## Retraction: "the stream contains seven record types" was wrong

That claim covered **6.2% of the payload**. Challenged on it — "nothing can be
junk" — and the challenge was correct.

Measured coverage of the byte-aligned framing:

    delta payload total      39.8 MB
      frame headers           0.3 MB   0.8%
      framed sections         2.5 MB   6.2%
      UNPARSED remainder     37.0 MB  93.0%

12,755 of 18,308 frames broke mid-chain. Declaring the stream enumerated on
that basis was not a supportable claim, and the "evidence of absence" argument
built on it is withdrawn.

### The framing is a bitstream

The section length is in **bits**, and sections are packed contiguously in
bits — not padded to byte boundaries. Stepping in whole bytes desynchronises
the moment a length is not a multiple of eight, which is most of them. Reading
it LSB-first as a bitstream:

    byte-stepping   7.0% coverage,   7 record types,     0 frames fully consumed
    bit-stepping   52.4% coverage,  12 record types, 12,828 frames fully consumed

Two of the newly visible types carry marker byte **0x05**, which the old walker
rejected outright — it required `0x01`. That was over-filtering, exactly as
suspected.

### What the bulk of the file is

    0x3781   1,034,245 records x 64 bits   ~8.3 MB

Keyed by stream (105 distinct keys, values 38..16148 — not object ids), payload
`count << 8 | 0x20`, incrementing per key: 0x120, 0x320, 0x420, 0x620 ... It is
a sequence counter. Structural, not junk, but it carries no game state.

### Five unidentified types

| type | n | bits | notes |
|---|--:|--:|---|
| 0x2208 | 68 | 187 | marker 0x05, always emitted together with 0x2403 |
| 0x2403 | 68 | 1024 | same timestamps as 0x2208 |
| 0x2602 | 51 | 962 | 16 of 51 within 400ms of a move order |
| 0x0602 | 27 | 962 | |
| 0x6602 | 2 | 922 | both at 61.6s |

216 records in total, the same order of magnitude as the 153 move orders. These
are the strongest remaining candidates for player events — selection, selling,
production commands — and none has been decoded.

### Where selection stands

Not found, and **not ruled out**. The previous section claimed the stream was
enumerated and therefore selection could not be in it. With 47% of the payload
still unframed and five record types unidentified, that claim does not hold.
What remains true is the sampling argument for the *object* records
specifically: those are re-sent about once every 24 seconds, far too slow to
carry a state that changes every 1.5 seconds. Selection is not on the object
record. It may well be in the unread 47%.

## Coverage: 6.2% -> 98.2%

Pushed on "nothing can be junk", which was right twice over. Two separate
mistakes were capping how much of the file could be read.

### Mistake one: byte alignment

The section length is in **bits** and sections are packed contiguously in
bits. Stepping in bytes desynchronises at the first length that is not a
multiple of eight. Reading LSB-first as a bitstream took coverage from 7% to
52.4% and the type count from 7 to 12 — two of the new types carry marker byte
`0x05`, which the byte-aligned walker rejected outright because it demanded
`0x01`.

### Mistake two: giving up on frames whose chain would not start

5,480 frames had a first length field of zero and were written off. They are
not malformed — they carry a **variable-length prefix** before the chain, median
840 bits. And they are the larger frames, so they held nearly half the payload.

No length field for that prefix has been identified, so the start is found by
search. That is safe because the framing is self-verifying: an offset is
accepted only if its chain consumes the payload to the final bit. Of 5,480
frames, **5,447 resolve**; 33 remain.

The recovery is checkable, and checks out — sections recovered by resync are of
a known record type **99.5%** of the time, against 100% for frames that never
needed it. A coincidental alignment would produce novel garbage types, not the
same seven.

    frames   clean 12,828   resynced 5,447   unsolved 33
    sections 1,104,738 -> 1,743,930
    coverage      52.4% -> 98.2%

### What the unread half contained

| type | before | after | what it is |
|---|--:|--:|---|
| 0x3781 | 1,034,245 | 1,624,676 | sequence counters |
| 0x5781 | 32,140 | 55,224 | periodic |
| **0x7781** | **5,470** | **16,253** | **object records — tripled** |
| 0xb801 | 12,373 | 15,418 | object/sidebar, one side |
| 0x9801 | 12,302 | 15,321 | the same, other side |
| 0x2602 | 51 | 327 | unidentified |
| 0x6602 | 2 | 234 | unidentified |
| 0x2403 | 68 | 226 | unidentified |
| 0x2208 | 68 | 225 | unidentified |
| 0x0602 | 27 | 200 | unidentified |
| 0x0000, 0x6f02, 0x6004, 0x8000 | - | 1,340 / 126 / 80 / 66 | newly visible |

The object records tripling matters most: every position, every track and every
placement time in this project comes from those, and two thirds of them were
being skipped.

The five unidentified types also grew by 4-100x, which makes them far more
tractable as the remaining candidates for player events — selection and selling
among them.

## The object decode, re-run at full coverage

Routing the object decode through the section framing instead of scanning raw
payload bytes.

**Only 2% of sections start on a byte boundary.** The other 98% are bit-shifted,
and their name fields do not read as ASCII until realigned — which is why
scanning raw bytes found so few. `sectionBytes` realigns each section, and
`parseObjects` then sees them all:

    object records parsed   3,293 -> 15,600

    dllType 1 infantry   200      dllType 5 terrain    932
    dllType 2 vehicles   572      dllType 6 anims   12,897
    dllType 3 aircraft   359      dllType 7 bullets    399
    dllType 4 buildings  241

### What it changed

| | before | after |
|---|--:|--:|
| move orders | 153 | **504** |
| HARV sightings | 22 | **187** |
| E1 sightings | 35 | **135** |
| structures placed, owner 0xa | 17 | **25 of 32** |
| structures placed, owner 0x8 | 9 | **11 of 13** |

Harvester tracks are sampled every ~13s now rather than every ~24s, so their
routes are real over more of the match; harvester states across the match run
`harvest 141, move 467, return 60, idle 8`.

### Two bugs the extra data exposed

**Tracks keyed on id alone.** `findMobileCellOffset` grouped sightings by object
id, and ids are not unique across players. With few sightings that rarely
mattered; with four times as many it spliced two players' units into one track,
which reads as teleporting. Now keyed on owner and id together.

**A brittle plausibility gate.** Even correctly keyed, ids are recycled when a
unit dies, so a track occasionally splices a dead unit onto its replacement and
each splice reads as one impossible jump. Infantry scored 87% of short-gap
pairs plausible against a hard 0.9 threshold — at an offset putting **100%** of
readings on the map with 32 distinct x and 38 distinct y. The gate rejected it
outright and infantry vanished from the output. Lowered to 0.75: the in-bounds
rate and the two-axis test are what separate a position from a look-alike;
this gate only needs to reject fields that teleport constantly.

The C17 is excluded here as it is elsewhere — engine-spawned, scripted flight,
and calibration settles on a near-constant field that reports every delivery at
the same spot.

Verified end to end: p0 11 structures at (23,46) bottom-left, p1 25 at (50,27)
top-right — the same sides the waypoint rule assigns, from three times the data.

## Only tanks fire on the move

In Tiberian Dawn only the tracked, turreted vehicles shoot while driving.
Infantry stop, plant themselves and fire; wheeled vehicles stop and turn onto
the target first. Everything in this simulation was firing while driving, which
is why a Buggy raid read as a drive-by rather than the series of halts it
actually is.

`FIRES_ON_THE_MOVE` now holds the Light, Medium, Heavy and Stealth tanks and
the Rocket Launcher. Everything else, on acquiring a target: stops where it
stands, turns to face, and only then fires. The Flame Tank is deliberately not
on the list — it is tracked but its nozzle is fixed, so it has to be pointed at
what it is burning.

Measured over the match, sampling every two seconds:

    non-tank units in the attack state
      stationary while firing   6,693
      still moving                595   (8.2%)

The residual 8.2% is mostly the sampling interval catching units mid-halt: the
check compares positions two seconds apart, so a unit that stopped inside that
window still reads as having moved.

## The five unidentified record types: what they are not

With full coverage they have 200-330 instances each, enough to characterise.
None of them decoded, and it is worth recording what they look like so the next
attempt does not repeat this one.

**0x2602 (327), 0x0602 (200), 0x6602 (234)** — 122 bytes each, marker 0x01, and
all three carry the *same constant key* `82 11`. Their payload is a repeating
12-byte block (`d0 f4 64 55 64 c4 34 85 ...`) that recurs within a single
record. Emitted every ~0.7s throughout the match. Packed periodic data of some
kind; the repetition inside one record argues against it being per-object
state.

**0x2403 (226)** — 125 bytes, marker 0x05, also a repeating internal block.
Arrives in bursts (median gap 0.0s) alongside 0x2208.

**0x2208 (225)** — 24 bytes, marker 0x05, and the most tractable: almost
entirely constant, with only bytes 1-2, 7-8, 11 and 23 varying, and what read
as bitmasks at 9-10 (`ff 3f`) and 19-23 (`f8 ff ff ff 07`). Bytes 1-2 are
unique per record — a sequence or id. The u16 at byte 7 takes **three distinct
values** across all 225 records, so it is an enum, not a counter, a resource or
a position. Byte 11 is one of {0, 8, 64}, byte 23 one of {7, 55, 71, 183, 199}.
55 of 225 fall within 400ms of a move order, which is roughly what the order
density predicts rather than a real association.

None contains ASCII, none contains anything that decodes as a map cell, and
none has a field that tracks a known quantity. They remain the best candidates
for player events, and they remain undecoded.

## The five types, characterised across four replays

Comparing the same record types across four different matches separates them
into two families and rules out several readings.

### 0x2208 and 0x2403 — structured, present in every replay

| replay | 0x2208 | 0x2403 |
|---|--:|--:|
| 7764331 | 306 | 309 |
| 7940434 | 286 | 294 |
| 7967023 | 225 | 226 |
| 7945966 | 116 | 117 |

They arrive together — the counts track each other to within one — and both
carry a **constant signature across every match**: `22 a1 4a` at bytes 4-6 of
0x2208, `03 24 40 03 00 00 00 00 80` at bytes 3-11 of 0x2403. Their key field
is unique per record in every replay (n = distinct keys), so it is a sequence
number, not an object reference.

0x2208 is 24 bytes and nearly all constant. Only bytes 7-8, 11 and 23 carry
data: the u16 at byte 7 takes **three** distinct values within a match and
different values between matches; byte 11 is one of {0x08, 0x40}; bytes 9-10
are always `ff 3f` and 19-23 always `f8 ff ff ff 07`, which read as masks.

Bursty in time — several within the same millisecond, then a gap of a second
or more.

### 0x2602, 0x0602, 0x6602 — probably not game state

These do **not** appear in every replay: 0x0602 shows up in one of four,
0x2602 in two, 0x6602 in three. Their key field repeats (81 distinct keys
across 327 records), unlike the two above.

The decisive observation: their payload block `d0 f4 64 55 64 c4 34 85 84`
appears **byte-identical in different replays and under different type
numbers** — in 7967023 under 0x2602 and 0x0602, in 7940434 and 7945966 under
0x6602. A record carrying match state would not repeat itself verbatim across
unrelated games.

### What has been excluded

For all five: no ASCII, no field decoding as a map cell, no monotonic field
(so no timer, score or accumulating resource), no association with move orders
beyond what their density predicts, and only weak bit-level periodicity around
96 bits.

They are not decoded. But the two families are now distinguishable, and the
one worth further effort is 0x2208/0x2403 — present in every match, paired,
sequence-keyed, with a fixed signature and a three-valued enum.

## 0x2208 and 0x2403: the evidence says stream descriptors, not events

Dug into the pair specifically. They are not decoded, but the evidence now
points consistently away from them being player events.

### What was established

**Strictly paired.** All 225 of 0x2208 share a timestamp with a 0x2403 —
225/225, and the per-replay counts track to within one (306/309, 286/294,
225/226, 116/117).

**No association with anything in the game.** Against every event stream
available, measured with the chance rate the window density predicts:

    production run starts   51/225 within 500ms   chance ~53%
    production run ends     43/225               chance ~53%
    move orders             64/225               chance ~100%
    object sightings        89/225               chance ~97%
    object first sightings  54/225               chance ~22%

Every one is at or below chance. If these recorded selling, selection or any
production command, at least one of these would separate.

**They arrive in a startup burst.** 76 records share the single instant
t=1.1s, out of 95 distinct instants for 225 records. Something is initialised
in bulk and then updated occasionally.

**Only three payload variants inside that burst.** The u16 at byte 7 takes
exactly three values across all 76 (7046, 11970, 14926), and 0x2403 splits the
same three ways, while the key field is random per record. Three variants
under a random key is the shape of a hash or a table id, not of 76 distinct
game events.

**The fixed fields read as bit masks.** Bytes 9-10 are always `ff 3f` — 14 low
bits set. Bytes 19-23 are always `f8 ff ff ff 07`, which is a run of 32 set
bits offset by three. Field widths, not values.

**The count scales with the stream, not the game.** Across six replays:

    per 1000 frames      29% variation
    per 1000 sections    30%
    per second           29%
    per production run   50%

A record emitted per player action would track the action count. These track
how much stream there is.

### Reading

Best supported: they describe the bitstream itself — code tables or field
layouts, established in bulk at startup and revised occasionally. That would
explain the constant magic in every replay, the mask-shaped constants, the
hash-like keys, the three variants, and the scaling with stream size rather
than with play.

Stated as the best-supported reading, not a decode. What would confirm it:
finding that a 0x2403 payload predicts how a following section decodes.

### Consequence

If that reading holds, no record type in the delta stream carries selection or
sell events — the twelve are object and sidebar state, sequence counters,
heartbeats, three non-state periodic records, and these descriptors. That is
consistent with the sampling argument made earlier from a completely different
direction: selection changes every 1.5s while objects are re-sent every ~24s.

The caveat from the last retraction still applies. Coverage is 98.2%, not
100%, and 33 frames never framed at all.

### Tested, and refuted

The stream-descriptor reading made a prediction: if 0x2403 describes field
layouts, then how an object record decodes should follow the preceding
descriptor rather than the object's own type. Building records whose cell
matches a known structure give 194 cases to test on.

    offset by object type
      AFLD  n=19   45:19        HAND  n=37   35:37
      FACT  n=19   41:19        NUKE  n=60   35:60
      GUN   n=12   31:12        PROC  n=47   37:47
      -> object type predicts the offset 100.0% of the time

    offset by preceding 0x2403 variant
      (none)     n=187   35:97  37:41  41:19  45:18  31:12
      0937de11   n=  4   37:4
      815dde11   n=  3   37:2  45:1
      -> the variant predicts the offset 53.1% of the time

**The object's type determines its layout completely — 194 of 194.** No other
variable is needed, so nothing else can be determining it. The descriptor
reading is withdrawn.

(187 of the 194 had no 0x2403 earlier in their frame at all, so the variant
column is mostly uninformative by construction. That weakens the second table
but not the first, and the first is what settles it: a perfect predictor
leaves nothing for a second explanation to do.)

So 0x2208 and 0x2403 are still unidentified, and now two readings are excluded
rather than one:

* **not player events** — at or below chance against production starts,
  production ends, move orders, object sightings and object creations
* **not layout descriptors** — object type already predicts record layout
  perfectly

What survives unexplained: strictly paired, present in every replay with a
constant signature, sequence-keyed, 76 in a burst at t=1.1s, three payload
variants, mask-shaped constants, and a count that scales with stream size
(29%) better than with play (50%).

## What 0x2403 actually predicts: a full sidebar dump

The compression test came back with a real, controlled result — though not the
one predicted.

**No entropy change.** Payload entropy across a 0x2403 is z = -1.1 against a
random-split null. Nothing about the encoding of following data changes, so
"code tables" is wrong.

**But section sizes jump, for the same record type.** Comparing 200 sections
before against 200 after each 0x2403, holding the record type fixed:

    0x3781   before    85.1 bits   after    82.6   -3.0%
    0x5781   before   438.6        after   417.0   -4.9%
    0x7781   before   901.9        after   890.2   -1.3%
    0x9801   before  1678.2        after  6779.9   +304%
    0xb801   before  2087.4        after 16368.5   +684%

Three types are flat within 5%; the two **sidebar/production** record types
grow three- to sevenfold. That is not a change in what follows — it is the
same record carrying far more. A 0x2403 marks a point where the sidebar state
is re-sent in full rather than as a delta.

So 0x2403 is a **full-state marker for the sidebar stream**. It predicts what
follows, just not how it is compressed.

(0x9801 and 0xb801 contain no object records at all — 0.00 per section — which
is what identifies them as the sidebar stream. Object records live in 0x7781,
at 0.97 per section.)

## A credit-shaped field in the oversized dumps — candidate, not confirmed

Those oversized sidebar dumps are new ground, and `CNCSidebarStruct` carries
`Credits`. Searching them for a field that opens at the known starting balance
found exactly one, at byte 15 as a u16, in **both** record types:

    0xb801   opening 10000 ... 21s 8601 ... 34s 5577 ... 120s 1942 ... 0
    0x9801   opening 10000 ... 27s 8117 ... 90s 2875 ... final 356

Opening at exactly 10000 in both, independently, is a strong coincidence
otherwise, and the small irregular decrements match construction billing —
C&C charges continuously while a structure goes up.

**But the dynamics contradict it.** Across the whole match there are only 2-5
*increases* in each series, where harvesting should credit dozens of times, and
one series sits at 0 from 165s onward while that player kept producing. Implied
spend also runs about 3,000 behind production cost by 30s, before the first
refinery finishes.

So: a field that opens at the starting balance and drains like construction
billing, that does not behave like a balance being replenished. Recorded as a
candidate. Given two retractions already in this work, it is not being called
credits until the rises are explained.

## Income, selling, cancelling: not found in the dumps

Checked all three in the oversized sidebar dumps.

### The falling field is 16.16 fixed point

The u16 at byte 15 is only the integer half of a u32 at byte 13:

    655360000 = 10000 x 65536   -> exactly 10000.0
    616038400 = 9400  x 65536   -> exactly 9400.0
    567803906 = 8664  x 65536 + 2

A fixed-point value with a fractional part that moves, which is why the
decrements looked small and irregular — it drains continuously, the way C&C
bills for construction rather than charging on placement.

### No income field

Scanned every u16 and u32 in the first 64 bytes of both dump types for a
**rising** series with meaningful range. There is exactly one qualifying field
in either type and it is the falling one above. Nothing accumulates.

That leaves the candidate unresolved rather than confirmed: a quantity opening
at exactly the starting balance and draining like construction billing, with no
paired income field and only 2-5 rises in a whole match. Still not called
credits.

### No sell or cancel event

The dumps do not carry a full sidebar listing in a form `parseSidebarEntries`
recognises — at most 1-2 entries each, 14-16 appearing and 14-16 vanishing
across the whole match. Far too few to be the production queue, and the
vanishings are dominated by a single asset (HAND) rather than tracking the
things that were actually sold.

**One real find:** sidebar entries carry three states, not one. `readProduction`
only ever looks at **state 10**, and 0 and 8 also occur:

    0xb801   state 8: 16   state 10: 9   state 0: 7
    0x9801   state 8: 11   state 0: 10

`CNCSidebarEntryStruct` has separate `Constructing` and `ConstructionOnHold`
flags, so 8 and 0 plausibly mean held and available against 10 for building —
and a *hold* is what a cancelled queue item becomes. That is the most direct
route to cancel detection found so far. There are too few instances here to
characterise, because these are the oversized dumps only; the same states in
the ordinary sidebar records are a much larger sample and have never been
looked at.

## Cancelled production, found in the states the decoder was discarding

`readProduction` filtered to `state === 10` and threw everything else away.
Instrumenting it to keep the rest, over the whole match:

    state 10   14,024 entries   progress 9..1013   BGGY, PROC, E4, E1, GUN, NUKE, HAND, AFLD
    state  9      137           progress always 0  BGGY(83), E1(12), E4(10), GUN(10) ...
    state  8       30           progress always 0  every buildable asset, twice, all within 101-114s
    state  0        8

**State 9 is the completion marker.** All 137 land within 3 seconds of a
production run ending — zero orphans — and runs carrying one peaked at 990 of
a possible 1013 against 903 for runs without.

**State 8 is a sidebar refresh**: every buildable asset listed twice inside a
14-second window, progress zero. Not an event.

### Cancellation

The obvious rule — no completion marker means cancelled — is wrong, and the
data says so: several runs with no marker peaked at 1013 of 1013. The scan
samples rather than watches, so it misses markers.

Progress is the reliable signal, and the two populations separate cleanly.
Under-sampled completions are last seen at 97-98%; genuine abandonments stop
at 5%, 10%, 12%, 24%, 54%, 56%, 57%, 68%, 78%. The threshold sits in the gap
at 90%, and `completed` is `marker || peak >= 90%`.

    213 runs: 204 completed, 9 abandoned

    127s side0 PROC  54%     301s side0 GUN   68%     386s side0 GUN   56%
    130s side0 BGGY  78%     306s side0 BGGY  57%     406s side0 BGGY  24%
    164s side1 AFLD  12%     343s side0 GUN   10%     407s side1 BGGY   5%

The last two start at 406s and 407s in a match that ends at 407s — interrupted
by the finish, not cancelled. The other seven are real: a refinery abandoned at
54%, an airstrip at 12%, three turrets, two buggies.

### It fixes the build order too

Cancelled runs were claiming a place in the build order and finding no
structure to pair with — a share of the "no cell" entries. They are now
excluded, since an item the player stopped paying for was never built.

## Credits: decoded. Earlier claim retracted.

An earlier section concluded credits were not in the file, after searching the
starting value, house records, the sidebar header and the whole payload. That
search only ever saw the **ordinary** sidebar records. The full-state dumps —
the oversized ones following a 0x2403 — had not been framed yet, and that is
where the balance lives.

`readCredits` reads byte 13 of those dumps as a **16.16 fixed-point** value.
Byte 15 alone is the integer part, which is how it was first noticed; the
fraction is what makes the balance move smoothly rather than in steps.

Four independent checks, none of which was fitted to:

* opens at exactly **10000.00** in both series — the ladder's starting balance
* **drains at the construction billing rate**: across intervals where exactly
  one item was building, observed drop against that item's cost-per-second
  gives a median ratio of **1.05** (side 1) and **1.22** (side 0)
* sits pinned at 0 for a player who has spent everything, then spikes
* the spikes land on exact TD half-cost refunds

The "it never rises, so it cannot be a balance" objection that held this back
was wrong for a simple reason: **both players were broke.** One sits at 0 from
165s onward while still producing. Income arrived and was spent inside a
sampling interval, so only refunds — arriving as a lump — clear the surface.

## Selling, via refunds

TD pays back half the build cost, so a rise landing on an exact half-cost is a
sale. Harvester income cannot be mistaken for one: a full load is 700, which is
not half of anything buildable.

    223.6s  owner 0x8   +2500  ->  Construction Yard or MCV
    258.2s  owner 0xa   + 300  ->  Gun Turret
    261.0s  owner 0xa   + 150  ->  Power Plant or Hand of Nod
    366.2s  owner 0xa   + 300  ->  Gun Turret
    389.1s  owner 0xa   +  36  ->  Concrete

Owner 0x8 is the opponent, and **the +2500 is the MCV sale the player
described from memory** — "he went 3 ref air into 2nd air and sell mcv". That
is independent confirmation: the amount, the side and the timing were decoded
without reference to the account, and a 2500 refund is only an MCV or a
Construction Yard.

Reported with candidates rather than one answer, because costs collide: 2500 is
both an MCV and a Construction Yard, 150 is a Power Plant or a Hand of Nod.

### What it does not find

The player also recalls selling a refinery, which would refund 1000. No 1000
appears in either series. A refund is only visible if the balance is still
raised at the next sample, and for a player spending continuously at 300 a
buggy, a 1000 refund can be gone inside the ~1.6s between dumps. So this
detects sales, but does not claim to detect all of them.

## Credits wired into the viewer

`readCredits` now feeds the simulation through a `credits` command, and the
decoded balance **replaces** the modelled economy rather than adjusting it.

That replacement is the part that mattered. Samples land every ~1.6s, and left
running in between, modelled harvester income adds hundreds per second — six
harvesters unloading 700 apiece pulled the readout thousands above what the
players actually had. `realCredits` now switches off modelled income, billing
and purchase costs the moment a decoded balance arrives.

Verified against the decoded series at ten points, exact at every one:

      0s  10000 / 10000        224s   2501 / 0
     30s   7597 /  6648        240s   2501 / 0
     60s   4300 /  3700        300s    348 / 0
    120s   2875 /  2141        380s    659 / 0
    180s      1 /     0

224s is the MCV sale landing — 1 credit to 2501.

### The rolling counter had to stop rolling on jumps

The readout still showed impossible figures after all this: 5133 and 4273 at
3:47, values that appear **nowhere** in the decoded series. The cause was the
counter animation added earlier — it eases toward its target, and a scrub moves
the balance by thousands at once, so the display spent seconds passing through
numbers the player never had. It now snaps on jumps over 1500 and rolls only
for ordinary movement. On screen: 10000 at the start, 2501 and 0 at 3:47.

## Open: player rows look swapped after a ladder re-sync

Spotted while verifying the above, not yet fixed. With the players in the order
this sync returned them, the HUD shows IIIIIIIIIIII with 11 buildings and
Ronaldo-r9 with 18 at 3:47 — the wrong way round, since IIIIIIIIIIII holds the
larger top-right base.

The ladder returns p1/p2 in an unstable order (it re-syncs per queried player),
and the waypoint rule is supposed to absorb that by pairing each player's
`location` with the decoded base. Something in that chain is not following the
flip. The credit values themselves are right; which row they are printed on may
not be.

## The swapped player rows: my own fallback was inventing spawn data

`matchFromLocalReplay` — the local-replay fallback added earlier — set
`location: i`, numbering the two players 0 and 1 by row order. That is not a
spawn index. It is a fabricated fact, and the waypoint rule consumed it as if
it were real, assigning each decoded base by that invented order.

It only surfaced when the ladder returned the players the other way round: the
names flipped, the fabricated locations did not, and the HUD showed one
player's base under the other's name.

The fallback now reports `UNKNOWN_SPAWN` (-1), the server only passes
`spawnLocations` when both are real, and `slotsByOwner` requires both to be
non-negative before using the waypoint rule. A replay with no ladder row falls
through to faction, then to first-build order — which cannot identify a mirror,
and should not pretend to.

Verified across all three cases:

    ladder order A     Ronaldo-r9   11 bldgs BOT-LEFT  | IIIIIIIIIIII 25 TOP-RIGHT
    ladder order B     IIIIIIIIIIII 25 bldgs TOP-RIGHT | Ronaldo-r9   11 BOT-LEFT
    no ladder row      IIIIIIIIIIII 25 bldgs TOP-RIGHT | Ronaldo-r9   11 BOT-LEFT

## Two display bugs found while verifying

**The counter overshot zero.** A fixed minimum step of 15 credits meant the
roll stepped past the target on the last frame and printed a negative balance
(-30) on the way down. It now snaps when the remaining distance is under one
step.

**A stale Vite module cache.** The readout sat at a flat 10000 for both players
long after the engine was correct — the browser was running an older
`simulation.ts` while the newer viewer code reloaded around it. Clearing
`node_modules/.vite` and restarting resolved it. Worth remembering: node
verification passing while the browser disagrees is a cache symptom, not
necessarily a bug.

Final state in the running viewer at 4:17, against the decoded series:

    IIIIIIIIIIII      0 credits   20 buildings
    Ronaldo-r9     1539 credits   11 buildings
    decoded at 257s:  0 and 1539

## Airstrip delivery: the plane now lands

Three things were wrong with the cargo run.

**It barely stopped.** `DELIVERY_UNLOAD_TICKS` was 22 — about a second and a
half of match time, which at x2 or x8 playback reads as no landing at all: the
plane appeared to cross the strip without ever settling. Now 60 ticks, four
seconds, so the landing is a landing.

**It reversed out the way it came in.** The outbound leg targeted whichever
edge the plane was nearer, which after touching down meant flying back out the
side it entered. In the original the plane holds one heading: in, down,
unload, and away on the same line.

**It could enter from either side.** The approach picked the nearest horizontal
edge, so a base on the west half was served by a plane flying west-to-east.
It now always comes in from the east and leaves to the west.

`facing` is also no longer recomputed each tick from the movement vector,
which had the plane swinging around as it settled onto the pad.

Measured over one delivery:

    inbound@x69 -> inbound@x68 -> ... -> outbound@x-4 -> outbound@x-5
    ticks parked on the strip: 60  (4.0s)
    headings used: 24 only  (west, and it never turns)

## Airstrip delivery (cargo plane)

Read from the shipped source, `SOURCECODE/TIBERIANDAWN/AIRCRAFT.CPP`,
mission `FLY_TO_AIRSTRIP`:

```
Altitude = FLIGHT_LEVEL;
if (navdist < 0x0600) Altitude = Fixed_To_Cardinal(FLIGHT_LEVEL, Cardinal_To_Fixed(0x0600, navdist));
if (navdist < 0x0080) { ...Detach_Object()... Status = BUG_OUT; }
```

So there is no landing and no pause. The plane holds `FLIGHT_LEVEL`, scales
its altitude down linearly over the last `0x0600` leptons — six cells — drops
the vehicle at `0x0080` and immediately goes to `BUG_OUT`, climbing back to
cruise as it carries on. The whole pass is one straight line east to west
across the map; the plane is only on screen for the ~13s it takes to cross.

Modelled in `simulation.ts` as `Delivery.alt` (1 = cruise, 0 = on the deck)
with `DESCENT_CELLS = 6` and `DELIVERY_UNLOAD_TICKS = 0`. `renderer.ts` draws
the plane `alt * CARGO_CRUISE_LIFT` pixels above its own shadow, so the gap
between the two closes over the strip and opens again on the way out.

Dead end: `SMOKLAND` is **not** the airstrip animation. `ADATA.CPP` maps it to
`ANIM_LZ_SMOKE`, placed at the campaign `Waypoint[25]` landing zone.

Also fixed here: the tactical view now clips to the map rectangle, so a plane
inbound from beyond the east edge stays hidden until it crosses the border
instead of being drawn over the letterbox.

### Two corrections

**The plane looked doubled.** `AircraftClass::Draw_It` does draw the shape
twice — body at `y - Altitude`, then a second pass at `x+1, y+2`:

```
CC_Draw_Shape(this, shapefile, shapenum, x+1, y+2, window,
              SHAPE_PREDATOR|SHAPE_CENTER|SHAPE_WIN_REL|SHAPE_FADING,
              Map.FadingShade, NULL);
```

but that second pass goes through `Map.FadingShade`, which collapses every
color toward black. It is a silhouette. Drawing a translucent copy of the
*colored* sprite instead — which is what the first pass here did — reads as
two aircraft flying in formation. Now cached as a black-filled silhouette at
the engine's own (+1, +2) offset.

**Every harvester docked at the first refinery.** `refineryFor` used
`entities.find(...)`, i.e. list order, i.e. whichever refinery was placed
first. The engine's `TechnoClass::Find_Docking_Bay` (TECHNO.CPP) scans all of
the house's refineries, skips any that refuse `RADIO_CAN_LOAD` because they
are already in radio contact with another harvester, and keeps the nearest of
what remains. Modelled with `Entity.bay` as the radio claim, held from the
decision to return until the unload completes. Across the Heavy Metal replay
the dockings now land on every refinery both players built:

```
P1 (52,19) 8   (49,20) 12  (58,10) 21  (56,26) 17  (53,29) 18  (46,37) 13
P2 (17,45) 9   (23,44) 17  (25,48) 17  (32,45) 16  (35,46) 12
```

## 0x5781 is the movement stream

13.1% of the delta stream, and the largest block that had no meaning assigned.
It is **per-object position, sampled every frame the object exists**.

The earlier note that it was "32,140 records of 431 bits, periodic" was wrong
on both counts: there are 55,224 of them in the Heavy Metal replay across
**54 distinct lengths**. 431 was just the modal length.

How it was found, in order:

1. **185 of its 186 keys are shared with the object records.** So the key is an
   object identity, not a channel — this is a per-object record.
2. Dumping the bytes for one key showed byte 5 counting down `3e 3d 3c 3b 3a`
   once per frame on a **C17**, with byte 6 constant. A cargo plane flies one
   straight horizontal line, so that is X changing at constant Y.
3. Scoring bytes 5/6 as a cell gave **0.00% impossible steps for PROC, GUN,
   NUKE and FACT** — structures do not move — and normal travel for BGGY and
   HARV. But every Y came out at exactly half its true value, so a bit was
   missing below it.
4. A bit-level search against 14 structures with already-decoded cells found
   the packing exactly.

```
position := 13 bits at bit 40 of the record
x = v & 0x7f          y = v >> 7
```

This is **not** the engine's `CELL`. `XY_Cell` in FUNCTION.H is `(y << 6) | x`
with a 6-bit X; the DLL's wire format gives X seven bits. Reading it with the
engine's own macro is what halved every Y.

**Validation.** Structures never move and their cells are already known, so
each structure key's constant value must land on a decoded structure of its own
type. Across six unrelated replays: **131 of 162 exact**. A random 13-bit value
lands on one of ~20 known cells about 0.5% of the time.

**What it buys.** 12x to 86x more position samples per replay than the object
records give. Those report an object only when something about it is restated —
two or three times in a whole match for a harvester, which is why movement had
to be modelled at all. This gives a position every frame.

### Segmenting

A key is recycled when its object dies, which splices two units into one track.
Splitting on an impossible step recovers the individual lives. Two rules that
looked reasonable and were wrong:

- **Splitting on a silence.** Objects are not restated every frame, so this cut
  standing buildings into hundreds of pieces.
- **Speed alone.** Records land as little as 20ms apart, where one cell of
  ordinary driving reads as 50 cells/s. A distance floor of 4 cells is needed
  before the speed test may call anything a teleport.

With `d >= 4 cells && d/dt > 12 cells/s`, zero impossible steps remain and the
segment counts are what the match actually looked like:

```
name     keys  segments  median life
FACT        2         2       354s     one construction yard per player
PROC       10        10       328s     refineries stand all match
GUN         6         6       118s
BGGY       82        87       218s     a few keys recycled
HARV       11        12       333s
C17        12       214         7s     one segment per delivery
MINIGUN    16      2433         0s     muzzle flashes — each its own instant
PIFF       12      1924         0s     bullet impacts
120MM       4       143         0s     tank shells
```

`MINIGUN`, `PIFF` and `120MM` positions are where shots were fired and landed —
combat data that was not available before.

Exposed as `readObjectTracks()` in `object-stream.ts`.

### Wired into the viewer

`readObjectTracks()` now drives unit movement end to end:

- `from-real.ts` spawns a unit at each track's first sample and issues a move
  for every cell it changed to. Waypoints are marked `silent` — they arrive
  several times a second per unit, so they must not draw a click ring or count
  toward APM. Nobody clicked them.
- A track ending before the match does is the unit dying, so it emits a `kill`.
  The stream restates an object for as long as it exists and only recycles its
  key once it is gone.
- The `spawn` case adopts an existing unit of the same kind rather than adding
  a second. The simulation has usually already produced it — a refinery hands
  over its harvester on completion, a decoded production run delivers its
  vehicle from the airstrip. Without this the queue and the track each made
  one and the map ended up with 121 buggies instead of 80.
- Decoded MOVEFLSH clicks no longer pick a unit. They still draw their ring and
  count as actions, but with units driving their recorded routes, handing a
  destination to whichever unit happened to be idle would drag one off its real
  path.

**Does the simulation put units where the replay says?** At 240s into the Heavy
Metal match the replay places 46 buggies and the simulation has 48. Median
distance from a real position to the nearest simulated buggy is **2 cells**,
against **19** for random cells; 35% land within one cell. The residual is
steering lag — the simulation drives toward each waypoint at the unit's own
speed instead of snapping, which keeps the movement smooth.

Unit counts now follow the match: 0 -> 5 -> 42 -> 48 -> 40 -> 62 buggies alive
at one-minute intervals, 80 at the end against 87 decoded track segments.

### Coverage after this

`0x5781` moves from unread to read, so the delta stream now stands at roughly
**76% fully read, 21% partial, 3% unread** by volume — the remainder being the
two heartbeats (2.6%) and the five unidentified types (0.1%).

## The object records are CNCObjectStruct

`SOURCECODE/TIBERIANDAWN/DLLInterface.h` line 205 defines `CNCObjectStruct`,
the struct the DLL hands the frontend for every object each frame. It has
`TypeName[16]` and `AssetName[16]` back to back, which is the double-name
anchor `parseObjects` already keys on. That gives the **field inventory** for
the object records:

```
Type, ID, BaseObjectID, BaseObjectType, PositionX/Y, Width, Height, Altitude,
SortOrder, Scale, DrawFlags, MaxStrength, Strength, ShapeIndex, CellX, CellY,
CenterCoordX/Y, SimLeptonX/Y, DimensionX/Y, Rotation, MaxSpeed, Owner,
RemapColor, SubObject, IsSelectable, IsSelectedMask, IsRepairing, IsDumping,
IsTheaterSpecific, FlashingFlags, Cloak, CanRepair, CanDemolish,
CanDemolishUnit, OccupyList[36], Pips[18], Lines[3], RecentlyCreated,
IsALoaner, IsFactory, IsPrimaryFactory, IsDeployable, IsAntiGround,
IsAntiAircraft, ..., CanMove[32], CanFire[32], ControlGroup, VisibleFlags,
SpiedByFlags, ProductionAssetName[16], ActionWithSelected[32]
```

It does **not** give offsets. The observed order is `Type(2) ID(4) … Owner(9)
RemapColor(10) DimensionX(11) DimensionY(12)`, but the struct declares
Dimension *before* Owner, so the wire format reorders. And the full struct runs
past 700 bytes while the records are 89–117 bytes, so the frontend serializes a
**subset** in its own order. The frontend is closed source; the struct is a
field list, not a map.

## Selection: searched properly, not found

`OBJECT.CPP:1643` gives the exact semantics:

```
int shift = (int)house;
IsSelectedMask |= (1 << shift);
```

declared `unsigned short` in OBJECT.H, widened to `unsigned int` in the DLL
struct. That makes it unusually easy to recognise. It must be:

- **mostly zero** — most objects are not selected;
- **a power of two** — one bit per house, ORed only if two players select the
  same object, which TD does not allow;
- **house-exclusive** — you may only select your own units, so a bit may only
  ever appear on objects of that house;
- **persistent** — a selection lasts until you select something else.

Every bit of both record types was scanned against all four constraints:

- **Object records** (every bit of 200 bytes): the only house-exclusive hits
  have n ≤ 35 — noise.
- **0x5781** (every bit, 53..400): two hits, bits 111 and 186, both
  house-exclusive at 100% with median run 1,295 records. Those are object *type*
  flags, not selection — bit 186 is set on exactly 13,404 records, which is
  precisely the C17 count.
- **Bits 194/195** looked right on shape alone (mostly off, one object at a
  time, 100% single-owner *frames*) and fail every real test: both houses carry
  both bits (owner 8: 132/274, owner 10: 219/50), median run is **1 record**
  where a selection persists for seconds, and at a decoded move order the
  clicking player owned a flagged object 55.8% / 36.8% of the time — chance.

A convergence test was also run over all 307 candidate bits: split each
player's objects at the moment of a decoded click by the bit, and see which
group drives to the clicked cell. Best bit scored **z = 2.08 across 70 tests**,
against a shuffled-destination null. That is nothing.

Selection is not in the object records and not in 0x5781.

## 0x1701 / 0x9701 are not heartbeats

They are **per-player, per-frame** records — byte 6 is `01` and `02`, byte 5 is
a frame counter, and they arrive at 14.9 and 14.1 records/sec. The tail is a
rolling 20-deep buffer that pushes exactly **24 bits per frame**, which is the
shape of a lockstep input stream:

```
t=22.1  [91 22 73 d1 72 73 11 73 73 91 22 73 31 d2 72 d1 91 72 31 d2]
t=22.4  [31 d2 72|91 22 73 d1 72 73 11 73 73 91 22 73 31 d2 72 d1 91]
t=22.6  [d1 91 72|31 d2 72 91 22 73 d1 72 73 11 73 73 91 22 73 31 d2]
```

But the pushed word takes only **7 distinct values in a whole match**, the same
7 for both players — and the identical byte sequence appears in four unrelated
replays, merely at different rotations:

```
912273d1727311737391227331d272d1917231d202   Heavy Metal, x623
912273d1727311737391227331d272d1917231d202   an unrelated match, x1397
```

A sequence that is byte-identical across unrelated files carries no per-match
information. That is not an assumption about the format — it is what the files
say. The buffer is a fixed rotating pattern.

The record's head does vary (bytes 12–19, ~130 distinct values each) but is
zero at almost every sample, so it is sparse events rather than a per-player
stat; it does not track credits (mean error ~1000 against the decoded series).

## 0x3781 is not a sequence counter — it is the per-object field delta

This block is **62.7% of the delta stream** and was written off as a counter
with payload `count << 8 | 0x20`. Every part of that is wrong:

| claim | measured |
|---|---|
| 1,034,245 records | **1,624,676** |
| fixed 64 bits | **variable** — 48b, 80b, 64b, 154b, 117b, 223b, … |
| payload low byte always `0x20` | `0x20` in **9.3%**; `0x00` 39%, `0x40` 19%, `0xff` 6% |
| counter increments by 1 | **+1 only 9.0% of the time** |
| "keyed by stream" | **268 keys**, matching the object records' 269 |

It is a per-object record with an **8-bit change mask at byte 5**, carrying
only the fields that changed. A static PROC sits at mask `0x00`; a driving
BGGY runs `0x0f` with smoothly incrementing coordinates.

Mask bits 5, 6 and 7 are cleanly additive in the record length — `0x60` is
48+16+32 = 96 exactly, `0x45` is 117+32 = 149, `0x6f` is 154+16+32 = 202:

```
mask 0x00   636,567 records   48 bits    nothing changed — a keep-alive
mask bit 2  0x04              16 bits    X, in leptons
mask bit 3  0x08              16 bits    Y, in leptons
mask bit 5  0x20              16 bits    small counters on PROC / MINIGUN /
                                         PIFF / SPLIT2 — an animation frame
mask bit 6  0x40              32 bits    values 15..99, changes constantly on
                                         terrain objects too — draw ordering
mask bit 7  0x80               5 bits    always zero in this match
bits 0, 1                     wide       unidentified — the widest fields left
```

Bits 0–3 are not independently additive (`0x05` and `0x0a` both give 117,
`0x0d` and `0x0e` both give 133), so bits 0/1 pair with 2/3 — most likely a
precision selector on each axis.

### Positions at lepton precision

TD measures position in leptons, 256 to a cell, so a 64-cell map spans 16384 —
and the values land in that range, separated by house exactly as the two bases
are separated on the map. Verified against the cells decoded from 0x5781:

```
field           offset    v>>8 == cell    within 1 cell
X (mask 0x04)   bit 48        54.9%           86.3%
Y (mask 0x08)   bit 64        65.4%          100.0%
```

100% within one cell is decisive; the off-by-one is that the two records sample
a moment apart and `Coord_Cell` rounds from the object's centre.

So unit movement is available at **1/256 of a cell, every frame** — finer than
the cell-level track from 0x5781 that currently drives the viewer, and enough
for pixel-accurate movement rather than cell-snapped steering.

## The 0x3781 record, fully laid out

Every mask value maps to exactly one record length — 100% of records, no
exceptions — which confirms the change-mask model outright. Marginal widths,
measured from pairs of masks differing in one bit:

```
bit 2  +16 always      bit 5  +16      bit 7  +5
bit 3  +16 always      bit 6  +32
bit 0  +53 first, +21 second
bit 1  +53 first, +21 second
```

53 = 32 + 21: a 32-bit field present whenever *either* of bits 0/1 is set,
plus 21 bits per axis. The field order was then pinned empirically by finding
where the lepton X/Y actually sit:

```
mask 0x05 (117b): X at bit 69                 99.9% within 1 cell
mask 0x0d (133b): X at bit 69, Y at bit 85   100.0% within 1 cell
mask 0x0f (154b): X at bit 90, Y at bit 106  100.0% within 1 cell
```

which gives the layout:

```
[48-bit head: marker | key | type | mask]
if bit0        21 bits   PositionX  (11 used)
if bit1        21 bits   PositionY  (11 used)
if bit2        16 bits   X in leptons
if bit3        16 bits   Y in leptons
if bit0|bit1   32 bits   unidentified (14 used) — comes last
```

Bit-level variability confirms the used widths: bits 0/1 carry 11 significant
bits with 10 zero above, and the 32-bit tail carries 14.

### Bits 0 and 1 are the render position, in pixels

They correlate with the lepton coordinates at **1.000** and their ranges
(444..1476, 8..1331) fit a 64-cell map at 24 px per cell. Fitting
`field = a * lepton + c`:

```
bit0 vs leptonX:  a = 0.093775   (3/32 = 0.093750)   mean error 0.33 px, 85.7% exact
bit1 vs leptonY:  a = 0.093761   (3/32 = 0.093750)   mean error 2.13 px
```

A slope matching 3/32 to four decimals is `lepton * 24 / 256` — leptons to
pixels — with a constant offset of about one cell (24 px) for the map origin.
These are `CNCObjectStruct.PositionX / PositionY`: **the game's own render
coordinates, recorded per frame**. The larger Y residual is the per-object draw
offset, since sprites are anchored by height.

That means pixel-exact placement does not have to be derived at all. It is in
the file.

### The 32-bit tail is the game frame number

Cracked. For mask 0x0f, whose field order is pinned by measurement, the tail at
bit 122 is exactly the frame the record belongs to:

```
tail = frame + 138      mean error 0.000, worst 0, over 88,446 records
```

and every record inside a frame carries the same value — 11,973 of 11,973
frames, spread zero. Verified on six unrelated replays, all with mean error
**0.000** and worst **0**; only the constant differs, being the number of frames
the game ran before the replay's own frame 1:

```
frame + 138   frame + 119   frame + 114   frame + 101   frame + 134   frame + 80
```

It uses 15 to 16 bits, not the 14 first measured — that reading came from one
match, whose frame count simply never needed the sixteenth bit.

The earlier guess of a Y-derived sort key came from a 0.39 correlation with
lepton Y, which is entirely spurious: over a match the units drift, so anything
that climbs with time correlates weakly with position.

**It is also a free check on the frame walking.** The tail increments by
exactly one per frame with zero error across 1.28 million records in six
replays, so it independently confirms the chain parser never loses or repeats a
frame.

Reading it as simply the last 32 bits of any record does *not* work — the modal
offset is right but many records come out as garbage, because the field widths
for mask bits 4 to 7 are still unpinned and the tail sits after them. The
result above is stated for the one mask whose layout is measured.

## ControlGroup: not found yet

IIIIIIIIIIII plays control groups 2 and 3 and held the top-right base, which is
house 10 — its structures centre on (48,29) against (24,46) for the other
house. That is a usable label, and it killed two false positives:

- **Object-record byte 0** looked perfect — house 8's top values are 2 (x306)
  and 3 (x213). It is `DllObjectTypeEnum` (2 = UNIT, 3 = AIRCRAFT), which is
  also why the effects-only house 254 reads 6 = ANIM.
- Every 4- and 5-bit field in 0x5781 that is constant within a unit splits
  32/10/6 for house 10 and 50/6/5 for house 8 — the unit-type mix, not groups.

No field yet varies between units, holds constant within one, and concentrates
house 10 on 2 and 3.

## Group taps and selection: 0x5781 bit 154

Searching for control-group taps directly — repeated co-flipping of a stable
unit set — found nothing above noise (clusters of 2 to 4 units, lifts driven by
units that barely appear). Neither did the per-player 0x1701/0x9701 head bytes:
byte 13 and byte 17 carry small values across the whole match, but both players
are dominated by 1, 3 and 4, with no concentration on 2 and 3 for either.

Two corrections along the way, both of which had invalidated earlier work:

- **The object record body is bit-packed.** `CellY` sits at **bit 609**, the
  same offset for MINIGUN, PIFF and GUNFIRE (80.6%, 81.4%, 71.0%). Every
  earlier scan of that record read bytes and was therefore reading shifted
  values. `CellX` is not 16 bits before it, so the frontend reorders and the
  struct order cannot be extrapolated.
- **Only 1,830 of 15,280 object records describe player-owned things.** The
  rest are effects (owner 254 — muzzle flashes, impacts). That record is far
  too sparse to carry per-frame selection, which rules the whole search there
  out on grounds of volume alone.
- **`IsSelected` is also a plain bool.** OBJECT.CPP sets `IsSelected = true`
  alongside `IsSelectedMask |= (1 << house)`. A single shared bit is *not*
  house-exclusive, so every scan gated on exclusivity rejected it by
  construction.

Dropping that gate and requiring persistence instead gives one strong
candidate: **0x5781 bit 154**.

| evidence | measurement |
|---|---|
| confined to commandable units | BGGY 25.5%, E1 25.2%, E4 3.5%, HARV 0.3%, **everything else exactly 0.0%** |
| not "in combat" | GUN turrets fight constantly and are 0.0% |
| not "is moving" | harvesters move constantly and are 0.3% |
| persists | median run 7 records, 504 separate runs |
| group-sized | up to 23 objects carrying it at once |
| does what selection does | flagged units end up **4.23 cells closer** to a clicked cell than the same owner's unflagged units; null (labels shuffled) **-0.28** |
| group starts are one player's | for starts of 15+ units the dominant owner holds **81.6%**, against ~59% expected from the 82/62 unit split |

Not conclusive. Owner agreement at a click is only 57.6%, no large start is
100% pure, and more starts follow a click (77) than precede one (51).

### Moments to check against the game

The largest simultaneous starts, for confirmation by eye in the in-game replay:

```
4:05.8   17 units of Ronaldo-r9   2x E1, 15x BGGY   centred on cell (39,41)
4:20.0   17 units of Ronaldo-r9   3x E1, 14x BGGY   centred on cell (42,42)
4:22.4   15 units of Ronaldo-r9   15x BGGY          centred on cell (41,44)
4:34.8   15 units of Ronaldo-r9   15x BGGY          centred on cell (38,46)
5:37.2   14 units of Ronaldo-r9   1x E1, 13x BGGY   centred on cell (50,34)
3:39.8   13 units of Ronaldo-r9   1x E1, 12x BGGY   centred on cell (40,26)
```

Each is a tight cluster of adjacent units plus one or two distant outliers,
which is the coincidental-overlap the purity figures predict. Every large group
belongs to house 8 (the bottom-left base, Ronaldo-r9) — worth noting, since
IIIIIIIIIIII is the one who reports heavy control-group use.

## Selection confirmed: 0x5781 bit 154 is IsSelected

IIIIIIIIIIII paused the in-game replay at **4:06** and photographed it. The
screen shows a block of buggies under selection brackets. The decode, for the
same instant, says Ronaldo-r9 had **15 BGGY and 2 E1** flagged with bit 154 —
and the prediction had been made before the screenshot, from the largest
simultaneous bit-154 starts:

```
4:05.8   17 units of Ronaldo-r9   2x E1, 15x BGGY   centred on cell (39,41)
```

The same frame settles two other things.

**The house mapping is right.** The game's sidebar at 4:06 reads Ronaldo-r9
$1,904 and IIIIIIIIIIII $58. The decode at 246s gives house 8 = 2236 and
house 10 = 0. So house 8 is Ronaldo-r9 (bottom-left, centroid (24,46)) and
house 10 is IIIIIIIIIIII (top-right, (48,29)) — which agrees with
IIIIIIIIIIII's own account of having been top right.

**The credit decode is validated against the game's own display** for the first
time: same instant, same order of magnitude, same rich/broke split. The ~330
gap is sampling offset, since credits move continuously.

Why every earlier search missed it: `OBJECT.CPP` keeps a plain `IsSelected`
bool alongside `IsSelectedMask |= (1 << house)`. This is the bool. It is not
house-exclusive, so every scan gated on exclusivity rejected it by
construction.

### A bug this uncovered in the encoder

Wiring it up worked headlessly and drew nothing in the browser. The cause was
in `format.ts`, not the decode: the `silent` flag added for track waypoints was
never written to the binary. Command flags encode `kind`, `x/y`, `id`,
`target`, `ref` and `real` — `silent` had no bit, so it was dropped on encode.

The viewer had therefore been treating all **23,270 track waypoints as player
clicks**, drawing a ring for each and counting every one toward APM. Adding
flag 64 fixes it: a round trip now preserves 1,919 select commands and 23,840
silent flags, and click rings fall from ~27,000 to 3,572.

Verified in the browser at 4:06: 270 pixels of bracket colour on the canvas,
and 14 buggies selected for Ronaldo-r9 after a full encode/decode cycle.

## Render positions wired into the viewer

`0x3781` mask bits 0 and 1 carry `CNCObjectStruct.PositionX / PositionY` — the
game's own draw coordinates, at 1/24 of a cell rather than the whole cell
`0x5781` reports. Those now drive the viewer.

**Reading them.** Fields follow in mask-bit order, so X sits at bit 48 and Y at
bit 69 when both are present. 205,435 records carry both axes — about 504
position updates a second across all objects.

**Calibrating the origin.** The recorded pixel origin is offset from the
renderer's world space by a constant (about +27, +28 for this replay). Rather
than hard-code it, `readObjectTracks` measures it: every pixel sample is paired
with the cell reported for the same object at the same instant, and the median
difference is taken as the origin. It self-calibrates per replay, so it holds
if a map or the game's own origin ever differs.

**Getting them to the viewer.** 504 updates/second is far too many to send as
commands. Instead the existing track waypoints carry the exact position, and a
waypoint is now emitted when the unit has moved half a cell in *pixels* rather
than only when its cell changes — cell changes alone would throw the precision
away, since a unit crossing a cell slowly emits one waypoint for 24 pixels of
travel.

```
track samples 55,150, of which 40,025 (72.6%) carry a render position
commands 27,770, of which 22,498 carry pixels
encoded replay 0.69 MB, round trip lossless
```

**Using them.** `steer` aims at the recorded pixel instead of the cell centre,
but only on the final leg — intermediate path nodes stay on cell centres,
because those are the simulation's own routing rather than recorded fact. Spawn
and refinery adoption place the unit at its exact pixel too.

At 4:06, 48 replay-driven units sit at sub-cell positions against 5 on a cell
centre. Units are no longer snapped to a 24-pixel grid they were never on.

The encoder needed a wider per-command budget for this (32 to 36 bytes) and a
new flag; the old comment claimed 32 was the widest shape, which was already
the bug that had bitten once before — the budget has to lead the widest
*possible* shape, not the widest one currently emitted.

## Player colours

`CNCObjectStruct.RemapColor` is at **bit 81** of the object body — a bit
offset, since the body is bit-packed. `PlayerColorType` (DEFINES.H) is
`NONE -1, GOLD 0, LTBLUE 1, RED 2, GREEN 3, ORANGE 4, BLUE 5`, and it reads
without a single exception on the sample match:

```
house   8 -> 0 GOLD    on all 803 of its records
house  10 -> 1 LTBLUE  on all 1,027
house 254 -> 255 NONE  on all 13,450   (effects have no house colour)
```

which is exactly what the game shows: Ronaldo-r9 in tan/gold, IIIIIIIIIIII in
light blue. The viewer had been painting slot 0 teal and slot 1 red — a choice
made for readability in mirror matches, before these colours could be decoded.

`palette.ts` now builds a ramp per `PlayerColorType`, `readHouseColors()`
returns each house's colour, and `withRealCommands` maps them onto the two
slots and stores them in the header. The teal/red pairing remains the fallback
for replays with no decoded colours.

### The unit counts are not a discrepancy

The viewer's HUD showed 55 units for Ronaldo-r9 where the game's sidebar showed
29, which looks like a bad over-count. It is not the same statistic. The game's
sidebar reads **0 buildings for both players** at 4:06 in a match where both
plainly have several — so that column cannot be a building count. Those columns
are kills and structures destroyed, not populations. Nothing to fix; the two
numbers were never comparable.

## Replaying unit movement instead of simulating it

Measured properly — pairing each simulated unit with **its own** track rather
than the nearest one — the simulated positions were badly off:

```
median 87.6px (3.6 cells)   p90 361.9px (15 cells)   max 919px
```

An earlier "median 2 cells" was flattering because it matched each recorded
position to the closest simulated unit, which hides exactly the error that
matters.

The cause was that the simulation still modelled *how* each unit got there:
A* routing, turning on the spot before driving, collision. None of that is
recorded fact, all of it adds error, and the error compounds — a unit that
falls behind never catches up.

Three changes, each measured:

| change | median error |
|---|---:|
| baseline: simulated routing | 87.6px |
| replay-driven units follow the recorded position directly | 17.0px |
| waypoint issued at the *previous* sample's time | 14.3px |
| each leg covered in the duration the recording gives | **5.2px** |

**Follow, don't route.** `steer` now hands any unit with a decoded track to
`follow`, which drives straight at the recorded position, turns while moving
rather than stopping to pivot, and keeps no path.

**Lead by one sample.** A unit told to go somewhere the instant it was already
there can only arrive a beat late, and that lag is never repaid. The waypoint
is issued at the previous sample's timestamp so the unit drives the interval.

**Carry the leg duration.** `target` is unused on a move command, so it carries
how many ticks the leg took, and the unit covers the leg in exactly that time.
A fixed rate cannot win here: tuned short it darts to each waypoint and waits,
tuned long it lags. It also sidesteps the unit table being slightly slow — a
buggy is 3.5px/tick there against about 4 in the recordings, which alone cost
7 pixels a leg.

Final: **median 5.2px, p75 12.5px, p90 20px** — a fifth of a cell, with cell
error 0 at the median. No regressions: harvester dockings still spread across
all 11 refineries (137 total), selection still peaks at 15.

Note the tuning metric samples position every 150 ticks, so it rewards darting
to a waypoint and sitting there. Smoothness had to be reasoned about rather
than measured, which is why the leg-duration form was preferred over the
fixed rate that scored similarly.

## The selection bit is not at a fixed offset

Shipping bit 154 as `IsSelected` was verified against one screenshot on one
match, and that was not enough. Checked across seven replays it decoded
selection in **one**:

```
bit 154 set on 11.6% of records in Heavy Metal
bit 154 set on  0.00% in five of the other six
```

Not a truncation problem — every record in every one of those replays is
longer than 154 bits. The field simply moves. Searching each replay by
signature instead finds it at **154, 155, 156, 157, 158 and 159** depending on
the file, so something ahead of it in the record varies in width by a few bits.

`findSelectionBit` now locates it per replay rather than assuming an offset.
The signature is sharp enough to be unambiguous:

- carried by commandable units, essentially never by structures or effects
- held for consecutive frames rather than blinking
- reaching group sizes

One gate was too strict: a median run of 3 frames rejected candidates that were
otherwise textbook — 99.7% on units, 4,596 runs, 46 objects at once — because
their median run is exactly 2. At 2 the search finds selection in **9 of 9**
replays, at 93.8% to 100% on units, with group peaks of 17 to 50.

The Heavy Metal result is unchanged, so the screenshot confirmation still
holds: at 4:06, Ronaldo-r9 with 15 BGGY and 2 E1.

### Still unresolved

Several replays offer **two** strong candidate bits, and they are not
house-exclusive — each leans one house 71% to 90% but appears on both. So this
is not `IsSelectedMask` written as one bit per house. Whether the pair is
`IsSelected` alongside a related flag is open; the search takes the candidate
with the best unit-purity times group-size, which is the one the screenshot
confirmed on the match where that could be checked.

## ControlGroup: still not found

With selection decoded, control groups can be labelled from the data itself —
units repeatedly selected together are a group. That gives real labels for the
field search: 414 same-group pairs (co-selected 3+ times) against 208
different-group pairs (never co-selected).

The best candidate, bit 393 at 3 bits, scores 86% same-group agreement and 83%
different-group split across 6 distinct values — and is not it. A control group
assignment persists for a unit's life; this is constant within a unit only 46%
of the time, and its value 6 is carried by 10 harvesters, which is a harvesting
state rather than a group. The score came from correlating with unit behaviour.

Worth noting for the next attempt: `ControlGroup` sits very late in
`CNCObjectStruct`, past `CanMove[32]` and `CanFire[32]`, and the wire format
serializes a subset — records are 89 to 117 bytes against a struct well over
700. It may simply not be written.

## 0x3781 fully laid out

Every field of the record is now pinned. Widths come from the mask/length
table, and the order was settled by using the frame stamp as a probe: its value
is predictable, so searching for the 32-bit window that equals `frame + offset`
locates it in each mask, and the rest follows by elimination.

```
header  48 bits   marker 8 | key 16 | type 16 | mask 8
bit0    21        PositionX, pixels          (11 bits used)
bit1    21        PositionY, pixels          (11 bits used)
bit2    16        X, leptons
bit3    16        Y, leptons
bit4    16        Altitude
tail    32        frame number               present iff bit0 or bit1
bit5    16        animation frame
bit6    32        draw order
bit7     5        always zero in these matches
```

The tail sits **after bits 0 to 4 and before bits 5 to 7**, which is why
reading it as the record's last 32 bits produced the right modal offset and
garbage everywhere else.

Validated across five replays: **zero length mismatches** over 77 to 143
distinct masks each, and the frame stamp decodes correctly in **100.00%** of
5.36 million records (99.98% in one replay).

### Bit 4 is Altitude

Range 0 to 256, and it separates perfectly by object:

```
C17     100% non-zero, top value 256      <- FLIGHT_LEVEL
BGGY      0% non-zero
HARV, E1, PROC, trees   all exactly 0, every reading
```

One cargo plane's readings in order:

```
245 235 213 203 192 171 160 149 139 128 117 107 85 75 64 43 32 21
 32 43 53 64 96 107 117 128
```

That is the descent and the climb away — the `FLY_TO_AIRSTRIP` curve read out
of AIRCRAFT.CPP earlier, now visible in the recording. The viewer currently
models that descent with `DESCENT_CELLS = 6`; the real altitude is available
and could drive it instead.

### Bits 5 and 6

Bit 5 spans 0 to 659 across 581 values, changes almost every record (constant
within an object only 8% of the time), and is carried by MINIGUN, PIFF and PROC
as much as by units — an animation frame.

Bit 6 spans 0 to 184 across 185 values, differs between objects in the same
frame, and its range tracks the number of objects alive. That is the draw
order — `SortOrder++` per object per frame, the second of the two SortOrder
paths in DLLInterface.cpp rather than the `Sort_Y() >> 3` one.

Bit 7 is five bits and zero in every one of 102,287 readings.

## The cargo plane's altitude now comes from the recording

Mask bit 4 is `Altitude`, so the descent no longer has to be modelled. Across
**212 cargo-plane passes**, aligned on each pass's own lowest point:

```
cells from the lowest point   0     1     2     3     4     5     6    7+
measured fraction of cruise  0.23  0.34  0.51  0.73  0.88  0.94  0.98  1.00
the old linear ramp          0.00  0.17  0.33  0.50  0.67  0.83  1.00  1.00
```

The six-cell span was right — that is the engine's own `0x0600` lepton rule out
of AIRCRAFT.CPP, and the recording agrees. Two things the linear ramp had
wrong:

- **The plane bottoms out at 0.23 of cruise, never at zero.** It is a fly-past
  and it stays well clear of the ground. The lowest point of a pass is a median
  of 32 out of 256, p10 21, p90 75.
- **The curve is steeper near the bottom than a straight line**, so the plane
  holds its height longer and then drops.

`CARGO_ALTITUDE_BY_CELL` in `simulation.ts` is that measured profile, read by
`cargoAltitude()` with linear interpolation between cells. A simulated pass now
bottoms at exactly 0.23 against the recording's 0.23, and still never stops.

Earlier attempts at this measurement were thrown off twice, both worth
recording:

- Comparing altitude against distance to the *nearest decoded airstrip* looked
  like it disproved the six-cell span. Only one of the match's three airstrips
  had decoded a track, so planes descending toward the other two were counted
  as cruising far from a strip, which dragged the apparent cruise altitude down
  to 189 of 256.
- Splitting the altitude series into passes by "altitude jumped up" cut passes
  mid-descent and produced a profile that never reached cruise. Using the
  position-jump segmentation already validated for tracks fixed it.

## Cargo planes now fly their recorded routes

A C17 track segment *is* one delivery run: the stream restates the plane every
frame it exists and recycles its key once the pass is over, so the
position-jump segmentation that separates unit lives separates passes too. With
position, pixels and altitude all decoded, neither the route nor the descent
has to be modelled.

Carried on a new `cargo` command — one waypoint each, with the altitude in
`target` and the leg's length in `id`, since a cargo waypoint has no other use
for either. A command with no position ends that plane's pass. The modelled
deliveries stand down whenever the replay carries its own; without them the two
would double up.

```
214 C17 segments -> 6,256 waypoints, 212 refs, 212 end markers
212 planes born, 204 ended (8 still airborne when the match ends)
simulated pass length  median 7.1s   max 90.9s
recorded segment length median 7.3s   max 91.0s
lowest point across 200 passes: median 0.13, against the recording's 0.13
```

Two typical passes, as the simulation now flies them:

```
ref 8   x 61 58 53 48 43 38 34 28 24 19 15 10 5   y 19 (constant)
        altitude 0.93 0.33 0.79 1.00 1.00 ... lowest 0.08
ref 7   x 60 56 51 47 42 38 33 27 23 18 14  9 4   y 21 (constant)
        altitude 0.76 0.39 1.00 1.00 1.00 ... lowest 0.33
```

East to west on a fixed heading, no stop — and the two passes fly different
lanes, y=19 against y=21, which is real recorded variation the single modelled
route could not produce.

One caution while reading these: a probe that latched onto the first
track-driven plane appeared to show one crossing the map three times. It had
picked the 91-second outlier segment rather than a typical 7-second pass. The
median comparison above is the honest check, not a single trace.

## Structures are destroyed now

They were not before, and that was the visible bug: a guard added so that
synthesised combat could not delete a decoded building also meant *nothing*
could, so every structure either player ever built stood to the final frame.
A base that really finished with two refineries was drawn with six.

`kill()` now takes a `decoded` flag. Synthesised combat still cannot touch a
real structure — that guard was right, and it was stopping invented events from
overwriting ground truth. A decoded kill is the opposite: it *is* ground truth.

The signal is a structure's track going quiet. A building is restated while it
exists and its key is recycled once it is gone, so a well-followed structure
that stops being reported well before the match ends has been destroyed or
sold. On the Heavy Metal match that gives six losses, and the shape of them
matches the result — Ronaldo-r9 loses two power plants and a refinery, and the
winner loses two refineries to the counter-attack.

### Two traps in the site logic, both hit

**A structure never moves, so every cell a track visits is a different
building.** The segmenter needs a jump of several cells to split a track, and a
key reused on a structure two cells away stays one track. Reading its last cell
then attributes the death to the wrong building entirely: it had a Construction
Yard being demolished at a gun turret's coordinates, 100+ cells away.

**But splitting on the exact cell is too sharp.** A building's reported cell
drifts by a cell, which split one Construction Yard into several sites and had
it destroyed at 218s while it was plainly still standing at 364s. Sites are now
merged within two cells — about a footprint.

### Construction Yards are excluded, deliberately

This signal gets them wrong. It wanted to demolish **both** yards in a match
one player went on to win, and losing a yard effectively ends a Tiberian Dawn
game — a player still fighting at the final frame had theirs. Rather than ship
a visibly false event, `FACT` is skipped.

That is a real gap, not a solved problem. The underlying cause is that the keys
behind structure tracks are recycled, so a track ending is ambiguous evidence.
A stronger signal would settle it: the half-cost refunds already decoded
identify sales, which would separate "sold" from "destroyed" and leave a
cleaner residue to reason about.

## The "overlapping structures" were my footprints, not the decode

A turret and a Hand of Nod decoded onto the same cell, which looked like a
placement error. It is not one.

Two independent sources agree on where structures stood — the build events
(per-type byte offsets in the object records) and the 0x5781 cell at bit 40.
Where both exist they match **exactly**: 15 of 17 at distance 0. The apparent
disagreements are all buildings with no track at all, where the nearest site of
the same kind is simply a different building.

The real cause is that **Tiberian Dawn foundations are not rectangles**, and
the viewer treats them as such. From the occupy lists in BDATA.CPP:

```
Refinery    {1, MCW, MCW+1, MCW+2}        4 cells of a 3x2 box, both top corners free
Power       {0, MCW, MCW+1}               3 cells of a 2x2, top-right free
Hand of Nod {MCW, MCW+1, MCW*2+1}         an L in a 2x3
Barracks    {0, 1}                        2x1
Weapons     rows 1-2, cols 0-2            3x3 with the top row free
Con Yard    {0,1,2, MCW,MCW+1,MCW+2}      a full 3x2
Airstrip    {0..3, MCW..MCW+3}            a full 4x2
```

A turret at a Hand of Nod's top-left corner is standing on a genuinely free
cell — players tuck them into those notches, and it is good play. Of the three
apparent overlaps in the sample match, two are this, and only
`PROC(58,10) x GUN(60,11)` lands on a cell the refinery really occupies.

### Ten footprints were wrong

Checked against the occupy lists, the table had been guessed:

```
Construction Yard  2x2 -> 3x2       Weapons Factory  3x2 -> 3x3
Airstrip           3x2 -> 4x2       Repair Facility  2x2 -> 3x3
Hand of Nod        2x2 -> 2x3       Tiberium Silo    1x1 -> 2x1
Barracks           2x2 -> 2x1       SAM Site         1x1 -> 2x1
Obelisk            1x1 -> 1x2       Adv. Guard Tower 1x1 -> 1x2
```

The bounding box is still an approximation. Carrying the occupy lists
themselves is what a faithful version would do, and it would let a turret sit
in a refinery's corner exactly as it does in the game.

## Health: 0x5781 bit 134

`Strength` — current health — is a 16-bit field at bit 134. Found by matching
its per-type peak against the game's own numbers rather than by guessing:

```
BGGY 140    HARV 600    PROC 900    NUKE 400    E1/E4 70
```

Those are UDATA.CPP's and BDATA.CPP's values exactly, and it is the **only**
16-bit field in the record that peaks at them. Confirmed on four unrelated
replays: PROC 900, NUKE 400 and HARV 600 every time.

It behaves like health: **3,296 steps down against 670 up** — it falls under
fire and only rises on repair — and one buggy's trace reads

```
140 140 ... 138 118 118 116 ... 44 12   then 140 as the key is recycled
```

Unlike the selection flag, this one does **not** move between replays.

### It separates a destroyed building from an untracked one

Health alone does not mark death — the stream usually stops restating a
building before it dies, so only one structure in the sample match reaches
zero. Health *together with* the track ending does separate the cases cleanly:

```
house 10 FACT (50,10)   800/800 full, goes quiet at   5s   -> never tracked, stood
house  8 FACT (17,51)   390/800 hurt, goes quiet at 364s   -> destroyed
house 10 AFLD (57,19)  1000/1000 full, quiet at 112s       -> never tracked, stood
house 10 GUN  (46,37)   380/900 hurt, quiet at 356s        -> destroyed
```

Full health when it goes quiet means the stream lost interest; damaged means it
fell. That is the distinction the previous rule could not make, and it is why
that rule wanted to demolish **both** Construction Yards in a match one player
won — the winner's is at 800 of 800 when it drops out, the loser's at 390.

### Honest state of the death rule

Gating on health removes the false Construction Yard kills, and the
`FACT` exclusion is gone. But it is now too conservative: three deaths fire
where the per-site figures above justify six, because sites are merged across a
whole track and the peak and final readings get mixed between buildings that
shared a recycled key. One kill also lands on a cell with nothing on it.

So: the health decode is solid and verified; the death rule built on it is
better than what it replaced and still not right. Splitting sites by health
history rather than only by position is the obvious next move — a site whose
health jumps back to full is a different building.

### What health is really for

Health bars, and real damage. The viewer currently invents both. Every object
carries its health every frame it is restated, so the bars could show what the
players actually saw. That wiring is not done.

## Health is in the viewer

Recorded health now drives the bars. It rides on the track waypoints and the
spawns, in a **second flag byte**: byte 7 of each command was a spare, and the
first flag byte was full at eight bits, so extra fields live there rather than
overloading an existing one.

```
24,485 commands carry health, lossless through the encode
encoded replay 0.97 MB, up from 0.69
```

The simulation clamps each reading to the unit's own maximum and the renderer
already drew bars from `hp / maxHp`, so nothing there had to change. At 3:00 in
the sample match the canvas carries 274 pixels of healthy bar and 41 of damaged
— red bars on units that really were hurt, where before both the damage and the
bar were invented.

Damage over the match, on replay-driven buggies:

```
120s   3 alive,  2 showing damage
180s  33 alive, 22 showing damage
240s  19 alive, 13 showing damage
360s   2 alive,  2 showing damage
```

and harvesters ending the match at 592/600, 551/600, 173/600, 140/600.

### The death rule, finally not lying

Splitting sites on health as well as position fixed the last false event: a key
recycled onto a fresh structure on the same ground shows up as health jumping
back toward full, and merging those two lives into one site mixed their peak and
final readings.

All three decoded structure deaths now land on a real building, none on empty
ground, and neither Construction Yard is wrongly destroyed. It remains
conservative — the per-site figures justify six losses and three fire, because
the others fall under the sample and span thresholds once split. Under-reporting
a loss is the safe direction; inventing one is not.

## Combat is recorded, not simulated

Muzzle flashes, bullet impacts, shells and explosions are objects in the stream
like any other, each with a position and a moment. In one six-minute match:

```
MINIGUN  2,433    muzzle flashes
PIFF     1,924    bullet impacts
120MM      143    tank shells
FIRE3/FIRE2/FRAG1/FBALL1   explosions
                 4,509 events in total
```

They are unowned — house 254, `REMAP_NONE` — which is why they never appeared
in any per-player analysis, and why the earlier structure work kept tripping
over them.

Whether an effect marks the shooter or the target is visible in where it sits.
Sampling against the units that have tracks:

```
PIFF     on a unit's exact cell 42%, within one cell 53%   — impacts, on targets
MINIGUN  on a unit's exact cell 15%, within one cell 31%   — flashes, drawn at the barrel
120MM                            7%,                 25%   — shells in flight
```

The match rates are floors, not ceilings: only units that earned a 0x5781 track
are in the comparison at all.

### Drawn with the game's own art

`minigun.shp`, `piff.shp`, `120mm.shp`, `gunfire.shp`, `fire1-4`, `frag1/3`,
`fball1` and the napalms are all bundled already, so a recorded shot is drawn
with the sprite that shot actually had. The sprite bank loads one per
`COMBAT_EFFECTS` entry and the renderer plays each animation once over the
effect's life.

Peak 28 effects on screen at once, and the count climbs through the match as
the fighting builds — 0 at the start, 4 by 4:00, 12 by 6:00.

The encoded replay is 1.04 MB with all of this in it.

## Facing comes from the recording

The DLL never exports a usable rotation — `new_object.Rotation = 0` on the main
path — so a search for a heading field in 0x5781 found nothing: the best
candidate agreed with the direction units actually travelled at 0.26, against a
0.13 baseline. Sharpening the headings with pixel positions made it *worse*,
which is the tell that it was never facing to begin with.

Facing is carried by `ShapeIndex` instead, which is 0x3781 mask bit 5 — the
field previously labelled "animation frame". For a vehicle the sprite frame
**is** the heading:

```
BGGY   shape % 32, counter-clockwise   agreement 0.809
HARV   shape % 32, counter-clockwise   agreement 0.915

every other reading — 8 or 16 steps, either direction — 0.03 to 0.16
```

Counter-clockwise, which independently confirms the renderer's existing note
that "all vehicle sprites run counter-clockwise" — that was worked out from the
SHP files, and the recording agrees.

Wired through on spawns and waypoints in the second flag byte: 6,516 commands
carry a facing, and at 4:06 **33 of 34** replay-driven vehicles point where they
really pointed, across 15 of the 32 steps. `follow()` only derives a heading
from motion when the replay did not record one.

Buggy values run 0..63 rather than 0..31 — the upper half is a second state
(the harvester's digging pose already lives at `VEHICLE_FACINGS + f` in the
sprite code), so `% 32` takes the heading and leaves that intact.

## The infantry animation table was wrong

IDATA.CPP carries a `[start, count, jump]` triple per sequence per infantry
type. `MiniGunnerDos` says:

```
DO_STAND_READY    0, 1, 1        DO_FIRE_WEAPON   64, 8, 8
DO_STAND_GUARD    8, 1, 1        DO_LIE_DOWN     128, 2, 2
DO_WALK          16, 6, 6        DO_CRAWL        144, 4, 4
DO_PRONE        192, 1, 8        DO_FIRE_PRONE   192, 6, 8
```

The viewer had walk starting at **8** and fire at **72**. Both wrong — walk
starts at 16 and fire at 64. An earlier attempt measured this off the SHP
itself and landed on 8; the recording says otherwise, and so does the game's
own table.

The recorded frames settle it cleanly:

```
                        real table      viewer's old table
frames inside a sequence   98.8%              —
frames in the walk cycle   89.6%              —
facing vs travel          0.930  (4,340)   0.861  (3,268)
```

It also shows poses the viewer never drew: **CRAWL 126 readings, FIRE_PRONE 63,
LIE_DOWN 16, GET_UP 11**, and both idle animations. Infantry in this match go
prone and crawl, and the viewer had them walking upright throughout.

`INFANTRY_DO` now carries the game's numbers, including guard, lie-down, crawl,
get-up and prone-fire.

## Facing, both unit classes

`infantryFacingFromShape()` recovers the facing from an infantry frame by
finding which sequence it lands in — a frame is `start + facing * jump + stage`,
so the facing falls out once the sequence is known. Vehicles take
`shape % 32` directly.

At 4:06 of the sample match, **33 of 34 vehicles** and both infantry present
point where they really pointed. `follow()` derives a heading from motion only
where the replay recorded none.

## The recorded frame is drawn, not a chosen one

`ShapeIndex` is the frame the game itself drew. It carries the pose as well as
the heading, so deriving a frame from facing plus "is it moving" can only
differ from what actually happened.

`unitFrame()` now returns the recorded frame directly when the replay has one,
and ignores facing, movement and the animation clock entirely. Those remain
only as the fallback for objects the replay never framed.

```
units drawing the game's own frame   450 / 468
infantry poses, taken from the file  walk, ready, fire — and crawl and prone
                                     wherever the match had them
```

This is what makes the earlier infantry work matter. Correcting the table from
IDATA.CPP fixed *which* frame a pose maps to; drawing the recorded frame means
the pose is not chosen at all. A unit that dropped prone is drawn prone because
the file says frame 192-something, not because the viewer inferred it stopped
moving.

Still derived, and worth naming: the **turret overlay** (`turretFrame`) is
computed from a simulated turret facing. Vehicles with independent turrets carry
their turret frames in the same SHP above the hull frames, so the recording very
likely has them too — that is the next thing to take off the simulation.

## Turrets are separate objects — and were being drawn as extra vehicles

The DLL exports a vehicle's turret as a sub-object with its own
`CNCObjectStruct`, and the stream keeps that: a Buggy arrives as **two keys**,
the hull with frames 0..31 and the turret with frames 32..63.

```
BGGY   80 keys — 39 pure hull, 41 pure turret, 0 mixed
HARV   11 keys — 10 mixed
```

The Harvester is the control: its 32+ frames are the digging pose, the same
directions with the arms out, so its keys are *mixed* rather than split. That
difference is how the two cases tell themselves apart, and it matches what the
sprite code already said about harvester frames.

**The bug this exposed:** every turret was being spawned as a second vehicle
sitting on top of its hull. Roughly half the buggies on screen were turrets
drawn as whole units. Filtering them takes the sample match from 87 Buggy tracks
spawning to 59.

Synthesised combat can no longer kill a replay-driven unit either, only a
decoded death can — the same rule structures already had. It was killing most
of the survivors on top of the file's own deaths.

### Two parts that did not land

Being straight about it rather than leaving them looking finished:

**Turret facing is plumbed but barely populated.** The wire format carries a
turret frame, the renderer draws it in preference to a computed one, and the
hull/turret pairing works by co-location — but only **6** commands come out
carrying one. The pairing samples too few points per track and mostly fails to
match. The turret still falls back to the simulated facing.

**Unit deaths now under-fire.** Gating them on health the way structures are
gated leaves 32 buggies alive where the tracks say about 14 of 59 hulls survive
— 45 end at 20 health or less of 140. Before the change it killed too many and
left 4. Under-reporting is the safer of the two errors, so this is where it
sits, but it is not right.

Both come down to the same weakness: `shape` and the per-sample health only
reach 18% of track samples, because they ride on 0x3781 records that carry a
position pair *and* the relevant mask bit. Reading those fields from records
that carry them without a position would widen the coverage a lot, and is the
thing to fix before either of these can work properly.

## The coverage bug behind both failures

`0x3781` is a **delta**: a record carries only what changed. A frame that
reports a new sprite index without the object having moved has no position
pair. `readObjectTracks` required a position pair before reading *anything* from
a record, so every one of those was discarded.

Each field is now collected in its own series and attached to samples by
nearest time, independently:

```
                 before    after
sprite frame       18%      87.8%
health             —       100.0%
altitude           —        52.7%
position                    72.6%
```

That one change fixed both of the things that were failing:

**Turret classification is now clean.** 87 Buggy tracks split 42 hull / 43
turret with 2 too sparse to judge, against 31/28 with 28 unjudgeable before.
Buggy spawns fall from 87 to 44 — the doubled vehicles are gone, and the
encoded replay drops from 1.05 MB to 0.78 MB because it is no longer carrying
a phantom unit for every real one.

**Unit deaths land.** The file says 29 of 44 hulls die and 15 survive; the
simulation now ends with **17** buggies alive. It ended with 4 when deaths fired
on the track ending alone, and 32 when the health gate could not see enough
health to fire.

Sprite frames carried on the wire go from 6,516 to **14,630**.

### Turret rotation

Turrets now rotate from the recording:

```
turret frames carried    10,606   (48 before)
distinct angles used         32   of 32
units whose turret turns  71 of 76, a median of 21 angles each
peak units drawing one       61
```

Two things had to be right. Turret records are matched to their hull on the
**cell**, not the pixel: a turret does not move independently, so its position
is seldom restated and matching on pixels found 25 frames in a whole match.
And the last known angle is carried forward for a few seconds rather than
requiring a reading beside every hull waypoint — which is what the engine does
between updates anyway, since a turret keeps pointing where it was pointing
until it is told otherwise.

The reason it looked like a data-density problem for so long was simpler and
more embarrassing: an earlier edit had dropped the turret lookup from the
**move** waypoint, leaving it only on the spawn. Every vehicle picked up one
turret angle at birth and held it for life. The symptom — "one frame per unit"
— was the diagnosis, and I read it as thin data instead of a missing line.

## Synthesised combat stands down

With every shot and every health value coming from the file, the simulated
combat was no longer adding anything — it was **overwriting** what had been
decoded. `tickCombat` re-aimed each turret at whatever target it picked, on
every tick, off the recorded angle; and projectile hits subtracted invented
damage from recorded health.

That was undoing the turret and health work between waypoint updates.

`hasRecordedCombat` is set when the replay carries effect commands, and while it
holds nothing fights: no target acquisition, no projectiles, no invented damage.
It applies to every object, not just tracked ones — a stray generated unit
throwing shots across a decoded battle is noise either way.

```
peak invented projectiles    0     (recorded effects 28)
invented explosions          3     — from decoded deaths, which is right
units showing recorded damage 22
buggies alive at end         17    against the file's 15
```

The explosions that remain come from `kill()`, so they mark deaths the replay
recorded rather than fights the viewer imagined.

## End to end, on replays other than the one it was built on

Everything above was verified on one match, which after a session of finding
integration bugs is not enough. Running the whole pipeline — decode, command
build, encode, decode, simulate — on unrelated replays:

```
replay          tracks  selection  turret  effects  units at end  file says
Heavy Metal      4,868     11.6%     67%      28         34          30
second           5,402      9.8%     39%      17         91         121
third            2,829      5.0%     16%      13         88          82
```

Nothing fails outright. Selection, turret facing and combat effects all decode
in every one, and the survivor counts land near what the tracks themselves say.

Two honest gaps:

**Turret coverage varies a lot** — 67%, 39%, 16%. The cell match depends on how
often a turret's record is restated near its hull's waypoints, and that differs
by match. Where it misses, the turret falls back to the simulated facing, so
the effect is a partial improvement rather than a wrong one.

**Survivor counts drift by up to 30.** The second replay ends with 91 units
where its own tracks say 121, the third with 88 against 82. The death rule
gates on health at the last sighting, and it is over-firing on some matches and
under-firing on others. It is the least settled part of the pipeline.

## Four viewer bugs, and what the file actually said

Reported from watching the viewer: red never showed a selection, a teal cargo
plane landed on red's airstrip, harvesters moved too fast, and each player
started with a harvester at the opposing spawn. All four were decode bugs, and
three of them had the answer sitting in the game's own source.

### IsSelected is a mask, not a flag

`DLLInterface.h:238` declares `unsigned int IsSelectedMask` — one bit per
house, because each player in a multiplayer game has their own selection. The
decoder searched for a single best bit and found one, which is why selection
looked perfect for one player and absent for the other.

Scanning the movement stream by house shows the two bits side by side:

```
bit    set   onUnit%     h10     h8   medRun  atOnce
154   6390    100.0      655   5735        7      23
155   4025     99.7     2197   1828        3      23
```

Bit 154 is teal's, 155 is red's. The viewer read only 154. Each house is now
given the candidate bit that fires most on the objects it owns, and an object
counts as selected when its *own* owner's bit is set — a player can click an
enemy unit to inspect it, which sets the clicking player's bit on an object
they do not own, and drawing that would bracket the wrong side's units.

Neighbouring bits are held to the purity test but not the frequency floor: a
player who selects rarely fell under it, which left that side with no selection
at all in two of eight replays. Selection now decodes for both players in every
replay where it decodes at all (8/10; the other two decode none).

### The cargo plane's owner is not in its track

Every C17 in the reference replay is recorded under one house — 214 of 214 —
because the engine spawns the delivery aircraft rather than the player owning
it. Reading the track's house painted every plane the same colour. The airstrip
it delivers to is the real owner, so each flight is now matched to the strip it
passes closest to. Planes went from `player 1: 6256, player 0: 0` to
`player 0: 2988, player 1: 3255`.

### Harvesters ran at 3.7x their own top speed

`UDATA.CPP` gives every unit a SPEED from the `MPH` enum in `DEFINES.H` —
leptons per logic tick, 256 leptons to a cell. Measured against the recordings
a buggy comes out at almost exactly **twice** `(MPH/256)*15`, which puts the
logic rate at 30 ticks a second rather than the 15 the classic games ran at.

On that conversion buggies were already correct and harvesters were 3.7x too
fast. The cause was not bad positions but two clocks: a sample's pixel reading
can have been taken up to 250ms from the sample itself, so a leg's *distance*
came from the pixel clock while its *duration* came from the sample clock.
Buggies are sampled densely enough not to notice; harvesters, sampled the most
sparsely, do not survive it.

```
            sample clock      pixel clock
HARV   5.21 c/s  3.70x     1.49 c/s  1.06x
BGGY   3.48 c/s  0.99x     3.55 c/s  1.01x
```

Samples now carry the pixel reading's own timestamp and legs are timed by it.
Across eight replays harvesters land at 1.06-1.14x the table and buggies at
0.90-1.01x. A pixel reading that disagrees with the cell reported for the same
object is also dropped now, the cell being the field verified exact.

### Object ids are recycled, so identity is per tenure, not per key

Name and owner both came from a vote over everything the object records ever
said about a key. That is wrong in principle: the engine recycles object ids.
In the reference replay **79 of 173 keys report more than one owner** over
their life, and one key runs a house 10 MCV and then a house 8 harvester:

```
key 1352: 5s MCV/h10  26s MCV/h10  50s HARV/h8  64s HARV/h8  79s HARV/h8 ...
```

Voting gave every tenure the identity of whichever object held the key
longest. That is how each side's starting harvester ended up at the opposing
spawn — it was really the other player's MCV — and how one player's buggies
came off the other player's airstrip.

Sections carry exactly one object each (15,280 objects over 46,992 sections,
never two), so the records are a clean per-object timeline. Samples are now
cut wherever that timeline changes name or owner, and each piece takes the
identity in force over it. A vehicle never changes house in TD, so either
change means a different object.

The check that this is right is **MCV count**: every Quickmatch starts each
player with exactly one. Seven of eight replays now decode exactly 2, and
unit segments per house came into balance (p0 31 / p1 48 -> p0 72 / p1 70).

### A per-unit speed cap shreds tracks — retracted

Capping segmentation by each unit's table speed instead of one flat 12
cells/s looked principled and was a disaster: buggy tracks went from **87
segments to 3,059**, because two cells of ordinary driving between samples
300ms apart reads as 6.7 cells/s and a buggy's cap is 5.6. Every extra
segment becomes a unit that spawns and never dies, which carpeted the map
with buggies and put selection brackets on all of them.

It also never did anything: harvester speed measured 1.49 c/s under the flat
cap, the per-unit cap, and the per-unit cap with the original jump floor —
identical in all three. The pixel clock was the entire fix. Reverted.
### Explosions do not corroborate deaths

Counted from object records rather than track segments the animations are
plentiful — FIRE3 226, FRAG1 201, FIRE2 32, NAPALM1 20, FBALL1 19 — which
retracts the earlier "too few explosions" note, measured from segments. But
only 20 of them resolve a position, because `readDeltaObjects` cannot calibrate
a per-type cell offset for a type that appears rarely. Those 20 sit beside 10%
of deaths against a 0% positional null, so the signal is real and far too thin
to gate on. The death rule stays on health at last sighting.

### Selection has to be asked at a moment too

Reported after the identity fix landed: each player had some of the other's
units bracketed. The track assembly was resolving identity per tenure by then,
but the selection pass still asked `ownerOf(key)` — the key's majority owner,
the very thing that had just been shown wrong. A key that served one player and
later the other therefore spent half its life reading the wrong player's mask
bit, and a bit set because the *opponent* clicked a unit to inspect it was
drawn as that unit's own selection.

Both places now share one tenure table, and the owner is asked at the probe's
own timestamp. That also sharpens the evidence for the mask model itself,
because the earlier per-bit figures were computed with the bad owner:

```
                 key-majority owner        tenure owner
bit 154   h8 5735 / h10  655  (90% h8)   h8 5211 / h10 1179  (82% h8)
bit 155   h8 1828 / h10 2197  (55% h10)  h8 1140 / h10 2885  (72% h10)
```

Bit 155 looked like noise at 55% and is plainly house 10's at 72%. Both bits
are one house's selection, as `IsSelectedMask` says they should be. The
residual cross-firing is discarded: an object counts as selected only when its
own owner's bit is set. **0 of 2,003** select commands now name a unit
belonging to the other player.

### The mask bit is computable: `150 + owner/2`

The residual was chased rather than written off, and both halves of it gave
something up.

**The cross-firing was a dating error, not clicks.** Splitting selections by
how near they sat to a key changing hands:

```
cross-firing as a share of selections   on a key that never changes hands  11.6%
                                        within 15s of a handover           51.0%
                                        away from any handover              9.2%
```

A handover was dated at the first record carrying the new identity, but the
records restate an object only every few tens of seconds while the movement
stream samples it constantly, so a long tail of samples stayed credited to the
previous object and was read against the previous player's bit. The recording
says where the handover really is: one object moves continuously and the next
to take the key is somewhere else, so the largest position step inside the
bracket is the changeover. That drops near-handover cross-firing to **8.9%**,
level with keys that never change hands. It also recovered selections that
were being lost outright — house 8 from 5,211 to 5,845 samples, house 10 from
2,885 to 3,318.

**The `base + owner/2` layout holds after all.** The earlier scan that gave
eight different bases had no purity gate and locked onto a common flag at bit
140. Going straight to the predicted bit instead of hunting for the best one,
every house of eight replays fires on its own objects 66-93% of the time.

What made it look wrong was the *selectable* set, which was hand-written and
missing things. One bit read 37% "on units" because 1,425 of its hits were
**E2** — the Engineer. Others were **HELI** (Apache), **HPAD** (Helipad),
**C1**/**C7** (civilians) and **C17** (the cargo plane). Taking the names from
UDATA.CPP, IDATA.CPP, BDATA.CPP and the aircraft types instead, the predicted
bits fire on selectable objects essentially always.

So each house's bit is now computed as `SELECT_MASK_BASE + owner / 2` with
`SELECT_MASK_BASE = 150`, validated per replay, with the old signature search
kept as a fallback. That matters most for the quiet player: a search needs
enough selections to recognise the field, so someone who rarely selected
anything got nothing decoded. **10 of 10 replays now decode selection for both
players**, up from 8, and 0 of 2,357 select commands name the other player's
unit.

### The owner is not in the movement record

Worth stating as a settled negative, because it is the obvious thing to reach
for. `CNCObjectStruct` has a `char Owner` field, so the movement record might
carry it and make all the tenure inference unnecessary. Searched over every
offset of the widest record (601 bits) at every width from 1 to 12, against
15,965 samples on the 94 keys that never change hands, the best field agrees
with the owner **68.1%** of the time — barely above simply guessing the larger
house. There is no owner field. 0x5781 carries state; identity lives in the
object records, and has to be joined to it by key and moment.

### Animations hold keys too

21.1% of all samples arrive before their key's first *owned* record — median
lag 40s, up to 264s — and 128 of 149 such keys show a position jump in that
stretch, meaning a different object held the key. Those samples were being
swept into whichever unit claimed the key next.

The records sitting in that gap turned out to be `FIRE3` and `PIFF` under house
254. They were being filtered out as unowned, but an explosion or a muzzle
flash is an object and takes a key like anything else. Keeping them as tenures
in their own right moves **~8,400 samples** off the players and onto the
objects that actually owned them:

```
             before    after
house 8      27,137   24,410
house 10     26,616   20,811
house 254     ~1,400    9,929
```

Every unit figure held: MCV 2, 143 spawns, 110 kills, 0 cross-player
selections. It also surfaced **2,620 PIFF tracks** — one per shot — that had
been absorbed into unit paths.

Across ten replays: MCV is exactly 2 in **9 of 10**, selection decodes for both
players in **10 of 10**, and unit segments per house are balanced throughout.

### What the wrong-side units are

31 of 143 unit tracks begin nearer the opponent's base. Splitting them by how
much of their life they spend on their own side: **24 go home at some point**,
which is a raid, and **13 never leave the other side**. The 13 remain
unexplained — they are 6% of units, they cluster near the opposing airstrip,
and their object records name their house consistently, so either they are
genuinely parked in the enemy base for their whole life or something upstream
of the object records is wrong about them. Not resolved.

### Impacts corroborate the death rule but cannot improve it

`ANIM_PIFF` is DEFINES.H's "machine gun impact piffs", drawn where the round
lands rather than where it was fired, so impacts cluster on whatever is being
shot. Counted within 3 cells and 4s of a track's last position:

```
ends early, low health   (rule: died)      109 tracks, 99% have an impact beside them, median 28
ends early, full health  (rule: survived)    7 tracks, 71%, median 4
still there at the end   (alive)            24 tracks, 67%, median 7
random cell and moment                                  4%, median 0
```

That is a strong independent check on a rule that had none. It is not a
replacement: with turret sub-objects excluded, health and impacts agree on 81
of 116 tracks, and every one of the 33 that only health flags is infantry at
**0% of peak strength** — dead beyond argument, just not the sort of death that
leaves piffs. The 2 that only impacts flag are a harvester at 51% health and an
E4 at 99%, both of which were merely standing near a firefight.

An earlier version of this test claimed 60 tracks had no health reading at all
and 49 of them sat in a hail of impacts, which looked like a large population
of missed deaths. That was wrong — see below.

### Turret sub-objects carry no strength

71 of 140 Buggy tracks read strength 0 for their entire life, while every E1,
E4 and HARV track reads a real value whose peak matches the game table exactly
(BGGY 140, E1 50, E4 70, HARV 600 — so the field offset is right).

Those 71 are the turret sub-objects. `CNCObjectStruct` has a `SubObject` field;
strength lives on the parent, so a turret reports none. Against the existing
turret test — over 95% of shape readings in 32..63 — the split is exact:

```
strength 0, looks like a turret   71
strength 0, looks like a hull      0
has strength, looks like a turret   0
has strength, looks like a hull    69
```

Two unrelated signals agreeing on all 140 tracks is the strongest confirmation
the turret classifier has had. It also explains the phantom "units with no
health": they were never units. Treating them as such is what made the death
rule look like it was missing 49 kills, and a rule was written and then
reverted on the strength of it.

### The units on the "wrong side" are crews, and they are correct

13 unit tracks began nearer the opponent's base and never went home. Every one
is an `E1`, every one has a peak strength between 5 and 25, and most appear
within seconds of a same-house Buggy's track ending at that exact spot.

`UNIT.CPP:952` explains all three facts at once:

```cpp
if (Class->IsCrew && !Class->IsTransporter) {
    if (Random_Pick(0, 1) == 0) {                                   // half the time
        i = new InfantryClass(INFANTRY_E1, House->Class->House);     // the DEAD unit's house
        i->Strength = Random_Pick(5, (int)i->Class->MaxStrength/2);  // 5..25 for a Minigunner
```

The Buggy is declared `IsCrew`. So a buggy destroyed while attacking leaves a
minigunner belonging to the *attacker*, standing in the defender's base, at a
fraction of full health. That is the game, not a decode error.

Strength alone separates the two populations. Across six replays, E1 peak
strength:

```
 5-24   35 tracks     the crew band, Random_Pick(5, 25)
25-29   10
30-49    6            built units already damaged when first seen
50-54  133 tracks     barracks-built, full strength
```

133 sit exactly at 50 and 42 in the crew band, with an almost empty valley
between. Nothing needed fixing; the diagnostic that flagged them did.

### Civilians were being dropped

Chasing the crews turned up a real gap. `C1` and `C7` were absent from the
asset-to-kind table, so every civilian was discarded — 16 C1 and 14 C7 tracks
across eight replays, all owned by player houses.

They come from two places. `UNIT.CPP` sends out a C1 technician when an
*unarmed* crewed vehicle dies (`Class->Primary == WEAPON_NONE`), and
`BuildingClass::Crew_Type` releases a C1 or a C7 on a coin flip when a Silo is
destroyed. The recorded strengths confirm which: C1 tracks peak at 25 and C7 at
5, exactly their `MaxStrength` in IDATA.CPP, so these are building survivors at
full health rather than technicians, who would spawn at `Random_Pick(5, 12)`.

Both sprites were already bundled. Adding the two kinds took the reference
replay from 143 spawns to 146. Their animation table is not the Minigunner's —
`CivilianDos1` walks at frame 56 and fires at 205, against 16 and 64 — but the
recorded ShapeIndex drives the frame directly, so the difference only matters
for the fallback animation.

## Turret coverage

Turret frames reached only some of a vehicle's waypoints, and the shortfall
turned out to be three separate things.

### There is no link to the parent in the record

`CNCObjectStruct` carries `int BaseObjectID` and `char SubObject`, so the
obvious fix is to read the turret's parent straight off the record. It is not
there. Using 112 turret records whose hull was known from position, every
offset in the body was tested at u16 and u32: **nothing names the hull**. A
field at +6 looked perfect at first — 100% of its values on turret records are
some other object's id — but matched against the *specific* hull underneath it,
it is right 0% of the time, and hulls never carry 0 there either. Object ids
are dense enough that any small integer hits the set. The join has to stay
positional.

### Strength identifies a turret exactly

The old test needed 20 shape readings before it would judge a track, then asked
whether over 95% of them sat in 32..63. Strength is exact and needs no budget:
a sub-object reports none. On all 140 Buggy tracks of the reference replay the
two agree perfectly (71 turrets, 69 hulls), and strength additionally caught
tracks the shape test had to abstain on — 47 turrets against 46, 51 against 49,
22 against 19. Each of those was being spawned as a phantom second buggy.

### Pair the turret to its hull once, not per waypoint

The join asked, for every waypoint, which turret reading of this player last
stood on this cell. It misses whenever hull and turret are restated a moment
apart, and with a one-cell tolerance it can hand a vehicle its neighbour's gun.

Deriving the pairing instead — whichever hull a turret shares a cell with most
often is its hull, for its whole life — every turret pairs, and coverage rises:

```
             per-waypoint join   paired
replay A                  91%      96%
replay B                  90%      93%
replay C                  82%      94%
```

All 32 facings appear in the output, so the gun really does rotate through its
full range rather than sticking at a spawn angle.

The remaining "0% coverage" replays are not a failure: three of six built no
turreted units at all, so there is nothing to cover. That is where the old
16-67% range came from — it was averaging matches that had no turrets with
matches that did.

## The last two maps are ported

Tournament Desert and Tournament Middle Camp were the only maps still drawn by
the procedural generator. Both ship with the game, as loose `.bin`/`.ini` pairs
in the community map folder of the installation:

```
Data/CNCDATA/TIBERIAN_DAWN/COMMUNITY/SCMC5EA.*   [UF] Tournament Middle Camp
Data/CNCDATA/TIBERIAN_DAWN/COMMUNITY/SCMC6EA.*   Tournament Dessert
```

(The game's own data spells it "Dessert".) The seven files there are the whole
community pool, which is what the replay filenames mean by
`MULTIPLAYER_COMMUNITY_4_MAP`. Copying the two pairs in under the ids the
viewer already expected and rerunning `node scripts/gen-map-data.mjs` was the
entire port — no new format work, since the same pipeline already carried five
maps.

```
tournament-desert       desert  77 templates, 454 tiberium, 57 terrain, 2 waypoints
tournament-middle-camp  winter  75 templates, 680 tiberium, 45 terrain, 2 waypoints
```

Two things fell out of it.

**Middle Camp is a winter map**, not temperate. Its `.ini` says `Theater=winter`
and the viewer already had winter tiles and `WINTER.PAL`; only the hand-written
`MAP_META` entry disagreed. Checking the rest against their own files, two more
were wrong the same way — Heavy Metal is temperate rather than desert, and
Monkey in the Middle is desert rather than temperate. `buildMap` reads the real
data so terrain always drew correctly, but `MAP_META.theater` is shown as a
badge on the map page, so all three were being labelled wrongly in the UI.

**The generator branches for both maps are now unreachable** and have been
removed, along with the comment calling them "not yet ported". Only Canyon and
Bullseye still generate, and they show it: 4 distinct tiles against 75-80 for a
real map.

## The sidebar type is not a constant

Two symptoms, reported separately, with one cause: build orders appeared to
exist only for one map, and GDI buildings never showed up in a Nod-vs-GDI
match.

`readProduction` looked for section types `0x01b8` and `0x0198`. Those are not
fixed. Every replay carries exactly two sidebar types, one per player, and
which two varies from file to file:

```
0x0138 + 0x01b8      0x01f8 + 0x0138
0x01f8 + 0x01d8      0x0198 + 0x01f8
```

Each file carries none of the others, so the hardcoded pair decoded both
players in some replays, one player in others, and neither in the rest. Of 35
sampled replays **17 produced no build order at all**, and the maps only looked
implicated because the failures fell unevenly across them — Elevation happened
to be 5/5 and Tournament Desert 1/5. Even a "working" replay usually resolved a
single side, which is why `sideToOwner` so often held one entry.

That is also the GDI bug. Listing the names in each type shows one side
building PYLE/E2/FIX and the other HAND/AFLD/E4 — the two factions. Whenever
the unrecognised type belonged to the GDI player, that player's structures were
never decoded and never drawn.

The type is now found by content: a candidate is accepted if its bytes parse as
sidebar entries, which is decisive — the two real types yield thousands each
and nothing else yields any. A cheap gate on the high byte (0x01 on every type
seen) keeps this off the million-plus object sections per replay. Sides are
numbered by sorting the two types ascending, which is arbitrary but stable;
`mapSidesToOwners` still resolves which player a side actually is by matching
completions against the object records.

`readCredits` had the identical bug against the same two constants, so credits
failed on exactly the replays production failed on. It now shares the discovery
function, which also guarantees a credit sample's side means the same thing as
a build order's.

```
                     before          after
both players          18/35 partial   35/35
credit sides          one or none     0,1 on every replay
Nod-vs-GDI            GDI missing     both sides, GDI-only structures present
```

## Canyon and Bullseye removed

Neither is a ladder map. With them gone every remaining id has real map data,
so the per-map procedural branches were all unreachable and went with them,
along with the helpers only they used. What survives is the `default` branch,
which still guards a `buildMap` call naming no map at all — `mapIdFromName`
never produces one, but a direct call could. `mapIdFromName("canyon")` now
resolves to the default ladder map rather than to a generated one.

Seven maps remain, all from the game's own files.

## Structures were placed when queued, not when built

A building is queued, builds in the sidebar, and only then does the player put
it down. Placements were timed by `queuedAt`, so every structure appeared a
whole build too early:

```
             queued   on the map   error
FACT             6s           7s     1s
NUKE             6s          12s     7s
HAND            11s          18s     7s
PROC            17s          30s    14s
```

Median build time is 5s and p90 is 11s, so the early buildings were on the
ground a full build ahead of themselves — bases assembled before the player had
paid for them.

`BuildEvent` carried `queuedAt` and `placedAt` (first sighting) but no
completion time, and the two bracket it from the wrong sides: queue is early,
sighting is late because object records are sparse. `completedAt` is now
carried from the production run's own end, and placements use it. All ten
sampled structures land on completion, none early.

### The list and the map want different times

They are different questions. A build order is what a player started and when
they started it; the map is where the building is, which is several seconds
later. Both are decoded, so both are sent: the placement rides on the command
tick and the queue moment on `target`, which a placement has no other use for.
`noteBuild` stamps the build order with the queue tick when one is given and
falls back to the current tick for anything with none, such as a unit read
from its movement track.

```
structure        queued  completed | placed on map  build-order list
fact p0              6s         7s |            7s                6s
powr p0              6s        10s |           10s                6s
hand p0             11s        16s |           16s               11s
proc p0             17s        28s |           28s               17s
```

Checked through the binary round-trip, so the split survives encoding.

## The five "rare types" were mostly a miscount

Listing every delta type by volume corrects the premise:

```
0x3781  1,737,844  decoded (per-object field delta)
0x5781     36,872  decoded (movement)
0x3801     14,767  the sidebar, byte-swapped
0xb801     12,705  decoded (object record)
0x7781     12,221  decoded (object record)
0x1701      5,205  sidebar family, byte-swapped
0x9701      5,186  sidebar family, byte-swapped
0x2403      1,115  genuinely undecoded
0x2208      1,109  genuinely undecoded
0x4602        284  genuinely undecoded
0xc602        181  genuinely undecoded
```

`readDeltaSections` reports a type little-endian while the production path
reads it big-endian, so `0x3801` is `0x0138` — one of the sidebar types found
when the production constants were fixed — and `0x1701`/`0x9701` are
`0x0117`/`0x0197` from the same family. Three of the five were already decoded
under another name.

The long tail below those (`0x2aa3`, `0xde04`, `0x214f`, `0x551d` …) is not
record types at all: every one appears exactly once, all between 421s and 423s
in a 423s match, with lengths of 2560, 3200, 5120 and 16384 bits and keys like
0, 156 and 61408. That is the section parser running off the end of the last
frames, and it should be cut off rather than decoded.

### What 0x2208 and 0x2403 look like

The two real unknowns are near-twins and almost certainly two halves of one
thing:

```
          records  keys  length            keys named by object records
0x2403      1,115   269  936..715216 bits  185/269  BGGY, FIRE3, C17, PROC, E4
0x2208      1,109   268  187 bits, fixed     0/268
```

Both span the whole match, both average four records per key, and their counts
track each other. 0x2403 is keyed by object; 0x2208 is keyed in a space the
object records never use, so whatever it identifies is not an object.

### They are one record, paired, and they are the keyframe dump

Bullets were the obvious guess and are wrong. BULLET objects (DllObjectType 7)
do exist but there are only **four ids** in the whole match, all `120MM`, and
none of 0x2208's keys match one — nor any object id, nor any object key.

The key ranges give it away. 0x2403 spans 26..16243 and 0x2208 spans
16410..32627, two disjoint bands split at 16384. They are one id space with
bit 14 set:

```
0x2208 key - 16384 -> a 0x2403 key      268 / 268
0x2208 key - 16384 -> an object key     267 / 268
partner starts within 2s of it          267 / 268
```

So the two types are a *pair* of records about the same object, one filed
under its key and one under `key | 0x4000`. That is why their counts track
each other so closely (1,115 vs 1,109 records, 269 vs 268 keys, both averaging
four per key).

When they are emitted settles what they are. The distribution is bimodal: a
few frames carry the whole population at once and the rest carry exactly one.

```
    1.1s   76 records  delta frame        bulk frames on a keyframe   7 of 8
    4.8s   77 records  KEYFRAME           singles on a delta frame   95 of 96
   25.6s   89 records  KEYFRAME
  129.5s  171 records  KEYFRAME
  212.7s  208 records  KEYFRAME
  316.6s  266 records  KEYFRAME
```

The bulk count grows with the object population — 76, 77, 89, 171, 208, 266 —
and seven of the eight bulk frames land exactly on a keyframe (payload base
21, of which the file has 21). The singletons sit on ordinary delta frames,
one object at a time, which is what a newly created object would look like.

So 0x2403/0x2208 are the **per-object full-state dump**: every object restated
on a keyframe, individually as objects appear. That also explains why nothing
in the viewer was missing while they went unread — they mirror what the object
records already carry.

Their individual fields are still not decoded, and there is little reason to:
0x2208 is fixed at 187 bits but most of those bits are constant across all
1,109 records, no offset decodes as a map cell, and the byte fields that look
like house indices (16, 8, 4, 18) hold the same value in every record, so they
are header constants rather than data.

## Replays can be read from the cloud after all

"Why is the build order simulated again?" had a dull answer — that match had no
local `.Replay`, so there was nothing to reconstruct from and the viewer fell
back to the generated stream. Only **11 of the 19 matches on the front page**
had a local file, and the three newest had none: the ladder lists every match,
while a player only keeps their own.

The interesting part is the follow-up question. This file used to claim the
ladder's replay links were "mostly Glacier-archived and no longer
downloadable". That is wrong. EA still serves them:

```
HEAD https://replays.cnctdra.ea.com/<replayUrl>
  200, content-length 12-42 MB, accept-ranges: bytes
```

Which should have been obvious from this codebase's own behaviour — the header
fetch that supplies map name and duration is a *ranged read of that same URL*,
and it works.

Downloading one end to end: 12.5 MB in 4.3s, decoded in 4.3s, `byOwner 2`,
198 production runs, both houses resolving cleanly (house 12 Nod with
HAND/GUN/PROC, house 16 GDI with PYLE/WEAP/HTNK). A downloaded file decodes
exactly like a local one.

So the viewer now takes the replay from wherever it can: the player's own copy
first because it is free, then anything already downloaded, and only then the
network — cached to `~/.cache/ionscan-replays` (override with
`TD_REPLAY_CACHE`) so a match page never pays for the same download twice. The
cache is deliberately not the player's replay folder; that belongs to the game,
and a download is not something the game recorded.

Confirmed live: browsing matches without local copies produced two cached
downloads of 10.7 MB and 27.0 MB.

## The match simulation is gone

`generateReplay` used to synthesise a whole match from ladder metadata — a
plausible base layout, a build order, unit movement, attacks — so that every
match had something to play. It is now `replayScaffold`, which returns the
header and no commands at all: 278 lines down to 117.

Two reasons. It is not wanted, because an invented match is indistinguishable
from a real one once it is playing, and nobody watching can tell which they are
being shown. It is not needed, because a replay can now be had for almost any
match — the player's own copy, or a download.

A match whose replay cannot be found or decoded now reports that plainly rather
than being quietly filled in.

## Building footprints are right; the offset is elsewhere

The object records carry each building's size, and they agree with the occupy
lists in BDATA.CPP and with the viewer. The recorded figures are pixels and
divide by about 38.7 per cell:

```
AFLD 154x78 -> 4x2      HAND  78x116 -> 2x3
FACT 116x78 -> 3x2      NUKE  78x78  -> 2x2
GUN   40x40 -> 1x1      PROC 116x116 -> 3x3
```

All six match. So a structure drawn a tile out is not a dimension error. The
renderer already follows the game's convention — art centred over the footprint
and sitting on its bottom edge, since building art overhangs upward — which
leaves the sprite's own dimensions as the likely culprit, and that needs a
specific building to chase.

## Bibs are not drawn, and the art is not here

The dirt apron under a structure is a *smudge*, not a template.
`BuildingTypeClass::Bib_And_Offset` picks it by width — 2 wide takes BIB3, 3
takes BIB2, 4 takes BIB1 — only when the type's "Requires a bib dirt patch?"
flag is set, and it places the bib on the building's bottom row:

```cpp
cell += ((Height()-1)*MAP_CELL_W);
```

Nothing draws them yet, and the art is not bundled: there is no BIB1/2/3 under
`public/assets/td/sprites/`, because those live in the game's MIX archives and
nothing in this project extracts from a MIX. That extraction is the actual
work; the placement rule above is already known exactly.

## The selection grouping window is not a matter of taste

A box-select flips the selected bit on every unit in the box, so counting
flips would score one drag as a dozen actions. They have to be grouped, and
the window was the only number in the action count that looked like a
judgement call. It is not — the gaps between consecutive flips are sharply
bimodal, and the valley is empty:

```
   0-10 ms   7,222   75.5%   units inside one selection
  10-20 ms       0    0.0%   nothing at all
  20-40 ms      66    0.7%
  40 ms +    2,277           separate actions, peaking 400-1400 ms
```

Every flip belonging to one selection lands inside a single frame. So the rule
is exact: one selection action per house per frame in which its selection
changed. No threshold to argue about.

## Action rate, and why selection is not in it

Three things in the stream are unambiguously player actions: a move or attack
order (one MOVEFLSH each), starting an item in the sidebar, and placing a
structure. The per-sample movement waypoints are marked silent and already
excluded, so the existing counter needed only its display back. Across five
replays that gives 36-97 actions per minute, which is a believable spread.

Selection is deliberately excluded despite now being decodable, because it
decodes unevenly:

```
house  samples  selected  share
h10     16,023     1,744   10.9%
h18     13,128        47    0.4%   same match
h14     22,453     5,086   22.7%
h18     20,628     4,409   21.4%   both fine here
h12      2,102         1    0.0%
h14      1,246       190   15.2%
```

Nobody plays a match selecting nothing while their opponent selects every
tenth frame. When a house's computed mask bit fails validation it falls back to
another house's bit, which reports near-zero — that fallback is the bug.
Counting selection would flatter whichever player happened to decode.

The readout is labelled as decoded actions rather than APM, because it is a
floor: re-selecting an already-selected group changes nothing observable,
control groups never reach the stream, and stop and guard orders leave no
flash.

## Reading the game's MIX archives

`scripts/extract-mix.mjs` pulls files out of the game's own archives. A MIX
holds no filenames — every entry is keyed by a hash of its name — so
extraction means hashing the name you want and looking for that key:

```
int16 count
int32 bodySize
{ int32 id; int32 offset; int32 size } * count
body
```

The id is Westwood's C&C1 hash: walk the uppercased name four bytes at a time
into a little-endian word, rotating the accumulator left one bit and adding
each word. Red Alert's encrypted variant starts with a zero count; this refuses
those rather than guessing at them.

All 20 Tiberian Dawn archives parse. The bibs turned out to be theater art
rather than general art, so they carry a theater extension instead of `.SHP` —
which is why looking for `BIB1.SHP` found nothing:

```
BIB1.DES 3787   BIB2.DES 2702   BIB3.DES 2039   from DESERT.MIX
BIB1.TEM 3760   BIB2.TEM 2647   BIB3.TEM 2028   from TEMPERAT.MIX
BIB1.WIN 3760   BIB2.WIN 2647   BIB3.WIN 2028   from WINTER.MIX
```

Nine of nine extracted. Drawing them is the remaining step: the sprite loader
reads `.shp` names and these are per-theater, and the bib belongs on the
building's bottom row per `Bib_And_Offset`.

## Spam is recorded; the flash counter was double-counting it

BroodWar's APM counts control-group taps and spam clicking, which is why its
numbers run so high. Checking whether this stream carries the same thing: it
does. One player's move orders sit a median 132ms apart with 57% under 300ms
and 204 of those within two cells of the previous — hammering the same spot.
The other player is calm at a median 1386ms. That difference is real signal.

But checking it turned up a bug in the counter. `readOrderFlashes` pushed one
entry per *frame* an order flash appeared, and a flash survives into the next
frame, so a single click counted 1.82 times for one player and 1.45 for the
other. Uneven inflation is worse than flat inflation: it distorts exactly the
comparison the number exists to make.

The flash object's own id separates them, and the window comes from the same
kind of valley the selection window did:

```
gaps between two appearances of one flash id
   0-70 ms    21
  70-140 ms  141    the flash surviving into the next frame
 140-300 ms   11    valley
 300-700 ms   27
 700 ms +    266    separate orders
```

Orders counted plateau across that valley — 231 at 200ms, 228 at 300ms — so
200ms it is. A first attempt used 2000ms, which sat far past the valley and
merged a third of the real clicks away (154 where there were 231). That would
have thrown away the spam, which is precisely the part worth keeping.

Final: **33-66 decoded actions per minute** across ten player-slots.

What still separates this from a BroodWar APM: control groups (the struct has
`ControlGroup` but it has never been located in the stream), selection (decodes
unevenly, see above), and re-selecting an already-selected group (changes
nothing observable). Spam is not on that list any more.

## ControlGroup, found at last

An earlier pass concluded `ControlGroup` was not serialised. It is, and the
mistake was the same one that hid selection: it was looked for in the object
records rather than in the movement stream.

It was found by its neighbour rather than by searching for it. The struct puts
`unsigned char ControlGroup` immediately before `unsigned int VisibleFlags`,
whose "all" value is 0xffffffff — and a 32-bit read at bit 240 is all-ones in
every record of every replay. So the byte before it, bits 232-239, is the
field:

```
255 x 13,097     the "no group" sentinel
  2 x  9,148
  1 x  6,384
  3 x    492
  4 x     99
```

It behaves like a control group and not merely like a byte that changes.
Assigning one writes the same number onto every selected unit at once, so a
press is a set of units of one house taking one new value together:

```
house  presses  group sizes        keys used
h14         15  median 2, max  7   1,2,3,4
h18         32  median 2, max 18   1,2,3,4,7
h8          14  median 2, max 14   1,2,3
h10          2  median 21          1
```

Hotkeys 1-4 and 7, groups from a pair up to a 21-unit army, and different
players using different numbers of them.

### It barely moves the action rate, and that is the honest result

Presses are now counted, and the rate went from 33-66 to 33-68 per minute.
Nought to seventeen presses in a whole match cannot do more than that.

The reason is worth stating plainly, because it is the real gap to a BroodWar
number: **only assignment is visible, not recall**. Pressing ctrl+2 writes 2
onto the selected units and shows up here. Pressing 2 to call that group back
changes only what is selected — it writes nothing to any unit — and a player
does that constantly while assigning it once. Recall lands in selection, which
still decodes unevenly.

So the ordering of what is missing, largest first: control-group recalls,
re-selecting an already-selected group, and selection generally. Spam is not on
the list — repeat clicking is recorded and counted.

## The selection mask fallback, and selection in the action rate

Three houses were failing validation and silently borrowing another house's
bit, which reported near-zero selection for that player. All three failed the
same check — selectable purity at 94.5%, 92.4% and 84.1% against a 95% bar —
and the reason was not what it looked like.

The hits that were dragging the purity down were not hits on rubbish. They were
hits on keys that no object record ever named, counted against the bit as
though they were misfires. The decode was being scored on its own naming gaps.
Judged over the hits that can be identified, **every house reads 100.0%** and
passes; the unnamed hits were 58-216 per house, enough to sink a perfect bit.

Two changes: purity is measured over named hits only, and a house with no bit
of its own now reads nothing rather than borrowing. Absent data should look
absent. Across six replays the imbalance between the two players fell from 27x
and 190x to a worst case of **2.2x**, which is ordinary — one player really
does select more than the other.

With that fixed, selection joins the action rate, one action per player per
frame in which their selection changed. The rate goes from 33-68 to 62-191 per
minute, and selection is the largest component. It is also how a control group
*recall* is counted: pressing the key writes nothing to any unit, so only the
selection change betrays it.

## Selection flaps, because the bit moves with the record

Adding selection to the action rate produced one player at 191 per minute on
934 selection actions in 7.3 minutes — two a second, sustained — against 93 for
their opponent. That warranted a check rather than a shrug.

Per object, a real selection is held and a flapping bit alternates:

```
h18  BGGY  402 flips over 753 samples, 356 selected   average run 1.8 samples
h14  BGGY  103 flips over 586 samples, 328 selected   average run 6.4 samples
```

Same unit type, similar share of time selected, four times the toggling. And
across the house: 65% of h18's selected stretches last a single sample against
17-35% everywhere else.

Two candidate fixes failed, which is what pointed at the real cause. Dropping
single-sample blips cut every house by 6-24% alike and left the worst object at
244 flips against a next-busiest of 85 — a general noise floor, not the fault.
Nor is it a few bad objects: h18's top ten carry 55% of its flips against h14's
43%, barely different.

The cause is that **the field's position depends on the record's shape**.
Splitting one house's records by length:

```
346 bits  158 records   9.5% set
431 bits  135 records  21.5% set
426 bits   91 records   0.0% set   <- never
508 bits   93 records   5.4% set
```

Records of one length never carry it while a length five bits different carries
it a fifth of the time. A fixed offset lands on selection in some layouts and
on something else in others, so the flag alternates as a unit's records
alternate in shape. That also explains why purity and own-house validation were
never quite clean even for the houses that passed.

So selection is out of the action rate again, and the rate is back to 33-68 per
minute on move orders, production starts, placements and control group
assignments. It still drives the on-screen brackets, where being wrong now and
then is visible and harmless. Counting it would put a number on the HUD wrong
by a factor that varies per player, which is the one thing an action rate must
not be.

The way back in is the same work that was already done for the 0x3781 delta
fields: derive the offset per record instead of assuming one.

## Sell is not bit 184

The candidate had the right shape — structure-only, 3s runs, 54% of hits in a
building's last five seconds — but credits settle it. Selling refunds half the
cost, so a flagged building going away should step its owner's balance up and
an unflagged one should not:

```
bit 184 set    9 buildings   22% gained credits
bit 184 unset 49 buildings   24% gained credits
```

No separation at all. The shape was coincidence. Given the struct order —
IsRepairing, IsDumping, IsTheaterSpecific — 184 is more likely
IsTheaterSpecific, which is a per-type property and would explain why it sits
on a handful of buildings for their whole life.

Sell may still be reachable through credits alone: a structure vanishing while
its owner's balance steps up by half the cost. The credit samples look too
sparse to catch it reliably, so it stays undone rather than guessed.

## The sidebar does not carry the tab

The Remastered sidebar has four tabs — buildings, infantry, vehicles,
superweapons — and byte 21 of the sidebar record looked promising: held for
long stretches, flipping a few dozen times a match, and on one file holding
exactly four values.

It is not the tab. Over three replays it holds seven values, not four, and
none of them predicts what the record is listing:

```
byte 21   building  infantry  vehicle    dominant
    0         6284      6091    12783    vehicle 51%
    1          330       527     1006    vehicle 54%
    2          175       906      790    infantry 46%
    3          159       266      487    vehicle 53%
    6            3         0      135    vehicle 98%
```

A tab value would be nearly pure. These are all mixtures.

The mixture is the real finding. **Every sidebar record lists buildings,
infantry and vehicles together**, so these records are not a view of whichever
tab is showing — they are the whole production state at once. The tab is
purely which slice the client chooses to draw, which is why there is no reason
for it to be written down, and it sits with the camera, control group recalls
and re-selects among the interface actions this file never records.

Even with a perfect decode it probably should not count toward an action rate:
BroodWar counts what reaches the engine, and a tab switch does not. Control
group recalls are the opposite case — real commands that happen to be
invisible here.

## A behavioural map of the movement record

Rather than guess a field and test it, every bit was described by how it
behaves — how often set, whether it ever changes over one object's life,
whether it fires on units or buildings — and the field boundaries fall out,
since bits of one field behave alike.

```
  0- 7   header byte, always 0x01
  8-21   14 bits, fixed per object, each about half set across objects
 22-39   constant marker bits
 40-52   changes constantly                 position (already known)
134      strength
150+     selection mask, one bit per house
182      IsRepairing
232      ControlGroup
240-271  VisibleFlags
430-479  undifferentiated churn, no field structure
```

**Bits 8-21 are the object's own id.** Fourteen bits is 16,384 values, which is
exactly why the keyframe pair 0x2403 and 0x2208 run 26-16,243 and 16,410-32,627
— the same id space with bit 14 set as a flag. Two findings that looked
unrelated are the same thing.

## Reading a match for a post-mortem (24 Sep 2026)

`src/lib/review/analyse.ts` judges a match from three decoded streams, and
`getReviewFn` in `lib/cncstats/server.ts` assembles them. Four traps cost a
night's work before the numbers could be trusted; each one produced confident,
wrong output first.

**Which side is which player.** `extractReplayInfo().playerList[side]` does not
follow the ladder's slots. Checked against mixed-faction games, where the
faction-only buildings settle it, it was inverted in 3 of 3. Use
`slotsByOwner(orders, factions, locations, map.starts)`.

**Health is not a death signal.** `hp` in an object track is zero or absent for
objects that are plainly alive — a buggy leaves the airstrip reading 0 and
drives for 100 seconds. Reading `hp === 0` as destroyed turned every vehicle
delivery into a loss at the airstrip cell.

**Buildings are not tracked.** The object stream samples what moves. A
construction yard gets one or two samples and then goes quiet: its track
ending says nothing about whether it survived. Unit losses only.

**Objects are re-keyed.** An MCV deploying ends its track and a FACT track
begins, which books a 5,000-credit loss at 0:07 of every game. Effects
(`MOVEFLSH`) are objects in the stream too.

### Calibration, and the hold-out test

Thresholds are fitted with `_discriminate.ts` and then checked with
`_validate.ts`, which re-fits on the older half of a player's games and
measures on the newer half. On one player's 114 games, re-decoded after the side-swap fix below:

| check | fitted | held out | kept? |
|---|---|---|---|
| first refinery before 0:14 | 95% / 70% | 86% / 56% | yes |
| third refinery before 1:00 | 85% / 63% | 73% / 46% | yes |
| no harvesters lost | 97% / 59% | 84% / 53% | yes |
| six or more fights on their ground | 94% / 73% | 88% / 59% | yes |
| five or more refineries | 88% / 59% | 71% / 53% | yes |
| six refineries by 5:00 | 90% / 67% | 76% / 60% | yes |
| trade ratio under 0.82 | 93% / 74% | 83% / 65% | yes |
| killed any of their harvesters | 96% / 62% | 74% / 60% | weakened |
| time spent floating | 89% / 69% | 65% / 68% | dropped |
| match under ~7 minutes | 86% / 71% | 60% / 72% | **reversed** |

The last row is the reason the test exists: fitted on half the games, short
games looked decisively better; on the half it was not fitted to, the longer
games won more often. A check that does not survive this is not reported as a
finding — at most as a reading, labelled as not judged.

Checks were also compared for how often they fire in wins against losses. Four
of the original seven fired as often or more often in the player's *wins*
("late airstrip", "infantry before production", "refinery #4 late", "the worst
fight of the game"), which is what plausible-sounding RTS advice looks like
when nothing has tested it.

### A fifth trap: deciding the sides too early

`readBuildOrdersFromProduction` takes a callback so the caller can name the
sides while the stream is being read. `slotsByOwner` called from inside it can
be asked to decide **before either construction yard has been decoded** — and
with no yard to match against a spawn, and no faction difference to lean on in
a mirror, it falls back to the order the owners appeared in. That is a coin
flip, and the early answer was being kept.

It put one player's buildings, losses and fights under the other's name in 12
of 79 mirror games. Mixed-faction games were unaffected, so a faction-based
check passes while the mirrors — most Nod-vs-Nod ladder games — are wrong.

Call `slotsByOwner` again on the completed orders and use that answer.
`_mirrorcheck.ts` is the regression test: it compares each decoded side's yard
against the spawn the ladder recorded for that player, and should report every
mirror game agreeing.
