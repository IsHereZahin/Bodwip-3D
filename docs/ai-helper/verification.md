# Verifying changes

On `cinematic-village`, typecheck, build and headless shots may be run without asking. Never claim a result that wasn't actually seen.

## The checks

- `npm run typecheck`, then `npm run build`. The warning that a chunk is over 500 kB is expected.
- **Look at the pictures:** judge by eye, not by the numbers alone.
- **Check across the six seasons** after any visual change.
- **Check film changes from the film's own camera path** (see "Film checks").
- **Read the page's console output** that the script prints; it should be empty.

## Headless stills: `scripts/headless/shoot.mjs`

```bash
npm run dev   # leave it running; it listens on localhost only
node scripts/headless/shoot.mjs <outDir> --base http://localhost:5173/ --shots '[{"name":"golden","journey":0.05,"hour":17.5}]'
```

- **Arguments:**
  - `<outDir>` (default `shots`);
  - `--base` (default `http://127.0.0.1:5173/`, which misses the localhost-only dev server);
  - `--swiftshader` (no GPU, slow);
  - `--shots '<json array>'`.
- **Environment:**
  - `W`/`H`: the viewport (1280×720);
  - `HUD=1`: keep the UI in the frame (otherwise `#load,#brand,#hint,#dock,#toast,#ui-restore` are hidden);
  - `CHROME_PATH`: if Chrome is not at the default Windows path.
- **What it does:** it opens the page with `?debug`, waits for `__river.ready` and 4 s, then for each shot calls `__river.shot(shot)`, waits three frames and saves `<name>.png`. It prints `info()` per shot, then every console message from the page.
- **`cdp.mjs`** (`launchChrome`, `Page`) is the base for live recordings: a script that screenshots every second or so while the film plays.

- **A free still jumps there** (`rig.placeFree` sets the ease done): the opening flight's ease once held every free still at the flight's pose.

### Shot options (`__river.shot`)

| Key | Meaning |
| --- | --- |
| `name` | The file name (the script's own key) |
| `journey` | The boat's place, as a share 0..1 of `JOURNEY.length` |
| `hour` | Local solar hour, 0..24 |
| `moon` | The moon's age in days (14.8 is full) |
| `yaw`, `pitch`, `dist` | The follow camera's orbit |
| `face` | `'sun'` or `'moon'`: the follow camera frames it low; the free camera looks straight at it |
| `free` | A free camera at `[x, y, z, yaw, pitch]` |
| `film` | `[i, u]`: shot `i` of the film at `u` 0..1 |
| `visit` | `[id, i, u]`: a map place's shot `i` at `u` (rig/visits.ts ids: `salt`, `hill`, `kash`, `zamindar`, `ghat`, `bridge`, `mosque`, `graves`, `sanko`, `palms`, `rail`, `bil`); the boat put where its visit puts her |
| `day` | Day of the year (0 = 1 January) |
| `season` | 0–5 (0 গ্রীষ্ম … 5 বসন্ত), at its middle |
| `weather` | `'auto' \| 'clear' \| 'drizzle' \| 'rain' \| 'storm'` |
| `wind` | Hold the wind at this strength (`null`: follow the season) |
| `rain`, `wet` | Hold the rain and how wet the land is (0..1). With `film`, a scene that has its own `rain` keys sets them back on the next frame. A still without `film` lets go of any rain held before it |

`shot()` sets the water level and the weather at once. Rain streaks need the world to run a while first (`trace`).

### The debug API (`?debug` → `window.__river`)

| Call | What it does |
| --- | --- |
| `shot(options)` | Sets the boat, the day and the camera, draws one frame and freezes the loop and the clock |
| `resume()` | Runs the loop and the clock again |
| `trace(seconds, every = 5)` | Runs the world without drawing, in 1/30 s steps. Every `every` s it samples the boat: `x`, `z`, `along`, `depth`, `reach`, `speed` |
| `boatState()` | Position, `heave`, `pitch`, `roll`, `heading`, `course`, `speed`, `crew`, `reach` (shoulder→wrist ÷ arm length; he leans above 0.985), `depth` |
| `flight(every = 0.1, reach = 12, log = 1, until?)` | Flies the opening again from its start (1/30 s steps, without drawing). Every `every` s it measures the nearest triangle of anything drawn within `reach` m (all but the ground, the water and the sky: `what` names it), the height over the ground or the water, the speed, the acceleration, the turn (°/s) and the pitch. Returns the worst of each and a sample every `log` s. With `until` it stops there and holds the frame: a still of the flight |
| `hullWater(seconds = 20)` | Runs the world and measures the hero hull against the water drawn round her: the surface less her waterline down both sides (`gap` min, max, rms; > 0 the water up her side), and the most she heaved, pitched and rolled. In a kalboishakhi (`weather: 'storm'`, `wind` 2.6–3.4) the gap stays within ±0.16 m (her heel), the heave a few cm |
| `stroke(phase)` | Holds the majhi's stroke at `phase` 0..1 (check at ten phases, side and front) |
| `people()` | Where the boatman's and the girl's heads are; the salt workers; the boat's heading; `girlYaw`, `umbrella`, `rainy` |
| `envState()` | The shown day and moon, crop shares, water level, flow, rain, cloud, wind, weather, the session's countdown, the sun's elevation and its angle from the view |
| `info()` | `calls`, `triangles`, `scale`, `ms`, `programs`, `camera`, … |
| `stats(group?)` | Meshes, instances and triangles per top-level group, or within one group |
| `hide(name)`/`show(name)` | Toggles every object with that name. Groups include `terrain`, `vegetation`, `villages`, `landmarks`, `banyan`, `bridge`, `roads`, `meadow`, `crops`, `drift`, `ponds`, `bil`, `stones`, `saltworks`, `railway`, `train`, `girl`, `hero-boat`, `fisher`, `harvest`, `khejur`, `life`, `birds`, `songbirds`, `fish`, `leaves`, `rain`, `lightning`, `hill-mist`, `backdrop`, `sky` |
| `events()` | The day's sky events, `{ kind, hour }` |
| `train(s, forward = true)` | Puts the train's nose `s` m along the line (from its east end) |
| `fisher(at)` | Puts the river fisherman `at` s into his cast (he throws at ≈3.3 s) |
| `bolt(age = 0)` | A lightning strike in view, held `age` s into it (0 is its first stroke at its brightest) |
| `leaves(n = 6)` | Samples the falling leaves |
| `birds(ahead = 40)` | Launches a flock `ahead` m in front of the boat |
| `sapTree()` | The film's date palm: its foot, the cut, the pot's mouth and the way the cut faces |
| `petal()` | The film's tree in flower (its crown, reach and kind), and its petal: where it lets go and comes down, and how long it falls |
| `mats(ahead = 14, count = 3)`/`matsAt(x, z, count)` | Puts hyacinth mats in front of the boat or at a point |

## Film checks

- **Stills:** `shot({ film: [i, u] })` at the start, the middle and u ≈ 0.95 of each shot. At u = 1 the next scene is already dissolving in.
- **Live:** stills can't show what time does. The girl's crossing, the hat's change, the umbrella opening, the sap's drops, the paddle's splash, the sweeps and the dissolves must be judged live, from a recording of the film playing.
- **For each scene ask:** does the frame show what the caption says? Are pop-in, clipping, freezes, black artefacts or murky darkness anywhere?
- **A cut's cost:**
  - Start just before the cut: `shot({ film: [i, 0.3] })`, then `resume()`.
  - Record every frame's interval with `requestAnimationFrame`, alongside `info().scene`.
  - A CPU profile across the cut (CDP `Profiler`) shows what the cut's frame builds: what the warm-ahead didn't reach, or something new.
- **The 33 shots** (`film` index), in order:

| i | Shot | i | Shot |
| --- | --- | --- | --- |
| 0 | শীতের ভোর | 16–19 | লাল ছাতা, shots 4–7 (no caption) |
| 1 | খেজুরের রস | 20 | বর্ষার ঘের |
| 2 | মাঝি | 21 | ডুবো মাঠে আমন |
| 3 | গ্রামের ঘাট | 22 | বাঁশের সাঁকো |
| 4 | গ্রামের পথ | 23 | শাপলা বিল |
| 5 | সরিষার মাঠ | 24 | পুকুরপাড় |
| 6 | লবণ মাঠ | 25 | কাশবন |
| 7 | ট্রেন যাচ্ছে | 26–28 | জেলের জাল: wide, medium, close |
| 8 | বসন্তের রং | 29 | হেমন্তের ধান |
| 9 | কালবৈশাখী | 30 | সূর্যাস্ত |
| 10 | আষাঢ়ের মেঘ | 31 | চাঁদ ওঠা |
| 11 | বর্ষার খাল | 32 | রাতের বিল |
| 12 | আষাঢ়ের ধারা | | |
| 13–15 | লাল ছাতা, shots 1–3 | | |
- **The petal (shot 8, 23 s):** it lets go 6 s in and touches the water ≈9.5 s later (`petal().fall`). Judge its swing, its tumbling and the ripple from a recording; stills at u ≈ 0.26–0.65 show the follow, and 0.69–0.76 the ripple (it shows only where it catches the light). Hide `petals lying` and `petals afloat` to tell the film's petal from the rest.
- **Fallen petals:** a still round a tree in flower at day 75 (`free` at 3 m, looking down), and at day 200 there must be none.
- **Ripples, fish, frogs:** they need frames: `shot(…)`, then `resume()`, wait 2–5 s, then capture. Frogs come out in the rains (day ≈205); `stats('frogs')` counts them. A still settles the frogs and the turtles where they would be (`settle`).
- **The new places** (`free` = x, y, z, yaw, pitch):
  - the mosque, its pond, graveyard and banyan from the pond's east bank: `[72, 4.6, 213, 1.85, -0.1]`; the graveyard `[146, 4.2, 158, 0.6, -0.4]`;
  - the mosque's front on its axis `[122, 4.2, 212, 1.5708, 0.02]`, the kalima `[136, 4.6, 212, 1.5708, 0.05]`, the minaret `[132, 3.5, 190, 0.62, 0.42]`, the walk from over the pond `[112, 3.6, 212, 1.5708, -0.12]`, the ghat from the water `[105, 3.0, 209, 1.33, -0.15]` and close `[112.5, 3.4, 206.5, 0.74, -0.3]`. At night (hour 20.5) the doors and windows glow, the lantern lights the ghat's steps, and its glints lie on the pond;
  - the kept pond's pebbles along its north shore `[100, 3.2, 210, 0, -0.55]` (look away from the sun: looking down into it, its reflection fills the frame);
  - the sanko with the boat under it (`journey` 0.7869 puts her boatman under its walkway): from the bank `[143.6, 3.4, 466.6, 0.606, 0.02]` and from the film's camera `[164, 2.9, 481, -1.91, 0.1]`; check day 230 (the water highest: his mathal must clear the walkway) and day 40;
  - the turtles' first rock (day 20, morning): `[-13.5, 3.4, 122.5, 0, -0.4]`;
  - the hill stream from the river: `[-862, 3.2, 48, 3.14, 0.12]` (day 205 full, day 20 a thread);
  - the sluice from the river: `[-540, 2.8, 141, -0.45, -0.06]` (day 230 and 300 pouring, day 20 shut).
- **The cast net:** record shots 26–28. The net must show in flight, the water ring as it strikes, the haul's pulls move his whole body and the boat, and the bag come up over the gunwale.
- **The sanko (shot 22):** stills keep the boat where the scene starts; record it (`shot({ film: [22, 0] })`, `resume()`, a frame every 1.5 s) to see her come up through its middle span, the boatman pass under the walkway and come out before the cut.
- **The opening and the loader:** load the page without `?debug` hooks firing a still (`scripts`: record from load, a frame every 1–2.5 s): the loader's sun rises, the still gives way to the flight, the mark lifts after ≈9 s, the flight settles behind the boat at 22 s with no jump. Check a phone size (390 × 844) too.
- **The opening flight's path:** after any change to rig/opening.ts, run `__river.flight(0.1, 15, 0.5)`:
  - nothing within 15 m but the hero boat, the drift and the fish under the water (as last measured: no tree within ≈25 m; the boat ≈6 m as she comes past);
  - the acceleration with no spike (≤ ≈9 m/s²), the speed rising and falling smoothly (≤ ≈21 m/s), the turn ≤ ≈26°/s, the pitch ≥ ≈−30° once low;
  - ending at the follow camera's height (3.24 m).

  Then take stills along it in daylight: `shot({ hour: 9.5, weather: 'clear' })`, then `flight(999, 1, 999, t)` for t from 1 to 22 s, each held for a screenshot.
- **The camera left to itself:** `__river.sights()` lists the sights (where, kind, side). Put the boat ≈35 m before one (`shot({ journey })`), `resume()`, `__river.letGo()` (as if the viewer had stopped steering), and record: the camera eases over in ≈6 s, holds with the boat in frame, eases back.
- **The clock in stills:** `shot()` turns `live` off and holds the day; without `day` it takes the journey's day where it puts the boat.
- **The loader's backdrop:** a still of the bil at sunset from this world: `shot({ journey: 0.95, day: 300, hour: 17.15, yaw: 1.7, pitch: 0.04, dist: 34 })` at 1920 × 1080 (`W`/`H`), saved as WebP 1600 × 900 (quality ≈72) to `public/brand/loader.webp`; its tiny inline copy (32 × 18 JPEG, base64) sits in `#load`'s `--ld-blur`.
- **Rain:** the drops and the splashes show only in motion: judge them from a recording. Close up (`shot` with `free` at 1 m over the water), check the rings, the crowns, the puddles and the wet ground. Compare dry and wet with `rain: 0` and `wet` 0 or 1.

## The map and its visits

- **The map:** open it (`L`, a `KeyboardEvent` in a probe) after a still, wait a few seconds for its ground to paint, and screenshot; hover a card (`pointerenter`) for its card on the map; check a phone's width too.
- **Each place's shots:** `shot({ visit: [id, i, u] })` at u 0.15 and 0.85 of each shot; nothing close in front of the lens, the place framed, the caption on the first.
- **A visit live:** after a still, `resume()`, open the map and click a card; screenshot every 2 s and read `boatState()`: the camera comes back (`info().mode` from `film` to `follow`) with the boat still short of the place's `sync` (the zamindar's ghat at x ≈ −452.6), then she passes it.
- **The camera left alone:** `shot({ journey })` 30–45 m short of a sight (`sights()`), `resume()`, `letGo()`, a frame every 2.5 s: the camera turns toward the sight with her in the foreground and comes back, never leaving her.

## Scans of the land

Probes run in the page (`import('/src/…')`, the functions are right though `G` is not the page's), as scratch scripts on cdp.mjs:

- **The ways:** every piece of `roads.ts` `roadLines()`, a point a metre: under a water's mean level (`meanWaterLevelAt`, the crossings left out), in a pond or on its bank (`pondReach`), in a house (village.ts `planHuts`), on a landmark's ground (`onLandmark`), and the drawn ground (terrain.ts `meshGround`) against the way's surface. The zamindar's and the mosque's walks end on their buildings' ground; nothing else should show.
- **The water near a place:** a character map of the ground round it: water (`meanWaterLevelAt` over `terrainHeight`), a pond's bank, a house, a mound, a way, and the ground's height in bands (a sharp step between bands is a cliff: the bil's rim had one).
- **The salt farms:** a still from above (≈230 m over the farms) in the salt season and in the rains, then each farm from its bund; the workers frame by frame (`run` 0.3–0.4 s between stills).

## Pitfalls

- **`shot()` freezes the frame loop.** Call `resume()` before sending `KeyboardEvent`s to drive keys.
- **After a long `trace()`** the idle page may start the film by itself. Send a key at once.
- **Headless frames are slow.** In a live recording a moving boat can outrun the camera.
- **Rebuilding `public/humans/`** while a page is open makes Vite reload it.
- **Git Bash heredocs turn `\\` into `\`.** Write scripts that contain backslashes to a scratch file first.
- **Python output:** Python here prints with cp1252. Set `PYTHONIOENCODING=utf-8` to print Bangla.
- **Finding the cost:** use `stats()` and `hide()`/`show()` A/B with `info().ms`. Vegetation's cost is draw calls and alpha-tested overdraw as much as triangles.
- **Drive input with CDP:** use `Input.dispatchMouseEvent`/`dispatchKeyEvent` for clicks, drags and keys. A synthetic `PointerEvent` throws in the rig's `setPointerCapture`.
- **Touch:** emulate a phone with `Emulation.setDeviceMetricsOverride` (`mobile: true`) and `Emulation.setTouchEmulationEnabled`, then send `Input.dispatchTouchEvent` (two points for a pinch).
- **Sound:** to read the audio context's state, wrap `AudioContext` in a script added before load (`Page.enable`, then `Page.addScriptToEvaluateOnNewDocument`).
- **Measure frame costs on the production build** (`npm run build`, then `npm run preview` on port 4173). Shader logs are checked only in development, so the dev server's first use of a program is slower.
- **Programs compiled after load:** set `window.__THREE_DEVTOOLS__` (an `EventTarget`) before load. The renderer announces itself on it, and then `renderer.info.programs` gives each program's `cacheKey`.
- **Timing in headless:** a frame's step is capped at 0.05 s, so the film runs slower than the wall clock when frames are slow. Wait on `info()` (its `scene`, `dissolve`, `mode`) rather than on fixed delays.

## Sharing a build temporarily

```bash
npm run build && npm run preview          # serves dist/ on port 4173
cloudflared tunnel --url http://127.0.0.1:4173 --http-host-header localhost:4173
```

Vite accepts only a localhost Host header, hence the header flag. Each run gives a new temporary URL. Share only when the user asks.
