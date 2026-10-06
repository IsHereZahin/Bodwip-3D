# Decisions and the user's direction

These are the user's decisions that still bind the work, and the reasons for them. When a decision changes, replace its entry here rather than adding history below it; superseded directions survive in git.

## Direction (2026-10-05, branch `cinematic-village`)

- **What it is:** the best-looking cinematic Bengali village round a small river journey, in the spirit of valley.mengto.here.now. Moheshkhali and Cox's Bazar are inspiration only. It is one art-directed, cohesive world: every road, bridge, house, ghat, boat and tree is finished and structurally believable. Village logic holds: roads connect, bridges join places, boats use navigable water, houses sit on the ground, crops stay on farmland, and paths lead somewhere.
- **Priorities:**
  - beauty over geographic accuracy;
  - cinematic beauty and village logic over completeness;
  - quality and cohesion over the number of features.
  - The river journey is the emotional centre. Keep and improve what is already good (water, boat, majhi, sky, seasons, crops, bil, bridge and girl).
- **The test for anything added:** "Would this really be here?" and "Does it make the journey more beautiful?" The user's phrase: "Do less, but make what exists much better."
- **The user's choices for this branch:**
  - the foundation: a designed village (`plan.ts`) replacing the GIS bake, with the runtime systems kept;
  - the waterway: a river (≈30 m) → a khal (≈14 m) under the old brick arch → the side khal under the bamboo sanko → a shapla bil;
  - the focal points: a banyan ghat with a tea stall, a small mosque, an old zamindar house with its ghat, and a bamboo sanko over a side khal.
- **Size:** the world is cut to ≈2.15 × 1.65 km, with a ≈230 m corridor either side of the waters. Beyond that is haze and the backdrop's hills; nothing grows there and the free camera can't go there. The user found the open fields beyond empty and unneeded, and wants the project kept light.
- **Added at the user's request:**
  - steep wooded hills right by the water (from their reference photos);
  - a map panel to fly or sail to places;
  - the railway with Bangladesh Railway's intercity, after the train in their own history project;
  - the salt field with its tidal creek;
  - the fisherman's cast net;
  - the harvest;
  - the date-palm sap.

## Look

- **Light:** moody but never murky. Shadows keep their detail (the grade's lifted toe, a brighter daylight sky).
- **Sun and moon:** never dead ahead of the camera or the majhi. They are framed to one side, with the light raking across.
- **Water:** clear and greenish in the dry months, showing the bed and stones; silty in the rains.
- **Plants:** Bengal plants only (kash, hyacinth, shapla, joba, tal, khejur, banyan, golpata), not Japanese.
- **Crops:** real 3D crops, not grass, following the user's photos.
  - Rice grows in hills with nodding panicles and glows when backlit; it turns golden when ripe.
  - Mustard is dense, with yellow racemes.
  - Only two representations are allowed: the plants, then the canopy cards. The middle row cards were removed at the user's request.
- **Grass:** one full clump type out to 100 m, thinning at the very end. No sparse far clumps, which read as a step.
- **Roads:**
  - Tal palms in close rows along the village road across open fields; coconut-lined paths with grass verges; a curving pond-side path (all from reference photos).
  - The paved village road sits slightly raised on its embankment; earth paths lie at ground level.
  - Road–bridge joins have no gaps, floating or steps.
  - There are real footpaths to every ghat and to the mosque.
- **Streaming:** nothing pops in. Stream with fades or grow-in, and build ahead along the known camera path rather than loading everything up front.
- **Trees:** each sways in its own way. Storms bow and thrash them but never stretch them. Leaves fall, and petals in spring.
- **Wildlife:** subtle (birds landing, fish), never like game NPCs.

## Seasons (central to the project)

- Every change of season must change the village the way Bangladesh's six seasons really do. Check visuals across all six (গ্রীষ্ম, বর্ষা, শরৎ, হেমন্ত, শীত, বসন্ত), not just the one in view.
- **Water:** full in the rains and Sharat, low in winter and spring (the user's choice).
- **Seasonal sights:** winter cloud and mist on the hills; spring's red blossom and falling petals; kash in autumn.
- **Activities belong to their season:**
  - salt-making in the dry season, and the field becomes a fish gher in the rains;
  - reaping only while the rice is ripe;
  - date-palm sap only in winter.
  - Nothing is shown just because it is pretty.
  - Salt comes from sea water, so the salt field has its own saline creek, not the fresh river.
- **Weather** is the season's own. The user asked for no weather picker (`B` and the menu were removed).
- **Rain must be felt in the world, not laid over it** (2026-10-06).
  - Drops ring and splash the water, unevenly and never in a repeating pattern.
  - The land wets as the rain goes on, never all at once: the ways, the yards and the hollows first, slopes and high ground less.
  - Wet ground is darker and a little glossy. Puddles stand where water collects.
  - Roofs, decks, wood and leaves look wet.
  - A heavier rain means more of everything: drops, rings, splashes, wetness, wind, mist and sound.
- **Picks:** the world starts at today's date. A picked season or moon holds for one minute (`SESSION_MS`), then eases back to today. The year turns as a time-lapse, and every change is smooth.

## The film (what the user judges the work by)

- **Format:** a ≈5-minute tour (`C`, the dock's button, or after idling). It tells a year in the village as a story in five movements, round the young majhi.
- **Each scene:**
  - in the season where it means most;
  - shot as a cinematographer would (shot size, height, foreground, light direction);
  - as long as its importance warrants (the train's scene: far off → close → passing → rising over the fields).
- **One continuous film "like a video":** dissolves between two moving shots. Never freeze, hold a frame or cut hard. Never fly the camera between scenes or recompose the shots: the user rejected that on 2026-10-05 and asked for the earlier scenes and angles back.
- **Captions:** caption = subject = what is in frame. Find places from the village as it stands, not by guessing.
- **Sky events:** sunrise, sunset and moonrise are seen happening over a few seconds (sweeps). The sunset ends in a deep red sky.
- **Navigation:** previous/next scene buttons and keys while the film plays.
- **"লাল ছাতা":** the girl on the bridge watches the majhi pass, across several shots: wide → her → tracking the boat → her crossing → over her shoulder → the boat gone → her reaction.
- **"বসন্তের রং" follows one petal** (2026-10-06):
  - The shot runs: wide (the tree, the khal, petals already afloat) → in toward the water → one petal letting go and followed as it swings and tumbles down → touching the water with a small ripple → floating.
  - It is one continuous move with a depth of field and a focus pull, and the petal is never cut or jumped.
  - Petals lie thick under trees in flower, in drifts, with no repeated pattern. The film's tree has a full crown with natural, uneven branches to its top.
- **A living river, learned from the koi-pond projects but made Bengali** (2026-10-06): ripples that spread, cross and run back off the banks from whatever touches the water; fish that swim as fish do; frogs at the edges in the rains and turtles basking on the khal's rocks; a hill stream down the wooded hill and a sluice in the levee (the user chose both). Not the Japanese garden: shapla not lotus pads, river and khal fish not koi, the river's stones, a village sluice not a garden bridge. Everything part of the place, nothing a decoration; done in one pass, judged at the end.
- **The mosque's pond, graveyard and banyan** (2026-10-06): the mosque, its clean clear pond (bright fish, a little shapla, short grass on its banks, four or five big trees round it shading its water), a small village graveyard beside the mosque (simple graves, grass, nothing grim) and an old banyan by it, as one familiar village composition, a little irregular, never symmetric.
- **The village planned as one ecosystem, then built** (2026-10-06): where people walk, go down to the pond, go to the mosque, and where the boat goes are decided first, and the assets placed on that plan.
  - **The mosque:** a simple but beautiful rural Bangladeshi mosque, never luxurious: whitewash, green trim, pointed arches, Bengal domes with lotus collars and finials, an open verandah, a low forecourt wall, a modest azan minaret. Its doors and windows glow warm after dark, so its light is seen from outside, never harsh.
  - **The kalima** «لَا إِلٰهَ إِلَّا اللَّهُ مُحَمَّدٌ رَسُولُ اللَّهِ» over the main entrance, in correct Arabic script, cream on a green panel in a thin gold border. Set in the Amiri Google Font (the user chose it); no made-up or decorative lettering.
  - **One axis from the mosque to its pond:** the mosque's door, its steps, the brick walk and the pond's ghat lie on one line (z = 212), so a person walks straight from the road to the steps and the door, and down to the water, with no gaps, floating parts or sudden heights.
  - **The pond's ghat** is clean and usable: no grass on or between its steps (grass may grow beside them). A small lantern on a pillar at its head lights the steps and the bank softly after dark and glints on the water.
  - **The kept pond** has many fish of every size: shoals of little ones, medium schools that sometimes move together, a few visibly big ones deep, in natural colours at different depths. Pebbles and small stones lie on its bed, thickest in the shallows, scattered naturally, never arranged.
  - **The boat goes under the sanko** (the user chose to take her way through the side khal): river → khal under the old bridge → side khal under the bamboo sanko → shapla bil. The sanko is built for it (high, its middle span free of trestles, rungs on its climb), and the film has a shot that shows her passing under it (বাঁশের সাঁকো), with no clipping.
- **"জেলের জাল":** a wide shot that shows his boat clearly, then medium and close shots of the net (2026-10-06). The water answers the net: it strikes with rings and a splash, is stirred as he hauls, and drips under the lifted bag. He hauls with his whole body, from his hands to the boat under his feet.
- **The monsoon is told as it comes** (2026-10-06):
  - The order: the Asharh cloud gathering, then the rain beginning, then a heavy Asharh downpour, with the land wetting all the while. After that the rain eases, and the land is left wet.
  - It may run longer than the other seasons, and the rain must not be one loop throughout.
- **Verify every scene from its real camera path** (see verification.md). Pop-in, clipping, freezes, black artefacts and murky darkness are bugs.

## People

- **General:** realistic but generic, with no likeness of any real person. Built from MakeHuman CC0 data, as game characters are.
- **The young majhi (`tarun`):**
  - about 20, a handsome Bangladeshi young man;
  - warm wheaten skin (neither artificially white nor overly dark);
  - slightly long hair with a few locks in the wind, and a red headband;
  - the mathal on in rain or hard sun and off otherwise, with a visible put-on and take-off.
- **The girl (`meye`):**
  - about 17, beautiful but realistic;
  - the final dress (2026-10-06, after kameez → saree → blue lehenga): a simple red lehenga-style everyday dress, not bridal;
  - a red Chinese paper umbrella, only in the rains.
- **Hair:** a few locks lift at a time, never all together, never over the eyes or face.
- **The paddle:** the majhi rows from the side with a boitha (the stern oar was dropped). His top hand stays at chest height, never at his face. Check the whole cycle frame by frame.
- **Older men** (the `majhi` body) are the salt rakers, the reapers and the gher's keeper.

## Assets and technology

- **Procedural** apart from:
  - six CC0 Poly Haven textures for the ground layers and the bark (the user's choice, the third request);
  - the MakeHuman CC0 people.
  - Ask before adding any other asset. There are no audio files (sound is Web Audio).
- **Nothing copied:** valley.mengto's code carries no licence; koi-pond-garden (MIT) and the other koi-pond projects gave ideas only (Nagomi is PolyForm Noncommercial: never its code). The project has its own render pipeline, with no postprocessing or GSAP libraries.
- **Target devices:** desktop and laptop (decided 2026-10-04). Phones are not a target, though the dock has been kept folding to fit 390 px.

## Working agreements

- Reply in Bangla.
- On `cinematic-village` the user handed over the whole job: typecheck, build and headless screenshots may be run to verify without asking.
- Commit only when the user asks, in as few commits as possible, with one-line messages and no AI attribution. Never push unless asked.
- When several decisions are open, ask one or two at a time, with a recommended option first.
- Follow the documentation rule in `CLAUDE.md`.

## Branch history (superseded directions)

- `main`: the first golden-hour river (2026-10-03). Later sessions added the controls, the photo textures, the boatman and his physics, hyacinth, the seasons, weather and wind, the film and the bridge.
- `geo-foundation` (2026-10-04): the real Moheshkhali–Matarbari at 1:3 from open GIS data.
- `compact-moheshkhali`: a compact tourist Moheshkhali; the MakeHuman people were introduced here.
- `river-journey`: only the Bara Moheshkhali khal and a shapla bil, with the journey, the camera and the film.
- `cinematic-village` is the current direction, cut from `river-journey`.
- **Gone and not to come back unless asked:** the sea, port, power plant, jetties, temple hill, crabs, lift nets, walking, taking the helm, voyages and the GIS mode. (The map came back here by request.)
- **The real-geography plan and data audit:** `git show 7181995:GEOGRAPHY_PLAN.md` and `git show 7181995:GEO_AUDIT.md`. Comments in `scripts/geo/`, `src/geo/` and `world/waves.ts` cite their sections.
- **The session-by-session log** (requests, verification runs, the bug diary) is in `git show 7181995:HANDOFF.md`.

## Techniques taken from the references

- **valley.mengto.here.now:**
  - the post pipeline: scene → planar reflection → light shafts → bloom → composite (ACES, grade, S-curve, vignette, grain) → AA;
  - one shared uniform set, so the whole world changes together;
  - adaptive resolution; shadow maps only when the focus moves; shaders compiled before showing;
  - shader comments written from real observation.
- **koi-pond-garden:**
  - the film as a shot list (`{ caption, T, pos(u), look(u) }`), with a letterbox and captions;
  - a gentle handheld sway;
  - the camera never under the ground or the water;
  - the loop "describe, run, screenshot, measure, fix, repeat";
  - a ripple simulation on the GPU round where the camera looks, drops from whatever touches the water, banks that throw rings back (world/ripples.ts);
  - fish that burst and glide, their bodies bent in the vertex shader (world/fish.ts);
  - the frog's breathing and leap, the turtle's bask-slide-swim-climb (frogs.ts, turtles.ts);
  - water whose froth is carried down it (world/falls.ts).
