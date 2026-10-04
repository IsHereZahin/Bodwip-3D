// The landmarks the world is checked against (GEOGRAPHY_PLAN.md §4, GEO_AUDIT.md): where each one really is,
// who says so, and how sure that is. The bake writes them to public/geo/places.json with the baked ground
// under each; the debug view pins them, and the checks measure how far the world puts them from here.
//
// confidence: 'high' (mapped or measured, sources agree), 'medium' (one good source), 'low' (estimate),
// 'model' (a place chosen by reasoning where no real one was found: GEOGRAPHY_PLAN.md D3).

export const PLACES = [
  // Gorakghata and Adinath
  { id: 'gorakghata-jetty-land', name: 'গোরকঘাটা জেটি (ডাঙার মাথা)', lat: 21.5182, lon: 91.9716, source: 'OSM way 43107027', confidence: 'high' },
  { id: 'gorakghata-jetty-head', name: 'গোরকঘাটা জেটি (পানির মাথা)', lat: 21.5172, lon: 91.9786, source: 'OSM way 43107027', confidence: 'high' },
  { id: 'adinath-jetty-land', name: 'আদিনাথ জেটি (ডাঙার মাথা)', lat: 21.5266, lon: 91.9742, source: 'OSM way 43106847', confidence: 'high' },
  { id: 'adinath-jetty-head', name: 'আদিনাথ জেটি (পানির মাথা)', lat: 21.5247, lon: 91.9808, source: 'OSM way 43106847', confidence: 'high' },
  { id: 'adinath-temple', name: 'আদিনাথ মন্দির', lat: 21.528118, lon: 91.974811, source: 'Wikipedia; OSM building 21.52843, 91.97499', confidence: 'high' },
  { id: 'mainak-top', name: 'মৈনাক পাহাড়ের চূড়া', lat: 21.52736, lon: 91.97377, source: 'FABDEM 41 m (Copernicus 45 m, SRTM 36 m)', confidence: 'high' },
  { id: 'gorakghata-town', name: 'গোরকঘাটা (মহেশখালী শহর)', lat: 21.5197, lon: 91.9678, source: 'OSM place=town', confidence: 'high' },
  { id: 'upazila-parishad', name: 'উপজেলা পরিষদ', lat: 21.5194, lon: 91.9646, source: 'OSM', confidence: 'high' },
  { id: 'upazila-pond', name: 'উপজেলা পুকুর', lat: 21.5191, lon: 91.9656, source: 'OSM way 884929294', confidence: 'high' },
  { id: 'hills-highest', name: 'পাহাড়সারির সর্বোচ্চ বিন্দু', lat: 21.5986, lon: 91.9556, source: 'FABDEM 82 m (Copernicus 86 m, SRTM 82 m)', confidence: 'high' },
  // the channel's crossings and landings
  { id: 'kastura-ghat', name: 'কস্তুরা ঘাট', lat: 21.4462, lon: 91.9736, source: 'OSM node 1801399269', confidence: 'high' },
  { id: 'jetty-6', name: '৬ নম্বর জেটি', lat: 21.44815, lon: 91.97248, source: 'OSM node 540053558', confidence: 'high' },
  { id: 'badarkhali-bridge', name: 'বদরখালী–জনতা বাজার সেতু', lat: 21.71615, lon: 91.94665, source: 'OSM way 236712195 (347 m)', confidence: 'high' },
  { id: 'kohelia-port-road-bridge', name: 'কোহেলিয়ার ওপর বন্দর সড়কের সেতু', lat: 21.70935, lon: 91.9149, source: 'OSM (553 m)', confidence: 'high' },
  // Matarbari
  { id: 'matarbari-plant', name: 'মাতারবাড়ী বিদ্যুৎকেন্দ্র', lat: 21.701, lon: 91.8821, source: 'OSM way 1098932510', confidence: 'high' },
  { id: 'matarbari-stack', name: 'চিমনি (২৭৫ m)', lat: 21.70065, lon: 91.88483, source: 'OSM node 14000705496', confidence: 'high' },
  { id: 'matarbari-switchyard', name: '400 kV switchyard', lat: 21.701, lon: 91.8897, source: 'OSM way 1301552541', confidence: 'medium' },
  { id: 'matarbari-coal-berth', name: 'কয়লার জেটি', lat: 21.7, lon: 91.8757, source: 'Sentinel-2 2026-02-26 (ship and unloaders at the east quay)', confidence: 'medium' },
  { id: 'matarbari-port', name: 'মাতারবাড়ী গভীর সমুদ্রবন্দর', lat: 21.6914, lon: 91.8589, source: 'Wikipedia (21°41′29″ N, 91°51′32″ E)', confidence: 'medium' },
  { id: 'summit-fsru', name: 'ভাসমান LNG টার্মিনাল', lat: 21.557, lon: 91.816, source: 'Sentinel-2 2026-02-26 (a large ship ≈800 m from GEM\'s estimate)', confidence: 'medium' },
  // Sonadia and the coast
  { id: 'sonadia', name: 'সোনাদিয়া', lat: 21.496, lon: 91.884, source: 'Wikipedia', confidence: 'medium' },
  { id: 'sonadia-beach', name: 'সোনাদিয়ার সৈকত', lat: 21.4843, lon: 91.882, source: 'on OSM natural=beach (79.9 ha), the south-west shore, read off Sentinel-2 2026-02-26', confidence: 'high' },
  { id: 'nazirartek', name: 'নাজিরারটেক শুঁটকি', lat: 21.4234, lon: 91.9798, source: 'OSM "Shutki (Dry Fish) Market"', confidence: 'medium' },
  { id: 'wind-farm', name: 'খুরুশকুল বায়ুবিদ্যুৎকেন্দ্র', lat: 21.508, lon: 92.004, source: 'OSM power=plant', confidence: 'medium' },
  { id: 'coxs-bazar-station', name: 'কক্সবাজার রেলস্টেশন', lat: 21.4288, lon: 92.015, source: 'OSM', confidence: 'medium' },
  // unions (Bangla Wikipedia's points; OSM differs for some, see GEOGRAPHY_PLAN.md §4)
  { id: 'kutubjom', name: 'কুতুবজোম', lat: 21.5247, lon: 91.9214, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'bara-moheshkhali', name: 'বড় মহেশখালী', lat: 21.5464, lon: 91.9417, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'chhota-moheshkhali', name: 'ছোট মহেশখালী', lat: 21.5478, lon: 91.9567, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'hoanak', name: 'হোয়ানক', lat: 21.6043, lon: 91.8921, source: 'OSM place=village', confidence: 'medium' },
  { id: 'shaplapur', name: 'শাপলাপুর', lat: 21.6048, lon: 91.9561, source: 'OSM place=village', confidence: 'medium' },
  { id: 'kalarmarchhara', name: 'কালারমারছড়া', lat: 21.6725, lon: 91.9297, source: 'bn.wikipedia', confidence: 'medium' },
  { id: 'matarbari', name: 'মাতারবাড়ী', lat: 21.729, lon: 91.8896, source: 'OSM place=village', confidence: 'medium' },
  { id: 'dhalghata', name: 'ধলঘাটা', lat: 21.6725, lon: 91.8717, source: 'bn.wikipedia', confidence: 'medium' },
  // where the scene's own features go (no real one found: D3)
  { id: 'arch-bridge', name: 'পুরোনো খিলান সেতু (মেয়েটিসহ)', lat: 21.5313, lon: 91.9579, source: 'a real ≈25 m crossing of a khal in OSM; the arch itself is the scene\'s', confidence: 'model' },
  { id: 'shapla-bil', name: 'শাপলা বিল', lat: 21.615, lon: 91.925, source: 'low ground at the hills\' west foot, fed by the "Jiri" hill streams', confidence: 'model' },
];
