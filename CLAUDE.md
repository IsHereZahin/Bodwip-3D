# নদী — a real-time 3D Bengal river at golden hour

Standalone site: Vite 8 + TypeScript 7 + three r186. Almost everything (terrain, trees, grass, huts, boats, most textures, sound) is generated in code. The one exception, chosen by the user in the second session: six CC0 Poly Haven textures (colour + normal, 1K WebP, ≈4.5 MB) in `public/textures/` for the ground layers and the bark. There are no model or audio files.

## Start here

- `HANDOFF.md` is the saved record of the session that built this: the requests, decisions, what exists, verification done, bugs fixed, known issues and the backlog. Read it before changing anything.
- The user asked for replies in Bangla (বাংলা) during this work. Keep replying in Bangla unless they switch.
- `README.md` is the user-facing run guide (in Bangla).

## Where this folder sits

- It lives at `old_version/bangla-river/` inside the `3d-bangladesh-history` repo, whose `.gitignore` excludes `old_version/`. **This folder is not under version control.** No git repo has been created for it yet; ask before creating one.
- Claude Code also loads the parent repo's `CLAUDE.md` (ancestor directories are read). Its phase workflow, `PROGRESS.md`, `public/assets/` rules and `git commit -m "phase N: …"` convention belong to the main app only. They do not apply here. The user's global engineering standards still apply: ask before running builds, tests or screenshots, stay in scope, and never add AI attribution.
- Packages come from the parent repo's `node_modules` (Node resolution walks up). No local install is needed: `npm run …` finds the parent's `node_modules/.bin`. To make the folder self-contained, run `npm install` here.

## Commands

- `npm run dev` serves on http://localhost:5173. `npm run build` writes `dist/` (hashed files in `dist/bundle/`). `npm run typecheck` runs `tsc --noEmit`. `npm run preview` serves `dist/`.
- Visual check (only when asked): with the dev server running, `node scripts/headless/shoot.mjs <outDir> --shots '<json>'`. It saves PNGs and prints draw calls, triangles, frame ms and every page console message. It needs Chrome (set `CHROME_PATH` if Chrome is not at the default Windows path). The shot format and the debug API are documented in `HANDOFF.md`.
- The build warns that the bundle is over 500 kB. That is expected: three.js is most of it (≈643 kB, ≈172 kB gzipped).

## Architecture (`src/`)

- `core/globals.ts`: `G`, the uniforms every scene shader shares (time, pass camera position, sun, key light, glow, fog, mist, night, wind). Materials hold references to these objects, so mutate `.value` and never replace an object. Layers: `LAYER_WATER = 1`, `LAYER_NO_REFLECT = 2`. Both are drawn by the main camera only; the mirror camera sees layer 0.
- `render/glsl.ts`: `GLSL_COMMON` (uniform declarations, hash/noise/fbm, `hazeColor`, `applyAtmosphere`). Include it exactly once per shader.
- `render/patch.ts`: `patchMaterial(material, options)` injects the shared atmosphere into built-in materials, plus optional wind sway, grime, translucency, terrain paddy plots, riverbed caustics, foliage normals, and `splat` (the photo ground layers), through `onBeforeCompile`. It sets `material.defines` and `customProgramCacheKey`; any new option must change that key. Its fog step also calls `underwater()` (in `glsl.ts`): anything below y = 0 fades into `G.uWaterBody` with the length of water it is seen through.
- `render/surfaces.ts`: loads the photo textures (`GROUND_LAYERS` grass, dirt, mud, sand, pebbles as two `DataArrayTexture`s, colour and normal, plus each layer's mean colour; and the bark). A set that fails to load is `null`, and the scene falls back to its painted look.
- `render/pipeline.ts`: `Pipeline` runs, in order: mirror pass (half-res `PlanarReflection`, `uReflPass = 1`, `uCamPos` = mirror camera) → scene (HalfFloat, MSAA ×4) → bright pass → 5-level bloom → radial light shafts → composite (ACES, grade, vignette, grain, chromatic fringe, fades, letterbox) straight to the canvas.
- `render/reflection.ts`: Reflector-style mirror camera for the plane `y = WATER_Y`, with an oblique near plane.
- `render/builder.ts`: `MeshBuilder` (merges procedural parts into one geometry), `rgb()` (sRGB hex → linear triple), `taperedTube`, `card`. `render/instancing.ts`: `instanced()` splits placements into 600 m slabs along z so off-screen slabs are culled. `render/textures.ts`: every texture is painted on a canvas and turned into a `DataTexture`. Rows are flipped so v = 1 is the canvas top, and `bleed` fills transparent texels with the average colour.
- `world/terrain.ts` also exports `groundAt(x, z)` / `Cover`: painted colour, paddy zone and the photo-layer weights at a point. The terrain's `aSplat` attribute and the meadow's grass density both come from it.
- `world/meadow.ts`: dense blade grass, wild flowers and waterline pebbles round the camera, built in 12 m chunks (two levels of detail, a few chunks per frame, from a 1.5 m height lattice) into one `InstancedMesh` per layer. `world/drift.ts`: water hyacinth as position-based dynamics: 720 plants (each its own body, tied to neighbours in mats by tension-only root links that snap when overstretched) and 160 leaves, dragged toward the local current and a little downwind, colliding through a spatial hash, pushed out of the hero hull and by the oar blade, nudged off the banks, bobbing and tilting on the shared waves; recycled round the viewer. `world/ponds.ts`: lily pads and flowers on the village ponds.
- `world/geography.ts` is the single source of truth for land and water: `riverX`, `halfWidth`, `edgeHalfWidth`, `CHARS`, `VILLAGES`/`VILLAGE_CENTERS`, `PONDS`, `landLevel`, `charHeight`, `terrainHeight`, `bankInfo`, `boatLane`, and the world and journey extents. The river flows toward −z, and the boat travels from `JOURNEY_Z0` to `JOURNEY_Z1`.
- `world/`: `terrain.ts` (grid laid out across the river from its centre line, 8 chunks, paddy mask in `aZone`, layer weights in `aSplat`), `water.ts` (premultiplied and see-through: it outputs only reflection × Fresnel, glitter and foam, and the riverbed tints itself through `underwater()`; ripples stretched along the current, foam flecks riding it, Kelvin wake, river-field texture, water discarded inside the hero hull), `sky.ts`, `vegetation.ts`, `village.ts` (`planHuts`, huts, haystacks, ghats, moored boats, `LIFT_NETS`, stake rows), `hull.ts` (hull shapes plus the GLSL twin of the waterline), `hero.ts` (the boat's planking, frames, floorboards, thwarts, posts, painted eyes, cargo, chhoi, the oar that feathers at each end of its sweep, the lantern as a pendulum, a contact-shadow decal under the boatman; `update(dt, t, lamp, body)` places the group from the BoatBody), `boatman.ts` (the boatman, facing +z so his right is −x: real proportions, two-bone IK for legs and arms with feet planted, a balance spring against the deck's tilt, the mathal hat; hands posed on the oar first, then the arms reach the wrists, and the chest leans in if a hold is out of reach; lungi and vest as `ClothTube`s, gamchha as a `ClothRibbon`; returns `crew`, his weight offset, and `stretch` for debugging), `anatomy.ts` (limb and hand geometry: limbs along +y, a hand closed round a bar in the bar's frame, right hand built and mirrored for the left; all wound outward), `cloth.ts` (`ClothTube`: rings placed by the body plus static folds, looser rows as damped springs with wind and an optional limb collider; `ClothRibbon`: a Verlet strip pinned where it lies on him), `boatPhysics.ts` (`BoatBody`: surge/sway/yaw with mass, added mass, drag through the moving water and a PD steering for a look-ahead point on the lane; heave/pitch/roll as damped springs toward the wave plane averaged over hull samples plus the crew's weight and his push on the oar; also `scull()`, `strokePhase()`, `currentAt()`), `waves.ts` (the shared wave field with a GLSL twin), `boats.ts` (river traffic), `life.ts` (birds, motes, fireflies).
- `env/astro.ts`: sun and moon directions for a local solar hour and the moon's age (latitude 23.7°, fixed sun declination 8°, moon on the ecliptic). `env/clock.ts`: `Clock` holds time in days (the fraction is solar time), the speed and pause, the moon's age, and each day's sunrise, sunset, moonrise and moonset (found numerically, cached per day). It slows near every event (`LINGER`) and says when an event may be watched (`WATCH`). A day takes about 16 minutes at 1×.
- `env/environment.ts`: light and colour for an hour and moon age. The `LOOKS` table, keyed on sun elevation, sets every colour, the exposure and the mist (dawn adds river mist). Below −4.5° the key light is the moon (by phase and elevation) blended with a faint sky glow from `SKY_GLOW_DIR`; it follows the moon as soon as the moon is up. `aimShadow` decides when the shadow map is redrawn (not while the key is dark). `skyColorAt` paints the timeline.
- `rig/rig.ts`: the boat's journey with a mist-fade loop (`boat` is a `BoatBody` steered down the lane), plus the camera: `follow` (orbit with drag, wheel, pinch, arrows; idle drift back to the chosen `VIEWS` rest view) or `free` (`rig/flycam.ts`: WASD/QE, clamped above ground and water and inside the world). `rig.watch` is a direction to turn to when idle (a sky event). Keys reach the rig through `press()` from `main.ts`. `rig/director.ts`: the film tour, seven shots with dip-to-black cuts, letterbox and captions.
- `ui/controls.ts` (+ `controls.css`, imported by it): the bottom dock (play, speed, 24-hour timeline with event markers and the moon's hours, camera mode, views, moon phase, sound, fullscreen, hide UI, help `<dialog>`). It reads the `Clock` each frame and writes the DOM only on change. `ui/bangla.ts`: Bangla digits, spoken time ("সন্ধ্যা ৬:১৪"), tithi, phase and event names. `ui/hud.ts`: loader, title, hint, film captions, event notices.
- `audio/soundscape.ts` (Web Audio synthesis), `main.ts` (bootstrap, loader steps, adaptive resolution, every keyboard shortcut in one `keydown`, sky-event watching, the `?debug` hooks).

## Invariants and gotchas (each one cost a bug)

- Never toggle `visible` on a light. Changing the light count recompiles every material (a 60 ms+ hitch at sunset). Set the intensity to 0 instead.
- Shadow maps use `renderer.shadowMap.autoUpdate = false`. Redraw only when `Environment.aimShadow()` returns true; it checks whether the focus moved or the key light turned.
- Post passes sanitize NaN/Inf with comparisons, not `isnan()`. ANGLE/D3D may optimise `isnan()` away. A single bad pixel otherwise smears into black squares through the bloom chain. Birds once produced such a pixel, and the root cause is still unknown (see `HANDOFF.md`).
- Alpha-tested cards lose thin strokes in their mipmaps. Keep a dense core in the texture, as the kash plume does.
- Foliage cards use `foliage: true`, which keeps the vertex normal on back faces, so a crown shades as one soft volume.
- The water discards fragments inside the hero hull using `hullHalfBeamAtWater`, which is generated from `HERO_HULL`. Edit the hull only in `hull.ts`, and the GLSL follows.
- Fog is split between passes. The mirror pass fogs only water → object (the `uReflPass` branch of `applyAtmosphere`), and the water shader fogs camera → water.
- `tsconfig` has `erasableSyntaxOnly`: no constructor parameter properties, enums or namespaces. It also has `noUnusedLocals`/`noUnusedParameters`.
- Watch for aliasing of shared temporary vectors. The boatman's arm IK broke because an output vector was also read as an input.
- Cameras and the film follow `boat.course` (smoothed); `boat.heading` wags about a degree with each stroke and would shake them.
- The hero group's rotation is `(rotX, heading, rotZ, 'YXZ')`: rotX positive is bow down, rotZ positive is starboard up. Local hull height is `heave + x·rotZ − z·rotX`.
- Boat and boatman form a loop: `hero.crew` (where his weight is) feeds `rig.update` one frame late; `hero.update` reads the body to pose him.
- The boatman's hands are placed on the oar before his arms are solved (`placeHand` uses last frame's elbow), and the arm IK then targets the wrist that leaves. Don't solve the arm first: the hand would float off the oar. `hero.ts` passes each hold as a point on the bar plus the bar's direction toward the thumb.
- `taperedTube` in `render/builder.ts` winds its triangles inward (known, not yet fixed project-wide; see `HANDOFF.md`). New single-sided geometry should use outward winding, as `anatomy.ts` does.
- Cloth vertex colours carry shading, so cloth materials need `vertexColors: true`; anything added with them must have a colour attribute (build it with `MeshBuilder`), or it renders black.
- Waves that move things must come from `waves.ts` (`waveHeight`/`waveSlope`, and `waveSlopeGlsl()` in the water shader), so floating things ride what the eye sees.
- Debug-only code stays behind `?debug`.
- The water is see-through: every material that can sit below y = 0 must go through `patchMaterial`, or it will show through the river untinted.
- The ground blend samples only the two strongest layers, with the layer index as a texture coordinate. Arrays indexed in loops (`w[i]`, `cs[i]`) took frames from 16.7 ms to 26–32 ms in headless Chrome (ANGLE/Direct3D).
- The meadow builds only a few chunks a frame; stills call `meadow.update(camera.position, true)` to build them all.
- The orbit camera always looks at the boat, so it cannot look up at a high moon; stills of a high moon need `shot({ free, face })`.
- Sky event times come from `Clock.events()`; compare events by `clock.watching(ev)`, not identity (the cache is rebuilt each day and on a moon change).

## Conventions

- TypeScript strict. Keep modules small and focused, put the reason in comments, and match the surrounding style.
- Keep it procedural apart from the six CC0 textures in `public/textures/`; ask before adding any other asset. External requests: those textures (same origin) and the Noto Serif Bengali Google Font, with system fallbacks.
- UI copy and captions are in Bangla. No realistic faces or likenesses of real people: the boatmen are faceless and stylised.
