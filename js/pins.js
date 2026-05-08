// User-placed pins, their popup (radius / measuring / thermometer / lock /
// remove), measuring circles, and pairwise thermometers between pins.

import { map, measuringRenderer } from './map.js';
import { loadedLayers } from './layers.js';
import { escapeHtml, shareText } from './coords.js';

const RADII = [250, 500, 1000, 2000, 5000, 10000];
const PIN_KEY = 'jetlag.pins.v2';
const THERM_KEY = 'jetlag.thermometers.v2';

// Logarithmic slider for the custom radius preset. The default custom value
// is the slider's log midpoint (~548 m) — deliberately not in RADII so that
// switching from a preset to Custom actually puts the pin in custom mode
// (otherwise the popup would re-render with the matching preset highlighted
// and the slider hidden).
const CUSTOM_R_MIN = 30, CUSTOM_R_MAX = 10000;
const CUSTOM_DEFAULT = Math.round(Math.sqrt(CUSTOM_R_MIN * CUSTOM_R_MAX));
function sliderToRadius(v) {
  const clamped = Math.max(0, Math.min(1, v));
  return Math.round(CUSTOM_R_MIN * Math.pow(CUSTOM_R_MAX / CUSTOM_R_MIN, clamped));
}
function radiusToSlider(r) {
  const v = Math.log(r / CUSTOM_R_MIN) / Math.log(CUSTOM_R_MAX / CUSTOM_R_MIN);
  return Math.max(0, Math.min(1, v));
}
function formatRadius(m) {
  if (m >= 10000) return (m / 1000).toFixed(0) + ' km';
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  return Math.round(m) + ' m';
}

export const pins = new Map();
export const thermometers = []; // [{ id, aId, bId, layers }]
let pendingThermometerFrom = null;

// ---------- Persistence ----------

function savePins() {
  const data = [...pins.values()].map(p => ({
    id: p.id, lat: p.lat, lng: p.lng,
    radius: p.radius, customRadius: p.customRadius,
    measuringCategory: p.measuringCategory,
    locked: p.locked,
  }));
  localStorage.setItem(PIN_KEY, JSON.stringify(data));
}

export function loadPins() {
  let data = [];
  try { data = JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch (e) {}
  if (!Array.isArray(data)) {
    try { data = JSON.parse(localStorage.getItem('jetlag.pins.v1') || '[]'); } catch (e) { data = []; }
  }
  for (const p of (data || [])) {
    const pin = addPin(p.lat, p.lng, { id: p.id, save: false, locked: !!p.locked });
    if (p.customRadius) pin.customRadius = p.customRadius;
    if (p.radius) setCircle(pin.id, p.radius, false);
    if (p.measuringCategory) pin.measuringCategory = p.measuringCategory;
  }
}

function saveThermometers() {
  localStorage.setItem(THERM_KEY, JSON.stringify(
    thermometers.map(t => ({ id: t.id, aId: t.aId, bId: t.bId }))
  ));
}

export function loadThermometers() {
  try {
    const data = JSON.parse(localStorage.getItem(THERM_KEY) || '[]');
    for (const t of data) {
      if (pins.has(t.aId) && pins.has(t.bId)) {
        const therm = { id: t.id, aId: t.aId, bId: t.bId, layers: [] };
        thermometers.push(therm);
        drawThermometer(therm);
      }
    }
  } catch (e) {}
}

// Called from main.js after layers finish loading — restores measuring circles
// for pins that referenced a category before the category data was available.
export function reapplyMeasuring() {
  for (const pin of pins.values()) {
    if (pin.measuringCategory) drawMeasuringCircles(pin);
  }
}

// ---------- Popup HTML / handlers ----------

function pinPopupHtml(id) {
  const pin = pins.get(id);

  const radiusBtns = RADII.map(r => {
    const label = r >= 1000 ? (r / 1000) + ' km' : r + ' m';
    return `<button class="r-btn${pin.radius === r ? ' active' : ''}" data-r="${r}">${label}</button>`;
  }).join('');
  const noneActive = !pin.radius ? ' active' : '';
  const isCustom = pin.radius && !RADII.includes(pin.radius);
  // Always render the slider row in the DOM, just hidden until Custom is
  // active. This way switching to/from Custom toggles a display style on an
  // existing element instead of rebuilding the popup, which keeps the
  // popup visually open and stable.
  const sliderValue = isCustom ? radiusToSlider(pin.radius).toFixed(3) : '0.5';
  const sliderDisplay = isCustom ? formatRadius(pin.radius) : formatRadius(CUSTOM_DEFAULT);
  const sliderRow = `
        <div class="row custom-radius" style="display: ${isCustom ? 'flex' : 'none'}">
          <input type="range" min="0" max="1" step="0.001" value="${sliderValue}">
          <span class="custom-display">${sliderDisplay}</span>
        </div>`;

  // Object.values preserves insertion order, which is the manifest order
  // (Transit → Admin → Natural → Places of Interest → Public Utilities).
  const pointCats = Object.values(loadedLayers).filter(l => l.points);
  const measureOpts = `<option value="">— off —</option>` +
    pointCats.map(l => {
      const sel = pin.measuringCategory === l.file ? ' selected' : '';
      return `<option value="${escapeHtml(l.file)}"${sel}>${escapeHtml(l.label)}</option>`;
    }).join('');

  const myThermometers = thermometers.filter(t => t.aId === id || t.bId === id);
  let thermSection;
  if (pendingThermometerFrom === id) {
    thermSection = `<div class="row"><button class="therm-cancel" data-action="cancel-pending">Cancel pending</button></div>`;
  } else if (myThermometers.length > 0) {
    thermSection = myThermometers.map(t => {
      const otherId = t.aId === id ? t.bId : t.aId;
      const other = pins.get(otherId);
      const otherStr = other ? `${other.lat.toFixed(4)}, ${other.lng.toFixed(4)}` : '?';
      return `<div class="row"><button data-action="remove-therm" data-tid="${escapeHtml(t.id)}">Remove (to ${escapeHtml(otherStr)})</button></div>`;
    }).join('');
  } else {
    thermSection = `<div class="row"><button data-action="start-therm">Start thermometer</button></div>`;
  }

  return `
    <div class="pin-popup" data-id="${escapeHtml(String(id))}">
      <div class="header-row">
        <div><b>Pin</b> <span class="coords">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</span></div>
        <label class="lock-toggle"><input type="checkbox" data-action="toggle-lock"${pin.locked ? ' checked' : ''}> 🔒 lock</label>
      </div>

      <div class="section-label">Radius</div>
      <div class="row">${radiusBtns}<button class="r-btn${isCustom ? ' active' : ''}" data-r="custom">Custom</button><button class="r-btn${noneActive}" data-r="">×</button></div>
      ${sliderRow}

      <div class="section-label">Measuring circles</div>
      <select class="measure-sel">${measureOpts}</select>

      <div class="section-label">Thermometer</div>
      ${thermSection}

      <hr>
      <div class="row"><button data-action="export-pin">Export</button><button data-action="remove">Remove pin</button></div>
    </div>
  `;
}

// Update the radius row in-place — preset active states + slider visibility
// + slider value/display — so the popup doesn't get rebuilt and the user
// doesn't see it visually flicker (or worse, lose focus on the slider).
function setRadiusActive(node, pin) {
  const buttons = node.querySelectorAll('button[data-r]');
  for (const btn of buttons) {
    btn.classList.remove('active');
    const v = btn.dataset.r;
    if (v === '' && !pin.radius) btn.classList.add('active');
    else if (v === 'custom' && pin.radius && !RADII.includes(pin.radius)) btn.classList.add('active');
    else if (v !== '' && v !== 'custom' && parseInt(v, 10) === pin.radius) btn.classList.add('active');
  }
  const sliderRow = node.querySelector('.custom-radius');
  if (!sliderRow) return;
  const isCustom = pin.radius && !RADII.includes(pin.radius);
  sliderRow.style.display = isCustom ? 'flex' : 'none';
  if (isCustom) {
    const slider = sliderRow.querySelector('input[type="range"]');
    const display = sliderRow.querySelector('.custom-display');
    if (slider) slider.value = radiusToSlider(pin.radius).toFixed(3);
    if (display) display.textContent = formatRadius(pin.radius);
  }
}

function attachPopupHandlers(node, id) {
  const pin = pins.get(id);
  node.querySelectorAll('button[data-r]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.r;
      if (v === '') { setCircle(id, null); setRadiusActive(node, pins.get(id)); return; }
      if (v === 'custom') {
        // Switch to custom mode. Use last custom value if there is one,
        // otherwise default to the slider midpoint (~548 m). 1000 would
        // collide with the 1km preset and bounce us out of custom mode.
        const initial = (pin && pin.radius && !RADII.includes(pin.radius))
          ? pin.radius
          : ((pin && pin.customRadius) || CUSTOM_DEFAULT);
        setCircle(id, initial);
        setRadiusActive(node, pins.get(id));
        return;
      }
      setCircle(id, parseInt(v, 10));
      setRadiusActive(node, pins.get(id));
    });
  });
  const slider = node.querySelector('.custom-radius input[type="range"]');
  const display = node.querySelector('.custom-display');
  if (slider) {
    slider.addEventListener('input', () => {
      const r = sliderToRadius(parseFloat(slider.value));
      if (display) display.textContent = formatRadius(r);
      // Update the circle live without re-rendering the popup so the
      // slider keeps focus and the user can keep dragging.
      setCircle(id, r);
    });
  }
  node.querySelectorAll('.measure-sel').forEach(sel => {
    sel.addEventListener('change', () => setMeasuring(id, sel.value || null));
  });
  node.querySelectorAll('button[data-action="start-therm"]').forEach(btn => {
    btn.addEventListener('click', () => startThermometerFrom(id));
  });
  node.querySelectorAll('button[data-action="cancel-pending"]').forEach(btn => {
    btn.addEventListener('click', () => cancelPendingThermometer());
  });
  node.querySelectorAll('button[data-action="remove-therm"]').forEach(btn => {
    btn.addEventListener('click', () => removeThermometer(btn.dataset.tid));
  });
  node.querySelectorAll('button[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => removePin(id));
  });
  node.querySelectorAll('button[data-action="export-pin"]').forEach(btn => {
    btn.addEventListener('click', () => shareText('Jetlag pin', exportPinText(id)));
  });
  node.querySelectorAll('input[data-action="toggle-lock"]').forEach(cb => {
    cb.addEventListener('change', () => setPinLocked(id, cb.checked));
  });
}

function refreshPinPopup(id) {
  const pin = pins.get(id);
  if (!pin || !pin.marker.isPopupOpen()) return;
  pin.marker.setPopupContent(pinPopupHtml(id));
  attachPopupHandlers(pin.marker.getPopup().getElement(), id);
}

export function refreshAllPinPopups() {
  for (const id of pins.keys()) refreshPinPopup(id);
}

// ---------- Pin lifecycle ----------

export function addPin(lat, lng, { id = Date.now() + Math.random(), save = true, locked = false } = {}) {
  const marker = L.marker([lat, lng], { draggable: !locked }).addTo(map);
  const pin = {
    id, lat, lng, marker,
    circle: null, radius: null, customRadius: null,
    measuringCategory: null, measuringCircles: [],
    locked: !!locked,
  };
  pins.set(id, pin);
  marker.bindPopup(() => pinPopupHtml(id));
  marker.on('popupopen', e => {
    if (pendingThermometerFrom !== null && pendingThermometerFrom !== id) {
      // This popup-open is the second leg of a pending thermometer — close
      // the popup we just triggered and create the thermometer instead.
      completeThermometer(id);
      marker.closePopup();
      return;
    }
    attachPopupHandlers(e.popup.getElement(), id);
  });
  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    pin.lat = ll.lat; pin.lng = ll.lng;
    if (pin.circle) pin.circle.setLatLng(ll);
    if (pin.measuringCategory) drawMeasuringCircles(pin);
    for (const t of thermometers) {
      if (t.aId === id || t.bId === id) drawThermometer(t);
    }
    savePins();
    refreshPinPopup(id);
  });
  if (save) savePins();
  return pin;
}

function setPinLocked(id, locked) {
  const pin = pins.get(id);
  if (!pin) return;
  pin.locked = !!locked;
  if (pin.locked) pin.marker.dragging.disable();
  else pin.marker.dragging.enable();
  savePins();
  refreshPinPopup(id);
}

function removePin(id) {
  const pin = pins.get(id);
  if (!pin) return;
  for (const c of pin.measuringCircles) map.removeLayer(c);
  for (let i = thermometers.length - 1; i >= 0; i--) {
    if (thermometers[i].aId === id || thermometers[i].bId === id) {
      for (const layer of thermometers[i].layers) map.removeLayer(layer);
      thermometers.splice(i, 1);
    }
  }
  if (pendingThermometerFrom === id) cancelPendingThermometer();
  map.removeLayer(pin.marker);
  if (pin.circle) map.removeLayer(pin.circle);
  pins.delete(id);
  savePins();
  saveThermometers();
  refreshAllPinPopups();
}

function setCircle(id, radius, save = true) {
  const pin = pins.get(id);
  if (!pin) return;
  if (pin.circle) { map.removeLayer(pin.circle); pin.circle = null; }
  pin.radius = radius;
  if (radius && !RADII.includes(radius)) pin.customRadius = radius;
  if (radius) {
    pin.circle = L.circle([pin.lat, pin.lng], {
      radius, color: '#0066cc', weight: 2, fillColor: '#0066cc', fillOpacity: 0.1,
    }).addTo(map);
  }
  if (save) savePins();
  // No popup refresh here — callers refresh when needed. The slider input
  // handler deliberately skips refresh so it keeps focus while dragging.
}

// ---------- Measuring circles (matching-question visualization) ----------

function drawMeasuringCircles(pin) {
  for (const c of pin.measuringCircles) map.removeLayer(c);
  pin.measuringCircles = [];
  const layer = pin.measuringCategory && loadedLayers[pin.measuringCategory];
  if (!layer || !layer.geo) return;
  const points = layer.geo.features.filter(f => f.geometry && f.geometry.type === 'Point');
  if (points.length === 0) return;
  // Single radius for every circle: the pin's distance to its nearest feature.
  let dNearest = Infinity;
  for (const f of points) {
    const [lng, lat] = f.geometry.coordinates;
    const d = map.distance([pin.lat, pin.lng], [lat, lng]);
    if (d < dNearest) dNearest = d;
  }
  if (!isFinite(dNearest) || dNearest === 0) return;
  for (const f of points) {
    const [lng, lat] = f.geometry.coordinates;
    const c = L.circle([lat, lng], {
      radius: dNearest,
      stroke: false,
      fillColor: '#ff7f0e', fillOpacity: 1.0,
      interactive: false,
      pane: 'measuring',
      renderer: measuringRenderer,
    }).addTo(map);
    pin.measuringCircles.push(c);
  }
}

function setMeasuring(id, file) {
  const pin = pins.get(id);
  if (!pin) return;
  pin.measuringCategory = (file && loadedLayers[file]) ? file : null;
  drawMeasuringCircles(pin);
  savePins();
  refreshPinPopup(id);
}

// ---------- Thermometers ----------
// The bisector geometry is computed in Web Mercator pixel space (Leaflet
// renders polylines as straight pixel lines in Mercator, and Mercator is
// conformal — so a perpendicular drawn in Mercator pixels stays visually
// perpendicular at any rendering zoom). Doing it in lat/lng degrees with a
// cos(lat) correction skews when A and B differ in latitude, because
// Mercator's y-axis is non-linear in lat.

function bisectorEndpoints(a, b) {
  const z = 18;
  const ptA = map.project(L.latLng(a.lat, a.lng), z);
  const ptB = map.project(L.latLng(b.lat, b.lng), z);
  const mid = L.point((ptA.x + ptB.x) / 2, (ptA.y + ptB.y) / 2);
  const dx = ptB.x - ptA.x, dy = ptB.y - ptA.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;
  const px = -dy / len, py = dx / len;
  const ext = 1e7;
  return [
    map.unproject(L.point(mid.x + px * ext, mid.y + py * ext), z),
    map.unproject(L.point(mid.x - px * ext, mid.y - py * ext), z),
  ];
}

function drawThermometer(t) {
  for (const layer of t.layers) map.removeLayer(layer);
  t.layers = [];
  const a = pins.get(t.aId), b = pins.get(t.bId);
  if (!a || !b) return;
  const aLL = L.latLng(a.lat, a.lng);
  const bLL = L.latLng(b.lat, b.lng);
  const seg = L.polyline([aLL, bLL], { color: '#d62728', weight: 2, opacity: 0.8 }).addTo(map);
  t.layers.push(seg);
  const ends = bisectorEndpoints(aLL, bLL);
  if (ends) {
    const bisector = L.polyline(ends, {
      color: '#d62728', weight: 2, dashArray: '8, 6', opacity: 0.8,
    }).addTo(map);
    t.layers.push(bisector);
  }
}

function startThermometerFrom(pinId) {
  pendingThermometerFrom = pinId;
  document.getElementById('therm-banner').style.display = 'flex';
  const pin = pins.get(pinId);
  if (pin) pin.marker.closePopup();
  refreshAllPinPopups();
}

function cancelPendingThermometer() {
  const wasPending = pendingThermometerFrom;
  pendingThermometerFrom = null;
  document.getElementById('therm-banner').style.display = 'none';
  if (wasPending !== null) refreshPinPopup(wasPending);
}

// Create a thermometer link between two existing pins. Returns the new
// thermometer object, or null if the pair already had one or either pin is
// missing. Public so import flows can call it without going through pending
// mode.
export function createThermometer(aId, bId) {
  if (aId === bId || !pins.has(aId) || !pins.has(bId)) return null;
  const dup = thermometers.some(t =>
    (t.aId === aId && t.bId === bId) ||
    (t.aId === bId && t.bId === aId)
  );
  if (dup) return null;
  const t = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    aId, bId, layers: [],
  };
  thermometers.push(t);
  drawThermometer(t);
  saveThermometers();
  return t;
}

function completeThermometer(secondPinId) {
  const aId = pendingThermometerFrom;
  if (aId === null || aId === secondPinId) {
    cancelPendingThermometer();
    return;
  }
  createThermometer(aId, secondPinId);
  pendingThermometerFrom = null;
  document.getElementById('therm-banner').style.display = 'none';
  refreshAllPinPopups();
}

function removeThermometer(thermId) {
  const idx = thermometers.findIndex(t => t.id === thermId);
  if (idx < 0) return;
  for (const layer of thermometers[idx].layers) map.removeLayer(layer);
  thermometers.splice(idx, 1);
  saveThermometers();
  refreshAllPinPopups();
}

document.getElementById('cancel-pending-therm').addEventListener('click', cancelPendingThermometer);

// ---------- Export / import format ----------
// One line per item, prefixed with "jetlag <type>". Compact + parseable.
//
//   jetlag pin <lat>, <lng> [r=<radius>] [m=<category>] [locked]
//   jetlag therm <lat>, <lng> <-> <lat>, <lng>
//   jetlag zone <category> <name>     (handled in layers.js)

function formatExportRadius(m) {
  if (m >= 1000 && m % 1000 === 0) return (m / 1000) + 'km';
  if (m >= 1000) return (Math.round(m) / 1000) + 'km';
  return Math.round(m) + 'm';
}

function parseExportRadius(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(km|m)?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] && m[2].toLowerCase() === 'km') n *= 1000;
  return Math.round(n);
}

function coordKey(lat, lng) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function formatPinLine(pin) {
  const attrs = [];
  if (pin.radius) attrs.push(`r=${formatExportRadius(pin.radius)}`);
  if (pin.measuringCategory) {
    attrs.push(`m=${pin.measuringCategory.replace(/\.geojson$/, '')}`);
  }
  if (pin.locked) attrs.push('locked');
  const tail = attrs.length ? ' ' + attrs.join(' ') : '';
  return `jetlag pin ${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}${tail}`;
}

function formatThermLine(a, b) {
  return `jetlag therm ${a.lat.toFixed(6)}, ${a.lng.toFixed(6)} <-> ${b.lat.toFixed(6)}, ${b.lng.toFixed(6)}`;
}

// Single pin's export text — also includes any thermometer partners.
export function exportPinText(id) {
  const pin = pins.get(id);
  if (!pin) return '';
  const lines = [formatPinLine(pin)];
  const myTherms = thermometers.filter(t => t.aId === id || t.bId === id);
  for (const t of myTherms) {
    const other = pins.get(t.aId === id ? t.bId : t.aId);
    if (!other) continue;
    lines.push(formatPinLine(other));
    // Always emit the original pin first, then partner
    const a = t.aId === id ? pin : other;
    const b = t.aId === id ? other : pin;
    lines.push(formatThermLine(a, b));
  }
  return lines.join('\n');
}

// Export all pins + therms (not zones — those are handled in layers.js).
export function formatAllPinsExport() {
  const lines = [];
  for (const pin of pins.values()) lines.push(formatPinLine(pin));
  for (const t of thermometers) {
    const a = pins.get(t.aId);
    const b = pins.get(t.bId);
    if (a && b) lines.push(formatThermLine(a, b));
  }
  return lines.join('\n');
}

// ---------- Import ----------

// Parse a block of jetlag-format text into structured objects.
export function parsePinsFromText(text) {
  const out = { pins: [], thermometers: [] };
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^jetlag\s+pin\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(.*)$/i))) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      const attrs = (m[3] || '').trim().split(/\s+/).filter(Boolean);
      const p = { lat, lng };
      for (const a of attrs) {
        if (a === 'locked') p.locked = true;
        else if (a.startsWith('r=')) {
          const r = parseExportRadius(a.slice(2));
          if (r != null) p.radius = r;
        } else if (a.startsWith('m=')) {
          p.measuringCategory = a.slice(2) + '.geojson';
        }
      }
      out.pins.push(p);
    } else if ((m = line.match(/^jetlag\s+therm\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*<->\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i))) {
      out.thermometers.push({
        a: { lat: parseFloat(m[1]), lng: parseFloat(m[2]) },
        b: { lat: parseFloat(m[3]), lng: parseFloat(m[4]) },
      });
    }
  }
  return out;
}

// Apply parsed pin/therm data to the map. Returns the first created pin
// (caller can pan to it / open its popup).
export function applyImportedPins(parsed) {
  const byCoord = new Map();
  let firstPin = null;
  for (const p of parsed.pins) {
    const pin = addPin(p.lat, p.lng, { locked: !!p.locked });
    if (p.radius) setCircle(pin.id, p.radius);
    if (p.measuringCategory && loadedLayers[p.measuringCategory]) {
      pin.measuringCategory = p.measuringCategory;
      drawMeasuringCircles(pin);
    }
    byCoord.set(coordKey(p.lat, p.lng), pin);
    if (!firstPin) firstPin = pin;
  }
  for (const t of parsed.thermometers) {
    const a = byCoord.get(coordKey(t.a.lat, t.a.lng));
    const b = byCoord.get(coordKey(t.b.lat, t.b.lng));
    if (a && b) createThermometer(a.id, b.id);
  }
  savePins();
  return firstPin;
}
