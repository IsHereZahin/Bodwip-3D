# নদী — a real-time 3D Bengali village round a small river, through the six seasons

Standalone site: Vite 8 + TypeScript 7 + three r186. Almost everything (terrain, trees, grass, houses, boats, most textures, sound) is generated in code. There are two exceptions:

- six CC0 Poly Haven textures (colour + normal, 1K WebP, ≈4.5 MB) in `public/textures/`, for the ground layers and the bark;
- the people, built as game characters are, from MakeHuman's CC0 body, skeleton, skins, eyes, brows, lashes and hair (`public/humans/`, ≈1.3 MB, made by `scripts/humans/`);
- the brand (`public/brand/`, the user's request): the logo and the icons made from it (`scripts/brand/icons.mjs`), and the loader's backdrop, a still of this world (`loader.webp`).

There are no audio files and no map data.

## Start here

- **This branch, `cinematic-village`,** is the user's direction of 2026-10-05: the best-looking cinematic Bengali village round a small river journey (river → khal under an old brick arch → side khal under a bamboo sanko → shapla bil), designed in `src/world/plan.ts`. Beauty and village logic come before geography; quality and cohesion come before the number of features.
- **Before changing anything, read the docs that bear on the task** (`docs/ai-helper/`):
  - `decisions.md`: the user's direction and standing decisions, and why; what was rejected; the branch history.
  - `architecture.md`: the map of `src/` and where to change what.
  - `verification.md`: how to check work (headless stills, the `?debug` API, the film's shots, pitfalls).
  - `known-issues.md`: open bugs, accepted limits, what was never verified, the backlog.
- **The user judges the work by the film and by the seasons.** Check every visual change across the six seasons, and every film change from the film's real camera path, both in stills and live.
- **The experience opens** in the cinematic mode: the most beautiful morning of the year, chosen by weighing every day (`rig/cinematic.ts`), the sun rising in the drone flight's first seconds, then the clock running on at 1×; the season turns with her journey round the year from that day (`rig/yearJourney.ts`). **Live** (the dock's button, `0`) is Bangladesh's own date, hour, season and moon now (`Clock.live`); off again, the cinematic morning returns; left alone, the camera composes its own views of her surroundings and of the village's sights as she passes them (`rig/compose.ts`, `rig/showcase.ts`, `rig/sightlines.ts`; the user's direction of 2026-10-07).
- **Language:** reply to the user in Bangla (বাংলা) unless they switch. UI copy and captions are in Bangla. `README.md` is the user-facing run guide, in Bangla.

## Working rules

- **The folder:** it is a standalone folder (`D:/learning purposes/bangla-river`) and its own git repository, with a GitHub remote `origin`. The branches are `main`, `geo-foundation`, `compact-moheshkhali`, `river-journey` and `cinematic-village` (history in decisions.md).
- **Commits:** commit only when the user asks, in as few commits as possible, with one-line messages and no AI attribution. Never push unless asked.
- **Global standards apply:** stay in scope, and never add AI attribution.
- **Verification:** on this branch the user handed over the whole job, so typecheck, build and headless screenshots may be run to verify without asking.
- **Packages** are installed here (`node_modules`); `npm run …` uses them.

## Documentation rule

- **Where knowledge goes:** the AI-helper docs are this file plus the four files in `docs/ai-helper/`. Never create a file per update, session or task (no `update-N.md`, session logs or progress notes). Put new knowledge into the document it belongs to:

  | New knowledge | Where it goes |
  | --- | --- |
  | A user decision | `decisions.md` |
  | A module or responsibility | `architecture.md` |
  | A rule that cost a bug | Invariants below |
  | A limit or open item | `known-issues.md` |
  | A way to test | `verification.md` |

- **Keep docs current, not historical.** Replace what is outdated, remove what is fixed or superseded, and keep each entry short. Record what holds now and why, not what was done when; git keeps the history. Don't write verification-run logs or bug diaries.
- **The code is the source of truth.** When a doc disagrees with the code, fix the doc.
- **A new file is allowed only** when the information has its own long-term purpose, would bend an existing document out of shape, and will be useful to future agents again and again.

## Commands

- **Dev server:** `npm run dev` serves on <http://localhost:5173>. It listens on `localhost` only, so pass `--base http://localhost:5173/` to the headless scripts, whose default is 127.0.0.1.
- **Build and check:** `npm run build` writes `dist/` (hashed files in `dist/bundle/`). `npm run typecheck` runs `tsc --noEmit`. `npm run preview` serves `dist/`.
- **The build warns that a chunk is over 500 kB.** That is expected: three.js is a large share of it.
- **Brand:** `node scripts/brand/icons.mjs` remakes the PNG icons from `public/brand/logo.svg` and `favicon.svg`. The loader's backdrop is a still of this world (how to shoot it: verification.md).
- **Visual check:** with the dev server running, run `node scripts/headless/shoot.mjs <outDir> --base http://localhost:5173/ --shots '<json>'`. It saves PNGs and prints draw calls, triangles, frame ms and every page console message. It needs Chrome (set `CHROME_PATH` if Chrome is not at the default Windows path). The shot format and the debug API are in `docs/ai-helper/verification.md`.
- **Quality tier:** `?quality=low|high` holds it. Without it, `main.ts` chooses at load: the opening's first view is drawn a few times behind the loader and its GPU cost measured (`gpuCost`, `GPU_AIM`), which sets the starting size and tier; then the adaptive resolution (`ADAPT`) follows the frame rate, and the lower tier (no multisampling) comes in if the picture is slow at three quarters of its size or the frames wait on the CPU. Stills (`shot()`) are always drawn at full size in the high tier (or the tier asked for).
- **People** (`scripts/humans/`, all MakeHuman, CC0):
  1. `node scripts/humans/fetch.mjs` downloads into `scripts/humans/cache/` (git-ignored): the base mesh, the default skeleton and weights, the macro targets, and the modelling targets the characters' `mods` name. From the 280 MB system asset pack it takes only the members `config.mjs` lists (`PACK_FOLDERS`), by range requests (`scripts/geo/lib/zip.mjs`).
  2. `node scripts/humans/build.mjs` builds the characters of `config.mjs` into `public/humans/humans.json` + `humans.bin` (deflate-raw; arrays shared between characters are stored once), and writes `cache/textures.json`. The characters (`CHARACTERS`) are:
     - `majhi`: the older men (salt rakers, reapers, the gher's keeper);
     - `tarun`: the young majhi the film follows.

     Each is defined by:
     - macro sliders, and `mods` (face and build from MakeHuman's targets, with weights);
     - height, and skins (`tone`);
     - eyes, brows and lashes;
     - hair: `loose` hair gets a measured wind reach for each vertex (`free`) and a number for each card (`lock`); `tuck` lifts the fringe above the headband;
     - `wear`: `sando` or `lungi`.
  3. `python scripts/humans/textures.py` (Python 3 + Pillow) makes the WebP textures.

  Never hand-edit `public/humans/`.

## Invariants and gotchas (each one cost a bug)

- `Rig.settle()` (for stills) holds the camera idle at −1e9 so nothing moves it. Anything else that calls it must set `idle` itself: `beginOpening` did not, and after the opening the composer never took the camera until the viewer touched something.
- The camera's springs (compose.ts `Spring`) hold their acceleration as well as their speed: a critically damped spring set a long way off starts with a jolt (≈10 m/s² as the camera set off for a sight). A blend that hands one moving camera to another eases by a smootherstep, not a smoothstep (the opening's hand-over jolted at 35 m/s²).

- The clock's speeds are multiples of the wall's (`SPEEDS`, 1 = real time); the film's scenes run at `LAPSE`, the old 1× they were shot at. Outside the film the clock is advanced with `own` (`advance(dt, true)`): each sky event passes in `EVENT_SECONDS` whatever the pace (the user's rule); the film keeps its `LINGER`. Anything the viewer or a still does to the hour (a jump, a seek, the pace, a pause) goes through `takeClock` (main.ts): it turns `clock.live` off and ends the cinematic sunrise, or the next frame puts the hour back to Bangladesh's or the sunrise's. A film scene turns `clock.live` off itself, and the film's `save` finishes a sunrise first.
- The season is the mode's own (main.ts `onJourney`, `followYear`): the journey's in the cinematic mode, the clock's day (today's) in Live, unless a season is picked (`seasonHeld`), the film plays or a still holds it. A still with no `day` takes the journey's day where it puts the boat. A jump of the boat's place eases the year over (`yearTurn` toward the journey's day).
- A change of mode sets its whole world at once under a moment of dark (`DIP`, `setMode`): eased across in the open, the hour would sweep the sun backwards or through a whole night.
- The opening flight and the sights pose the camera over the follow camera's pose, blending with it (`orbit()` first), never in its place: so the hand back has no seam. Input ends the flight through the rig's own blend.
- The opening flight (rig/opening.ts) keeps these, each of which made it stick, shake or whip:
  - Its least height is a floor laid out for the whole flight as it sets off and eased in time (`openingFloor`), met by a soft max. A clamp that switched on a threshold (`terrain + (h > 20 ? 22 : 1.6)`) made the drone catch on the bank's trees and jump clear.
  - It is laid in the way's frame by `wayAt`, the heading taken across ±`TANGENT` m. The journey's own heading turns in steps every 2 m, and 60 m out each step jolted the camera sideways (≈300 m/s² for a frame).
  - Its keys are unevenly spaced in time, so their slopes are per second (`curve`). A uniform Catmull-Rom made the pace jump at every key (21 → 26 m/s).
  - Round her it goes by its bearing about her middle, where it looks (`roundAt`, `bearingAt`: gathering to an even turn and settling), out over the open water. A path straight over her whipped the picture round at 130°/s; going round a point ahead of her bow while looking at her middle, the look turned quicker than the bearing behind her (25°/s).
  - It ends in the composer's own shot (`handOver` from compose.ts `USUAL`, placed and framed by `poseOf`), and the composer takes the camera there in the frame it ends (`takeFrom` with the third). Ended at the follow camera's pose, the composer held it ≈4 s while it weighed and the user saw the camera stop in front of her. Only the difference between its own end and the composer's stand is taken up over its last seconds (blended toward where it was still going, its last move stopped at 9 m/s²), and its look comes into the composer's framing by its progress round her (`roundShare`), her on the third away from the camera (on the nearer one the look swung back against its turn as it settled).
  - Check any change with `__river.flight()` and a recording from load (verification.md).
- A camera posed anywhere but the follow camera's pose must be taken over in the frame it is let go (`composing`, `showPos`/`showLook`): the next frame's `orbit()` would put it back at the follow pose for a frame.
- A canvas resized after a frame is drawn goes out blank for that frame (the page's background flashes through). The adaptive resolution's new size is taken up just before the next frame is drawn (`resizeDue`, main.ts), never at the end of one.
- An SVG element's CSS `transform` replaces its `transform` attribute: animate an inner group (the loader's boat bobs inside the group that places it).
- The scene never remakes its own matrix (`scene.matrixAutoUpdate = false`, main.ts), and a group that never moves is added through `still()` (its matrices made once, `matrixWorldAutoUpdate` off on the group). A parent that remakes its matrix makes its whole subtree's be remade (three forces it), so a container that never moves but holds moving or hidden things must not either (the salt farms' group: every hidden crew was remade every frame). Something hidden and not posed (a salt crew, the reapers out of season) has `matrixWorldAutoUpdate` follow its visibility.
- `Pipeline.render` brings the world's matrices up to date once, in its first pass (the mirror's); nothing may move between its passes. Moving things between two of its calls (`drawLeaving` moving the boat) is fine: each call updates in its first pass.
- A value kept to be compared with `===` must be kept at the precision it is computed in: the fireflies' places kept in a `Float32Array` never equalled themselves again, and every firefly was laid afresh (its ground and water asked) every frame.
- Never toggle `visible` on a light. Changing the light count recompiles every material (a 60 ms+ hitch at sunset). Set the intensity to 0 instead.
- three's `compile` passes over hidden objects. For the load-time `compileAsync`, main.ts shows everything hidden for a moment (never a light) and hides it again. Otherwise a material first seen mid-film (out of season, out of reach) is compiled in a cut's frame.
- A transparent `DoubleSide` material is drawn in two passes, and each pass is its own program. A thin veil (the cast net) takes `forceSinglePass`. Its second program used to be compiled when the net first came into view.
- `Material.clone()` drops `patchMaterial`'s patch: make each copy through `patchMaterial` (the date palms' rings).
- Shadow maps use `renderer.shadowMap.autoUpdate = false`. Redraw only when `Environment.aimShadow()` returns true; it checks whether the focus moved or the key light turned.
- Post passes sanitize NaN/Inf with comparisons, not `isnan()`. ANGLE/D3D may optimise `isnan()` away. A single bad pixel otherwise smears into black squares through the bloom chain. Birds once produced such a pixel, and the root cause is still unknown (`docs/ai-helper/known-issues.md`).
- The pipeline's held frame (`toHeld`) must not be bound as a texture while it is being drawn into. If it is, WebGL drops the draw ("Feedback loop formed between Framebuffer and active Texture") and the dissolve dies.
- Alpha-tested cards lose thin strokes in their mipmaps. Keep a dense core in the texture, as the kash plume does.
- The kash's plumes are hidden out of season by brightness alone (`seasonal: 'kash'` in `patch.ts`). The plume must stay the only bright part of `kashTexture`, and the test runs before the season's tint.
- Foliage cards use `foliage: true`, which keeps the vertex normal on back faces, so a crown shades as one soft volume.
- The water discards fragments inside the hero hull using `hullHalfBeamAtWater`, which is generated from `HERO_HULL`. Edit the hull only in `hull.ts`, and the GLSL follows.
- Fog is split between passes. The mirror pass fogs only water → object (the `uReflPass` branch of `applyAtmosphere`), and the water shader fogs camera → water.
- `tsconfig` has `erasableSyntaxOnly`: no constructor parameter properties, enums or namespaces. It also has `noUnusedLocals`/`noUnusedParameters`.
- Watch for aliasing of shared temporary vectors. `waterwayAt`, `Waterway.frame` and `journeyFrame` each return their own reused object: copy what you need before calling the same one again.
- A module that `geography.ts` imports must not import `geography.ts` back, or it would read its constants before they exist. That is why `roads.ts` takes the ground as a parameter of `buildRoads`, the crossings' frames live in `sites.ts`, the river's levee and char live in `waterways.ts`, and the small channels' shapes (`channels.ts`) are plain data that geography carves.
- What lies on the ground near the camera where the ground is cut finer than the terrain's 2 m lattice (the hill stream's gully, the sluice's drain) rests on `meshGround` (terrain.ts), not `terrainHeight`. Laid on the true carved bed, the stream sank under the drawn ground in pieces.
- Whatever touches the water near the camera rings it through the ripple patch (`Ripples.drop`, world/ripples.ts), never a decal ring: the old white ring decals looked pasted on at close range.
- An `InstancedMesh` with per-instance colours gets its `instanceColor` in its constructor, before the load-time compile. Made later by `setColorAt`, it recompiles the material the first time one shows (a hitch mid-film).
- Cameras and the film follow `boat.course` (smoothed). `boat.heading` wags about a degree with each stroke and would shake them.
- The hero group's rotation is `(rotX, heading, rotZ, 'YXZ')`: rotX positive is bow down, rotZ positive is starboard up. Local hull height is `heave + x·rotZ − z·rotX`.
- The water's hole for the hero hull is cut where the surface meets her as she heaves, pitches and heels (`uBoatHull`, hull.ts `hullHalfWidth`). Set it wherever her group is placed (main.ts `hullOnWater`, and per shot in `drawLeaving` with the left shot's `water.boat`). A cut fixed at her waterline at rest let the water into her lee side as she heeled.
- Boat and boatman form a loop: `hero.crew` (where his weight is) feeds `rig.update` one frame late, and `hero.update` reads the body to pose him.
- The boatman's hands are placed on the paddle before his arms are solved (`Human.holdBar` uses last frame's elbow), and the arm IK then targets the wrist that leaves. Call `setHand` before `setArm`; if the arm is solved first, the hand floats off the paddle.
- A `Human`'s bones are flat (all children of its `group`, with no rotation in the bind), and its meshes are skinned by dual quaternions (`DQ_BASE` etc. in `human.ts`). So every material on a `Human` goes through `dualQuaternions`, and nothing moves until `commit()`. Its meshes' bounding sphere is carried with the hips in `setTrunk`.
- The IK must use the body's own lengths (`body.dims`). Things laid on a person are bind points carried by a bone (`onChest`, `onHead`, a child of `bone(name)`).
- A fitted garment is a shell over the skin, built in `scripts/humans/build.mjs` (its edge comes from a smooth field and is cut by `alphaTest`). Loose cloth is sized from the `sections` the build measures. `ClothTube.update` lays each ring's depth on once, as given.
- The paddle stroke lives only in `paddle.ts`: change it there and everything stays in step. `MEAN_THRUST` must match the drag at `CRUISE`.
- The hero boat's frame is `HERO_SINK` (8 cm) below the water. Measure a height over the water from there: the paddle's `wet`, the recovery's lift, the blade tip's clearance. Measured from the frame's zero, the blade's tip dragged through the whole recovery. While he rests the paddle (`!rowing` at `REST_PHASE`), it drives nothing and needs no turning against (`boatPhysics.ts`).
- The stroke's cross-grip must stay at chest height in front of the right shoulder for the young majhi's 1.71 m (the user saw his hand come up to his face). After any change, look at the whole stroke frame by frame (`__river.stroke(phase)` at ten phases, side and front).
- The young majhi's mathal follows the weather by itself (hero.ts `hatWeather`). A scene that wants him bareheaded at its start says so after its world is set (`Stage.bareheaded`). `settleHat` clears the jump check (a scene's own placing of the boat is no jump); otherwise the next frame's jump check settles the hat back.
- Stills cannot show what time does: the hat follows the weather, and the drops and the splash need frames. Judge the hat's change, the sap's drops and the sweeps live (from a film recording).
- The journey is its own line (`journeyAt(s)`, with `s` in metres along it), not a waterway's middle. The boat steers along it, and the film and the stills place her by a share of `JOURNEY.length`. What stands by the water is placed from the waterways (`Waterway.beside`, `bankAt`), never from the journey.
- A waterway's bank must be out of the water within a step of its edge (`wayGround`'s profile from `EDGE_DEPTH`). Ground below the water's level beyond the marked water stood as dark, undrained hollows (the char's beach did, with hyacinth in them).
- The bil's lane cuts the ground only where it runs (`bilGround`: `bilLane` > 0). Taken as the bil's level everywhere, it flattened the whole rim to the water and left the fields standing 1.4 m over it in a straight cliff.
- Ghat steps come from `ghatFlight.ts`: every rise the same, every tread clear of all the ground below it toward the water. Laid on the bank's own slope, the steps rose unevenly and the bank's shoulder stood up through them, grass and all. The zamindar's grand ghat is laid out in geography.ts (`grandGhat`), so `onLandmark` keeps the grass, the trees and the stones off it.
- No way crosses a pond, the bil or a waterway but at a crossing, and none runs through a house (the ways scan, verification.md). The south bank's path ran 18 m through a homestead's pond and the sanko's path 41 m through the side khal, and the yard paths struck from the mounds' middles ran through the houses: they leave by the yard's open front.
- Placements (houses, haystacks, trees, kash) must check `nearBackwater` (through `onDryLand` in vegetation), `onRoad` and `onLandmark`. Water shows only where `levelTexture` (water.ts) puts it: a new carved water must answer `inlandWaterAt`/`waterLevelAt` (or be painted through `eachWaterwayPoint`).
- Grass, flowers and crop patches ask `onRoad` for each plant, because the ground lattice is too coarse to see a 1.2 m footpath. A chunk that no way comes near skips those checks (`roadNear`); before that they were most of a crop chunk's cost. The terrain's plots keep off the ways and the banks' strip (`bankStrip`); the meadow keeps off the ghats.
- The paths are laid on the ground as it is drawn (`buildRoads(meshGround)`, main.ts). Laid on `terrainHeight`, they floated over the lattice's hollows and sank under its crowns by a hand's breadth.
- The paddy plots have a CPU twin of their shader layout (`glsl.ts` `plotWarp`/`plotFrame`/`PLOT_SIZE`/`PLOT_ANGLE` ↔ `crops.ts` `toPlots`/`fromPlots`/`PLOT`): change both together.
  - A plot's crop comes from `plotRank`, in GLSL only (the terrain and the crops' vertex shader both read it).
  - A per-plot random rank turned the fields into a checkerboard, and the old bands of turned grids drew seams across them.
- What a shader decides per tree or per plot that the CPU must also know (which trees flower, which crop a plot holds) has a CPU twin built from `glslHash12`/`glslNoise` (core/noise.ts): `bloomRank` (leaves.ts), `plotCropAt` (crops.ts). Change the shader and its twin together. The salt farms' layout has its twin in `saltworks.ts` (`bundLines`, `saltStage` with the farm's `seed`); patch.ts paints each farm in its own unrolled branch (no array indexed in a loop).
- GLSL_COMMON's `rainDrop` is the one place that decides where and when the drops strike: the water's rings, the puddles' rings and the crowns all read it. Change it, or `RAIN_CELL`, there only (`world/rain.ts` builds its crowns' cells from the same sizes).
- A season's share of 0 must give none. The blossom's ramp starts at the share; it used to leave ≈5% of the trees red all year.
- Floating plants keep to the slack water along the banks (`EDGE` in `drift.ts`), and the bil's lilies keep off the boat's way (`routeGap`).
  - A floater with no water to go to waits as NaN. Keep waiting ones out of any spatial hash or neighbour loop: they all hashed to one cell, `collide` went quadratic, and the cut into the kash took ≈1 s. They look for water again on staggered frames (`RETRY`), never all in the same frame.
- Seen from above the water, the haze ends at its surface (`applyAtmosphere` cuts the ray there).
- Past the world's edges the land fades into the haze (`EDGE_HAZE`, from `uLevelMap`). The free camera stays `EDGE` m inside them and below `CEILING`.
- Wave slopes evaluated per pixel must fade by the pixel's footprint (`waveSlopeLod`, with the footprint from `dFdx`/`dFdy`).
- Lines drawn with a fixed colour floor glow against dark ground. Light anything a pixel wide from the key light and the sky, and blend it by the share of the pixel it would really cover.
- A detail painted into a tiling texture repeats with it: the plaster texture's fallen patches stood in rows along the bridge's walls as black marks every 3.4 m (the user saw them). Place one-off marks (fallen plaster, stains) as geometry; every plaster is `plasterTexture(seed, { fallen: false })`.
- Check the winding of every new surface: the water grid's rings and four of the bridge's faces once faced inward and vanished.
  - `taperedTube` in `render/builder.ts` winds its triangles inward (known, not yet fixed project-wide). New single-sided geometry should wind outward; the sanko's bamboo uses a double-sided material.
  - A hull (`buildHull` in `hull.ts`) winds outward, and its inside is its back face, so every boat's material is two-sided. Wound inward, a dinghy's near side vanished and the hero was lit from within.
- A body's sections are fitted with the tightest ellipse that holds the skin (`enclosing` in `human.ts`). Scaling both axes by the worst point made every waist 5–18% too wide, and the lungi stood out from the hips (the user saw it on every character).
- The cast net is drawn after the water while it is above it (`renderOrder` 1) and before it once sunk (−2). Drawn before the water in flight, the water painted over it and the net vanished between the hands and the splash.
- A scene's `begin(stage, at)` is given the seconds into the scene a still starts at. A cue that runs on its own clock (the casts, the film's petal) starts that far on, or a still shows it at its start.
- The film's petal follows a way worked out when it is cued (`HeroPetal.aim`). The camera reads that way (`PetalWay.at`, `slowAt`), never the mesh, so a still and the film agree and the warm-ahead can guess the shot.
- Cloth vertex colours carry shading, so cloth materials need `vertexColors: true`. Anything added with them must have a colour attribute (build it with `MeshBuilder`), or it renders black.
- `MeshBuilder.add(geometry, matrix, color)` takes one colour per call and ignores a geometry's own colours; pass `'own'` to keep them (a hull's tar and wood). With one colour every moored boat came out flat black; the date-palm pot came out white.
- Waves that move things must come from `waves.ts` (`waveHeight`/`waveSlope`, `hullWaves` for hulls, and the GLSL twins in shaders), so floating things ride what the eye sees.
- The water mesh is laid round the camera in its vertex shader. Anything that floats on it must ride the waves at the share the surface carries there: `surfaceShare(depth, flow)` (waves.ts: `SHELTERED` where it is still, dying out over `SHOAL_DEPTH`, and `INLAND`), the water shader's own factor (and `wake.ts` near the hero). Ridden at the open waves' height, the hero boat heaved and tilted some seven times as much as the water drawn round her and stood out of it in a kalboishakhi.
- A moored boat's line rides with her by its share of the way from its post to her stem (`aMoor.w`), and she swings about her stem (`aPivot`): anything tied to a floating thing is built that way, or its fixed end lifts with the season's water.
- The shot being left is posed every frame by its own `pose` through the ghost stage. Whatever a pose reads must be the left shot's own: its boat, course, sun and moon are kept in `Outgoing` (a night shot posed by the incoming dawn's moon jumped to the boat's other side). A scene that moves the boat in `begin` is caught by `enter` comparing where she was; otherwise the left shot loses her and shows her hole in the water.
- A map place's visit (rig/visits.ts) plays through the director in the viewer's own world. What belongs to the film alone (the clock's pace, the turning year held off, the scene bar, the arrows through its scenes, backToToday) checks `filming()` in main.ts, not `director.active`: with `director.active` the year switched to the clock's day mid-visit and the land's season jumped. A visit's `sync` is the part of its place on the boat's way its shots show from the water (the zamindar's ghat, not its house set back: timed to the house, she was past the ghat when the camera came back).
- Give a scene's boat place as its `journey`, worked out when the scenes are built (`tourScenes`: the kash's from the vegetation, the sunset's from astro's `sunDirectionOn`), never in `begin`. The warm-ahead poses the next shot before its `begin` runs, so a place set there was never built ahead, and its cut stalled (≈0.9 s). A further shot (`shot: true`) may have its own `journey`, for a cut that leaves time out (the old bridge's three shots); a still of a later shot reckons her place from the last shot that put her somewhere. Keep no state across frames in tour.ts's shared scratch vectors.
- The people of a shot being left go on working through its dissolve: whatever is posed only near the camera also takes the leaving shot's camera (`director.leaving`). Before that, the salt rakers stopped mid-stroke.
- A cut in the film is a dissolve between two moving shots, each drawn every frame in its own world (main.ts `drawLeaving`).
  - Never hold a frame or let a shot come to rest: the user asked for one continuous film, "like a video". Never fly the camera between scenes or recompose the shots: the user rejected that.
  - Anything a shot's look depends on that a scene changes must be tracked in `worldLook` (main.ts), or the shot being left takes on the new one's (a light, the sky, the boat's place). The meadow and the crops keep two sets of meshes for it (`holdView`/`showHeld`/`releaseView`).
  - Through a dissolve each frame draws two shots, so the adaptive resolution leaves those frames out of its average.
  - `WorldLook.track` throws on a field it cannot keep: a mistyped key would otherwise drop silently out of what the left shot keeps.
- Anything streamed round the camera fades in (a band of distance, or growing from `aBorn`): a chunk that appears at once is the pop-in the user saw. Measure reach with `groundReach`, so it also gives way when the camera is high.
- Vegetation's cost is draw calls (species shapes × slabs × mirror) and alpha-tested overdraw as much as triangles. Before adding a species, shape or density, check `__river.stats('vegetation')` and the frame time.
- Debug-only code stays behind `?debug`. `shot()` freezes the frame loop: call `resume()` before holding keys. A probe's `import('/src/…')` gets its own module instances. Their functions are right (the ground, the water and the waterways can be sampled that way), but `G` there is not the page's.
- All the water is inland: the river, the khals and the bil at `WATER_LEVEL`, the ponds at `POND_LEVEL` (`waterLevelAt`, −∞ on dry ground; `waterSurface(xz)` in a shader). Never compare a height with `uWaterLevel` alone. Check `Number.isFinite` before putting anything at a water's level: −∞ reaches the GPU as NaN (the fish and the paddle's splash could do this).
- Those levels are means, and the season moves them (`waterRise()`, `G.uWaterRise`).
  - Anything that floats or stands at the water must follow the rise now (`waterLevelAt`, `risenLevel`, or `uWaterRise` in its shader), never a constant `WATER_LEVEL`.
  - Anything baked once (the level map, the terrain's colours, placements) reads `meanWaterLevelAt`.
  - A thing that can be left dry when the water falls must rest on the ground (the moored boats' `aground`).
  - The salt farms' water is real (plan.ts `SALT_FIELDS`): the level map seeds each farm's cells and one round them with its rains' level, and `risenLevel` / GLSL `waterLevels` drain a level above `SALT_BAND` by `(1 − uSaltWet) × SALT_DRAIN`. Keep a farm's `dig − rains` ≥ 0.2, or the rains stand in the hollows past its embankment. `shoreLevel` leaves the farms out: the terrain took their rains' level as standing water all year and painted the pans as a riverbed.
- Anything the wind moves takes it from `windAt`/`gustAt` (CPU) or `windGust` (GLSL).
- The plants' sway (patch.ts `ATM_WIND`):
  - The lean levels off at `LEAN_MAX`: a storm bows a crown and thrashes it (the old cubic lean slid crowns 10–20 m off their trunks in the nor'wester).
  - A stem keeps its length as it bends, so what is carried over comes down.
  - A big plant answers the gusts late (`uGust.y`, how far the fronts roll in a second: the past at a point is the present downwind).
  - The wood and the leaves of one plant must share `wind` and `windHeight`, or the crown parts from its trunk (the tal's fans and the banana's stem did).
- Things that move must not cast shadows, because the shadow map is not redrawn every frame (the hero boat, the people, the train). This includes the moored boats: their vertex shader lifts them onto the water, and the shadow pass would draw them unlifted.
- The water reads the key light's shadow map through getters (`Water.takeShadow`), because a dissolve swaps the light's map for the shot being left. In shadow the sun's glitter goes out; the reflection stays.
- The level map's `a` is the sea's exposure over the sea and, over inland water, how clear it is kept (GLSL `waterClarity`: the mosque's pond). Read it as clarity only where `g` (the sea) is 0.
- Camera-facing quads built in a vertex shader (the rain, the lightning) must be `DoubleSide`.
- Anything that reads `Cover.zone` must allow for its sign (paddy > 0, salt < 0): the meadow uses `1 − |zone|`.
- The water is see-through: every material that can sit below the water must go through `patchMaterial`, or it will show through the water untinted.
- `patchMaterial` needs a lit built-in material (its chunks read the normal): a `MeshBasicMaterial` does not compile through it. Make a glow an emissive `MeshStandardMaterial` (the mosque's lit openings take their gradient from an `emissiveMap`).
- The lamps' light is four separate uniform pairs (`uLamp0..3`, `uLampColor0..3`), never an array indexed in a loop. A fifth lamp light needs its own pair in globals.ts, glsl.ts `lampsAt` and water.ts's glints. What glows after dark is set by `lampsGlow` and tracked by `worldLook` (`NIGHT_GLOWS`).
- Whatever spans the boat's way must clear her: the boatman stands ≈2.2 m over the water under his mathal, and the rains raise it up to 0.85 m. The sanko's `crown` and its trestle-free `gap` are sized for that (sites.ts `SANKO`).
- The ground blend samples only the two strongest layers, with the layer index as a texture coordinate. Arrays indexed in loops took frames from 16.7 ms to 26–32 ms in headless Chrome (ANGLE/Direct3D).
- The meadow builds only a few chunks a frame, so stills call `meadow.update(camera.position, true)` to build them all.
- The orbit camera always looks at the boat, so it cannot look up at a high moon. Stills of a high moon need `shot({ free, face })`.
- Sky event times come from `Clock.events()`. Compare events by `clock.watching(ev)`, not by identity.
- Season, weather and moon picks are eased and held for `SESSION_MS`. Read the shown day and moon, not the clock's, for anything drawn.
- The quality tier (`setQuality` in `main.ts`) only scales what is already there: cull distances (`setCullReach`), the mirror's resolution, the shadow map and the grass's reach. Anything new that is costly far off should register with `cullBeyond`.
- Distance culling (`render/cull.ts`) owns `visible` on the meshes registered with `cullBeyond`, and their bounding spheres are taken once, at build. Register only things that stay put.
- `applyAtmosphere` integrates the fog and mist as a difference of the ray's two ends' exponentials. The product form is 0 × ∞ = NaN in fp32 once the eye is a few hundred metres up.

## Conventions

- TypeScript strict. Keep modules small and focused, put the reason in comments, and match the surrounding style.
- Keep it procedural apart from the six CC0 textures in `public/textures/` and the people's MakeHuman (CC0) data in `public/humans/`; ask before adding any other asset.
- External requests: those textures and the brand (same origin), and the Google Fonts Noto Serif Bengali (300, 500, 700: the UI and the logo's word) and Amiri (the mosque's kalima, the user's choice), with system fallbacks.
- The people are realistic but generic: no likeness of any real person.
- The village is designed in `plan.ts`. Change the layout there (and check it top-down) rather than placing things ad hoc in the builders.
- Every visible element gets the same level of finish. Before adding anything, ask whether it belongs in a Bengali village and whether it makes the river journey more beautiful.
