// Category overlays (one per maps/*.kml file, split into points/polygons
// sub-layers), the layer-toggle UI, and locked voronoi zones.

import { map } from './map.js';
import { escapeHtml } from './coords.js';

const LAYER_KEY = 'jetlag.layers.v2';
const LAYER_KEY_LEGACY = 'jetlag.layers.v1';
const LOCKED_ZONES_KEY = 'jetlag.lockedZones.v1';

// file -> { file, label, geo, points: SubLayer|null, polygons: SubLayer|null }
// where SubLayer = { leafletLayer, visible }
export const loadedLayers = {};

// key -> { categoryFile, name, leafletLayer }
export const lockedZones = new Map();

// Callback fired when loadLayers() finishes (after locked zones are restored).
let layersLoadedCallback = () => {};
export function onLayersLoaded(cb) { layersLoadedCallback = cb; }

export function lockKeyFor(categoryFile, name) {
  return `${categoryFile}::${name || ''}`;
}

// ---------- Feature popups (Lock/Unlock zone for polygons) ----------

function featurePopupHtml(categoryFile, feature, isPolygon) {
  const p = feature.properties || {};
  let lockSection = '';
  if (isPolygon) {
    const key = lockKeyFor(categoryFile, p.name);
    const locked = lockedZones.has(key);
    lockSection = `<div style="margin-top:8px"><button data-action="${locked ? 'unlock-zone' : 'lock-zone'}">${locked ? 'Unlock zone' : 'Lock zone'}</button></div>`;
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
      unlockZone(lockKeyFor(categoryFile, feature.properties && feature.properties.name));
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

    const cardEntry = { file: cat.file, label: cat.label, geo, points: null, polygons: null };
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

    // Layer-grid row: name + count, then two checkboxes
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = cat.label;
    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = (geo.features || []).length;
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
  const key = lockKeyFor(categoryFile, name);
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
  lockedZones.set(key, { categoryFile, name, leafletLayer: lyr });
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
  const data = [...lockedZones.values()].map(z => ({
    categoryFile: z.categoryFile, name: z.name,
  }));
  localStorage.setItem(LOCKED_ZONES_KEY, JSON.stringify(data));
}

function loadLockedZones() {
  try {
    const data = JSON.parse(localStorage.getItem(LOCKED_ZONES_KEY) || '[]');
    for (const entry of data) {
      const cat = loadedLayers[entry.categoryFile];
      if (!cat || !cat.geo) continue;
      const feature = cat.geo.features.find(f =>
        f.properties && f.properties.name === entry.name &&
        f.geometry && f.geometry.type !== 'Point'
      );
      if (feature) lockZone(entry.categoryFile, feature);
    }
  } catch (e) { console.warn('Failed to load locked zones:', e); }
}
