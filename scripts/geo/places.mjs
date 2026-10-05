// The landmarks the world is checked against (GEOGRAPHY_PLAN.md §4, GEO_AUDIT.md): where each one really is,
// who says so, and how sure that is. Only those inside the world's small window round the khal and the bil
// (src/geo/project.ts CROP) are kept. The bake writes them to public/geo/places.json with the baked ground
// under each; the debug view pins them, and the checks measure how far the world puts them from here.
//
// confidence: 'high' (mapped or measured, sources agree), 'medium' (one good source), 'low' (estimate),
// 'model' (a place chosen by reasoning where no real one was found: GEOGRAPHY_PLAN.md D3).
// expect: the baked ground it must stand on: 'land', 'water' (sea or inland), 'wet' (tidal, mangrove or
// water) or 'any' (a broad place, or one P6 will rebuild: the port and the plant's raised ground).

export const PLACES = [
  // the villages the khal runs between (Bangla Wikipedia's points)
  { id: 'bara-moheshkhali', expect: 'land', name: 'বড় মহেশখালী', lat: 21.5464, lon: 91.9417, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'chhota-moheshkhali', expect: 'land', name: 'ছোট মহেশখালী', lat: 21.5478, lon: 91.9567, source: 'bn.wikipedia', confidence: 'medium' },
  // where the scene's own features go (no real one found: D3)
  { id: 'arch-bridge', expect: 'land', name: 'পুরোনো খিলান সেতু (মেয়েটিসহ)', lat: 21.5313, lon: 91.9579, source: 'a real ≈25 m crossing of a khal in OSM; the arch itself is the scene\'s', confidence: 'model' },
  { id: 'shapla-bil', expect: 'land', name: 'শাপলা বিল', lat: 21.5415, lon: 91.9383, source: 'at the head of the khal through Bara Moheshkhali, on the low ground between it and the ponds to its west, below the hills\' feet', confidence: 'model' },
];
