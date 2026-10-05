# Architecture

The code map of `src/` as it stands on `cinematic-village`, and where to change what. Coordinates are world metres: x west, z north, y up. The rules that keep these modules working together are in `CLAUDE.md` (Invariants and gotchas).

## The design and the land

- `world/plan.ts`: the village as designed, plain data. Everything is [নকশা] (designed); nothing is measured.
  - `WORLD`: the designed area, ≈2.15 × 1.65 km round the boat's way, the village, the bil and the railway. Beyond it the land fades into the haze and only the backdrop's hills stand on the horizon.
  - Levels: `WATER_LEVEL` is one water for the river, the khals and the bil, at its mean (the season raises and lowers it, `season.ts`). `PLAIN` is the fields, `MOUND` a homestead's ভিটা above them, `ROAD_RAISE` the brick road's embankment. `POND_LEVEL` is the ponds' level and `POND_RISE` their share of the season's rise.
  - Waterways' control points: `RIVER_POINTS` east to west, running on beyond the world both ways; `KHAL_POINTS` from the river's middle north to the bil; `SIDE_KHAL_POINTS` through the fields into the bil's west side; `SALT_CREEK_POINTS`.
  - Sites: `BIL_SPEC`; the journey's ends `JOURNEY_FROM` and `INTO_BIL`; `OPENING_NEAR`; the crossings `BRIDGE_NEAR` and `SANKO_NEAR`; `FISHER_NEAR`.
  - `CHAR`: the sandy inside of the river's broad bend.
  - `SALT_FIELD`: the salt farm on the river's south bank by where the boat sets out, under the hill. It holds the frame, the size, the sections (settling pond, evaporation beds, crystallizers) and the cells. `render/patch.ts` paints it and `world/saltworks.ts` builds on it, in step.
  - `KHAL_ROCKS`: the khal's rocks the boat goes round, all on her right, away from the paddle.
  - `HOMESTEADS`: each has an id, a rough place, a `w` × `d` mound, a `face` (or `bank` m back from the nearest water's edge, facing it), a `ghat`, and a `pond` in its own frame.
  - Landmarks: `BANYAN`, `HUB_GHAT`, `TEA_STALL`, `ZAMINDAR` with its pond, `MOSQUE` with its pond.
  - `FAR_GROVES`: the far villages toward every horizon.
  - `HILLS`: steep wooded hills right by the waters (over the river's south bank where the boat sets out, out of the bil's north-east shore, behind the char's kash). Each has `steep`: a grassy foot by the water, then a steep climb. Rounder hills stand on the horizons in the haze.
  - `RAILWAY_POINTS`/`RAILWAY`: the line north of the bil, on its embankment.
  - `ROADS`: the brick road and the earth paths. Each is either designed points (with the crossings' anchors `'bridge-e'`/`'bridge-w'`/`'sanko-s'`/`'sanko-n'`) or `along` a bank at an offset from the water's edge.
  - `KHEJUR_PATH`/`KHEJUR_ROW`: the field path past the date palms.
- `world/waterways.ts`: each waterway is a `Waterway`, a Catmull–Rom curve through its points, resampled every 2 m.
  - Along a waterway: `half(s)` and `depth(s)`; `current` in m/s along increasing s; `at(s)`; `frame(x, z)`, which returns `s`, `d` and `side` (+1 is left going along it) within its reach, as a reused object; `beside(s, side, out)`; `line.nearestS`.
  - The waterways:
    - `RIVER`: ≈30 m wide, 3 m deep, flowing west at 0.22 m/s.
    - `KHAL`: ≈14 m wide. Its mouth flares into the river, it narrows to 6 m under the bridge and widens into the bil. It drains toward the river.
    - `SIDE_KHAL`: ≈7 m wide, still.
    - `SALT_CREEK`: a tidal creek winding up from the south, out of the haze toward the coast, to the salt field's sluice. It is not joined to the fresh river (salt is made from sea water). Its banks are wide tidal mud (`bankWidth` 9).
  - `waterwayAt(x, z)`: the nearest waterway by distance from its bank, giving the way, `s`, `d`, `side` and `half` (a reused object). Also `charShare` and `riverLevee`.
  - `BIL` (its long axis is the khal's heading at its end), with `bilLocal`/`bilPoint`/`bilReach`.
  - The boat's way is its own line: down the river from `JOURNEY_FROM`, round the banyan's corner into the khal on a curve swinging wide of it, up the khal, on into the bil.
    - `JOURNEY` has `length` (≈1.9 km), `opening`, `turn`, `bridge` and `head`.
    - `journeyAt(s)`, `journeyFrame(x, z)`, `journeyHalfWidth(s)` (from the way to the nearer bank), `journeyDistance(x, z)` (a chamfer field over the world).
    - The way swerves round the khal's rocks (`rockSwerve`), keeping `ROCK_CLEAR` (3 m) from each.
  - `BRIDGE_SITE`, `SANKO_SITE`.
- `world/layout.ts`: the raised grounds and ponds, worked out once from the design. Both `geography.ts` and `roads.ts` read it.
  - `Shape`: a rounded rectangle turned by its face, with `local`/`shapePoint`/`shapeDistance`.
  - `FeatureGrid`; `MOUNDS`/`HOMESTEAD_MOUNDS` (the homesteads' mounds settled by `bank`); `PONDS` with `POND_BANK` and `pondReach`.
- `world/sites.ts`: the crossings' frames.
  - `BRIDGE`: the old brick arch over the khal, with its span, rise, ring, width, parapets, half-length with ramps and crown. `bank` is the road's crest where its ramps come down. Heights in its frame are above `water`.
  - The bridge's functions: `bridgeFrame`/`bridgeToWorld`/`bridgeSoffit`/`bridgeDeck`/`onBridge`/`bridgeEnds`.
  - `SANKO`: the bamboo sanko over the side khal, with `sankoToWorld`/`sankoEnds`/`onSanko`.
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
  - Also `HOMESTEAD_MOUNDS`, `PONDS`, `bilMarsh`, `bilDepth`, `routeGap` (the distance from the boat's way) and `onLandmark`. It re-exports `BRIDGE`/`SANKO` and their frames, `WATER_LEVEL`, `JOURNEY` and the journey's functions.
  - The season's water:
    - `setWaterRise` (called from main.ts each frame, from `season.water`) and `waterRise()`.
    - `meanWaterLevelAt`: the water at its mean level. The maps baked once read it.
    - `waterLevelAt`: where the water stands now (`risenLevel(mean)`, and in the rains out over the banks' foot and the bil's low rim). GLSL `waterLevels` adds `G.uWaterRise` the same way.
    - The bil keeps a deeper lane along the boat's way from the khal's mouth (`bilLane`), so she can go in when the water is low.
  - The salt field's ground: `saltLocal`/`saltPoint`/`saltShare`, graded flat a little below the fields. It feeds `landUse().salt` and the terrain's `LOOK.salt` (its zone is below 0); `onLandmark` keeps everything else off it.
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
  - It spends a few ms a frame building, with the nearest built ancestor standing in until a patch is ready. `update(eye, true)` builds everything, for stills.
  - Colour and layer weights per vertex come from `landUse` (`LOOK` per kind of ground), the beds under water, the wet mud up a bank from `shoreLevel`, and trodden earth along the ways.
  - A yard is drawn with the fine sand layer's grain under its clay colour.
  - It also exports `groundAt(x, z)`/`Cover` (`bare` marks a swept yard or a way's trodden ground, where the meadow grows nothing) and `groundLattice` for the chunked builders.
- `world/roads.ts`: the ways of `plan.ts` as smooth curves (points every 2.5 m), split at the crossings. Each piece comes straight onto its crossing for `APPROACH` m.
  - The brick road's crest is `PLAIN` + levee + `ROAD_RAISE`, smoothed, with its embankment `roadGround`. The village road is as wide as the bridge's deck.
  - Queries: `roadCover` (trodden ground), `roadEdge` (the brick road's edge; its verges are grass), `onRoad`, `roadLines()` (for the trees along it).
  - A way with `flat` is brick laid on the ground: the hub's paving under the banyan and down onto its ghat's landing, and the mosque's walk to its pond's ghat.
  - Every homestead that no designed way passes gets its own footpath to the nearest way, unless it would cross water. Every homestead with a ghat gets a trodden way from its yard to the ghat's landing (`LANDING` m up from the water). A path crosses the char through its kash.
  - `buildRoads(ground)` draws the raised road on its crest and the paths laid over the terrain, from one texture atlas (`roadAtlas`), one mesh per 1300 m cell.
  - `core/segmentIndex.ts`: `SegmentIndex` files segments in square cells, to find the nearest one measured against its half-width.

## Built things

- `world/village.ts`:
  - `planHuts()` lays each homestead's houses round its yard in its mound's frame: the main house across the back with its veranda over the yard, one or two houses along the sides facing in, the kitchen at a front corner and the cowshed at a back corner. Each house has a `HouseStyle` chosen once: mud or painted-tin walls, thatch or tin roof, the wall's wash, the door's paint and the veranda's depth.
  - `planGhats()` places the village's ghat below the banyan, then a ghat at each homestead front that has one, at the water's edge of the nearest bank. A `Ghat` has the waterway, `s`, `side`, `up` and `kind` (brick or bamboo).
  - `buildVillages(huts, ghats)` builds:
    - the houses, through `houses.ts`, and haystacks by the mounds' back corners;
    - brick ghats laid tread by tread on the bank's own slope between low walls. The village's ghat is 5 m wide with a rowak bench each side; each pond's ghat goes down the point the design gives;
    - bamboo ghats on posts out over the water;
    - a boat tied up at every other ghat.
  - It uses one mesh per material. Tin is barely metallic, because with no environment map a metal reads black.
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
  - The zamindar house: colonnades, balustrades, cornices, a pediment, green shutters, plaster fallen to the brick in patches, and a peepal on its broken parapet. With it go its grand ghat with two pavilions and its terracotta char-chala temple.
  - The mosque: whitewashed (`plasterTexture(seed, { white, fallen })`), with three pointed arches, a dome on its drum, four corner turrets and a walled forecourt open toward its pond.
  - The tea stall.
  - Arches are dark fans under a raised frame (`archOutline`: semicircular, or pointed from two arcs).
- `world/bridge.ts`: the old humped brick arch over the khal, in the bridge's frame.
  - Lime-plastered spandrels and ramp walls, brick voussoirs and barrel, parapets with coping, end pillars and a brick deck.
  - Damp and moss, and ferns. Fallen plaster patches are placed one by one (`fallenPatches`).
  - Also `bridgeTrees` and `BRIDGE_CLEARING`.
- `world/sanko.ts`: the bamboo sanko: three culms on X-trestles with crossbars and lashings, one handrail, and the deck humped over the water.
- `world/railway.ts`: the railway.
  - The line: `railAt`, `RAIL_LENGTH`; `railGround`/`railShare` for the ground.
  - `buildRailway()`: the ballast bed with its sleepers painted on (`trackTexture`), two rails and kilometre posts.
  - `Train`: Bangladesh Railway's intercity, after the user's train in their history project. It has a cab car and six coaches lofted from one section, in green with red and white bands, windows lit at night and lamps on the nose. Each car follows the line.
  - A run comes every `EVERY` s (300), west and east in turn. `place(t, s, forward)` puts the nose where a shot wants it.
- `world/stones.ts`: `buildStones()`.
  - Mossy stones along the banks and at the water's edge. A stone's shape is `rockShape` (a sphere cut by soft planes, UVs laid from above), with `rockTexture` and its normal map, and `wetline`.
  - The khal's rocks (`khalRocks()`): each a boulder on a broader stone.
  - Broken foam where the water meets a stone, laid at the season's level. `nearStone` keeps the grass and the bushes off the stones.
- `world/saltworks.ts`: `SaltWorks`.
  - The salt field's bunds (`bundLines`, the twin of the shader's layout), heaps raked up on them (gone in the rains), the gola, and an old heap under black sheeting.
  - Three men rake the crust (`Raker`: the boatman's body holding a board on a bamboo handle; `rakerStations()`). They are hidden out of the salt season and posed only within 320 m.
  - The sluice where the creek's water is let in.
  - In the rains (`salt` < 0.25) the field is kept as a fish gher, with a fisherman casting from the settling pond's bund (`gherStand()`, `cueGher`) and a watchman's hut on bamboo legs.
  - `saltStage(col, row)` is the shader's stage of a crystallizer bed.

## Living things

- `world/vegetation.ts`: `buildVegetation(huts, bark, clear, featured)`, placed by the design.
  - Tal palms (`tal`) stand in close rows both sides of the village road where it crosses open fields (`openField`).
  - The hills' forest: tall garjan (`garjan`) over rain trees, mango and akashmoni, with cheap crowns over the hills' backs. The horizon's hills get larger, fewer crowns.
  - Each homestead's grove: bamboo and fruit trees two deep at the back, betel-nut and banana along the sides, coconuts and a date palm at the front corners. Groves fill the gaps within a para.
  - Old trees along the banks' tops, rows of rain trees and akashmoni along the brick road, a few lone palms and trees in the fields, the bil's groves and hijol, the far villages' groves, joba by the houses, and golpata (`nipa`) along the salt creek.
  - Kash (`kashTuft`) grows in drifts over the char and in stretches along the khals (`kashStand()` for the film). There are grass tufts along every bank near the boat's way, and knee-high flowering bushes (`flowerBush`) along the khals' banks.
  - `onDryLand` and a spatial-hash `Occupancy` keep plants off houses, ways, landmarks and water. Trees near the boat's way or the water show in the mirror.
  - `treeCrowns()` feeds the leaves and the songbirds.
- `world/crops.ts`: 3D crops in the paddy plots round the camera, in 8 m chunks measured by `groundReach`.
  - The real plants: `ricePatch` (hills of three crossed cards of `riceHillTexture` with nodding panicle ribbons) and `mustardPatch` (racemes of `mustardRacemeTexture`). Both are textured through `uv1`, while `uv` carries each vertex's offset from its plant's foot.
  - The plants reach out to `CROP_REACH.fade`/`edge` (≈30–37 m). Heads are shown near (chunks nearer than `SWITCH`) and fade first (`HEADS_OUT`). A chunk changing level is shown by its twin until it is built (`twin`).
  - Canopy cards alone carry on out to `CROP_REACH.canopy` (100 m). Only these two representations exist.
  - Late chunks grow up out of the ground (`aBorn`, `GROW`). Chunks ahead are built first within `BUILD_MS`, and `warm(view, until)` builds them out of sight.
  - Each patch works out its plot's crop in the vertex shader (`plotFrame`/`plotRank`/`cropShares`). Patches are laid per plot through the CPU twin of the layout (`toPlots`/`fromPlots`), off the roads.
  - Two sets of meshes exist for the film's dissolves (`holdView`/`showHeld`/`releaseView`).
- `world/meadow.ts`: `Meadow(huts, ghats)`: blade grass and wild flowers round the camera, in 8 m chunks.
  - One kind of full clump goes out to 100 m, thinning over the last stretch at each clump's own distance (`BANDS`, `THIN`).
  - Chunks grow in, are built in front first, and `warm` builds ahead.
  - No grass grows in the water or on the mud above it, on roads, on landmarks or round the ghats.
  - Two sets of meshes exist for the dissolves.
- `world/drift.ts`: water hyacinth as position-based dynamics on the still fresh water round the viewer: ponds, the bil, and the slack within `EDGE` of the waterways' banks.
- `world/ponds.ts`: `LILY_PONDS`, with pads, flowers and reed clumps.
- `world/bil.ts`: the shapla bil's lilies (pushed aside by the hull and drawn back by their stems; only those near the boat simulate on the CPU), reeds, lotus and egrets.
- `world/khejur.ts`: `Khejur`, the date palms along `KHEJUR_PATH`.
  - Their trunks zig-zag from years of tapping (`khejurBarkTexture`).
  - In the tapping season (`SEASON`, late autumn to the end of winter) a tree shows the fresh V cut (`khejurCutTexture`), a bamboo spout and a clay pot. The pot is hung from the afternoon to after sunrise (`HUNG`) and fills through the night, with drops near the camera.
  - `hero` is the film's tree; `cue` fills its pot.
- `world/leaves.ts`: `FallingLeaves(crowns)`.
  - Red blossoms fall from the trees in flower. `bloomAt`/`bloomRank` are the CPU twin of the shader's choice of which trees flower.
  - Yellow and brown leaves fall in the dry months. Each falls at its own pace, carried by `windAt`.
  - A storm strips the trees.
- `world/songbirds.ts` (small birds on treetops and open ground, flying tree to tree), `world/fish.ts` (`Fish`: schools under the surface, scattering from the boat, an occasional leap with its rings), `world/life.ts` (flocks, motes and fireflies; `birdGeometry`, `FLAP`).
- `world/fisher.ts`: `Fisher(fish, place)`, a man casting his ঝাঁকি জাল. He stands on a bund (`FisherPlace.ground`, `water`) or, by default, in a dinghy tied to a pole below the khal's mouth (`FISHER_SITE`).
  - He is the boatman's body (`Boatman`) going through a 19 s cycle (`T`).
  - The net is a ring-and-spoke mesh laid each frame (`castNetTexture`), drawn before the water.
  - `cue(t)` sets the cycle. He is posed only within 420 m.
- `world/harvest.ts`: `Harvest(field)`: two reapers (`Reaper`) on the film's field's edge, with sheaves and a stook. They appear only while the season's rice stands ripe.
- `world/hillMist.ts`: `buildHillMist()`: soft camera-facing banks of cloud over the hills' crowns, thickest on winter mornings (`G.uHillCloud`). They fade out at their feet.
- `world/lightning.ts`: `Lightning` strikes when the weather sends them (`weather.ts` `struck`) or a shot asks (`schedule`).
  - Each strike is a channel 650–1700 m off, built by midpoint displacement with branches. A third stay in the cloud.
  - One to four strokes follow a faint stepped leader. They are drawn as camera-facing `DoubleSide` ribbons.
  - `light` lights the cloud (`G.uLightning`) and a little of the land (`weather.flash`). Thunder comes at the speed of sound (soundscape `thunder(metres)`).
- `world/rain.ts`: rain streaks round the camera, kept off the area under the girl's umbrella (`uShelter`).

## The boat and the people

- `world/hull.ts`: `HERO_HULL`, from which `hullHalfBeamAtWater` (GLSL) is generated. `HERO_SINK` (0.08 m) is how much deeper she sits with her load.
- `world/hero.ts`: the boat (planks, frames, cargo, the lantern) and the young majhi (`tarun`, `TARUN_OUTFIT`).
  - His mathal follows the weather: `wantHat` (main.ts `hatWanted`: rain, or a high clear sun outside mid-winter).
  - After `HAT_REACT` s he finishes the stroke and rests the paddle (`BoatBody.rowing` false, `REST_PHASE`). He reaches back for the hat on the stern's deck (`HAT_DOWN`) and puts it on, or takes it off (`hatHand`, `placeHat`). He never changes it again within `HAT_HOLD` s. `settleHat` runs at a new scene or a jump.
  - The boat casts no shadow; a soft spot under the boatman stands in for it.
- `world/paddle.ts`: the one stroke everything reads (`STROKE_SECONDS` 2.2, `CRUISE` 1.2 m/s, `MEAN_THRUST`). The shaft leans out by `LEAN_OUT`, so his top hand works at his chest; the blade is carried back low (`RECOVERY_LIFT`).
- `world/boatman.ts`: `Boatman` on a `Human` (`who`).
  - Loose hair moves in the wind, less under the mathal (`hairFree`).
  - The red ফিতা (`Outfit.band`, `tieBand`).
  - The mathal is fixed on the head (`Outfit.hat`), or is the young majhi's own object (`hat`, `hatOnHead`).
  - Elbows are kept down (`poleOf`). `BRACE`: he crouches as the deck rocks. `LEAN_MAX`: he leans toward a hand out of reach.
- `world/human.ts`, `world/humanData.ts`: `Human`, built from `public/humans/`.
  - Flat bones and dual-quaternion skinning.
  - `flowingHair` (the `HAIR_CODE` shader): most of the hair barely stirs while a few locks lift on their own time (`aLock`), within each vertex's reach (`aFree`), never over the face (`uHairFace`).
  - Skin is a `MeshPhysicalMaterial` with a soft sheen.
- `world/cloth.ts`: `ClothTube` (lungi, skirts) and `ClothRibbon` (gamchha, ওড়না; its width may vary along it). Both are springs round the body, moved by the wind in the body's frame.
- `world/girl.ts`: the girl on the bridge, a `Human` (`meye`, about seventeen).
  - She wears a red lehenga (a `ClothTube` with `lehengaTexture`), a deeper-red blouse shell, a cream ওড়না over her left shoulder (`ClothRibbon`), and bangles.
  - Her red Chinese paper umbrella (`paperUmbrella`, `paperUmbrellaTexture`, rib fold shader `FLAP_CODE`) goes with the rains (`brollyWeather`, `RAIN`). It is absent in the dry seasons, carried closed in the rains' season, and opened as the rain comes.
  - She watches the majhi's head, choreographed from where he is (`WATCH`). She steps to the parapet, turns as his bow goes under the arch, crosses the deck (`CROSS`, `stepFeet`) and watches him go. A jump puts her where she would be.
  - She casts no shadow; a soft foot shadow (`footShadow`) stands in for it.
- `world/splash.ts`: `PaddleSplash`, drops as the blade goes in and comes out.
- `world/boatPhysics.ts`: `BoatBody`.
  - `MASS` is 380 kg (with added mass). Drag is light fore and aft and heavy sideways, like a keel.
  - `currentAt` comes from `waterwayAt`.
  - Paddle force acts only during the pull. `PADDLE_MOMENT` balances the J-stroke, so the bow wags a little each stroke.
  - Each stroke's own power (`strokePower`, 0.65 to `MAX_POWER` 2.2) is harder when the last stroke was slow.
  - Heave, pitch and roll are damped springs to `hullWaves`. Heel stops at `MAX_HEEL`.
  - She steers for `LOOK_AHEAD` m ahead (rig.ts).
- `world/waves.ts`: the shared wave field (`waveHeight`, `waveSlope`, `hullWaves`, and their GLSL twins).
  - Waves are built by the wind over `FETCH` (5 km): `heightFor`, `peakFor`, `SHAPES`, and four direction groups (`QUARTERS`). They grow and die over `BUILD`/`FADE` and are capped at `STEEPEST` (`updateSea`).
  - Still water gets `SHELTERED` (35%).
  - Its open-sea and swell parts are inert (`exposureAt` is 0).
- `world/wake.ts`: the hull's bow and stern swell, the Kelvin wake and the blade's push (GLSL and a CPU twin).

## Water, sky and rendering

- `world/water.ts`: two meshes on one polar grid round the camera (`GRID_SEGMENTS`, `GRID_FAR`, `WATER_BOUNDS`).
  - `mesh` is the sea's and is hidden here; `inland` is every water at its own level.
  - `levelTexture` covers `WORLD` in `LEVEL_CELL` (6 m) cells. Its r channel is the water's level, carried `LEVEL_SPREAD` cells out over ground no lower than `SPREAD_BELOW` under it; its b channel is where water is.
  - The field textures (bed and current, from `waterwayAt`) come in a fine one following the camera and a wide one over the world.
  - Water at another level than the mirror's reflects the hazy sky. Its sea and ship parts are inert.
- `world/sky.ts`: clouds, stars and the moon (`MOON_R`; the phase lit by the sun's real angle).
  - The sun's disc reddens as it sinks.
  - After sunset the clouds toward it are lit crimson from below. environment.ts's `dusk` deepens the low sky.
- `core/globals.ts`: `G`, the uniforms every scene shader shares (mutate `.value`, never replace the object).
  - Layers: `LAYER_WATER = 1` and `LAYER_NO_REFLECT = 2` are drawn by the main camera only; the mirror sees layer 0.
  - `G.uWaterLevel`/`uTideHigh` are held at `WATER_LEVEL + season.water`.
  - `uWaterRise` is the season's rise. `uFlowScale` is the season's runoff on the currents and the water's clarity (clear and green in the dry months, silty in the rains, `underwater()`). `uHillCloud` is the cloud on the hills.
- `render/glsl.ts`: `GLSL_COMMON`. Include it exactly once per shader.
  - Uniforms, hash/noise/fbm, `windGust`.
  - `groundReach`: how far crops and grass are from the camera, with height counting double.
  - The paddy plots: `PLOT_SIZE`, `PLOT_ANGLE`, `plotWarp` (long sines that bend the grid), `plotFrame`, `plotRank` (broad patches worked together, each plot a little out of step), `cropShares`.
  - `waterLevels`/`waterSurface`, `underwater`, `hazeColor`, `applyAtmosphere` (with `EDGE_HAZE`), `CROP_REACH`, `CORRIDOR`, `EDGE_MARGIN`.
- `render/patch.ts`: `patchMaterial` adds the shared look to a three.js material.
  - Atmosphere.
  - Wind (`ATM_WIND`): each plant has its own period, phase and give; the trunk swings on two unrelated swings and the branches on quicker ones; leaves shiver (`ATM_FLUTTER` with `foliage`). The lean levels off at `LEAN_MAX`.
  - Grime, translucency, foliage normals, skin, `seasonal`, `vertex` hooks, `wetline`.
  - The terrain's paddy plots and splat layers (`SPLAT_TILE`, `SPLAT_COLOR`).
  - The salt field's beds, bunds, brine and crust where the terrain's zone is below 0, in `SALT_FIELD`'s frame.
- `render/surfaces.ts`: the photo ground layers (`GROUND_LAYERS`) and the bark.
- `render/pipeline.ts`: the post chain.
  - MSAA scene, bloom, light shafts, and a composite: ACES, a gentle S-curve and a lifted toe (moody, never murky), vignette, grain, and NaN-safe `sanitize`.
  - The letterbox with captions.
  - The held frame for dissolves (`toHeld`).
- `render/reflection.ts`: the planar mirror at half resolution.
- `render/instancing.ts`: instanced meshes split into cells (`chunk`, `across`) so off-screen cells cull.
- `render/cull.ts`: distance culling (`cullBeyond`, `setCullReach`).
- `render/textures.ts`: every canvas-painted texture (plaster, brick, cloth, bark, kash, rice, mustard, umbrella, and so on).
- `render/builder.ts`: `MeshBuilder`, `rgb`, `mixRgb`, `scaleRgb`, `taperedTube`, `card`, `slab`.
- `render/snapshot.ts`: `WorldLook`, the fields that make a shot's world.
  - It covers the shared uniforms except the clock, the camera and the gust fronts, plus the lights, the sky, the water's colours and the boat's uniforms, the rain, the lantern and the shadow's matrix.
  - These fields are captured and put back for the dissolves.

## Environment

- `env/astro.ts`: the sun and moon for a local solar hour at latitude 21.6°. The declination comes from the date; the moon walks the ecliptic, and its tilt off it is ignored.
- `env/clock.ts`: the day speeds through the middles and lingers near each rise and set (`BASE_RATE`, `LINGER`, `WATCH`, `SPEEDS`). `events()` gives the day's events.
- `env/season.ts`: the six Bangla seasons as key rows (`KEYS`, `SEASON_NAMES`).
  - `water`: the rivers' rise, full in the rains and Sharat and lowest in spring.
  - `salt`: the salt season. Also crops, colours, rain, wind and blossom.
- `env/weather.ts`: the season's own weather (`WeatherChoice`: `'auto' | 'clear' | 'drizzle' | 'rain' | 'storm'`; no picker in the UI), wetness and strikes.
- `env/wind.ts`: one wind (`WIND_MS`; `windAt`/`gustAt` on the CPU, `windGust` in GLSL).
- `env/environment.ts`: light and colour by the sun's elevation (`LOOKS`). It also sets the moonlight and the new-moon glow (`moonE`, `glowE`), `dusk`, and `aimShadow()`.

## Camera, film and UI

- `rig/rig.ts`: the boat's journey and the camera.
  - She steers for the point `LOOK_AHEAD` m along her way from where `journeyFrame` puts her. Near the end, in the bil, the mist comes down and she is put back at the start (`END_REACH`). She opens at `JOURNEY.opening`.
  - The `follow` orbit (`VIEWS`, `OPENING_VIEW`, `WATCH_VIEW`) is kept over the water near the banks (`overWater`), above the ground and the water, and under the bridge's arch (`keepClearOfBridge`).
  - `free` is the free camera (`flycam.ts`: `SPEED`, `EDGE`, `CEILING`).
- `rig/director.ts`: the film's engine.
  - Each scene has its own camera move at an even pace. The shot being left goes on moving (`CARRY`) while the next dissolves in over it for `DISSOLVE` s (2.2). The tour starts and ends the same way, from and to the viewer's view (`leaveView`, `leaveScene`).
  - The next shot's places are built a few ms a frame from `WARM_AHEAD` s before its cut (`Stage.warm`), and the rest when it begins (`Stage.prepare`).
  - A `Scene` with `shot` is a further shot of the one before, cut with `SHOT_DISSOLVE` (0.7 s).
  - A scene's `sweep` drives its own clock (`sweepAt`: a monotone cubic through `[u, hours]` keys); `pace` slows the sky's clock.
  - `Director.skip(±1)` steps to the previous or next scene.
- `rig/tour.ts`: `tourScenes(ghats)`, the film: 22 scenes (28 shots) in five movements.
  - The movements: a winter morning; spring's blossom and the nor'wester; the rains (with `লাল ছাতা`, seven shots on the bridge); autumn and the harvest; the evening and the night.
  - Places are found from the village as built: `cropField(crop, day)` (cached, and shared with the reapers), `overField`, `blossomTree()`, `stormHome()`, `talRoad()`/`alongRoad`, `ghats[0]`, `FISHER_SITE`, `gherStand()`, `rakerStations()`, `kashStand()`, `onWay`, `rel`, `facing`, `overOpenWater`.
  - Heights over the water are measured from the season's surface (`surface()`).
  - Scenes cue what moves in them through the `Stage`: the train, the casts, lightning, `bareheaded`, `sap`. They read `girlHead`/`girlYaw`/`sapTree` to frame those.
- `ui/`:
  - `controls.ts` (+ `controls.css`): the dock, the timeline, the views and the help. `#film-nav` shows the previous/next scene while the film plays.
  - `bangla.ts`: Bangla time, tithi and dates.
  - `hud.ts`: the loader, the title, notices and captions.
  - `mapPanel.ts` (+ `map.css`): the map (L). The village is painted from above a few rows a frame. The places (`places()`) can be flown to (`MapActions.fly`) or sailed to (`sail`), and a click on the land goes there.
  - Credits are static in `index.html` (`#sources`).
- `audio/soundscape.ts`: Web Audio only: water, wind, rain, paddle, birds, crickets, thunder.
- `main.ts`: the bootstrap; adaptive resolution and the quality tier (`setQuality`); the film's stage; `worldLook`/`drawLeaving` for dissolves; the jump under a moment of dark (`jumpAt`, `readyAround`); every keyboard shortcut; the `?debug` hooks.

## Legacy tooling

- `src/geo/project.ts`, `src/geo/tide.ts` and `scripts/geo/` are the real-geography pipeline of the earlier branches. Nothing in `src/` imports `src/geo/`.
- `scripts/humans/` uses `scripts/geo/lib/zip.mjs` and `png.mjs`.
- Comments there that cite `GEOGRAPHY_PLAN.md`/`GEO_AUDIT.md` sections refer to the files in git history (see decisions.md, Branch history).

## Where to change what

| What | Where |
| --- | --- |
| The layout: waters, homesteads, landmarks, roads, hills, salt field | `world/plan.ts` (check it top-down after) |
| Waterway widths, depths, currents; the journey's line | `world/waterways.ts` |
| Light, exposure, fog and water colour per time of day | `env/environment.ts` → `LOOKS`; moonlight and new-moon glow in `update()` (`moonE`, `glowE`) |
| Clock speed, lingering near events, when the camera watches | `env/clock.ts` → `BASE_RATE`, `LINGER`, `WATCH`, `SPEEDS` |
| Opening time, idle times, picks' hold and turn times | `main.ts` → `OPENING_BEFORE_SUNSET`, `FILM_IDLE_MS`, `SESSION_MS`, `YEAR_TURN_SECONDS`, `MOON_TURN_SECONDS` |
| Each season's values (water, crops, colours, rain, wind, salt) | `env/season.ts` → `KEYS` |
| How seasons look on plants and fields | `render/patch.ts` (`seasonal`, the paddy part) |
| Rain, storms, wetness | `env/weather.ts`; streaks `world/rain.ts` |
| Wind strength and gusts | `env/wind.ts` → `WIND_MS`, `windGust`/`gustAt` |
| Waves | `world/waves.ts` → `FETCH`, `heightFor`, `peakFor`, `SHAPES`, `QUARTERS`, `STEEPEST`, `BUILD`, `FADE`, `SHELTERED` |
| Water's clarity | `render/glsl.ts` → `underwater()` |
| Boat mass, drag, steering, heel | `world/boatPhysics.ts` → `MASS`, `STEER`, `strokePower`, `MAX_POWER`, `MAX_HEEL` |
| The stroke and the body's drive | `world/paddle.ts` → `STROKE_SECONDS`, `CATCH_Z`, `EXIT_Z`, `BLADE_X`, `LEAN_OUT`, `RECOVERY_LIFT`, `MEAN_THRUST`, `bodyDrive` |
| Where the majhi stands, his grip | `world/hero.ts` → `STANCE`, `CROSS_HOLD`, `LOWER_HOLD` |
| Bracing, leaning | `world/boatman.ts` → `BRACE`, `LEAN_MAX` |
| Cloth looseness and wind | `world/cloth.ts` → `DRAG`, `STIFF`, `LOOSE`, `ZETA` |
| People's bodies, faces, skin tone, hair, clothes | `scripts/humans/config.mjs` (`CHARACTERS`), then rebuild (`CLAUDE.md` Commands) |
| The girl's choreography and umbrella | `world/girl.ts` → `WATCH`, `CROSS`, `RAIN` |
| Camera views, opening view, look-ahead, loop | `rig/rig.ts` → `VIEWS`, `OPENING_VIEW`, `WATCH_VIEW`, `LOOK_AHEAD`, `END_REACH`, `LOOP_FADE` |
| Free camera speed and limits | `rig/flycam.ts` → `SPEED`, `EDGE`, `CEILING`; corridor `render/glsl.ts` → `CORRIDOR` |
| Film scenes: place, season, time, weather, camera, length, caption | `rig/tour.ts` → `tourScenes()` |
| Dissolves and warming ahead | `rig/director.ts` → `DISSOLVE`, `SHOT_DISSOLVE`, `WARM_AHEAD`, `CARRY` |
| Grass density and reach | `world/meadow.ts` → `STEP`, `BANDS`, `THIN`, `grassClump`, `flowerClump` |
| Crops' reach and build budget | `render/glsl.ts` → `CROP_REACH`; `world/crops.ts` → `SWITCH`, `HEADS_OUT`, `BUILD_MS`, `GROW` |
| Hyacinth | `world/drift.ts` → `PLANTS`, `EDGE` |
| Ground photo layers and their scale | `render/surfaces.ts` → `GROUND_LAYERS`; `render/patch.ts` → `SPLAT_TILE`, `SPLAT_COLOR`; `world/terrain.ts` → `LOOK` |
| Distance culling | `main.ts` → `cullBeyond(...)`; `render/cull.ts`; cells `render/instancing.ts` |
| Water level map | `world/water.ts` → `LEVEL_CELL`, `LEVEL_SPREAD`, `SPREAD_BELOW` |
| Train frequency | `world/railway.ts` → `EVERY` |
| Bloom, grade, letterbox | `render/pipeline.ts` |
| Textures | `render/textures.ts` |
| Sound | `audio/soundscape.ts` |
| UI markup and copy | `index.html`, `ui/controls.ts`, `ui/bangla.ts` |
