# নদী — a real-time 3D Bengali village round a small river, at golden hour

Standalone site: Vite 8 + TypeScript 7 + three r186. Almost everything (terrain, trees, grass, houses, boats, most textures, sound) is generated in code. There are two exceptions:

- six CC0 Poly Haven textures (colour + normal, 1K WebP, ≈4.5 MB) in `public/textures/`, for the ground layers and the bark;
- the people, built as game characters are, from MakeHuman's CC0 body, skeleton, skins, eyes, brows, lashes and hair (`public/humans/`, ≈1.9 MB, made by `scripts/humans/`).

There are no audio files and no map data.

## Start here

- **This branch, `cinematic-village`,** is the user's direction of 2026-10-05: the best-looking cinematic Bengali village round a small river journey (river → khal under an old brick arch → shapla bil), designed in `src/world/plan.ts`. Beauty and village logic come before geography; quality and cohesion come before the number of features.
- **Before changing anything, read the docs that bear on the task** (`docs/ai-helper/`):
  - `decisions.md`: the user's direction and standing decisions, and why; what was rejected; the branch history.
  - `architecture.md`: the map of `src/` and where to change what.
  - `verification.md`: how to check work (headless stills, the `?debug` API, the film's shots, pitfalls).
  - `known-issues.md`: open bugs, accepted limits, what was never verified, the backlog.
- **The user judges the work by the film and by the seasons.** Check every visual change across the six seasons, and every film change from the film's real camera path, both in stills and live.
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
- **Visual check:** with the dev server running, run `node scripts/headless/shoot.mjs <outDir> --base http://localhost:5173/ --shots '<json>'`. It saves PNGs and prints draw calls, triangles, frame ms and every page console message. It needs Chrome (set `CHROME_PATH` if Chrome is not at the default Windows path). The shot format and the debug API are in `docs/ai-helper/verification.md`.
- **Quality tier:** `?quality=low|high` holds it. Without it, `main.ts` drops to `low` by itself when even the adaptive resolution's floor runs under 30 fps.
- **People** (`scripts/humans/`, all MakeHuman, CC0):
  1. `node scripts/humans/fetch.mjs` downloads into `scripts/humans/cache/` (git-ignored): the base mesh, the default skeleton and weights, the macro targets, and the modelling targets the characters' `mods` name. From the 280 MB system asset pack it takes only the members `config.mjs` lists (`PACK_FOLDERS`), by range requests (`scripts/geo/lib/zip.mjs`).
  2. `node scripts/humans/build.mjs` builds the characters of `config.mjs` into `public/humans/humans.json` + `humans.bin` (deflate-raw; arrays shared between characters are stored once), and writes `cache/textures.json`. The characters (`CHARACTERS`) are:
     - `majhi`: the older men (salt rakers, reapers, the gher's keeper);
     - `tarun`: the young majhi the film follows;
     - `meye`: the girl on the bridge.

     Each is defined by:
     - macro sliders, and `mods` (face and build from MakeHuman's targets, with weights);
     - height, and skins (`tone`);
     - eyes, brows and lashes;
     - hair: `loose` hair gets a measured wind reach for each vertex (`free`) and a number for each card (`lock`); `tuck` lifts the fringe above the headband;
     - `wear`: `sando`, `lungi` or `blouse`.
  3. `python scripts/humans/textures.py` (Python 3 + Pillow) makes the WebP textures.

  Never hand-edit `public/humans/`.

## Invariants and gotchas (each one cost a bug)

- Never toggle `visible` on a light. Changing the light count recompiles every material (a 60 ms+ hitch at sunset). Set the intensity to 0 instead.
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
- A module that `geography.ts` imports must not import `geography.ts` back, or it would read its constants before they exist. That is why `roads.ts` takes the ground as a parameter of `buildRoads`, the crossings' frames live in `sites.ts`, and the river's levee and char live in `waterways.ts`.
- Cameras and the film follow `boat.course` (smoothed). `boat.heading` wags about a degree with each stroke and would shake them.
- The hero group's rotation is `(rotX, heading, rotZ, 'YXZ')`: rotX positive is bow down, rotZ positive is starboard up. Local hull height is `heave + x·rotZ − z·rotX`.
- Boat and boatman form a loop: `hero.crew` (where his weight is) feeds `rig.update` one frame late, and `hero.update` reads the body to pose him.
- The boatman's hands are placed on the paddle before his arms are solved (`Human.holdBar` uses last frame's elbow), and the arm IK then targets the wrist that leaves. Call `setHand` before `setArm`; if the arm is solved first, the hand floats off the paddle.
- A `Human`'s bones are flat (all children of its `group`, with no rotation in the bind), and its meshes are skinned by dual quaternions (`DQ_BASE` etc. in `human.ts`). So every material on a `Human` goes through `dualQuaternions`, and nothing moves until `commit()`. Its meshes' bounding sphere is carried with the hips in `setTrunk`.
- The IK must use the body's own lengths (`body.dims`). Things laid on a person are bind points carried by a bone (`onChest`, `onHead`, a child of `bone(name)`).
- A fitted garment is a shell over the skin, built in `scripts/humans/build.mjs` (its edge comes from a smooth field and is cut by `alphaTest`). Loose cloth is sized from the `sections` the build measures. `ClothTube.update` lays each ring's depth on once, as given.
- The paddle stroke lives only in `paddle.ts`: change it there and everything stays in step. `MEAN_THRUST` must match the drag at `CRUISE`.
- The stroke's cross-grip must stay at chest height in front of the right shoulder for the young majhi's 1.71 m (the user saw his hand come up to his face). After any change, look at the whole stroke frame by frame (`__river.stroke(phase)` at ten phases, side and front).
- The young majhi's mathal follows the weather by itself (hero.ts `hatWeather`). A scene that wants him bareheaded at its start says so after its world is set (`Stage.bareheaded`). `settleHat` clears the jump check (a scene's own placing of the boat is no jump); otherwise the next frame's jump check settles the hat back.
- Stills cannot show what time does. The girl is put on one side of the deck by where the boat is, the hat by the weather, and the drops and the splash need frames. Judge the bridge's crossing, the hat's change, the umbrella's opening, the sap's drops and the sweeps live (from a film recording).
- The journey is its own line (`journeyAt(s)`, with `s` in metres along it), not a waterway's middle. The boat steers along it, and the film and the stills place her by a share of `JOURNEY.length`. What stands by the water is placed from the waterways (`Waterway.beside`, `bankAt`), never from the journey.
- A waterway's bank must be out of the water within a step of its edge (`wayGround`'s profile from `EDGE_DEPTH`). Ground below the water's level beyond the marked water stood as dark, undrained hollows (the char's beach did, with hyacinth in them).
- Placements (houses, haystacks, trees, kash) must check `nearBackwater` (through `onDryLand` in vegetation), `onRoad` and `onLandmark`. Water shows only where `levelTexture` (water.ts) puts it: a new carved water must answer `inlandWaterAt`/`waterLevelAt` (or be painted through `eachWaterwayPoint`).
- Grass, flowers and crop patches ask `onRoad` for each plant, because the ground lattice is too coarse to see a 1.2 m footpath. The terrain's plots keep off the ways and the banks' strip (`bankStrip`); the meadow keeps off the ghats.
- The paddy plots have a CPU twin of their shader layout (`glsl.ts` `plotWarp`/`plotFrame`/`PLOT_SIZE`/`PLOT_ANGLE` ↔ `crops.ts` `toPlots`/`fromPlots`/`PLOT`): change both together.
  - A plot's crop comes from `plotRank`, in GLSL only (the terrain and the crops' vertex shader both read it).
  - A per-plot random rank turned the fields into a checkerboard, and the old bands of turned grids drew seams across them.
- What a shader decides per tree or per plot that the CPU must also know (which trees flower, which crop a plot holds) has a CPU twin built from `glslHash12`/`glslNoise` (core/noise.ts): `bloomRank` (leaves.ts), `plotCropAt` (crops.ts). Change the shader and its twin together. The salt field's layout has its twin in `saltworks.ts` (`bundLines`, `saltStage`).
- A season's share of 0 must give none. The blossom's ramp starts at the share; it used to leave ≈5% of the trees red all year.
- Floating plants keep to the slack water along the banks (`EDGE` in `drift.ts`), and the bil's lilies keep off the boat's way (`routeGap`).
- Seen from above the water, the haze ends at its surface (`applyAtmosphere` cuts the ray there).
- Past the world's edges the land fades into the haze (`EDGE_HAZE`, from `uLevelMap`). The free camera stays `EDGE` m inside them and below `CEILING`.
- Wave slopes evaluated per pixel must fade by the pixel's footprint (`waveSlopeLod`, with the footprint from `dFdx`/`dFdy`).
- Lines drawn with a fixed colour floor glow against dark ground. Light anything a pixel wide from the key light and the sky, and blend it by the share of the pixel it would really cover.
- A detail painted into a tiling texture repeats with it: the plaster texture's fallen patches stood in rows along the bridge's walls as black marks every 3.4 m (the user saw them). Place one-off marks (fallen plaster, stains) as geometry; every plaster is `plasterTexture(seed, { fallen: false })`.
- Check the winding of every new surface: the water grid's rings and four of the bridge's faces once faced inward and vanished.
  - `taperedTube` in `render/builder.ts` winds its triangles inward (known, not yet fixed project-wide). New single-sided geometry should wind outward; the sanko's bamboo uses a double-sided material.
- Cloth vertex colours carry shading, so cloth materials need `vertexColors: true`. Anything added with them must have a colour attribute (build it with `MeshBuilder`), or it renders black.
- `MeshBuilder.add(geometry, matrix, color)` takes one colour per call and ignores a geometry's own colours. Set colours per vertex yourself where they vary (the date-palm pot came out white).
- Waves that move things must come from `waves.ts` (`waveHeight`/`waveSlope`, `hullWaves` for hulls, and the GLSL twins in shaders), so floating things ride what the eye sees.
- The water mesh is laid round the camera in its vertex shader. Anything that floats on it must use `waves.ts` (and `wake.ts` near the hero) with the same shelter.
- The shot being left is posed every frame by its own `pose` through the ghost stage. Whatever a pose reads must be the left shot's own: its boat, course, sun and moon are kept in `Outgoing` (a night shot posed by the incoming dawn's moon jumped to the boat's other side). A scene that moves the boat in `begin` is caught by `enter` comparing where she was; otherwise the left shot loses her and shows her hole in the water.
- A cut in the film is a dissolve between two moving shots, each drawn every frame in its own world (main.ts `drawLeaving`).
  - Never hold a frame or let a shot come to rest: the user asked for one continuous film, "like a video". Never fly the camera between scenes or recompose the shots: the user rejected that.
  - Anything a shot's look depends on that a scene changes must be tracked in `worldLook` (main.ts), or the shot being left takes on the new one's (a light, the sky, the boat's place). The meadow and the crops keep two sets of meshes for it (`holdView`/`showHeld`/`releaseView`).
  - Through a dissolve each frame draws two shots, so the adaptive resolution leaves those frames out of its average.
- Anything streamed round the camera fades in (a band of distance, or growing from `aBorn`): a chunk that appears at once is the pop-in the user saw. Measure reach with `groundReach`, so it also gives way when the camera is high.
- Vegetation's cost is draw calls (species shapes × slabs × mirror) and alpha-tested overdraw as much as triangles. Before adding a species, shape or density, check `__river.stats('vegetation')` and the frame time.
- Debug-only code stays behind `?debug`. `shot()` freezes the frame loop: call `resume()` before holding keys. A probe's `import('/src/…')` gets its own module instances. Their functions are right (the ground, the water and the waterways can be sampled that way), but `G` there is not the page's.
- All the water is inland: the river, the khals and the bil at `WATER_LEVEL`, the ponds at `POND_LEVEL` (`waterLevelAt`, −∞ on dry ground; `waterSurface(xz)` in a shader). Never compare a height with `uWaterLevel` alone.
- Those levels are means, and the season moves them (`waterRise()`, `G.uWaterRise`).
  - Anything that floats or stands at the water must follow the rise now (`waterLevelAt`, `risenLevel`, or `uWaterRise` in its shader), never a constant `WATER_LEVEL`.
  - Anything baked once (the level map, the terrain's colours, placements) reads `meanWaterLevelAt`.
  - A thing that can be left dry when the water falls must rest on the ground (the moored boats' `aground`).
- Anything the wind moves takes it from `windAt`/`gustAt` (CPU) or `windGust` (GLSL).
- The plants' sway (patch.ts `ATM_WIND`):
  - The lean levels off at `LEAN_MAX`: a storm bows a crown and thrashes it (the old cubic lean slid crowns 10–20 m off their trunks in the nor'wester).
  - A stem keeps its length as it bends, so what is carried over comes down.
  - A big plant answers the gusts late (`uGust.y`, how far the fronts roll in a second: the past at a point is the present downwind).
  - The wood and the leaves of one plant must share `wind` and `windHeight`, or the crown parts from its trunk (the tal's fans and the banana's stem did).
- Things that move must not cast shadows, because the shadow map is not redrawn every frame (the hero boat, the girl, the train).
- Camera-facing quads built in a vertex shader (the rain, the lightning) must be `DoubleSide`.
- Anything that reads `Cover.zone` must allow for its sign (paddy > 0, salt < 0): the meadow uses `1 − |zone|`.
- The water is see-through: every material that can sit below the water must go through `patchMaterial`, or it will show through the water untinted.
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
- External requests: those textures (same origin) and the Noto Serif Bengali Google Font, with system fallbacks.
- The people are realistic but generic: no likeness of any real person.
- The village is designed in `plan.ts`. Change the layout there (and check it top-down) rather than placing things ad hoc in the builders.
- Every visible element gets the same level of finish. Before adding anything, ask whether it belongs in a Bengali village and whether it makes the river journey more beautiful.
