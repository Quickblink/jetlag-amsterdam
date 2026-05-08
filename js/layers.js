// Category overlays (one per maps/*.kml file, split into points/polygons
// sub-layers), the layer-toggle UI, and locked voronoi zones.

import { map } from './map.js';
import { escapeHtml, shareText } from './coords.js';

const LAYER_KEY = 'jetlag.layers.v2';
const LAYER_KEY_LEGACY = 'jetlag.layers.v1';
const LOCKED_ZONES_KEY = 'jetlag.lockedZones.v1';

// file -> { file, label, geo, points: SubLayer|null, polygons: SubLayer|null }
// where SubLayer = { leafletLayer, visible }
export const loadedLayers = {};

// key -> { categoryFile, name, feature, leafletLayer }
export const lockedZones = new Map();

// Callback fired when loadLayers() finishes (after locked zones are restored).
let layersLoadedCallback = () => {};
export function onLayersLoaded(cb) { layersLoadedCallback = cb; }

// Polygon centroid as the simple vertex-mean of the outer boundary. Used
// to disambiguate features that share a `name` (e.g. Wijken/Waterland has
// 42 polygons all called "Waterland"). Returns [lat, lng] or null.
function polygonCentroid(feature) {
  if (!feature || !feature.geometry) return null;
  const geom = feature.geometry;
  let coords;
  if (geom.type === 'Polygon') coords = geom.coordinates && geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') coords = geom.coordinates && geom.coordinates[0] && geom.coordinates[0][0];
  if (!coords || coords.length === 0) return null;
  let sumLat = 0, sumLng = 0;
  for (const [lng, lat] of coords) { sumLat += lat; sumLng += lng; }
  return [sumLat / coords.length, sumLng / coords.length];
}

// Lock key includes the centroid so duplicate-named features stay distinct.
// Falls back to name-only when geometry is missing (shouldn't happen for
// polygons but keeps the function total).
export function lockKeyFor(categoryFile, feature) {
  const c = polygonCentroid(feature);
  if (c) return `${categoryFile}::${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const name = feature && feature.properties && feature.properties.name;
  return `${categoryFile}::${name || ''}`;
}

// Find a polygon feature in a category by centroid (within ~2m tolerance).
// Used by import flows.
function findFeatureByCentroid(geo, lat, lng) {
  if (!geo || lat == null || lng == null) return null;
  const tol = 0.00002; // ~2 m
  for (const f of (geo.features || [])) {
    if (!f.geometry || f.geometry.type === 'Point') continue;
    const c = polygonCentroid(f);
    if (!c) continue;
    if (Math.abs(c[0] - lat) < tol && Math.abs(c[1] - lng) < tol) return f;
  }
  return null;
}

// ---------- Feature popups (Lock/Unlock zone for polygons) ----------

function featurePopupHtml(categoryFile, feature, isPolygon) {
  const p = feature.properties || {};
  let lockSection = '';
  if (isPolygon) {
    const key = lockKeyFor(categoryFile, feature);
    const locked = lockedZones.has(key);
    if (locked) {
      lockSection = `<div style="margin-top:8px"><button data-action="unlock-zone">Unlock zone</button> <button data-action="export-zone">Export</button></div>`;
    } else {
      lockSection = `<div style="margin-top:8px"><button data-action="lock-zone">Lock zone</button></div>`;
    }
  }
  return `<div class="feature-popup"><b>${escapeHtml(p.name || '(unnamed)')}</b>${p.description ? '<br>' + escapeHtml(p.description) : ''}${lockSection}</div>`;
}

function attachFeaturePopupHandlers(node, categoryFile, feature, layer) {
  node.querySelectorAll('button[data-action="lock-zone"]').forEach(btn => {
    btn.addEventListener('click', () => {
      lockZone(categoryFile, feature);
      layer.closePopup();
    });
  });
  node.querySelectorAll('button[data-action="unlock-zone"]').forEach(btn => {
    btn.addEventListener('click', () => {
      unlockZone(lockKeyFor(categoryFile, feature));
      layer.closePopup();
    });
  });
  node.querySelectorAll('button[data-action="export-zone"]').forEach(btn => {
    btn.addEventListener('click', () => {
      shareText('Jetlag locked zone', exportZoneText(categoryFile, feature));
      layer.closePopup();
    });
  });
}

function makeOnEachFeature(categoryFile, isPolygon) {
  return (feature, layer) => {
    layer.bindPopup(() => featurePopupHtml(categoryFile, feature, isPolygon));
    layer.on('popupopen', e => attachFeaturePopupHandlers(e.popup.getElement(), categoryFile, feature, layer));
  };
}

// ---------- Sub-layer construction ----------

function buildSubLayer(geo, categoryFile, kind /* 'points' | 'polygons' */, opts = {}) {
  const styles = geo._styles || {};
  const styleFor = feature => {
    const sid = feature && feature.properties && feature.properties._styleId;
    return (sid && styles[sid]) || {};
  };
  // Only set pane/renderer when actually requested — passing undefined
  // overrides Leaflet's defaults and breaks rendering on add.
  const childOpts = {};
  if (opts.pane) childOpts.pane = opts.pane;
  if (opts.renderer) childOpts.renderer = opts.renderer;
  return L.geoJSON(geo, {
    ...childOpts,
    style: feature => {
      const s = styleFor(feature);
      const base = {
        color: s.color || '#444',
        weight: s.weight != null ? s.weight : 1,
        opacity: s.opacity != null ? s.opacity : 1,
        fillColor: s.fillColor || s.color || '#444',
        fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.2,
      };
      if (opts.styleBoost) {
        base.weight = base.weight + (opts.styleBoost.weight || 0);
        base.fillOpacity = Math.min(1, base.fillOpacity + (opts.styleBoost.fillOpacity || 0));
      }
      return base;
    },
    pointToLayer: (feature, latlng) => {
      const s = styleFor(feature);
      if (s.iconUrl) {
        const size = Math.round(32 * (s.iconScale || 1));
        return L.marker(latlng, {
          ...childOpts,
          icon: L.icon({
            iconUrl: s.iconUrl,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2],
          }),
        });
      }
      return L.circleMarker(latlng, {
        ...childOpts,
        radius: 6,
        color: s.color || '#004d00',
        weight: 1,
        fillColor: s.fillColor || s.color || '#00aa00',
        fillOpacity: 0.85,
      });
    },
    onEachFeature: makeOnEachFeature(categoryFile, kind === 'polygons'),
  });
}

// ---------- Visibility persistence ----------

function loadLayerVisibility() {
  // v2 schema: { file: { points: bool, polygons: bool } }
  // v1 schema: { file: bool }  (apply boolean to both)
  let parsed = {};
  try { parsed = JSON.parse(localStorage.getItem(LAYER_KEY) || 'null') || {}; }
  catch (e) {}
  if (Object.keys(parsed).length === 0) {
    try {
      const legacy = JSON.parse(localStorage.getItem(LAYER_KEY_LEGACY) || '{}');
      for (const [file, val] of Object.entries(legacy)) {
        if (typeof val === 'boolean') parsed[file] = { points: val, polygons: val };
      }
    } catch (e) {}
  }
  const out = {};
  for (const [file, val] of Object.entries(parsed)) {
    if (typeof val === 'boolean') out[file] = { points: val, polygons: val };
    else if (val && typeof val === 'object') {
      out[file] = { points: !!val.points, polygons: !!val.polygons };
    }
  }
  return out;
}

function saveLayerVisibility() {
  const v = {};
  for (const file in loadedLayers) {
    const L_ = loadedLayers[file];
    v[file] = {
      points: !!(L_.points && L_.points.visible),
      polygons: !!(L_.polygons && L_.polygons.visible),
    };
  }
  localStorage.setItem(LAYER_KEY, JSON.stringify(v));
}

// ---------- Top-level: fetch manifest, build sub-layers, render the grid ----------

export async function loadLayers() {
  const layerGrid = document.getElementById('layer-grid');
  const savedVisibility = loadLayerVisibility();

  let manifest;
  try {
    manifest = await fetch('data/manifest.json').then(r => r.json());
  } catch (err) {
    console.error('Failed to load manifest:', err);
    return;
  }

  const items = await Promise.all(manifest.categories.map(cat =>
    fetch('data/' + cat.file).then(r => r.json()).then(geo => ({ cat, geo }))
  ));

  for (const { cat, geo } of items) {
    const pointFeatures = (geo.features || []).filter(f => f.geometry && f.geometry.type === 'Point');
    const polyFeatures = (geo.features || []).filter(f => f.geometry && f.geometry.type !== 'Point');
    const pointsGeo = pointFeatures.length ? { type: 'FeatureCollection', _styles: geo._styles, features: pointFeatures } : null;
    const polysGeo = polyFeatures.length ? { type: 'FeatureCollection', _styles: geo._styles, features: polyFeatures } : null;

    const saved = savedVisibility[cat.file] || {};
    const defaultOn = !!cat.default;

    const cardEntry = {
      file: cat.file, label: cat.label, geo,
      points: null, polygons: null,
      // Informational categories appear in the sidebar but are excluded
      // from the pin popup's measuring-circles dropdown — set in
      // manifest.json by the converter.
      informational: !!cat.informational,
    };
    if (pointsGeo) {
      const lyr = buildSubLayer(pointsGeo, cat.file, 'points');
      const visible = saved.points !== undefined ? !!saved.points : defaultOn;
      cardEntry.points = { leafletLayer: lyr, visible };
      if (visible) lyr.addTo(map);
    }
    if (polysGeo) {
      const lyr = buildSubLayer(polysGeo, cat.file, 'polygons');
      const visible = saved.polygons !== undefined ? !!saved.polygons : defaultOn;
      cardEntry.polygons = { leafletLayer: lyr, visible };
      if (visible) lyr.addTo(map);
    }
    loadedLayers[cat.file] = cardEntry;

    // Layer-grid row: name + count, then two checkboxes. The count is
    // max(points, polygons) rather than the sum, because most categories
    // produce one polygon (Voronoi cell) per point feature, so summing
    // would roughly double-count the underlying objects.
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = cat.label;
    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = Math.max(pointFeatures.length, polyFeatures.length);
    nameEl.append(labelSpan, countSpan);
    layerGrid.appendChild(nameEl);

    const iconCell = document.createElement('div');
    iconCell.className = 'cb-cell';
    const iconCb = document.createElement('input');
    iconCb.type = 'checkbox';
    if (cardEntry.points) {
      iconCb.checked = cardEntry.points.visible;
      iconCb.addEventListener('change', () => {
        cardEntry.points.visible = iconCb.checked;
        if (iconCb.checked) cardEntry.points.leafletLayer.addTo(map);
        else map.removeLayer(cardEntry.points.leafletLayer);
        saveLayerVisibility();
      });
    } else {
      iconCb.disabled = true;
    }
    iconCell.appendChild(iconCb);
    layerGrid.appendChild(iconCell);

    const zoneCell = document.createElement('div');
    zoneCell.className = 'cb-cell';
    const zoneCb = document.createElement('input');
    zoneCb.type = 'checkbox';
    if (cardEntry.polygons) {
      zoneCb.checked = cardEntry.polygons.visible;
      zoneCb.addEventListener('change', () => {
        cardEntry.polygons.visible = zoneCb.checked;
        if (zoneCb.checked) cardEntry.polygons.leafletLayer.addTo(map);
        else map.removeLayer(cardEntry.polygons.leafletLayer);
        saveLayerVisibility();
      });
    } else {
      zoneCb.disabled = true;
    }
    zoneCell.appendChild(zoneCb);
    layerGrid.appendChild(zoneCell);
  }

  loadLockedZones();
  layersLoadedCallback();
}

// ---------- Locked voronoi zones ----------
// Locked zones are rendered in the default pane with a style boost (heavier
// stroke, more fill) so they stand out from regular zones. They live in their
// own L.geoJSON layer that stays added to the map regardless of the parent
// category's visibility — that's how toggling a category off keeps the locked
// zone visible. Putting them in a dedicated pane was tempting for z-order, but
// that pane's canvas intercepted clicks for the regular polygon layer below,
// breaking selection of other zones.

function lockZone(categoryFile, feature) {
  const name = feature.properties && feature.properties.name;
  const key = lockKeyFor(categoryFile, feature);
  if (lockedZones.has(key)) return;
  const single = {
    type: 'FeatureCollection',
    _styles: loadedLayers[categoryFile] && loadedLayers[categoryFile].geo._styles,
    features: [feature],
  };
  const lyr = buildSubLayer(single, categoryFile, 'polygons', {
    styleBoost: { weight: 2, fillOpacity: 0.25 },
  });
  lyr.addTo(map);
  lockedZones.set(key, { categoryFile, name, feature, leafletLayer: lyr });
  saveLockedZones();
}

function unlockZone(key) {
  const z = lockedZones.get(key);
  if (!z) return;
  map.removeLayer(z.leafletLayer);
  lockedZones.delete(key);
  saveLockedZones();
}

function saveLockedZones() {
  const data = [...lockedZones.values()].map(z => {
    const c = polygonCentroid(z.feature) || [null, null];
    return { categoryFile: z.categoryFile, name: z.name, lat: c[0], lng: c[1] };
  });
  localStorage.setItem(LOCKED_ZONES_KEY, JSON.stringify(data));
}

function loadLockedZones() {
  try {
    const data = JSON.parse(localStorage.getItem(LOCKED_ZONES_KEY) || '[]');
    for (const entry of data) {
      const cat = loadedLayers[entry.categoryFile];
      if (!cat || !cat.geo) continue;
      let feature = null;
      if (entry.lat != null && entry.lng != null) {
        feature = findFeatureByCentroid(cat.geo, entry.lat, entry.lng);
      }
      if (!feature && entry.name) {
        // Pre-centroid entries: best-effort name match (first hit wins for
        // duplicate-named features — the centroid will be stored on next save).
        feature = cat.geo.features.find(f =>
          f.properties && f.properties.name === entry.name &&
          f.geometry && f.geometry.type !== 'Point'
        );
      }
      if (feature) lockZone(entry.categoryFile, feature);
    }
  } catch (e) { console.warn('Failed to load locked zones:', e); }
}

// ---------- Zone export / import ----------
//
//   jetlag zone <category> <name> @<lat>,<lng>
//
// Category is the basename without the .geojson extension. The centroid
// coordinates disambiguate zones that share a name (e.g. Wijken/Waterland
// has 42 polygons all called "Waterland").

export function exportZoneText(categoryFile, feature) {
  const cat = categoryFile.replace(/\.geojson$/, '');
  const name = (feature && feature.properties && feature.properties.name) || '';
  const c = polygonCentroid(feature);
  const coords = c ? ` @${c[0].toFixed(5)},${c[1].toFixed(5)}` : '';
  return `jetlag zone ${cat} ${name}${coords}`;
}

export function formatAllZonesExport() {
  const lines = [];
  for (const z of lockedZones.values()) {
    if (z.feature) lines.push(exportZoneText(z.categoryFile, z.feature));
  }
  return lines.join('\n');
}

// Lock a zone given the category basename + name + optional centroid. Used
// by import flows. Centroid is preferred; name is the fallback.
export function lockZoneByName(category, name, lat, lng) {
  const file = category.endsWith('.geojson') ? category : category + '.geojson';
  const cat = loadedLayers[file];
  if (!cat || !cat.geo) return false;
  let feature = null;
  if (lat != null && lng != null) {
    feature = findFeatureByCentroid(cat.geo, lat, lng);
  }
  if (!feature && name) {
    feature = cat.geo.features.find(f =>
      f.properties && f.properties.name === name &&
      f.geometry && f.geometry.type !== 'Point'
    );
  }
  if (!feature) return false;
  lockZone(file, feature);
  return true;
}

// Parse jetlag-zone lines from arbitrary text.
export function parseZonesFromText(text) {
  const out = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^jetlag\s+zone\s+(\S+)\s+(.+?)\s+@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s*$/i))) {
      out.push({
        category: m[1], name: m[2],
        lat: parseFloat(m[3]), lng: parseFloat(m[4]),
      });
    } else if ((m = line.match(/^jetlag\s+zone\s+(\S+)\s+(.+)$/i))) {
      out.push({ category: m[1], name: m[2] });
    }
  }
  return out;
}
