# Known issues, limits and open work

These entries are current as of commit 7181995 (2026-10-06). Remove an entry when it is fixed, and add new ones here, not in a new file.

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

## Performance

- **The terrain's photo-layer shader is the largest single cost.** It measured ≈7–9 ms in an earlier world, with the water ≈3 ms (1280×720, this machine).
- **Recent headless numbers** (2026-10-06 film run): render-only frames ≈22–30 ms, ≈60 ms with screenshots.
- **The mirror pass** redraws layer 0 (trees, kash) at half resolution. Adaptive resolution saves pixels, not vertices.
- **Hyacinth is never frustum-culled.**
- **Never measured:** phones, laptop integrated GPUs, weak GPUs.

## Accepted simplifications

- **The moon** is drawn about 5× its real size, and its orbit's tilt is ignored: no eclipses, and at new moon it sits on the sun.
- **Moonrise:** the moon often starts behind the bank's trees; an event's time is when the moon's centre is on the horizon.
- **New-moon nights** are dark but readable (`glowE` in `environment.ts`).
- **Rain** streaks are drawn only within 22 m of the camera. They aren't blocked by geometry, except under the girl's umbrella (`uShelter`).
- **Lightning** strikes only far off (650–1700 m): no near strikes, ground flashes or trees hit.
- **What moves casts no shadow:**
  - the hero boat (a soft spot under the majhi stands in);
  - the girl (a soft foot shadow stands in);
  - the train and the working people.
- **Grass and floating plants** are not in the mirror, and grass casts no shadow.
- **Only the hero boat sits deeper in the water** (`HERO_SINK`). Hyacinth meets her hull at its rest waterline.
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
- **The cast net** is a family of shapes (bag ↔ bell), not cloth physics. It ignores wind and obstacles, and the cast runs only on its 19 s cycle near the viewer.
- **The reapers** cut at the field's edge, but the field never shrinks (crops are a per-plot shader).
- **The three salt rakers** share one body (`majhi`) in different clothes, and are posed only within 320 m.
- **The storm wind** is strong (≈12 m/s mean, gusts doubling), so the boat slows to ≈0.7 m/s.
- **Film places are found at load** (`cropField`, ground sampling). This may add about 1 s (not measured). Re-check the shots after any geography change.
- **On phones** the free camera moves only by pinch (no joystick). iPhone Safari has no fullscreen, so the button is hidden there.

## Never verified

- Phones and weak or integrated GPUs; real touch and pinch; Firefox and Safari.
- Sound, live (headless is muted: thunder, rain).
- The paddle splash close up, live, and the date-palm drops (too small to judge in stills).

## Backlog (proposed, not yet asked for)

- **Banks and river life:** roots, mud, reeds and bushes on the banks; ghat details; moored and moving boats; washing and bathing at the ghats, cattle, cooking smoke at dusk, kites overhead; banana rafts in the rains.
- **Vegetation:** distant coconuts read as poles; the far villages' rows; homestead groves' density.
- **A light, atmosphere, colour and performance pass:** far-tree LOD or impostors; a cheaper terrain shader far off.
- **Remove the water shader's inert sea, ship and net parts** (`world/water.ts`'s sea mesh and ship waves, `waves.ts` swell/exposure). Do it carefully, with before/after shots.
- **Depth of field for film close-ups.** It needs a depth texture, because the scene render target is MSAA.
- **Sound:** a koel at dusk, distant boats, more birdsong.
