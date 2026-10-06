# Known issues, limits and open work

These entries are current as of the review of 2026-10-06, made after commit 7181995. Remove an entry when it is fixed, and add new ones here, not in a new file.

## Open bugs and risks

- **Bird NaN.** A bird once produced a NaN/Inf pixel, which smeared into black squares through bloom. The post passes now sanitize it (`render/pipeline.ts` `sanitize`), but the root cause is unknown.
  - To chase it: turn off the birds' translucency, `FLAP` and `DoubleSide` one at a time, with `sanitize` off.
  - `__river.birds()` launches a flock in front of the boat.
- **`taperedTube` winds its triangles inward.** On single-sided materials, trunks, bamboo and posts show their inside back wall.
  - The fix is simple (reverse the quad order), but it changes many looks and shadows. Ask the user before doing it project-wide.
- **Ground photo layers are projected from above.** They stretch on steep slopes. The riverside hills are steep, and this hasn't been checked close up.
- **The underwater tint assumes a flat surface** (`underwater()`). In big waves, the parts of a hull near the surface can take the wrong tint.
- **Ponds reflect the hazy sky.** They sit at their own level and so don't get the mirror; from above they can read as pale sheets.
- **The water grid is dense under the camera,** which is wasted from high up.
- **A crop chunk's reach shows as a rectangle from high above** (the free camera at ≈40 m over the bil's rim in the rains): the plants stop at a straight edge. From the boat and the film's heights it is not seen.

## Performance

- **The terrain's photo-layer shader is the largest single cost.** It measured ≈7–9 ms in an earlier world, with the water ≈3 ms (1280×720, this machine).
- **Recent headless numbers** (2026-10-06 film run): render-only frames ≈22–30 ms, ≈60 ms with screenshots.
- **The mirror pass** redraws layer 0 (trees, kash) at half resolution. Adaptive resolution saves pixels, not vertices.
- **Hyacinth is never frustum-culled.**
- **A cut's own frame** still costs ≈130–160 ms in headless Chrome on the production build; the frames round it are 20–40 ms.
  - The cost is two shots drawn, and the new grass and crop buffers uploaded.
  - The cut's building is capped at `PREPARE_MS`, and the water's next field is uploaded ahead.
  - One shadow-depth program is still first compiled as the film starts.
  - Not measured on a real GPU.
- **Never measured:** phones, laptop integrated GPUs, weak GPUs.
- **The salt farms' people** are boatman bodies (≈10 draw calls each, with cloth): up to 13 in the salt season. The film's লবণ মাঠ shot draws ≈1050 calls, the most of any shot. They are posed within `POSED` and drawn within `DRAWN` of their farm (saltworks.ts).

## Accepted simplifications

- **The moon** is drawn about 5× its real size, and its orbit's tilt is ignored: no eclipses, and at new moon it sits on the sun.
- **Moonrise:** the moon often starts behind the bank's trees; an event's time is when the moon's centre is on the horizon.
- **New-moon nights** are dark but readable (`glowE` in `environment.ts`).
- **Rain** streaks are drawn only within 22 m of the camera. They aren't blocked by geometry, except under the girl's umbrella (`uShelter`).
- **Where the rain strikes:**
  - Splashes show on the water, the ground, the ghats and the bridge's deck. None show on roofs, boats or leaves: these only look wet, and the leaves are knocked by the drops.
  - Puddles mirror only the hazy sky (there is no real reflection), darkened for the surroundings they would show.
  - Ground under trees and eaves wets like open ground.
  - The terrain's `aPool` sees a hollow only at its vertex spacing (2 m near the camera), so the finer dips come from a noise.
- **Lightning** strikes only far off (650–1700 m): no near strikes, ground flashes or trees hit.
- **What moves casts no shadow:**
  - the hero boat (a soft spot under the majhi stands in);
  - the girl (a soft foot shadow stands in);
  - the train and the working people.
- **Grass and floating plants** are not in the mirror, and grass casts no shadow.
- **Only the hero boat sits deeper in the water** (`HERO_SINK`). Hyacinth meets her hull at its rest waterline.
- **The girl's umbrella out of the rains:** a shower catches her without it while she is in sight. She has it the next time the camera comes back (see architecture.md).
- **Cloth** is springs round the body, not a full simulation: folds are painted, and it moves only a few cm in big jolts.
  - The girl's ওড়না is one row of particles, so it looks a little stiff from the front.
  - Her blouse pokes slightly through at the shoulder.
- **People:**
  - Faces come from MakeHuman sliders, with no expressions (only the eyes move and blink). Up close they still read as game characters.
  - Cloth patterns follow the body's UVs, so the seams show on the back and the inner arms.
  - Rebuilding the textures needs Python + Pillow.
  - A free camera within 1 m of a person can clip the arms at the near plane.
- **Bank grass is placed at the mean water level.** In the rains some of it stands in water. In the dry months the exposed beds keep their underwater colour (wet mud and pebbles), never cracked dry ground.
- **The salt creek's water** has the river's colour. The gher's water is painted on the terrain, so the gher fisherman's net sinks "into the ground".
- **The cast net** is a family of shapes (bag ↔ bell), not cloth physics. It ignores wind and obstacles, and the cast runs only on its 25 s cycle near the viewer.
- **Ripples:**
  - The simulated patch covers ≈15 m where the camera looks; elsewhere only the analytic rings (rain, nets, the boat) show, and a drop outside the patch is lost.
  - Nothing floats on the simulated ripples (a few mm): the plants and petals ride `waves.ts` only.
  - The banks in the patch come from the water's field (4 m texels), so the rings run back off a softened bank.
- **Creatures:**
  - Frogs sit only at the water's edge 9–36 m from the camera (small at that distance), never on the lily pads; their croaking has no throat to go with it.
  - Turtles bask only on the khal's three rocks; their walk off the rock is a slide.
- **The hill stream:** the ground's 2 m lattice smooths its ledges into steep chutes rather than sheer falls; no spray or mist. Its water is a ribbon (not in the level map). Where the stream and the sluice's spill run below the river's surface, they show through it untinted.
- **The water's shadow** takes four taps of the key light's map; beyond the map's reach the water is lit.
- **Petals:**
  - The film's tree stands ≈11 m back from the khal (the banks are kept clear of trees), so its petal is carried ≈7 m out by the scene's held breeze (`windToward`).
  - Only the film's petal ripples the water as it touches. Floating petals hide inside the hero's hull rather than being pushed aside.
  - Lying petals sit on the ground, so tall grass hides many of them.
  - A crown's carpet is laid over ≈0.5 s after it comes within 70 m (unseen: it shows from 38 m).
- **The mosque:**
  - It has no interior: its lit doors and windows are glowing panes, brightest low in their middle, with no depth behind them.
  - The lamps' light (`lampLight`) casts no shadows: what faces a lamp is lit through walls (faintly, its reach is short); what faces away is not. Only three lamps cast light (the hall's spill, the verandah's, the ghat's lantern); the other bulbs only glow.
  - The kalima needs the Amiri web font; offline a system Arabic face stands in (Traditional Arabic, Arabic Typesetting, Geeza Pro, Segoe UI), shaped correctly but plainer.
- **The boat's way** leaves the khal for the side khal: the khal's upper reach, its third rock and its mouth into the bil are no longer on her way (seen from the free camera only).
- **The map's visits:** a place's wide views are found from where it is seen, not by the light: some look into the sun at some hours. The hill by the river is too big to see whole from within the land the village keeps; its two shots are from down the river. A place's shots are designed for its usual look: at night they are dark (the mosque's lamps show), and in the rains some low shots over water ride the higher water. A visit's year is set to the boat's new place at once, so the land's season can differ from the view the viewer left (each keeps its own through the dissolve).
- **The experience:**
  - The loader's backdrop is one still (the bil at sunset) whatever the hour; it gives way to the cinematic dawn.
  - The cinematic morning is worked out the same on every visit (day 266, Sharat, as weighed on 2026-10-07) until the seasons' keys, the flight or the weighing change. Its terms are judgement, written in `planCinematic`; no morning moon passes them on that day, so the moon is a waxing one, down all morning.
  - The cinematic morning's follow view at the opening lies in the south bank's shade for its first minutes; the flight before it is in full sun.
  - Live at night is dark, by the user's choice of real time; the flight's first seconds show the world's edge haze from high.
  - Live's weather is the season's own for today's date, not the weather in Bangladesh now (a weather feed would be a new external request).
  - The mode is not remembered: every visit opens in the cinematic mode.
  - The camera's own views (rig/compose.ts) know the ground, the trees' crowns, the palms, the bamboo, the houses, the grand ghat and the bridge (sightlines.ts), as columns; not the bushes, the bananas, the landmarks' own buildings, the people or the moored boats. A shot's weights are judgement, tuned by eye on stills of the journey; left to itself the camera mostly chooses behind her and a little above (≈26 m out, ≈9.5 m up), looking down the water.
  - The sights' stretches are found once at load from the village as built; which are shown is chosen again as she goes. A sight seen poorly from her way (the mosque, from the khal) gives way to her surroundings.
  - The sanko is thin bamboo: from her way the camera shows it small.
  - The dock's menus use the Popover API (Chrome 114+, Safari 17+, Firefox 125+); the SVG favicon has a PNG fallback.
- **Depth of field** gathers 40 taps a pixel: a fine grain shows in the strongest blur. Rain streaks and other things that write no depth take the blur of what is behind them.
- **The reapers** cut at the field's edge, but the field never shrinks (crops are a per-plot shader).
- **The three salt rakers** share one body (`majhi`) in different clothes, and are posed only within 320 m.
- **The storm wind** is strong (≈12 m/s mean, gusts doubling), so the boat slows to ≈0.7 m/s.
- **Film places are found at load** (`cropField`, ground sampling). This may add about 1 s (not measured). Re-check the shots after any geography change.
- **On phones** the free camera moves only by pinch (no joystick). iPhone Safari has no fullscreen, so the button is hidden there.

## Never verified

- Real phones and weak or integrated GPUs; Firefox and Safari.
  - Touch, pinch and the sound's states were tested in headless Chrome with emulated touch on a phone-sized page.
- Sound by ear (headless only shows the audio context's state).
- The paddle splash close up, live, and the date-palm drops (too small to judge in stills).
- The boat under the sanko was judged in stills and one headless recording: not at full speed on a real GPU, and the paddle's blade against the middle span's trestles not frame by frame (the span leaves ≈1 m beyond the paddle's reach when she is on her line).

## Backlog (proposed, not yet asked for)

- **The salt farms:** only the creek's farm has a sluice and a gola; the others have feeder ditches painted along their embankments. The gher's fish swim through the drowned bunds. A walker's planted foot slides a little as he stops or turns in place.

- **Banks and river life:** roots, mud, reeds and bushes on the banks; ghat details; moored and moving boats; washing and bathing at the ghats, cattle, cooking smoke at dusk, kites overhead; banana rafts in the rains.
- **Vegetation:** distant coconuts read as poles; the far villages' rows; homestead groves' density.
- **A light, atmosphere, colour and performance pass:** far-tree LOD or impostors; a cheaper terrain shader far off.
- **Remove the water shader's inert sea, ship and net parts** (`world/water.ts`'s sea mesh and ship waves, `waves.ts` swell/exposure). Do it carefully, with before/after shots.

- **Sound:** a koel at dusk, distant boats, more birdsong.
