// The landmarks the world is checked against (GEOGRAPHY_PLAN.md §4, GEO_AUDIT.md): where each one really is,
// who says so, and how sure that is. The bake writes them to public/geo/places.json with the baked ground
// under each; the debug view pins them, and the checks measure how far the world puts them from here.
//
// confidence: 'high' (mapped or measured, sources agree), 'medium' (one good source), 'low' (estimate),
// 'model' (a place chosen by reasoning where no real one was found: GEOGRAPHY_PLAN.md D3).
// expect: the baked ground it must stand on: 'land', 'water' (sea or inland), 'wet' (tidal, mangrove or
// water) or 'any' (a broad place, or one P6 will rebuild: the port and the plant's raised ground).

export const PLACES = [
  // Gorakghata and Adinath
  { id: 'gorakghata-jetty-land', expect: 'land', name: 'গোরকঘাটা জেটি (ডাঙার মাথা)', lat: 21.5182, lon: 91.9716, source: 'OSM way 43107027', confidence: 'high' },
  { id: 'gorakghata-jetty-head', expect: 'wet', name: 'গোরকঘাটা জেটি (পানির মাথা)', lat: 21.5172, lon: 91.9786, source: 'OSM way 43107027', confidence: 'high' },
  { id: 'adinath-jetty-land', expect: 'land', name: 'আদিনাথ জেটি (ডাঙার মাথা)', lat: 21.5266, lon: 91.9742, source: 'OSM way 43106847', confidence: 'high' },
  { id: 'adinath-jetty-head', expect: 'wet', name: 'আদিনাথ জেটি (পানির মাথা)', lat: 21.5247, lon: 91.9808, source: 'OSM way 43106847', confidence: 'high' },
  { id: 'adinath-temple', expect: 'land', name: 'আদিনাথ মন্দির', lat: 21.528118, lon: 91.974811, source: 'Wikipedia; OSM building 21.52843, 91.97499', confidence: 'high' },
  { id: 'mainak-top', expect: 'land', name: 'মৈনাক পাহাড়ের চূড়া', lat: 21.52736, lon: 91.97377, source: 'FABDEM 41 m (Copernicus 45 m, SRTM 36 m)', confidence: 'high' },
  { id: 'gorakghata-town', expect: 'land', name: 'গোরকঘাটা (মহেশখালী শহর)', lat: 21.5197, lon: 91.9678, source: 'OSM place=town', confidence: 'high' },
  { id: 'upazila-parishad', expect: 'any', name: 'উপজেলা পরিষদ', lat: 21.5194, lon: 91.9646, source: 'OSM', confidence: 'high' },
  { id: 'upazila-pond', expect: 'water', name: 'উপজেলা পুকুর', lat: 21.5191, lon: 91.9656, source: 'OSM way 884929294', confidence: 'high' },
  { id: 'hills-highest', expect: 'land', name: 'পাহাড়সারির সর্বোচ্চ বিন্দু', lat: 21.5986, lon: 91.9556, source: 'FABDEM 82 m (Copernicus 86 m, SRTM 82 m)', confidence: 'high' },
  // the channel's crossings and landings
  { id: 'kastura-ghat', expect: 'any', name: 'কস্তুরা ঘাট', lat: 21.4462, lon: 91.9736, source: 'OSM node 1801399269', confidence: 'high' },
  { id: 'jetty-6', expect: 'any', name: '৬ নম্বর জেটি', lat: 21.44815, lon: 91.97248, source: 'OSM node 540053558', confidence: 'high' },
  { id: 'badarkhali-bridge', expect: 'water', name: 'বদরখালী–জনতা বাজার সেতু', lat: 21.71615, lon: 91.94665, source: 'OSM way 236712195 (347 m)', confidence: 'high' },
  { id: 'kohelia-port-road-bridge', expect: 'water', name: 'কোহেলিয়ার ওপর বন্দর সড়কের সেতু', lat: 21.70935, lon: 91.9149, source: 'OSM (553 m)', confidence: 'high' },
  // Matarbari
  { id: 'matarbari-plant', expect: 'land', name: 'মাতারবাড়ী বিদ্যুৎকেন্দ্র', lat: 21.701, lon: 91.8821, source: 'OSM way 1098932510', confidence: 'high' },
  { id: 'matarbari-stack', expect: 'land', name: 'চিমনি (২৭৫ m)', lat: 21.70065, lon: 91.88483, source: 'OSM node 14000705496', confidence: 'high' },
  { id: 'matarbari-switchyard', expect: 'land', name: '400 kV switchyard', lat: 21.701, lon: 91.8897, source: 'OSM way 1301552541', confidence: 'medium' },
  { id: 'matarbari-coal-berth', expect: 'wet', name: 'কয়লার জেটি', lat: 21.7, lon: 91.8757, source: 'Sentinel-2 2026-02-26 (ship and unloaders at the east quay)', confidence: 'medium' },
  { id: 'matarbari-port', expect: 'any', name: 'মাতারবাড়ী গভীর সমুদ্রবন্দর', lat: 21.6914, lon: 91.8589, source: 'Wikipedia (21°41′29″ N, 91°51′32″ E)', confidence: 'medium' },
  { id: 'summit-fsru', expect: 'water', name: 'ভাসমান LNG টার্মিনাল', lat: 21.557, lon: 91.816, source: 'Sentinel-2 2026-02-26 (a large ship ≈800 m from GEM\'s estimate)', confidence: 'medium' },
  // Sonadia and the coast
  { id: 'sonadia', expect: 'any', name: 'সোনাদিয়া', lat: 21.496, lon: 91.884, source: 'Wikipedia', confidence: 'medium' },
  { id: 'sonadia-beach', expect: 'any', name: 'সোনাদিয়ার সৈকত', lat: 21.48715, lon: 91.87969, source: 'the baked sand cell nearest the middle of OSM natural=beach (79.9 ha; 57 % of its cells bake as sand)', confidence: 'high' },
  { id: 'nazirartek', expect: 'land', name: 'নাজিরারটেক শুঁটকি', lat: 21.4234, lon: 91.9798, source: 'OSM "Shutki (Dry Fish) Market"', confidence: 'medium' },
  { id: 'wind-farm', expect: 'any', name: 'খুরুশকুল বায়ুবিদ্যুৎকেন্দ্র', lat: 21.508, lon: 92.004, source: 'OSM power=plant', confidence: 'medium' },
  { id: 'coxs-bazar-station', expect: 'land', name: 'কক্সবাজার রেলস্টেশন', lat: 21.4288, lon: 92.015, source: 'OSM', confidence: 'medium' },
  // unions (Bangla Wikipedia's points; OSM differs for some, see GEOGRAPHY_PLAN.md §4)
  { id: 'kutubjom', expect: 'any', name: 'কুতুবজোম', lat: 21.5247, lon: 91.9214, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'bara-moheshkhali', expect: 'land', name: 'বড় মহেশখালী', lat: 21.5464, lon: 91.9417, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'chhota-moheshkhali', expect: 'land', name: 'ছোট মহেশখালী', lat: 21.5478, lon: 91.9567, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'hoanak', expect: 'any', name: 'হোয়ানক', lat: 21.6043, lon: 91.8921, source: 'OSM place=village', confidence: 'medium' },
  { id: 'shaplapur', expect: 'land', name: 'শাপলাপুর', lat: 21.6048, lon: 91.9561, source: 'OSM place=village', confidence: 'medium' },
  { id: 'kalarmarchhara', expect: 'land', name: 'কালারমারছড়া', lat: 21.6725, lon: 91.9297, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'matarbari', expect: 'land', name: 'মাতারবাড়ী', lat: 21.729, lon: 91.8896, source: 'OSM place=village', confidence: 'medium' },
  { id: 'dhalghata', expect: 'any', name: 'ধলঘাটা', lat: 21.6725, lon: 91.8717, source: 'bn.wikipedia', confidence: 'medium' },
  // where the scene's own features go (no real one found: D3)
  { id: 'arch-bridge', expect: 'land', name: 'পুরোনো খিলান সেতু (মেয়েটিসহ)', lat: 21.5313, lon: 91.9579, source: 'a real ≈25 m crossing of a khal in OSM; the arch itself is the scene\'s', confidence: 'model' },
  { id: 'shapla-bil', expect: 'land', name: 'শাপলা বিল', lat: 21.615, lon: 91.925, source: 'low ground at the hills\' west foot, fed by the "Jiri" hill streams', confidence: 'model' },
];
