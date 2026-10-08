# Architecture

The code map of `src/` as it stands on `cinematic-village`, and where to change what. Coordinates are world metres: x west, z north, y up. The rules that keep these modules working together are in `CLAUDE.md` (Invariants and gotchas).

## The design and the land

- `world/plan.ts`: the village as designed, plain data. Everything is [নকশা] (designed); nothing is measured.
  - `WORLD`: the designed area, ≈2.15 × 1.65 km round the boat's way, the village, the bil and the railway. Beyond it the land fades into the haze and only the backdrop's hills stand on the horizon.
  - Levels: `WATER_LEVEL` is one water for the river, the khals and the bil, at its mean (the season raises and lowers it, `season.ts`). `PLAIN` is the fields, `MOUND` a homestead's ভিটা above them, `ROAD_RAISE` the brick road's embankment. `POND_LEVEL` is the ponds' level and `POND_RISE` their share of the season's rise.
  - Waterways' control points: `RIVER_POINTS` east to west, running on beyond the world both ways; `KHAL_POINTS` from the river's middle north to the bil; `SIDE_KHAL_POINTS` through the fields into the bil's west side; `SALT_CREEK_POINTS` from the coast up past the salt farms into the river; `SALT_FEEDERS` from the creek to the farms it does not pass.
  - Sites: `BIL_SPEC`; the journey's ends `JOURNEY_FROM` and `INTO_BIL`; `OPENING_NEAR`; the crossings `BRIDGE_NEAR` and `SANKO_NEAR`; `FISHER_NEAR`.
  - `CHAR`: the sandy inside of the river's broad bend.
  - `SALT_FIELDS`: the salt farms on the river's south bank by where the boat sets out, under the hill, none alike (`SaltFarm`): frame, size, sections (settling pond, evaporation beds, crystallizers) and cells; `dig` (pans below the fields), `rim` (the embankment's crest over them), `bunds` (inner bunds' heights), `rains` (the gher's depth), `grassy`, `seed` (which bed is at which stage), `intake` (where across its settling pond's end its water comes in), and `work` (`SaltTask`s: rake, carry, inspect, spade, watch, feed, net, by season). `SALT_FIELD` is the creek's farm, the film's. `SALT_BAND`/`SALT_DRAIN`: the farms' water in the level map. `render/patch.ts` paints them, `world/geography.ts` digs them and keeps their water, `world/saltworks.ts` builds on them, in step.
  - `ZAMINDAR_GROUNDS`: the zamindar house's lawn down to its ghat (kept grass, no paddy). `LOW_WATER`: how far the waters fall at their lowest (the ghats' steps run below it).
  - `KHAL_ROCKS`: the khal's rocks the boat goes round, all on her right, away from the paddle.
  - `HOMESTEADS`: each has an id, a rough place, a `w` × `d` mound, a `face` (or `bank` m back from the nearest water's edge, facing it), a `ghat`, and a `pond` in its own frame.
  - Landmarks: `BANYAN`, `HUB_GHAT`, `TEA_STALL`, `ZAMINDAR` with its pond, `MOSQUE` with its pond.
  - `FAR_GROVES`: the far villages toward every horizon.
  - `HILLS`: steep wooded hills right by the waters (over the river's south bank where the boat sets out, out of the bil's north-east shore, behind the char's kash). Each has `steep`: a grassy foot by the water, then a steep climb. Rounder hills stand on the horizons in the haze.
  - `RAILWAY_POINTS`/`RAILWAY`: the line north of the bil, on its embankment.
  - `ROADS`: the brick road and the earth paths. Each is either designed points (with the crossings' anchors `'bridge-e'`/`'bridge-w'`/`'sanko-s'`/`'sanko-n'`) or `along` a bank at an offset from the water's edge. No way crosses a pond, the bil or a waterway but at a crossing (the ways scan, verification.md). The zamindar house's brick walk down to its grand ghat's landing is one of them.
  - `KHEJUR_PATH`/`KHEJUR_ROW`: the field path past the date palms.
- `world/waterways.ts`: each waterway is a `Waterway`, a Catmull–Rom curve through its points, resampled every 2 m.
  - Along a waterway: `half(s)` and `depth(s)`; `current` in m/s along increasing s; `at(s)`; `frame(x, z)`, which returns `s`, `d` and `side` (+1 is left going along it) within its reach, as a reused object; `beside(s, side, out)`; `line.nearestS`.
  - The waterways:
    - `RIVER`: ≈30 m wide, 3 m deep, flowing west at 0.22 m/s.
    - `KHAL`: ≈14 m wide. Its mouth flares into the river, it narrows to 6 m under the bridge and widens into the bil. It drains toward the river.
    - `SIDE_KHAL`: ≈7 m wide, still.
    - `SALT_CREEK`: a tidal creek winding up from the south, out of the haze toward the coast, past the salt farms and on into the river through its sluice gate (`CREEK_GATE`, geography.ts: where it crosses the river's bank top), flaring and deepening there. Its banks are wide tidal mud (`bankWidth` 9).
    - `SALT_FEEDER_WAYS`: the feeders (≈2.6 m, knee deep, banks 2.5 m) from the creek to the farms it does not pass. `SALT_WATERS` (the creek and its feeders) is what is treated as the sea's water: no hyacinth, no bank trees or grass planted along it.
  - `waterwayAt(x, z)`: the nearest waterway by distance from its bank, giving the way, `s`, `d`, `side` and `half` (a reused object). Also `charShare` and `riverLevee`.
  - `BIL` (its long axis is the khal's heading at its end), with `bilLocal`/`bilPoint`/`bilReach`.
  - The boat's way is its own line: down the river from `JOURNEY_FROM`, round the banyan's corner into the khal on a curve swinging wide of it, up the khal under the old bridge, off it into the side khal (`curveInto`, `SIDE_IN`), along the side khal's middle under the sanko, and out into the bil toward its middle. The khal above the side khal's mouth is off the way.
    - `JOURNEY` has `length` (≈2.1 km), `opening`, `turn`, `bridge`, `sanko` and `head` (where she comes out of the side khal into the bil).
    - `SIDE_KHAL` is ≈8 m across and 1.3 m deep, for the boat.
    - `journeyAt(s)`, `journeyFrame(x, z)`, `journeyHalfWidth(s)` (from the way to the nearer bank), `journeyDistance(x, z)` (a chamfer field over the world).
    - The way swerves round the khal's rocks (`rockSwerve`), keeping `ROCK_CLEAR` (3 m) from each.
  - `BRIDGE_SITE`, `SANKO_SITE`.
- `world/layout.ts`: the raised grounds and ponds, worked out once from the design. Both `geography.ts` and `roads.ts` read it.
  - `Shape`: a rounded rectangle turned by its face, with `local`/`shapePoint`/`shapeDistance`.
  - `FeatureGrid`; `MOUNDS`/`HOMESTEAD_MOUNDS` (the homesteads' mounds settled by `bank`); `PONDS` with `POND_BANK` and `pondReach`.
- `world/sites.ts`: the crossings' frames.
  - `BRIDGE`: the old brick arch over the khal, with its span, rise, ring, width, parapets, half-length with ramps and crown. `bank` is the road's crest where its ramps come down. Heights in its frame are above `water`.
  - The bridge's functions: `bridgeFrame`/`bridgeToWorld`/`bridgeSoffit`/`bridgeDeck`/`onBridge`/`bridgeEnds`.
  - `SANKO`: the bamboo sanko over the side khal, built for the boat to pass under: `crown` (3.7 m over the water's mean), `gap` (the middle span's half-width, no trestles), `bank`, with `sankoDeck`/`sankoFrame`/`sankoToWorld`/`sankoEnds`/`onSanko`.
- `world/geography.ts` is the single source of truth for land and water.
  - `terrainHeight` is the land. It is built from:
    - the fields at `PLAIN` with a gentle unevenness, the river's levee and the char let down;
    - the mounds (`MOUNDS`: the homesteads', the zamindar compound, the mosque's plinth, the banyan's corner). Each is a rounded rectangle with a wobbled edge and a crowned yard, sloping to the fields;
    - the brick road's embankment (`roadGround`), and the ponds' banks and bowls;
    - the hills (`hillHeight`: lumpy domes; `hillShare` is their wooded ground);
    - the far villages' raised ground under their groves (`groveShare`: from the air a grove reads as a village on its mound);
    - the railway's embankment (`railGround`).
  - The waterways are cut in by `wayGround`: a bed shoaling to the sides, and a bank `bankWidth` wide rising from `EDGE_DEPTH` under the water. The bank is steepest at the water and out of it within a step, broad and low over the char. The bil's bowl is cut in too.
  - Water queries: `waterLevelAt` (`WATER_LEVEL` over the waterways and the bil, a pond's own level, −∞ on dry ground), `inlandWaterAt`, `shoreLevel`, `nearBackwater`, `bankStrip` (a waterway's bank and the strip along its top; plots keep off it), `eachWaterwayPoint` (for the water's level map), `bankAt(x, z)` (the water's edge on the nearest bank, and the way up it).
  - `landUse(x, z)`: the shares of yard, mound, verge, sand, marsh, field, salt and flats. The terrain paints from it and the planting reads it.
  - Also `HOMESTEAD_MOUNDS`, `PONDS`, `bilMarsh`, `bilDepth`, `routeGap` (the distance from the boat's way), `onLandmark`, `onMosqueGrounds`/`onZamindarGrounds` (their grass kept short). It re-exports `BRIDGE`/`SANKO` and their frames, `WATER_LEVEL`, `JOURNEY` and the journey's functions.
  - The zamindar's grand ghat is laid out here (`grandGhat()`, `GRAND_GHAT`: its site on the bank, its steps from ghatFlight.ts), so `onLandmark` keeps the grass, the trees and the stones off its stair and pavilions; landmarks.ts builds it and village.ts moors the house's boat by it.
  - The season's water:
    - `setWaterRise` (called from main.ts each frame, from `season.water`) and `waterRise()`.
    - `meanWaterLevelAt`: the water at its mean level. The maps baked once read it.
    - `waterLevelAt`: where the water stands now (`risenLevel(mean)`, and in the rains out over the banks' foot and the bil's low rim). GLSL `waterLevels` adds `G.uWaterRise` the same way.
    - The bil keeps a deeper lane along the boat's way from the khal's mouth (`bilLane`), so she can go in when the water is low. It cuts only where it runs; the rim rises slowly from the water to the fields.
    - The salt farms' water: `setSaltWet` (main.ts each frame, from `season.salt`; `G.uSaltWet` for the shaders). A farm's mean level is its rains' level (`saltRains`); `risenLevel` (and GLSL `waterLevels`) drains a level above `SALT_BAND` by `(1 − wet) × SALT_DRAIN`, so in the salt season only the settling pond keeps water. `shoreLevel` leaves the farms out (their beds are the salt shader's).
  - The salt farms' ground: `saltLocal`/`saltPoint` (a farm's frame, the creek's by default), `saltIntake(farm)` (where its water comes in: its embankment at its `intake`, and the nearest salt water's middle), `saltFarmAt(x, z, margin)`, `saltShare`, and `saltGround`: the pans dug `dig` below the fields, the settling pond `SETTLING` deeper, the earth embankment round them (crest at `RIM_CREST`, `rim` over the fields) and the feeder ditch along its foot. It feeds `landUse().salt` and the terrain's `LOOK.salt` (its zone is below 0); `onLandmark` keeps everything else off it (an old, `grassy` farm's embankment lets the meadow on).
  - The salt creek's land is its flats: `creekFlats`, `landUse().flats` and the terrain's `LOOK.flats`, which paints grey-brown mud with a thin salt-burnt grass and nothing sown.
- `world/corridor.ts` and `CORRIDOR` (glsl.ts): the land the village keeps to.
  - `corridorDistance` (geography.ts) is measured from the boat's way (`journeyDistance`) and from the bil's water. Everything is drawn out to `clear` (230 m).
  - Beyond that the haze thickens (`tCorridor`/`uCorridorMap` in `applyAtmosphere`).
  - The crops and the grass stop at `crops`, and the trees thin away between `trees` (vegetation's `put`).
  - The free camera keeps within `camera`: in flycam.ts, a move that would take it farther out slides along the limit or stops.
- `world/backdrop.ts`: `buildBackdrop()` puts the hills on the horizon past the world's edges.
  - Three ranks of strips run round it (700, 1300 and 2000 m beyond), each paler the farther. They have mist at their feet and are coloured by `hazeColor` alone.
  - They are low along the river's line east and west, so the sun and the moon still rise and set over the water.
  - The waters' level map runs `EDGE_MARGIN` (glsl.ts) past the edges, so the river goes on into the haze.
- `world/terrain.ts`: `Terrain`, the ground as quadtree patches round the camera.
  - Patches are 64 × 64 quads, with 128 m leaves, split nearer than 1.5 sizes, and skirts wound outward.
  - It spends a few ms a frame building (`BUDGET_MS`), with the nearest built ancestor standing in until a patch is ready. `update(eye, true)` builds everything, for stills; `warm(eye, until)` builds ahead.
  - Colour and layer weights per vertex come from `landUse` (`LOOK` per kind of ground), the beds under water, the wet mud up a bank from `shoreLevel`, and trodden earth along the ways.
  - A yard is drawn with the fine sand layer's grain under its clay colour.
  - It also exports `groundAt(x, z)`/`Cover` (`bare` marks a swept yard or a way's trodden ground, where the meadow grows nothing) and `groundLattice` for the chunked builders.
- `world/roads.ts`: the ways of `plan.ts` as smooth curves (points every 2.5 m), split at the crossings. Each piece comes straight onto its crossing for `APPROACH` m.
  - The brick road's crest is `PLAIN` + levee + `ROAD_RAISE`, smoothed, with its embankment `roadGround`. The village road is as wide as the bridge's deck.
  - Queries: `roadCover` (trodden ground), `roadEdge` (the brick road's edge; its verges are grass), `onRoad`, `roadLines()` (for the trees along it).
  - A way with `flat` is brick laid on the ground: the hub's paving under the banyan and down onto its ghat's landing, and the mosque's walk to its pond's ghat.
  - Every homestead that no designed way passes gets its own footpath to the nearest way, unless it would cross water. Every homestead with a ghat gets a trodden way from its yard to the ghat's landing (`LANDING` m up from the water). A path crosses the char through its kash.
  - `buildRoads(ground)` draws the raised road on its crest and the paths laid over the ground as it is drawn (main.ts passes terrain.ts `meshGround`), from one texture atlas (`roadAtlas`), one mesh per 1300 m cell.
  - A homestead no designed way passes gets a footpath of its own, out of its yard's open front (and round the mound's side if the way lies behind it), never across water; one with a ghat, a trodden way down to its landing.
  - `core/segmentIndex.ts`: `SegmentIndex` files segments in square cells, to find the nearest one measured against its half-width. A query is answered in a 4 m cell (`FINE`, built the first time it is asked about, in a table over the segments' reach) that keeps only the segments that can be the nearest to some point in it, in the order of the least `d − half` they can have there, so it stops at the first that cannot win. Its answers are exactly a scan of the filing cell's (ties to the first added). The ground asks it about every waterway at every height lookup.
  - `core/mathx.ts`: the shared small maths (`clamp`, `lerp`, `smoothstep`, `damp`, `angleDelta`, `tableAt` for a body's measured sections). Use these rather than local copies.

## Built things

- `world/village.ts`:
  - `planHuts()` lays each homestead's houses round its yard in its mound's frame: the main house across the back with its veranda over the yard, one or two houses along the sides facing in, the kitchen at a front corner and the cowshed at a back corner. Each house has a `HouseStyle` chosen once: mud or painted-tin walls, thatch or tin roof, the wall's wash, the door's paint and the veranda's depth.
  - `planGhats()` places the village's ghat below the banyan, then a ghat at each homestead front that has one, at the water's edge of the nearest bank. A `Ghat` has the waterway, `s`, `side`, `up` and `kind` (brick or bamboo).
  - `buildVillages(huts, ghats)` builds:
    - the houses, through `houses.ts`, and haystacks by the mounds' back corners;
    - brick ghats (`brickGhat`), their steps from ghatFlight.ts, between walls stepping down with them and holding the bank back where it stands higher. The village's ghat is 5 m wide with a rowak bench each side; each pond's ghat goes down the point the design gives;
    - bamboo ghats on posts out over the water;
    - a boat tied up at every other ghat, and the zamindar house's painted boat alongside the bank below its grand ghat (`tieUp`): each with thwarts and a bamboo pole, her own colours (`MeshBuilder.add(…, 'own')`), and her line from her stem to a post on the bank or in the shallows. They ride the water's waves as drawn and swing slowly on their lines about the stem (the `moored` vertex shader: `aMoor` = middle, aground height, and how much each vertex rides with her, 1 on the hull and its share of the way along the line; `aPivot` = her stem).
  - It uses one mesh per material. Tin is barely metallic, because with no environment map a metal reads black.
- `world/ghatFlight.ts`: a ghat's flight of steps from its site (`GhatSite`) and size (`GhatSpec`): every step the same `RISE`, none shorter than `RUN`, each tread clear of all the ground below it toward the water (the bank's envelope from the bed's deepest point in front of the foot), landings where the bank is gentle, solid masonry where it is steep, on below the lowest water. `ghatPoint`/`ghatLocal` (its frame), `groundOver`. It takes the ground as a parameter, so geography.ts can use it.
- `world/houses.ts`: `buildHouse(parts, …, style)` builds one house.
  - The plinth (পোতা) runs out as a veranda.
  - Walls are mud with a darker wiped band, or painted tin on a timber frame. There is a two-leaved door, small barred windows with shutters, and veranda posts on stones under a beam.
  - The roof is the do-chala (`doChala`: the ridge and eaves sag to the ends), with a thick trimmed thatch edge or tin with a ridge cap. Gables are mud, mat or tin.
  - The kitchen has its stove; the cowshed has posts, a mat wall and a manger. Also `haystack`.
- `world/yard.ts`: `buildYards(huts)` adds a washing line (saree, gamchha, lungi), clay pots, a tulsi stand, a gourd trellis and a bamboo fence. They are kept clear of the houses, the ways and the water.
- `world/banyan.ts`: `buildBanyan(bark)` builds the hub's banyan about its foot, so the wind bends it from there.
  - It has fused stems, eight great limbs, curtains of aerial roots (a few grown into pillars), a 30 m dome of 1500 leaf cards, and a two-stepped plastered platform.
  - Also `BANYAN_CLEARING`.
- `world/landmarks.ts`: `buildLandmarks()`.
  - The zamindar house: colonnades, balustrades, cornices, a pediment, green shutters, plaster fallen to the brick in patches, and a peepal on its broken parapet. With it go its grand ghat (geography.ts `grandGhat`: lime-plastered steps as solid blocks into the bank, a broad landing at the top, parapet walls stepping down and holding the bank back, a nosing on each tread, two pavilions on the landing's level) and its terracotta char-chala temple. Its brick walk to the ghat is a way (plan.ts `ROADS`), over its lawn.
  - The mosque (`mosque`, its sizes in `MQ`, its axis `mosqueAxis()`): on a plinth, a whitewashed prayer hall with pilasters, a cornice, a green band and merlons; three pointed doors (the middle one open), arched windows with recessed panels, the mihrab's half-domed niche behind; a large Bengal dome on an arcaded drum and two small ones (`bengalDome`: lotus collar, kalash finial, crescent); corner turrets (`turret`); a verandah of three pointed arches (`arcade`) with its roof and parapet; the kalima over its middle arch; a low forecourt wall with a green coping, the gate's piers and the steps down onto the walk; the azan minaret at the forecourt's corner (a square base with its door, two tapering octagonal stages with slit windows and balconies, loudspeakers, an open kiosk with its dome).
  - The kalima's panel: `inscriptionTexture` (render/textures.ts) writes it right to left in `KALIMA_FONT` (Amiri, loaded by index.html; main.ts waits up to 4 s for it before building).
  - The mosque's ghat (`mosqueGhat`): on its axis where it meets the kept pond, a landing with two benches, solid brick steps down past the lowest water, stepped side walls, and a lamp on a short pillar with a small iron lantern. The village's `pondGhat` skips the kept pond.
  - The night lights: the mosque's doors and windows glow from within after dark (`arch(..., lit)` into `Parts.glow`, its emissive running along `glowTexture`), bulbs (`lamps`), the lanterns' glass (`lanterns`), and up to four lamp lights (`lights`) put into globals.ts `uLamp0..3`: the hall's, the verandah's, the mosque ghat's lantern and the village ghat's (`hubLantern`: a hurricane lantern hung from a bamboo post at its landing's back corner). `lampsGlow(night)` sets their glow and colour; `NIGHT_GLOWS` are tracked by main.ts `worldLook`.
  - The tea stall.
  - Arches are dark fans under a raised frame (`archOutline`: semicircular, or pointed from two arcs).
- `world/bridge.ts`: the old humped brick arch over the khal, in the bridge's frame.
  - Lime-plastered spandrels and ramp walls, brick voussoirs and barrel, parapets with coping, end pillars and a brick deck.
  - Damp and moss, and ferns. Fallen plaster patches are placed one by one (`fallenPatches`).
  - Also `bridgeTrees` and `BRIDGE_CLEARING`.
- `world/sanko.ts`: the bamboo sanko: three culms on X-trestles with crossbars and lashings, one handrail, the walkway climbing high over the water (sites.ts `sankoDeck`) with rungs where it is steep; no trestles in its middle span (the boats' way), where the walkway is doubled and braced from the trestles either side.
- `world/railway.ts`: the railway.
  - The line: `railAt`, `RAIL_LENGTH`; `railGround`/`railShare` for the ground.
  - `buildRailway()`: the ballast bed with its sleepers painted on (`trackTexture`), two rails and kilometre posts.
  - `Train`: Bangladesh Railway's intercity, after the user's train in their history project. It has a cab car and six coaches lofted from one section, in green with red and white bands, its windows dark glass by day and lit after dark, its headlamps on day and night. Under each car: two bogies, each with two wheelsets on the rails (`WHEEL_R`, the broad gauge), side frames and axle boxes, and between them the underframe and its boxes (2026-10-08: the sky showed through under it). Each car follows the line, rocking a little on its springs out of step with the next (`SWAY`).
  - A run comes every `EVERY` s (300), west and east in turn. `place(t, s, forward)` puts the nose where a shot wants it.
  - `acoustics()`: where its sounds come from each frame (audio/soundscape.ts `TrainSound`): the engine under the cab car, its 14 bogies, each rail joint (`JOINT`, 13 m rails) one of its 28 wheelsets (`AXLES`) struck since it was last asked and how long ago, and the horn when its nose passes a whistle board (`WHISTLES`: every `WHISTLE_EVERY` m, and 450 m short of the stretch nearest the village either way) or comes within `APPROACH` m of the listener's place on the line (`railNearest`), never twice within `HORN_APART` m.
- `world/stones.ts`: `buildStones()` gives `{ group, pebbles }` (main.ts culls the pebbles near, `cullBeyond`).
  - Mossy stones along the banks and at the water's edge. A stone's shape is `rockShape(seed, look)` (a sphere cut by soft planes, UVs laid from above; `RockLook`: its detail, tint and moss), with `rockTexture` and its normal map, and `wetline`.
  - The kept pond's pebbles and small stones (`pondPebbles`, `PEBBLE_LOOKS`): few-sided, in drifts by noise, thickest in its shallows along the edge and thin over the deeper bed, off its ghat, on `meshGround`.
  - The khal's rocks (`khalRocks()`): each a boulder on a broader stone.
  - Broken foam where the water meets a stone, laid at the season's level. `nearStone` keeps the grass and the bushes off the stones.
- `world/saltworks.ts`: `SaltWorks`, every farm of `SALT_FIELDS`.
  - Each farm's inner bunds (`bundLines(farm)`, the twin of the shader's layout, each its own height between the farm's `bunds`, so the rains drown some), the heaps raked up on them and where the carriers tip theirs (gone in the rains). The embankment round a farm is the ground's (geography.ts), not a bund.
  - Each farm's people at their `work` (world/saltHands.ts), one crew per farm, its season's group shown (`salt` > 0.5 the salt work, < 0.25 the gher), posed within `POSED` and drawn within `DRAWN` of the farm. The film's three rakers are the creek's farm's (`workers`, `rakerStations()`).
  - Every farm's intake (`buildIntakes`, at `saltIntake`): a plank culvert through the creek's or the feeder's bank, its gate in grooves, and a trough on to the embankment, laid on `meshGround` (the feeders' banks are cut finer than the terrain's lattice). The creek's sluice gate in the river's embankment (`buildCreekGate`): a brick headwall across its cut with three vents, their iron gates raised, the wall running into the banks, a cement deck with a railing and a hoist with its wheel over each gate.
  - The creek's farm alone has the gola and the old heap under black sheeting, the gher's fisherman casting from the settling pond's bund (`gherStand()`, `cueGher`) and the watchman's hut.
  - `saltStage(col, row, farm)` is the shader's stage of a crystallizer bed (with the farm's `seed`).
- `world/saltHands.ts`: the people at work on the salt farms, each a `Boatman` body at his own pace and offset (`Hand`): `Raker` (the rake's board drawn through the crust), `Walker` (a carrier with a basket of salt on his head out along the bunds to the heap, tipping it out and back with it empty; or a man looking the beds over, crouching at each stop to feel the water, which rings it), `Spader` (dressing a bed's floor with the kodal: up over the shoulder, struck, the mud drawn back), `Watcher` (hands behind his back, weight shifting, pointing now and then) and `Feeder` (the gher's feed thrown from a bowl, landing as rings). A walker sets `Boatman.gait`: his feet, their pitch, his hips' bob and sway, and what he looks at.

## Living things

- `world/vegetation.ts`: `buildVegetation(huts, bark, clear, featured)`, placed by the design.
  - Tal palms (`tal`) stand in close rows both sides of the village road where it crosses open fields (`openField`).
  - The hills' forest: tall garjan (`garjan`) over rain trees, mango and akashmoni, with cheap crowns over the hills' backs. The horizon's hills get larger, fewer crowns.
  - Each homestead's grove: bamboo and fruit trees two deep at the back, betel-nut and banana along the sides, coconuts and a date palm at the front corners. Groves fill the gaps within a para.
  - Old trees along the banks' tops, rows of rain trees and akashmoni along the brick road, a few lone palms and trees in the fields, the bil's groves and hijol, the far villages' groves, joba by the houses, and golpata (`nipa`) along the salt creek (none within 12 m of its gate).
  - `crownDetail(crown)` fills out one tree's crown for the film's tree in flower (`tour.ts` `blossomTree`): limbs branching twice into twigs to the crown's top, with clusters of leaves on their ends, in the tree's own materials (so it sways and flowers with it). `hasCrownDetail` says which kinds it knows (`CROWN_FORM`). Each `Crown` carries its `kind`.
  - Featured trees (`featured`: the old bridge's, and plan.ts `MOSQUE_POND_TREES` round the mosque's pond) keep the rest of the planting off them.
- The mosque's composition (plan.ts): its grounds (`MOSQUE_GROUNDS`: a common of short grass, not fields, geography `landUse`, meadow `onMosqueGrounds`), its pond kept clean (`kept`: clear, no hyacinth (drift.ts), a little shapla (ponds.ts), bright fish), the big trees round it, the graveyard (`GRAVEYARD`: its mound in layout.ts, landmarks.ts `graveyard`: graves of every age, henna bushes, a low brick wall and a bamboo fence; short grass let grow in it, geography `inGraveyard`) and the old banyan at its corner (`GRAVE_BANYAN`, banyan.ts `GRAVEYARD_BANYAN`: no platform).
- `world/banyan.ts`: `buildBanyan(bark, spec)` for both banyans (`HUB_BANYAN`, `GRAVEYARD_BANYAN`).
  - Kash (`kashTuft`) grows in drifts over the char and in stretches along the khals (`kashStand()` for the film). There are grass tufts along every bank near the boat's way, and knee-high flowering bushes (`flowerBush`) along the khals' banks.
  - `onDryLand` and a spatial-hash `Occupancy` keep plants off houses, ways, landmarks and water. Trees near the boat's way or the water show in the mirror.
  - `treeCrowns()` feeds the leaves, the songbirds and the camera's sightlines; `palmStems()` (the palms and the bamboo) the sightlines. Each crown's `perch` is where a bird sits on it: the tops of its own shape's leaves (`crownTops`), its placement and its leaves' sway (the banyans' from banyan.ts `banyanPerch`).
- `world/crops.ts`: 3D crops in the paddy plots round the camera, in 8 m chunks measured by `groundReach`.
  - The real plants: `ricePatch` (hills of three crossed cards of `riceHillTexture` with nodding panicle ribbons) and `mustardPatch` (racemes of `mustardRacemeTexture`). Both are textured through `uv1`, while `uv` carries each vertex's offset from its plant's foot.
  - The plants reach out to `CROP_REACH.fade`/`edge` (≈30–37 m). Heads are shown near (chunks nearer than `SWITCH`) and fade first (`HEADS_OUT`). A chunk changing level is shown by its twin until it is built (`twin`).
  - Canopy cards alone carry on out to `CROP_REACH.canopy` (100 m). Only these two representations exist.
  - Late chunks grow up out of the ground (`aBorn`, `GROW`). Chunks ahead are built first within `BUILD_MS`, and `warm(view, until)` builds them out of sight.
  - Each patch works out its plot's crop in the vertex shader (`plotFrame`/`plotRank`/`cropShares`). Patches are laid per plot through the CPU twin of the layout (`toPlots`/`fromPlots`), off the roads.
  - Two sets of meshes exist for the film's dissolves (`holdView`/`showHeld`/`releaseView`).
- `world/meadow.ts`: `Meadow(huts, ghats)`: blade grass and wild flowers round the camera, in 8 m chunks.
  - One kind of full clump goes out to 100 m, thinning over the last stretch at each clump's own distance (`BANDS`, `THIN`).
  - Its upload sends only the part of each layer in use, and its bounds (for the culling) come from the chunks' squares and their ground's heights (`CLUMP_OUT`, `CLUMP_TOP`), not from every clump.
  - Chunks grow in, are built in front first, and `warm` builds ahead.
  - No grass grows in the water or on the mud above it, on roads, on landmarks or round the ghats.
  - Two sets of meshes exist for the dissolves.
- `world/drift.ts`: water hyacinth as position-based dynamics on the still fresh water round the viewer: ponds, the bil, and the slack within `EDGE` of the waterways' banks (within 0.4 of a narrow one's half, so the side khal's middle stays the boat's); none in the salt creek, its feeders or the salt farms.
  - The aground check asks the ground again only once a floater could have reached a bank since it was last measured (`STEEPEST`). Beyond `NEAR` of the viewer a floater is set on the waves every `FAR_EVERY` frames (its bobbing is under a pixel there); all of them after a jump. Height and slope come from one pass over the waves (waves.ts `waveHeightSlope`).
- `world/ponds.ts`: `LILY_PONDS`, with pads, flowers and reed clumps.
- `world/bil.ts`: the shapla bil's lilies (pushed aside by the hull and drawn back by their stems; only those near the boat simulate on the CPU), reeds, lotus and egrets.
- `world/khejur.ts`: `Khejur`, the date palms along `KHEJUR_PATH`.
  - Their trunks zig-zag from years of tapping (`khejurBarkTexture`).
  - In the tapping season (`SEASON`, late autumn to the end of winter) a tree shows the fresh V cut (`khejurCutTexture`), a bamboo spout and a clay pot. The pot is hung from the afternoon to after sunrise (`HUNG`) and fills through the night, with drops near the camera.
  - `hero` is the film's tree; `cue` fills its pot.
- `world/leaves.ts`: `FallingLeaves(crowns)`.
  - Red petals fall from the trees in flower. `bloomAt`/`bloomRank` are the CPU twin of the shader's choice of which trees flower.
  - The petal's shape (`petalGeometry`: a cupped, frilled spoon) and its one material (`petalMaterial`, `petalTexture`) serve every petal: falling, lying, afloat and the film's. `PETAL_TINTS`, `PETAL_WITHERED`, `PETAL_LENGTH`.
  - Yellow and brown leaves fall in the dry months. Each falls at its own pace, carried by `windAt`.
  - A storm strips the trees.
- `world/petals.ts`:
  - `PetalCarpet(crowns)`: the petals fallen under each tree in flower near the camera (`REACH`, thinning from `FULL`), in drifts, browning as the flowering goes on. Each crown's carpet is laid a little each frame (`LAY_MS`) from when it comes within reach, only while the flowering is on (out of it none show), and ahead of a film's cut (`warm`, whatever the season). It is let go past `KEEP`.
    - A carpet's petals are laid in the order of their rank (the share of the flowering by which each has fallen), so those to show are the first so many.
    - Those that fall on water float, drifting on the current until they sink (`AFLOAT_LIFE`). A crown near a waterway also has petals gathered in the slack water along its bank (`BANKED`). None float inside the hero's hull.
  - `HeroPetal`: the film's petal. `aim` picks its bough on the crown's lower edge and a place 2.6–4.2 m out on the water downwind (`INTO`, `CARRIED`), and works out its whole fall (`HERO_FALL`, `SWING`). It swings and tips, tumbles twice, levels out near the water, touches it (the water's `uTouch` ripples) and floats off on the current.
- `world/songbirds.ts` (small birds on the leaves at the treetops, each on its own spot and swaying with its tree, and on open ground, flying tree to tree; crowns found by `CELL`), `world/life.ts` (flocks, motes and fireflies; `birdGeometry`, `FLAP`).
- `world/fish.ts`: `Fish(ripples)`. Each fish swims on its own: a burst of tail beats and a glide, turning through its own momentum, its body bent along its length into the turn and swinging in a wave from head to tail (the vertex shader `SWIM`, per-instance `aSwim`).
  - Puti schools (cohesion, alignment, separation) under the river and the khals, a few rui deeper. They look ahead for the shallows and turn to the deeper side, and scatter from the boat.
  - The salt farms in the rains have theirs (`stockGhers`, `GHER_STOCK`, within `GHER_REACH`): schools of little sharputi and puti over the drowned beds, turning back from the embankment, rising to sip.
  - Ponds within `POND_REACH` have their own (`stock`): rui and tilapia. The kept pond (the mosque's) has `KEPT_STOCK`: two shoals of little sharputi near the top, a school of red tilapia and one of golden and silver fish (pond schools drift apart to feed and gather again), tilapia alone, and five big rui and katla deep. Pond fish rise now and then to sip the surface.
  - Leaps, sips and sharp turns just under the surface ring the water (`Ripples.drop`). `envMapIntensity` is low: underwater the sky's light reaches them only diffusely.
- `world/frogs.ts`: `Frogs(ripples)`: frogs at the water's very edge round the camera in the rains (`FIND`, found by walking down a bank to where the water laps), olive skipper frogs and a few monsoon-yellow bullfrogs, breathing. Someone within `SHY` m sends each leaping into the water with a ring. `settle` for stills.
- `world/turtles.ts`: `Turtles(ripples)`: turtles basking on the khal's rocks (stones.ts `khalRocks`) in the dry months' sun. As the boat comes within `SHY` m each walks to its rock's edge, slides in with a ring, swims off under the surface, comes up once to breathe, and once the boat is past `SAFE` swims back and climbs out. Their shells dry pale. `settle` for stills.
- `world/falls.ts`: `Falls(ripples, water.fallInto)`: falling water, its flow by the season.
  - The hill stream (plan.ts `HILL_STREAM`): its water a ribbon laid down its stepped gully (on `meshGround`), its froth carried down by a flow of noise, white where it falls off a ledge.
  - The sluice (`SLUICE`, `SLUICE_SITE`): brick headwall, wing walls along the outfall's sides (channels.ts `sluiceOutfall`) holding the bund's earth back, a stepped apron from wing wall to wing wall, the iron gate on the headwall's river face (where it is seen from the boat's way) in its guides, raised on a screw by a wheel. Its gate is up from the rains into autumn, down in the dry months, and half up before the spill shows.
  - Its water is laid by hydraulics (`laySluiceWater`, `SLUICE_WATER`), again whenever the season's head (`HEAD` × the flow) or the river's level moves: critical flow over the sill (q = √(g·yc³)), a free overfall off the vent's edge, a nappe falling under gravity onto the first tread, a sheet skimming down the steps' edges gathering speed and thinning, ending where it runs under the river (`sluiceMouth`: the froth and rings there). Its froth's `v` is the water's travel time (`uTimed`), so the froth runs at the water's own speed. Drowned (the river over the vent's edge) it shows no fall. The drain's water lies in its bed, the head deep, drawn down to the brink's depth near the vent. Every falling water's fragments under the river's surface are cut (`waterSurface`).
  - Where each meets the river, the water froths and rings (the water shader's `uFall0/1`, `Ripples.drop`). `update` returns how loud the nearest falling water is (soundscape `falls`).
- `world/channels.ts`: the small channels cut into the land: the hill stream's gully (stepped into ledges) and the sluice's drain (its bed above the river's highest). `channelAt`, `carve`; geography's `channelGround` cuts them after the land and before the waterways. `sluiceOutfall`: the sluice's outfall's half-width out from the headwall (its wing walls' line).
  - The sluice's bund (plan.ts `SLUICE.bund`, geography `sluiceBund`/`sluiceGround`) is laid after the waterways (the river's bank slope cut the land down there) and the drain cut through it again; its earth is grassed (`landUse`: verge, not the char's sand).
- `world/fisher.ts`: `Fisher(fish, place)`, a man casting his ঝাঁকি জাল. He stands on a bund (`FisherPlace.ground`, `water`) or, by default, in a dinghy tied to a pole below the khal's mouth (`FISHER_SITE`).
  - He is the boatman's body (`Boatman`) going through a 25 s cycle (`T`).
  - The net is a ring-and-spoke mesh laid each frame (`castNetTexture`). It is drawn after the water while up and before it once sunk.
  - Each cast is its own (`newCast`: side, reach, spread, spin). He hauls hand over hand, his weight going back with each pull (the dinghy pitching with it), then lifts the gathered bag over the gunwale, dripping (`layDrips`).
  - The water feels it (`bindWater`, the water shader's `netRings`): rings and a splash as the net strikes, the water stirred as it is hauled, and pattering under the dripping bag. The river fisherman has slot 0, the gher's slot 1.
  - `cue(t)` sets the cycle. He is posed only within 420 m. The drips off the lifted net ring the water (`Ripples.drop`).
- `world/harvest.ts`: `Harvest(field)`: two reapers (`Reaper`) on the film's field's edge, with sheaves and a stook. They appear only while the season's rice stands ripe.
- `world/hillMist.ts`: `buildHillMist()`: soft camera-facing banks of cloud over the hills' crowns, thickest on winter mornings (`G.uHillCloud`). They fade out at their feet.
- `world/lightning.ts`: `Lightning` strikes when the weather sends them (`weather.ts` `struck`) or a shot asks (`schedule`).
  - Each strike is a channel 650–1700 m off, built by midpoint displacement with branches. A third stay in the cloud.
  - One to four strokes follow a faint stepped leader. They are drawn as camera-facing `DoubleSide` ribbons.
  - `light` lights the cloud (`G.uLightning`) and a little of the land (`weather.flash`). Thunder comes at the speed of sound (soundscape `thunder(metres)`).
- `world/rain.ts`: the rain.
  - Its streaks round the camera (`buildRain`). A lighter rain is fewer drops, not fainter ones.
  - Where they strike:
    - `buildRainSplashes()`: crowns of water thrown up from the waters, one instance per cell of the drops' layers within `SPLASH_REACH`. Each shows its cell's drop (GLSL_COMMON `rainDrop`), so a crown rises where the water starts its ring.
    - `GroundSplashes`: splashes on the land, the ghats and the bridge's deck, at spots drawn round the camera (CPU, `GROUND_RATE`).
  - `render/glsl.ts` `rainDrop`/`rainRipples` (`RAIN_CELL`): the drops in cells of four sizes, each landing at a fresh place and time every fall, more of them the harder it rains. The finest layer is spray only (crowns, no rings). The water's rings, the puddles' rings and the crowns all read it.

## The boat and the people

- `world/hull.ts`: `HERO_HULL`, from which `hullHalfBeamAtWater` (GLSL) is generated. `HERO_SINK` (0.08 m) is how much deeper she sits with her load.
- `world/hero.ts`: the boat (planks, frames, cargo, the lantern) and the young majhi (`tarun`, `TARUN_OUTFIT`).
  - His বৈঠা (`buildPaddle`): a wooden T-grip, a pale bamboo shaft with its nodes (`BAMBOO_NODE`), a wooden blade lashed on, in its own material (2026-10-08: on the hull's plank texture the shaft had read as a dark streak; the user's reference boatman's light pole reads clear). His right hand on the T-grip, his left down the shaft (`CROSS_HOLD`, `LOWER_HOLD`), on the boat's +x (port) side. `boatState().shortBy` gives how far each wrist still misses its hold once he has leant (0 to a few mm through the stroke).
  - His mathal follows the weather: `wantHat` (main.ts `hatWanted`: rain, or a high clear sun outside mid-winter).
  - After `HAT_REACT` s he finishes the stroke and rests the paddle (`BoatBody.rowing` false, `REST_PHASE`). He reaches back for the hat on the stern's deck (`HAT_DOWN`) and puts it on, or takes it off (`hatHand`, `placeHat`). He never changes it again within `HAT_HOLD` s. `settleHat` runs at a new scene or a jump.
  - The boat casts no shadow; a soft spot under the boatman stands in for it.
- `world/paddle.ts`: the one stroke everything reads (`STROKE_SECONDS` 2.2, `CRUISE` 1.2 m/s, `MEAN_THRUST`). The shaft leans out by `LEAN_OUT`, so his top hand works at his chest. The blade is carried back low, its tip just clear of the water (`RECOVERY_LIFT`), with the shaft leaning further out as it swings (`RECOVERY_LEAN`), which lifts the blade and not his hand.
- `world/boatman.ts`: `Boatman` on a `Human` (`who`).
  - Loose hair moves in the wind, less under the mathal (`hairFree`).
  - The red ফিতা (`Outfit.band`, `tieBand`).
  - The mathal is fixed on the head (`Outfit.hat`), or is the young majhi's own object (`hat`, `hatOnHead`).
  - Elbows are kept down (`poleOf`). `BRACE`: he crouches as the deck rocks. `LEAN_MAX`: he leans toward a hand out of reach.
- `world/human.ts`, `world/humanData.ts`: `Human`, built from `public/humans/`.
  - Flat bones and dual-quaternion skinning.
  - `flowingHair` (the `HAIR_CODE` shader): most of the hair barely stirs while a few locks lift on their own time (`aLock`), within each vertex's reach (`aFree`), never over the face (`uHairFace`).
  - Skin is a `MeshPhysicalMaterial` with a soft sheen.
  - `cast` lays things on a body by rays through its bind pose; each ray is cast once a character (every body of one character meets it alike: the salt farms' workers lay the same ফিতা).
- `world/cloth.ts`: `ClothTube` (the lungi) and `ClothRibbon` (the gamchha, the headband's tails). Both are springs round the body, moved by the wind in the body's frame.
- `world/splash.ts`: `PaddleSplash`, drops as the blade goes in and comes out.
- `world/boatPhysics.ts`: `BoatBody`.
  - `MASS` is 380 kg (with added mass). Drag is light fore and aft and heavy sideways, like a keel.
  - `currentAt` comes from `waterwayAt`.
  - Paddle force acts only during the pull. `PADDLE_MOMENT` balances the J-stroke, so the bow wags a little each stroke.
  - Each stroke's own power (`strokePower`, 0.65 to `MAX_POWER` 2.2) is harder when the last stroke was slow.
  - Heave, pitch and roll are damped springs to `hullWaves`, at the share of the waves the drawn surface carries where she is (waves.ts `surfaceShare`). Heel stops at `MAX_HEEL` (0.14); the roll is also damped as the square of its rate (`ROLL_EDDY`), so a squall's gust does not swing her past it.
  - She steers for `LOOK_AHEAD` m ahead (rig.ts).
- `world/waves.ts`: the shared wave field (`waveHeight`, `waveSlope`, `hullWaves`, and their GLSL twins).
  - Waves are built by the wind over `FETCH` (5 km): `heightFor`, `peakFor`, `SHAPES`, and four direction groups (`QUARTERS`). They grow and die over `BUILD`/`FADE` and are capped at `STEEPEST` (`updateSea`).
  - Still water gets `SHELTERED` (35%); inland water carries `INLAND` (15%) of the waves the fetch would raise; they die out over the last `SHOAL_DEPTH`. `surfaceShare(depth, flow)` is the water shader's own factor: whatever floats (the hero, the moored boats, the fisher's boat, the lilies, the hyacinth, the petals) rides the surface as drawn.
  - Its open-sea and swell parts are inert (`exposureAt` is 0).
- `world/wake.ts`: the hull's bow and stern swell, the Kelvin wake and the blade's push (GLSL and a CPU twin).

## Water, sky and rendering

- `world/water.ts`: two meshes on one polar grid round the camera (`GRID_SEGMENTS`, `GRID_FAR`, `WATER_BOUNDS`).
  - `mesh` is the sea's and is hidden here; `inland` is every water at its own level.
  - `levelTexture` covers `WORLD` in `LEVEL_CELL` (6 m) cells. Its r channel is the water's level, carried `LEVEL_SPREAD` cells out over ground no lower than `SPREAD_BELOW` under it; its b channel is where water is. A salt farm's cells and one round them hold its own level as seeds, before any other water's is carried.
  - The water's hole for the hero hull is cut where the surface meets her as she heaves, pitches and heels (`uBoatHull`, hull.ts `hullHalfWidth`); main.ts sets it with `hullOnWater` (and per shot in `drawLeaving`).
  - In a strong wind the crests break white, measured against the waves this water carries (`INLAND` on inland water).
  - The field textures (bed and current, from `waterwayAt`) come in a fine one following the camera and a wide one over the world.
    - The fine one (`FineField`) is refilled round the camera once it strays `FINE.drift` m, `FINE.ms` a frame. The wide one stands in meanwhile.
    - The film readies the next shot's fine field ahead (`warm`) and uploads it to a spare texture (the two take turns as `tField`), so the cut only switches to it.
  - Water at another level than the mirror's reflects the hazy sky. Its sea and ship parts are inert.
  - `nets` (the cast nets' rings, `netRings`) and `touch` (`uTouch`: a light thing come down on the water, the film's petal) ripple it; `fallInto` (`uFall0/1`) froths it where the hill stream and the sluice pour in.
  - The ripple patch's slopes (`RIPPLE_GLSL`, world/ripples.ts) are added where the camera looks.
  - It takes the key light's shadow (`takeShadow`, `keyLight`): no glitter and less light in its froth under the trees.
  - The kept pond is clear whatever the season (`levelTexture`'s `a`, GLSL `waterClarity` in `underwater()`).
- `world/ripples.ts`: `Ripples`: the water's own ripples where the camera looks. A patch (`TEXELS`² over `SIZE` m, 6 cm a texel) simulated with the wave equation on the GPU (two targets ping-ponged, fixed `STEP`); the banks (from the water's field) and the hero's hull stand still, so rings run back off them, and the shallows calm them. `drop(x, z, radius, depth)` from what touches the water: the paddle (bite, pull, exit), the stem, fish, frogs, turtles, the net's drips, the falls. The patch follows where the camera meets the water, shifting its state as it goes.
- `world/sky.ts`: clouds, stars and the moon (`MOON_R`; the phase lit by the sun's real angle).
  - The sun's disc reddens as it sinks.
  - After sunset the clouds toward it are lit crimson from below. environment.ts's `dusk` deepens the low sky.
- `core/globals.ts`: `G`, the uniforms every scene shader shares (mutate `.value`, never replace the object).
  - Layers: `LAYER_WATER = 1` and `LAYER_NO_REFLECT = 2` are drawn by the main camera only; the mirror sees layer 0.
  - `G.uWaterLevel`/`uTideHigh` are held at `WATER_LEVEL + season.water`.
  - `uWaterRise` is the season's rise. `uFlowScale` is the season's runoff on the currents and the water's clarity (clear and green in the dry months, silty in the rains, `underwater()`). `uHillCloud` is the cloud on the hills.
  - `uLamp0..3` / `uLampColor0..3`: the village's lamps after dark (landmarks.ts `lampsGlow`): where each is and its reach, its colour times its strength (black by day).
  - `uSaltWet`: how much of the rains' water stands in the salt farms (geography.ts `setSaltWet`).
- `render/glsl.ts`: `GLSL_COMMON`. Include it exactly once per shader.
  - Uniforms, hash/noise/fbm, `windGust`.
  - `groundReach`: how far crops and grass are from the camera, with height counting double.
  - The paddy plots: `PLOT_SIZE`, `PLOT_ANGLE`, `plotWarp` (long sines that bend the grid), `plotFrame`, `plotRank` (broad patches worked together, each plot a little out of step), `cropShares`.
  - `waterLevels`/`waterSurface`, `underwater`, `hazeColor`, `applyAtmosphere` (with `EDGE_HAZE`), `CROP_REACH`, `CORRIDOR`, `EDGE_MARGIN`.
  - `lampLight`/`lampsAt`: the lamps' soft light on a surface (patch.ts adds it to every lit material after dark; the water shader has its own glints, water.ts `lampGlint`).
- `render/patch.ts`: `patchMaterial` adds the shared look to a three.js material.
  - Atmosphere.
  - Wind (`ATM_WIND`): each plant has its own period, phase and give; the trunk swings on two unrelated swings and the branches on quicker ones; leaves shiver (`ATM_FLUTTER` with `foliage`). The lean levels off at `LEAN_MAX`. `swayWith` sways what rests on a plant as the plant does there (per instance `aSwayAt`, `aSwayRoot`, `aSway`; a plant's own from `swayOf`).
  - Grime, translucency, foliage normals, skin, `seasonal`, `vertex` hooks, `wetline`.
  - The terrain's paddy plots and splat layers (`SPLAT_TILE`, `SPLAT_COLOR`).
  - The salt field's beds, bunds, brine and crust where the terrain's zone is below 0, in `SALT_FIELD`'s frame.
- `render/surfaces.ts`: the photo ground layers (`GROUND_LAYERS`) and the bark.
- `render/pipeline.ts`: the post chain. `render` brings the world's matrices up to date in its first pass only. `setSamples` sets the scene pass's multisampling (4, or 0 in the lower tier).
  - MSAA scene, bloom, light shafts, and a composite: ACES, a gentle S-curve and a lifted toe (moody, never murky), vignette, grain, and NaN-safe `sanitize`.
  - Depth of field for a shot that asks for it (`FrameParams.dof`, from a scene's `focus`): the scene's depth is resolved only then (`resolveDepthBuffer`), and each pixel gathers `DOF_TAPS` neighbours over a thin lens's blur. Bloom follows it.
  - The letterbox with captions.
  - The held frame for dissolves (`toHeld`).
- `render/reflection.ts`: the planar mirror at half resolution.
- `render/instancing.ts`: instanced meshes split into cells (`chunk`, `across`) so off-screen cells cull; `placementMatrix` places one as its `Placement` says.
- `render/cull.ts`: distance culling (`cullBeyond`, `setCullReach`).
- `render/textures.ts`: every canvas-painted texture (plaster, brick, cloth, bark, kash, rice, mustard, and so on). One painted again with the same inputs is painted once and handed out as clones (`paintedOnce`: the weaves; the cloth's relief, one for each kind of weave): each clone has its own repeat, and they share one image and one upload.
- `world/terrain.ts` `meshGround(x, z)`: the ground as the finest patches draw it (their 2 m lattice interpolated), for what must rest on it where the ground is cut finer.
- `render/builder.ts`: `MeshBuilder`, `rgb`, `mixRgb`, `scaleRgb`, `taperedTube`, `card`, `slab`; `crownTops` (the tops of a crown of cards).
- `render/snapshot.ts`: `WorldLook`, the fields that make a shot's world.
  - It covers the shared uniforms except the clock, the camera and the gust fronts, plus the lights, the sky, the water's colours and the boat's uniforms, the rain, the lantern and the shadow's matrix.
  - These fields are captured and put back for the dissolves.

## Environment

- `env/astro.ts`: the sun and moon for a local solar hour at latitude 21.6°. The declination comes from the date; the moon walks the ecliptic, and its tilt off it is ignored. `sunDirectionOn`/`moonDirectionOn` give them on another day without moving the sun's own day (for moments weighed ahead).
- `env/clock.ts`: sky time. `SPEEDS` are multiples of the wall clock's (1 = real time); faster, the time-lapse. `advance(dt, own)`: the viewer's own clock (`own`, main.ts outside the film) passes each event's `HAPPENING` in `EVENT_SECONDS` (25) whatever the pace, eased over `EVENT_RAMP` (`ownPace`); the film's lingers near each rise and set as its scenes were shot (`BASE_RATE`, `LINGER`, `rate`). `WATCH`: when the camera may turn to an event. `LAPSE` (360) is the film's pace. `live`: kept to Bangladesh's own time in Live (main.ts calls `follow(hour)` each frame) until the viewer turns the clock. `events()` gives the day's events.
- `env/season.ts`: the six Bangla seasons as key rows (`KEYS`, `SEASON_NAMES`, `SEASON_STARTS`). `bangladeshTime()`: the day of the year and the hour in Bangladesh now (UTC+6).
  - `water`: the rivers' rise, full in the rains and Sharat and lowest in spring.
  - `salt`: the salt season. Also crops, colours, rain, wind and blossom.
- `env/weather.ts`: the season's own weather (`WeatherChoice`: `'auto' | 'clear' | 'drizzle' | 'rain' | 'storm'`; no picker in the UI), wetness and strikes.
  - `wet` (0..1) builds toward a level that goes with how hard it rains, faster the harder. It dries slowly.
  - `render/patch.ts` reads `uWet`: surfaces are soaked through by ½, and puddles stand beyond that.
  - `hold` is the film's own rain and wet (SceneWorld `rain`/`wet`); the cloud and the wind follow it.
  - In `render/patch.ts`, rain wets the faces turned up to it most (darker, glossier, a little sky mirrored). The terrain wets by its `aPool` (`world/terrain.ts`: trodden or swept ground and hollows, never slopes) and stands water there. The ways have `puddles`. Standing water is ringed by the drops, and the leaves are knocked by them (`ATM_FLUTTER`).
  - `audio/soundscape.ts`: the rain's hiss grows faster than the rain, and a downpour's roar (`downpour`) comes in under it.
- `env/wind.ts`: one wind (`WIND_MS`; `windAt`/`gustAt` on the CPU, `windGust` in GLSL). A film scene may hold its strength (`override`) and the way it blows (`towardOverride`, SceneWorld `windToward`).
- `env/environment.ts`: light and colour by the sun's elevation (`LOOKS`). It also sets the moonlight and the new-moon glow (`moonE`, `glowE`), `dusk`, and `aimShadow()`.

## Camera, film and UI

- `rig/cinematic.ts`: the cinematic mode's morning. `planCinematic()` weighs every day of spring (`SPRING`, বসন্ত: the season the site opens in) for the opening (the season's land, water, mist and sky; where its sun comes up in the drone's frame, `highView`; a morning moon beside her way) and returns the best `Plan` (`day`, `dawn`, `lit` and `morning` hours, `moon`, and the best days `ranked` with their terms). `morningOn(day)` is the same morning on another day (the return from Live). `SUNRISE`: where the sunrise runs in the opening (up to the lit stage through the drone's descent; from `on`, overlapping it, on to `MORNING`, 8:05, at `until`, the flight's end; main.ts `riseSun`); `DAWN` (−6°: the land still dim), `LIT` (7–9° by the season's fog: soft, and just past the sunrise's watch window), `MOON_DOWN`. The moon is still weighed at the lit stage.
- `rig/yearJourney.ts`: `YearJourney(day).dayAt(s)`: the day of the year the land shows with the boat `s` m along her way, in the cinematic mode. From the chosen day's season round the year in the calendar's order, a stretch of the way to each season (`STRETCH`: the rains and Sharat longest), each holding its look (`HOLD`, `HOLD_DAYS`) and then turning to the next; back to that day where her way begins anew.
- `rig/opening.ts`: the opening flight (`OPENING_SECONDS` 15 s), in three parts:
  - The high part: `KEYS` in the way's own frame (`wayAt`: along it, out from it, height; the look along it, its height `up` over the water, its turn to the boat), from over the river ahead of the boat down beside the village's bank (`openingSide`), eased in over `SET_OFF` s (its own time running at `PACE` after them), interpolated with slopes per second (`curve`). It sets off looking up the river to the horizon (the cinematic sunrise) and tilts down to her by its third key. `highView(t)` is its view in its first seconds.
  - The round: from `ROUND.from`, where the descent leaves it coming in at `ROUND.arrive`, round her middle by its bearing (`bearingAt`: from the descent's turn `TURNING` it gathers over `ROUND.gather` to an even turn and settles over `ROUND.settle`) to the rest place behind her (`RestPlace`, given by the rig: the composer's shot it hands over in); drawn in to `ROUND.near` (× `RestPlace.wide` on a narrow screen) and down toward `ROUND.low` as it passes her beam, then out and up to the rest place (`roundAt`). Its look comes from the follow camera's target to her middle as its turn gathers. `roundShare(t)`: how far round it has come.
  - The floor (`openingFloor`): laid once at the start from `clearance`: with the rig's `Sightlines`, `CLEAR` m over what stands within `AROUND` m (crowns, palms, bamboo, houses) and `OPEN` m over open land, `LOW` over open water past `REACH`; without them, `CANOPY` m over all land. Risen to `AHEAD` s early, eased over `SMOOTH`, and met with a soft max (`BLEND`). Over its last `HANDOFF` s the little between its own end and the composer's stand is taken up by a smootherstep (rig.ts `flyOpening`).
- `rig/sightlines.ts`: `Sightlines(crowns, stems, huts)`: what stands between the eye and what it would see, for the camera's own choices. The ground on a 2 m lattice and its cover (water, open field) on a 4 m one, filled as asked; the crowns (`treeCrowns`), the palms and the bamboo (`palmStems`), the houses and the grand ghat as columns in a spatial hash; the old bridge with its arch open. `sees(from, to, spare)` (how clearly, 0..1), `look(from, heading, far)` (how deep a level look runs, over what, and what ends it), `clutter` (a crown or a roof close in front of the lens), `overWater`, `standsClear` (over the water clear of the crowns, low over open field, or high over the groves).
- `rig/showcase.ts`: the village's sights, for the camera to show by itself. `findSights` describes each once (`SightSpec`: its middle, `up`, `size`, `rank`, `front`, `reach`, `worth` by the season and the dark; a new landmark is one `add`) and places it on her way (`placeOnWay`: sampled every `STEP` m from `EYES` heights for distance, size in the frame, bearing from her, and `Sightlines.sees`): `s` where it is seen best, `best`, and `seen`, its stretch. `chooseShown` (the rig, every `CHOOSE_SECONDS`) picks which are shown by themselves by `rank × best × worth` now, each trimmed to what the others leave free `GAP` m round them; `sightWeight` eases in and out over `EASE` m; `ownReach` is a sight's own ground.
- `rig/compose.ts`: `Composer`, the views the camera composes left to itself. Shots in her frame (`Shot`: `bearing`, `dist`, `high`, `third`), from behind her and her quarters (`BEHIND`; her beam too for a sight, `BESIDE`), looking on ahead (`LOOK_ON`; to a sight no further round than `LOOK_ASIDE`, and turned to from about the shot held before it, `STAY`), are weighed a little each frame (`BUDGET_MS`; a weighing every `REST` s) in `rate`: the sight seen, its size and place on a third, its `front`; her and her majhi in the frame on the other third, never cut by its edge; the light (`light`: raking, the low sun to one side, `glare` in the middle); how deep the view runs (`look` rays: water, field by `fieldWorth`, a hill or a treeline behind); `clutter`; over the water (`ASHORE`). A shot is held (`HOLD`, `HOLD_SIGHT`) and left for one `BETTER` (held past `LONG`, another angle counts `FRESH`); a sight seen worse than `POOR` gives way to the surroundings. It moves on `Spring`s whose speed and acceleration are held (`ARC`, faster while it looks back `ARC_BACK`, `RUN`, `DRAW`, `LIFT`, `TURN`), drawn in where the banks close in (`safeDist`), lifted over what is under it. `narrowScale`: farther out on a phone held upright. `poseOf(shot)` and `lookFrom(pos)`: where it would stand and how it would frame, for a camera handed to it; `takeFrom(camera, m, third)` then starts from that framing and holds the shot as if chosen.
- `rig/vantage.ts`: `vantages(place, lines, count)`: where any place is seen from with the land round it: rings round it (`RINGS` × its size, `NEAREST`..`FARTHEST`, `HIGHS`), weighed by `sees`, its size in the frame (`SIZE`), the depth past it, clutter and the water; the best, `APART` round it. `surfaceAt`.
- `rig/visits.ts`: the map's places (`mapSpots(lines)`: a `Spot` each with its name, a line about it, its sign, its group and its shots). Each place's own shots (`SHOT` s, an even `glide` over the ground or the water beneath it) between its wide views (`viewShot`: `VIEW` s, an arc round it from a vantage found the first time one is posed), `before` and `after` per place. The salt farms have none found: their four shots are designed (high over the river, the gate, the creek and the farms in one; along a bund; up over them all; beside the creek on to the gate and the river). The shots after the first dissolve in over `CUT` s (director `Scene.dissolve`). The first carries the boat's place (`journey`): short of the place's `sync` (its part on her way: the zamindar's ghat) by the shots' length, the dissolve back and `LEAD` seconds more at `CRUISE`, so she has not passed it when the camera comes back to her.
- `rig/rig.ts`: the boat's journey and the camera.
  - She steers for the point `LOOK_AHEAD` m along her way from where `journeyFrame` puts her. Near the end, in the bil, the mist comes down and she is put back at the start (`END_REACH`). She opens at `JOURNEY.opening`.
  - The `follow` orbit (`VIEWS`, `OPENING_VIEW`, `WATCH_VIEW`) is kept over the water near the banks (`overWater`), above the ground and the water, under the bridge's arch (`keepClearOfBridge`), and through the sanko's middle span or over its walkway (`keepClearOfSanko`).
  - `free` is the free camera (`flycam.ts`: `SPEED`, `EDGE`, `CEILING`).
  - The opening flight (`beginOpening`, `flyOpening`, `openingBars` for its letterbox) poses the camera over the follow pose. It ends in the composer's usual shot on its side (`handOver`: compose.ts `USUAL`, her on the far third; `restPlace` from `poseOf`), its look coming into the composer's framing by `roundShare` (`lookFrom`), and the composer takes the camera there in that frame (`takeFrom` with the third). Input ends it (`endOpening`) with the rig's own blend; `OPENING_VIEW` is where the follow camera rests after it.
  - Left alone (`IDLE_SECONDS`) with the view `auto` (the default, সেরা দৃশ্য; `setView`), no sky event watched and no flight, the composer has the camera (`compose`), taking it from the follow pose (`Composer.takeFrom`). Any input (`steer`) hands it back where it stands: the orbit is set to that place (`stopComposing`) and the rig's blend turns it to her. Under the film (`directed`) it only holds its shot. `fillMoment` gives it her place, the sight whose stretch she is in and the `sky`; `focus` follows the composed view for the shadow map. A view picked is held (`auto` false). The orbit stands `narrowScale` farther out on a narrow screen.
- `rig/director.ts`: the film's engine.
  - Each scene has its own camera move at an even pace. The shot being left goes on moving (`CARRY`) while the next dissolves in over it for `DISSOLVE` s (2.2; a further shot of a scene `SHOT_DISSOLVE`, or a scene's own `dissolve`). The tour starts and ends the same way, from and to the viewer's view (`leaveView`, `leaveScene`).
  - The next shot's places are built a few ms a frame (`WARM_MS`) from `WARM_AHEAD` s (9) before its cut (`Stage.warm`). At the cut, `Stage.prepare` builds the rest of the ground, and the grass and crops within `PREPARE_MS`; their own updates finish them, growing in under the dissolve.
  - A scene's boat place is its `journey` (set when the scenes are built), so the warm-ahead knows it. A further shot may have its own, for a cut that leaves time out; a still of a later shot (`cue`) reckons her place from the last shot that put her somewhere.
  - A `Scene` with `shot` is a further shot of the one before, cut with `SHOT_DISSOLVE` (0.7 s).
  - A scene's `sweep` drives its own clock (`sweepAt`: a monotone cubic through `[u, hours]` keys); `pace` slows the sky's clock.
  - A scene's `rain` and `wet` keys (the same kind of curve) drive the weather through it (`Stage.weather`, the weather's `hold`). Each rain scene takes the wet up where the last left it, so the land wets across the movement. Without them, `stage.set` settles the weather at once, and a rain scene opens soaked.
  - A scene's `focus` (with `aperture`, default `APERTURE`) gives its shot a depth of field (`Director.dof`, `Leaving.dof`).
  - `begin(stage, at)`: `at` is how far into the scene a still starts (`cue`), so the cues on their own clocks start as far on.
  - `Director.skip(±1)` steps to the previous or next scene.
    - "Previous" restarts the scene once it has run `RESTART` s (3).
    - A skip asked for during a dissolve waits until it ends (`queued`).
    - A skipped scene's caption fades out before the next one's comes up.
    - Stopping the film always takes a full `DISSOLVE`.
- `rig/tour.ts`: `tourScenes(ghats)`, the film: 25 scenes (29 shots) in five movements.
  - The movements: a winter morning; spring's blossom and the nor'wester; the rains; autumn and the harvest; the evening and the night.
  - The rains, as the monsoon comes: আষাঢ়ের মেঘ (the cloud gathering, the first drops) → বর্ষার খাল (the rain coming on, the mathal put on) → আষাঢ়ের ধারা (the downpour on the village's ghat, the land soaking, thunder) → পুরনো সেতু (three shots of the boat under the old arch, steady rain) → the gher and the aman (easing) → বাঁশের সাঁকো (the boat under the high sanko in the side khal, late in the rains) → শাপলা বিল (after it, still wet).
  - Places are found from the village as built: `cropField(crop, day)` (cached, and shared with the reapers), `overField`, `blossomTree()` (exported and picked once: main.ts gives it its fuller crown and its petal), `stormHome()`, `talRoad()`/`alongRoad`, `ghats[0]`, `FISHER_SITE`, `gherStand()`, `rakerStations()`, `kashStand()`, `onWay`, `rel`, `facing`, `overOpenWater`.
  - বসন্তের রং (`PETAL_SHOT`, `PETAL_LETS_GO`): `petalOpening` (low on the water near the far bank, the sun well to the side) and `petalPose` (in toward the petal, rising to meet it as it comes out under the crown, then following it down at arm's length, kept over the water by `overWater`). Its breeze is held blowing from the tree out over the water (`windToward`), and its focus is drawn from the tree to the petal.
  - জেলের জাল: three shots (wide 16 m off, medium, close).
  - Heights over the water are measured from the season's surface (`surface()`).
  - Scenes cue what moves in them through the `Stage`: the train, the casts, lightning, `bareheaded`, `sap`. They read `sapTree` to frame the sap.
- `ui/`:
  - `controls.ts` (+ `controls.css`): the panels' colours are one block of tokens at the top of `controls.css` (`#dock, .pop, #help, #mapdlg`: the জামদানি muslin), with the dark glass's values on `:root` for the buttons shared with what sits on the scene alone (the toast, the restore button). The dock, a pane with a running stitch along its top: the year's ring (`#season-btn`: six arcs in `SEASON_HUES`, the journey's day marked), the hour and the Bangla date, `#live` (the mode, `TimeMode`: off in the cinematic mode, on in Live, hollow when the viewer has moved Live's clock; `#season-own` names the season menu's way back by the mode), the day's timeline with its sky events, the speed, the camera, and the view, moon, sound, map, full screen and more. The season, moon, view and more menus are popovers (`.pop`) placed over the button that opened them (`placePop`, `invoker`), moved by the arrow keys (`menuKeys`); on a phone the view, the moon and the map move into the more menu. `#brand` (the mark, top left) comes and goes with the dock and opens the help. `#film-nav` shows the previous/next scene while the film plays (`visibility: hidden` once it fades, so the keyboard can't reach it).
  - `bangla.ts`: Bangla time, tithi and dates.
  - `hud.ts`: the loader (its sun rises with `progress`, `now()` writes the cinematic morning's season, date and dawn under it; `ready` lets the still go and lifts the mark after the title's seconds), notices and captions.
  - The loader itself is inline in `index.html` (it shows before the scripts load): the still `public/brand/loader.webp` (a tiny blurred copy inline under it while it comes), the mark drawn inline, the word set once its face has come.
  - `mapPanel.ts` (+ `map.css`): the map (L), on the panels' muslin with a stitch under its title. The ground is painted from above a few rows a frame (`paintAt`, at `M` m a pixel), its shorelines lightened once all is in; over it, `FINE` times finer, the salt creek and its feeders and each farm's intake drawn along their lines (`saltWaterLines`, worked out once: narrower than the ground's pixels), the ways, the boat's way dashed, the waters named (the creek খাঁড়ি), a badge for each place in its group's colour with its sign (`ICONS`, 24 × 24 paths, the same in the list's cards), and the boat with a slow ring. Hovering a badge or a card picks it out and shows its card over the map; a click on either visits the place (`MapActions.visit`: the director's `visit`); a click elsewhere on the village's land looks at it from above (`fly`). The list groups the places (`GROUPS`: on the river, in the village, in the fields).
  - A visit (main.ts `visit`): the camera the visit comes back to is set to follow her (`rig.followNow`), the director plays the place's shots, and the year is set at once to her new place on the journey (under the first dissolve). The film's own ways (the clock's pace, the turning year, its scene bar, the arrows through its scenes) keep to the film (`filming()`), not to a visit.
  - Input in the film (main.ts):
    - A tap or click only wakes the controls.
    - A drag past `DRAG_PX`, a second finger, the wheel, Esc, or a steering key takes the camera (`takeOver`).
    - The world's own controls leave the film first (`ownWorld`): time, speed, season, moon, the timeline's marks, N, Y, `[` `]` and Space. The viewer's world is put back before the change applies to it.
    - The film starts only from its button or C (the journey is the experience left to itself).
- `audio/soundscape.ts`: Web Audio only.
  - The sounds: water (louder the nearer the listener is to it), wind (with its gusts), rain, the paddle's splash (by its distance), birds (silent in rain or a hard wind), crickets, frogs (the rains' nights: small frogs' rattles and bullfrogs' croaks), the falling water near (the hill stream, the sluice: fading as 1/distance from 6 m), thunder.
  - The train (`train`, fed by railway.ts `acoustics` each frame): its wheels' rolling summed over its bogies, its engine, its horn, each joint's clack (a high click over a low thump). Each is placed in the world (`Placed`: a delay line that follows the distance at 343 m/s, so the pitch rises coming and falls going, Doppler; the level by the distance; `airCutoff`, the highs the air and the grass take; its side), all through a compressor, its bus faded to nothing past `TRAIN_HEARD` m from the line (the user's rule: none past 300 m). The horn is an air horn's: two notes, each a pair of bells a few cents apart, its air's rush, its pitch bent by the pressure (`hornBend`: up as the valve opens, sagging as it closes). A jump of the listener or the train sets them where they are at once. Its timbre and loudness (`TRAIN_VOICE`, `HORN`) were tuned against the user's reference recording (Pixabay "Train #1"): the horn's two bright notes, the roar from 150 to 500 Hz, the rails' ring round 2.4 kHz.
  - Thunder still on its way is hushed when a scene changes (`hushThunder`).
  - It fades in on the first touch or key, is muted with M or the speaker (remembered as `nodi.muted`), and sleeps while the page is hidden.
- `main.ts`: the bootstrap; the mode (`mode`: cinematic or Live; `toggleLive`, `setMode` under the dip's dark `DIP`, `keepToWall`, `takeClock`), the cinematic sunrise (`sunrise`, `riseSun`, `beginSunrise`), the season's own (`onJourney`, `seasonHeld`, `yearJourney`, `followYear`, `backToMode`, `ownMoon`); the opening flight's start; adaptive resolution and the quality tier (`setQuality`); the film's stage; `worldLook`/`drawLeaving` for dissolves; the jump under a moment of dark (`jumpAt`, `readyAround`); every keyboard shortcut; the `?debug` hooks.
  - At load every material is compiled, the hidden ones too. What is built starts compiling at once (`compileSoon`, for the scene's lights `sceneLights` and the scene pass's target), so the driver works on the programs while the rest is built.
  - Groups that never move are added through `still()` (their matrices made once); the scene's own matrix is never remade.
  - Behind the loader, after the programs are compiled, everything standing within reach is drawn once with frustum culling off, its shadow too, and the passes drawn only now and then are compiled (`Pipeline.compile`, `Ripples.compile`): nothing the opening flight turns to is first sent to the GPU in its frames.
  - The quality: the opening's first view is readied and drawn a few times behind the loader, its GPU cost measured (`gpuCost`, by the timer query where there is one) and the starting size and tier set from it (`GPU_AIM`). Then the adaptive resolution (`ADAPT`): quick windows at first, a slow frame takes the size straight to what would hold it, never below `least` (`leastDense` on a phone's dense screen), back up a step at a time; the lower tier comes in once the picture is slow at `lowAt` or the frames wait on the CPU (`cpuBound`), where fewer pixels would not help. Back from a hidden tab the time away is no frame's (`away`), and no frame counts for more than `ADAPT.longest`. A new size is taken up just before the next frame is drawn (`resizeDue`). It costs that frame 60–90 ms (every target made again), so a step of less than `ADAPT.smallest` is not taken, and through the opening flight the size only comes down.
  - Shader logs are checked only in development (`renderer.debug.checkShaderErrors`): checking one on a program's first use waits for the driver.

## Legacy tooling

- `src/geo/project.ts`, `src/geo/tide.ts` and `scripts/geo/` are the real-geography pipeline of the earlier branches. Nothing in `src/` imports `src/geo/`.
- `scripts/humans/` uses `scripts/geo/lib/zip.mjs` and `png.mjs`.
- Comments there that cite `GEOGRAPHY_PLAN.md`/`GEO_AUDIT.md` sections refer to the files in git history (see decisions.md, Branch history).

## Where to change what

| What | Where |
| --- | --- |
| The layout: waters, homesteads, landmarks, roads, hills, salt farms | `world/plan.ts` (check it top-down after; the ways scan, verification.md) |
| A salt farm's ground, water, bunds and people | plan.ts `SALT_FIELDS` (`dig`, `rim`, `bunds`, `rains`, `work`); ground geography.ts `saltGround`, `SETTLING`, `RIM_CREST`; paint render/patch.ts; bunds and crews world/saltworks.ts (`POSED`, `DRAWN`); motions world/saltHands.ts (`RAKE`, `STRIDE`, `KODAL`, `KEYS`) |
| Ghat steps | world/ghatFlight.ts → `RISE`, `RUN`, `CLEAR`; the zamindar's geography.ts `GRAND_GHAT`; the village's village.ts `brickGhat` |
| Moored boats and their lines | world/village.ts → `tieUp`, `mooredBoat`, `zamindarBoat`, `MOORED_DRAFT`, `SLACK`; their swing and bob in the `moored` vertex shader |
| Waterway widths, depths, currents; the journey's line | `world/waterways.ts` |
| Light, exposure, fog and water colour per time of day | `env/environment.ts` → `LOOKS`; moonlight and new-moon glow in `update()` (`moonE`, `glowE`) |
| Clock speed, how long a sky event takes, the film's lingering, when the camera watches | `env/clock.ts` → `HAPPENING`, `EVENT_SECONDS`, `EVENT_RAMP`, `BASE_RATE`, `LINGER`, `WATCH`, `SPEEDS`, `LAPSE` |
| The seasons along the journey | `rig/yearJourney.ts` → `STRETCH`, `HOLD`, `HOLD_DAYS` |
| The opening flight | `rig/opening.ts` → `KEYS` (its first look up the river: `up`), `ROUND` (the round: `near`, `low`, `gather`, `settle`), `OPENING_SECONDS` (with it, how quickly it turns round her), `SET_OFF`, `PACE`, `HANDOFF`; the shot it ends in rig.ts `handOver` (compose.ts `USUAL`); its floor `CLEAR`, `AROUND`, `OPEN`, `CANOPY`, `LOW`, `REACH`, `AHEAD`, `SMOOTH`; where it ends `rig/rig.ts` → `OPENING_VIEW`; the title over it main.ts `TITLE_SECONDS` |
| The cinematic morning: what is weighed, the sunrise, the lit stage, the hour the journey sets out at | `rig/cinematic.ts` → `planCinematic` (its terms), `SUNRISE`, `DAWN`, `LIT`, `MORNING`, `MOON_DOWN`, `morningMoon` |
| The sights the camera shows by itself (a new landmark: one `add`) | `rig/showcase.ts` → `findSights`, `STEP`, `EYES`, `LEAST`, `MOST`, `KEEP`, `GAP`, `EASE`, `WORTHY`; how often they are chosen `rig/rig.ts` → `CHOOSE_SECONDS` |
| How the camera composes left to itself | `rig/compose.ts` → `BEHIND`, `BESIDE`, `DISTS` (how far out), `HIGHS`, `HER_SIZE` (how big she stands), `USUAL` (where the opening hands over), `LOOK_ON`, `LOOK_ASIDE`, `STAY`, `HOLD`, `BETTER`, `LONG`, `POOR`, `ASHORE`, the paces (`ARC`, `ARC_BACK`, `RUN`, `TURN`…), `HER_Y`, `SIGHT_Y`, `HORIZON_Y`, `rate` (its weights), `narrowScale`; what hides what `rig/sightlines.ts` |
| The map's places and their shots | `rig/visits.ts` → `mapSpots`, `glide`, `SHOT`, `VIEW`, `CUT`, `LEAD`, each place's `before`/`after`; their wide views `rig/vantage.ts` → `RINGS`, `HIGHS`, `SIZE`, `APART`; the map `ui/mapPanel.ts` → `ICONS`, `GROUPS`, `paintAt`, `drawLines`; `ui/map.css` |
| The loader, the logo, the icons | `index.html` (`#load`), `ui/hud.ts`; `public/brand/` (`logo.svg`, `favicon.svg`, `loader.webp`); `scripts/brand/icons.mjs` |
| The change of mode, the first fair minutes, idle times, picks' hold and turn times | `main.ts` → `DIP`, `OPENING_CLEAR_SECONDS`, `WATCH_IDLE_MS`, `SESSION_MS`, `YEAR_TURN_SECONDS`, `MOON_TURN_SECONDS` |
| Each season's values (water, crops, colours, rain, wind, salt) | `env/season.ts` → `KEYS` |
| How seasons look on plants and fields | `render/patch.ts` (`seasonal`, the paddy part) |
| Rain, storms, wetness | `env/weather.ts`; streaks and splashes `world/rain.ts`; drops `render/glsl.ts` → `RAIN_CELL`, `rainDrop`; wet and puddles `render/patch.ts` (`uWet`, `ATM_PUDDLES`), `world/terrain.ts` (`aPool`) |
| Wind strength and gusts | `env/wind.ts` → `WIND_MS`, `windGust`/`gustAt` |
| Waves | `world/waves.ts` → `FETCH`, `heightFor`, `peakFor`, `SHAPES`, `QUARTERS`, `STEEPEST`, `BUILD`, `FADE`, `SHELTERED`, `INLAND`, `SHOAL_DEPTH`, `surfaceShare` |
| Water's clarity | `render/glsl.ts` → `underwater()` |
| Boat mass, drag, steering, heel | `world/boatPhysics.ts` → `MASS`, `STEER`, `strokePower`, `MAX_POWER`, `MAX_HEEL`, `ROLL`, `ROLL_EDDY` |
| The stroke and the body's drive | `world/paddle.ts` → `STROKE_SECONDS`, `CATCH_Z`, `EXIT_Z`, `BLADE_X`, `LEAN_OUT`, `RECOVERY_LIFT`, `RECOVERY_LEAN`, `MEAN_THRUST`, `bodyDrive` |
| Where the majhi stands, his grip | `world/hero.ts` → `STANCE`, `CROSS_HOLD`, `LOWER_HOLD` |
| Bracing, leaning | `world/boatman.ts` → `BRACE`, `LEAN_MAX` |
| Cloth looseness and wind | `world/cloth.ts` → `DRAG`, `STIFF`, `LOOSE`, `ZETA` |
| People's bodies, faces, skin tone, hair, clothes | `scripts/humans/config.mjs` (`CHARACTERS`), then rebuild (`CLAUDE.md` Commands) |
| Camera views, opening view, look-ahead, loop, idle | `rig/rig.ts` → `VIEWS`, `OPENING_VIEW`, `WATCH_VIEW`, `LOOK_AHEAD`, `END_REACH`, `LOOP_FADE`, `IDLE_SECONDS`; the views' names `ui/controls.ts` → `VIEW_NAMES` |
| Free camera speed and limits | `rig/flycam.ts` → `SPEED`, `EDGE`, `CEILING`; corridor `render/glsl.ts` → `CORRIDOR` |
| Film scenes: place, season, time, weather, camera, length, caption | `rig/tour.ts` → `tourScenes()` |
| Dissolves and warming ahead | `rig/director.ts` → `DISSOLVE`, `SHOT_DISSOLVE`, `WARM_AHEAD`, `CARRY` |
| Grass density and reach | `world/meadow.ts` → `STEP`, `BANDS`, `THIN`, `grassClump`, `flowerClump` |
| Crops' reach and build budget | `render/glsl.ts` → `CROP_REACH`; `world/crops.ts` → `SWITCH`, `HEADS_OUT`, `BUILD_MS`, `GROW` |
| Hyacinth | `world/drift.ts` → `PLANTS`, `EDGE` |
| Ground photo layers and their scale | `render/surfaces.ts` → `GROUND_LAYERS`; `render/patch.ts` → `SPLAT_TILE`, `SPLAT_COLOR`; `world/terrain.ts` → `LOOK` |
| Distance culling | `main.ts` → `cullBeyond(...)`; `render/cull.ts`; cells `render/instancing.ts` |
| The quality tiers, the calibration at load, the adaptive resolution | `main.ts` → `setQuality`, `gpuCost`, `GPU_AIM`, `ADAPT`; the multisampling `render/pipeline.ts` `setSamples` |
| Water level map | `world/water.ts` → `LEVEL_CELL`, `LEVEL_SPREAD`, `SPREAD_BELOW` |
| Train frequency | `world/railway.ts` → `EVERY` |
| The train's sound: loudness, how far it is heard, horn, clatter; where the horn sounds | `audio/soundscape.ts` → `TRAIN_VOICE`, `TRAIN_HEARD`, `HORN`, `airCutoff`, `makeTrainVoice`, `blowHorn`; `world/railway.ts` → `JOINT`, `AXLES`, `WHISTLES`, `WHISTLE_EVERY`, `APPROACH`, `HORN_APART` |
| The train's look: running gear, sway, windows | `world/railway.ts` → `car`, `WHEEL_R`, `BOGIE_AT`, `SWAY`; `Train` (`lit`, the headlamps) |
| Bloom, grade, letterbox, depth of field | `render/pipeline.ts`; a shot's focus `rig/tour.ts` (`focus`, `aperture`) |
| Fallen petals, the film's petal | `world/petals.ts` → `PER_CROWN`, `REACH`, `BANKED`, `HERO_FALL`, `SWING`, `INTO`, `CARRIED`; the petal's shape `world/leaves.ts` |
| Ripples near the camera | `world/ripples.ts` → `TEXELS`, `SIZE`, `SPEED`, `DAMP`; who touches the water: `drop` calls (main.ts paddle and stem, fish.ts, frogs.ts, turtles.ts, fisher.ts, falls.ts) |
| Fish, frogs, turtles | `world/fish.ts` → `KINDS`, `SCHOOLS`, `SWIM`; `world/frogs.ts` → `MOST`, `FIND`, `SHY`; `world/turtles.ts` → `SHY`, `SAFE` |
| The hill stream and the sluice | plan.ts `HILL_STREAM`, `SLUICE`; carving `world/channels.ts`; water and flow `world/falls.ts` |
| The mosque, its pond, graveyard and banyan | plan.ts `MOSQUE`, `MOSQUE_POND_TREES`, `MOSQUE_GROUNDS`, `GRAVEYARD`, `GRAVE_BANYAN`; the building, its kalima and its ghat landmarks.ts `MQ`, `mosque`, `mosqueGhat`; graves landmarks.ts `graveyard`; its fish fish.ts `KEPT_STOCK`; pebbles stones.ts `PEBBLE_LOOKS` |
| The night lights (mosque, its ghat's lantern, the village ghat's) | landmarks.ts `lampsGlow`, `hubLantern`, `Parts.lights`/`lamps`/`lanterns`/`glow`; light glsl.ts `lampLight`; on the water water.ts `lampGlint` |
| The boat's way, the sanko's clearance | waterways.ts `JOURNEY_LINE`, `SIDE_KHAL`; sites.ts `SANKO` (`crown`, `gap`), `sankoDeck` |
| Textures | `render/textures.ts` |
| Sound | `audio/soundscape.ts` |
| UI markup and copy | `index.html`, `ui/controls.ts`, `ui/bangla.ts` |
