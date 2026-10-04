// What the geo scripts fetch, and for which area. Everything lands in scripts/geo/cache/ (not in git); the
// site never loads any of it directly: the bake step (P1) turns it into public/geo/.

/** The area (WGS84): Moheshkhali, Matarbari, Sonadia, the channel, Cox's Bazar's northern end, with a margin. */
export const BBOX = { south: 21.4, north: 21.82, west: 91.76, east: 92.06 };

/** The world is the real map at 1:3 (GEOGRAPHY_PLAN.md §5.1); objects and heights stay real size. */
export const MAP_SCALE = 3;

export const CACHE = new URL('./cache/', import.meta.url);

const FABDEM = 'https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N20E090-N30E100_FABDEM_V1-2.zip';
const DELTADTM = 'https://data.4tu.nl/file/1da2e70f-6c4d-4b03-86bd-b53e789cc629/672eba4c-1334-44c6-8119-8879ded25912';
const GMW = 'https://zenodo.org/api/records/6894273/files/gmw_v3_2020_gtiff.zip/content';
const copernicus = (tile) =>
  `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${tile}_DEM/Copernicus_DSM_COG_10_${tile}_DEM.tif`;

/**
 * kind: 'file' downloads the whole file; 'zip' takes one member out of a remote zip by range requests;
 * 'window' reads the area out of a large cloud-optimised GeoTIFF (`res` in the file's own units, to read a
 * coarser overview); 'overpass' and 'sentinel' are handled by their own code.
 */
export const SOURCES = [
  { id: 'copernicus-N21E091', kind: 'file', url: copernicus('N21_00_E091_00'), licence: 'Copernicus DEM licence (free, attribution)' },
  { id: 'copernicus-N21E092', kind: 'file', url: copernicus('N21_00_E092_00'), licence: 'Copernicus DEM licence (free, attribution)' },
  { id: 'fabdem-N21E091', kind: 'zip', url: FABDEM, member: 'N21E091_FABDEM_V1-2.tif', licence: 'CC BY-NC-SA 4.0' },
  { id: 'fabdem-N21E092', kind: 'zip', url: FABDEM, member: 'N21E092_FABDEM_V1-2.tif', licence: 'CC BY-NC-SA 4.0' },
  { id: 'deltadtm-N21E091', kind: 'zip', url: DELTADTM, member: 'DeltaDTM_v1_1_N21E091.tif', licence: 'CC BY 4.0' },
  { id: 'deltadtm-N21E092', kind: 'zip', url: DELTADTM, member: 'DeltaDTM_v1_1_N21E092.tif', licence: 'CC BY 4.0' },
  { id: 'srtm-N21E091', kind: 'file', url: 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/N21/N21E091.hgt.gz', licence: 'public domain (SRTM via Mapzen terrain tiles)' },
  { id: 'srtm-N21E092', kind: 'file', url: 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/N21/N21E092.hgt.gz', licence: 'public domain (SRTM via Mapzen terrain tiles)' },
  { id: 'gebco-2025', kind: 'window', url: 'https://s3-west.nrp-nautilus.io/public-high-seas/gebco-2025-cog.tif', crs: 'EPSG:4326', licence: 'public domain, attribution' },
  { id: 'worldcover-2021', kind: 'window', url: 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N21E090_Map.tif', crs: 'EPSG:4326', licence: 'CC BY 4.0' },
  { id: 'jrc-occurrence', kind: 'window', url: 'https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/occurrence_90E_30Nv1_4_2021.tif', crs: 'EPSG:4326', licence: 'free, attribution (EC JRC/Google)' },
  { id: 'jrc-seasonality', kind: 'window', url: 'https://storage.googleapis.com/global-surface-water/downloads2021/seasonality/seasonality_90E_30Nv1_4_2021.tif', crs: 'EPSG:4326', licence: 'free, attribution (EC JRC/Google)' },
  // Meta/WRI canopy height, 1 m: read at ≈5 m, plenty for where trees stand and how tall
  { id: 'canopy-meta', kind: 'window', url: 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/132200010.tif', crs: 'EPSG:3857', res: 5, licence: 'CC BY 4.0' },
  { id: 'gmw-N22E091', kind: 'zip', url: GMW, member: 'gmw_v3_2020/GMW_N22E091_2020_v3.tif', licence: 'CC BY 4.0' },
  { id: 'gmw-N22E092', kind: 'zip', url: GMW, member: 'gmw_v3_2020/GMW_N22E092_2020_v3.tif', licence: 'CC BY 4.0' },
  // the Cox's Bazar tide gauge, hourly (UHSLC research quality), for fitting the tide's harmonics
  { id: 'uhslc-coxs-bazar', kind: 'file', url: 'https://uhslc.soest.hawaii.edu/data/csv/rqds/indian/hourly/h136a.csv', licence: 'UHSLC research quality data (free, attribution)' },
  {
    id: 'ms-buildings',
    kind: 'file',
    url: 'https://minedbuildings.z5.web.core.windows.net/global-buildings/2026-02-03/global-buildings.geojsonl/RegionName=Bangladesh/quadkey=132200010/part-00073-4feead82-d499-422b-94cb-c036c212127a.c000.csv.gz',
    licence: 'ODbL',
  },
];

/** OpenStreetMap, by theme (each one Overpass query, geometry included). */
export const OSM_THEMES = {
  coast: 'nwr["natural"~"^(coastline|water|wetland|beach|sand|mud|bay|strait)$"];nwr["water"];nwr["waterway"];nwr["place"~"^(island|islet)$"];',
  landuse: 'nwr["landuse"];nwr["leisure"];nwr["natural"~"^(wood|scrub|grassland|tree_row|tree|peak|hill)$"];',
  roads: 'nwr["highway"];nwr["railway"];nwr["route"="ferry"];',
  buildings: 'nwr["building"];',
  // only what the map needs: all amenities and shops together time out on every Overpass server
  places: 'nwr["place"];nwr["religion"];nwr["amenity"~"^(place_of_worship|ferry_terminal|marketplace|townhall|school|hospital|fuel)$"];nwr["tourism"];nwr["historic"];',
  infrastructure: 'nwr["man_made"];nwr["power"];nwr["embankment"];nwr["bridge"];nwr["harbour"];nwr["seamark:type"];nwr["construction"];nwr["industrial"];',
};

/** Sentinel-2 L2A for checking the map against what is really there (never shipped). */
export const SENTINEL = {
  stac: 'https://earth-search.aws.element84.com/v1/search',
  collection: 'sentinel-2-c1-l2a',
  /** dry-season scenes: clear skies, salt being made; the latest is the closest to today */
  from: '2025-11-01',
  to: '2026-10-01',
  maxCloud: 3,
};
