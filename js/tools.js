// Sidebar tool buttons (drop pin, paste pin, export pins, viewport-center
// pin) and live position tracking. Attaches DOM handlers at module load.

import { map, toggleSidebar } from './map.js';
import { addPin, pins } from './pins.js';
import { parseCoords } from './coords.js';

const TRACK_KEY = 'jetlag.tracking.v1';

// ---------- Drop pin at current geolocation ----------
document.getElementById('drop-pin').addEventListener('click', () => {
  toggleSidebar(false);
  if (!navigator.geolocation) { alert('Geolocation is not available.'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const pin = addPin(pos.coords.latitude, pos.coords.longitude, { locked: true });
      map.panTo([pin.lat, pin.lng]);
      pin.marker.openPopup();
    },
    err => alert('Could not get location: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// ---------- Pin from clipboard ----------
document.getElementById('paste-pin').addEventListener('click', async () => {
  toggleSidebar(false);
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    alert('Clipboard reading is not available (HTTPS required).');
    return;
  }
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { alert('Could not read clipboard: ' + e.message); return; }
  const coords = parseCoords(text);
  if (!coords) {
    alert('No coordinates found in clipboard:\n' + text.slice(0, 200));
    return;
  }
  const pin = addPin(coords[0], coords[1], { locked: true });
  map.panTo([pin.lat, pin.lng]);
  pin.marker.openPopup();
});

// ---------- Export pins ----------
document.getElementById('export-pins').addEventListener('click', async () => {
  toggleSidebar(false);
  if (pins.size === 0) { alert('No pins to export.'); return; }
  const text = [...pins.values()]
    .map(p => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`)
    .join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: 'Jet Lag pins', text }); return; }
    catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      alert(`Copied ${pins.size} pin${pins.size === 1 ? '' : 's'} to clipboard.`);
      return;
    } catch (e) { console.warn(e); }
  }
  prompt('Copy these pins:', text);
});

// ---------- Pin at viewport center ----------
document.getElementById('pin-here').addEventListener('click', () => {
  const c = map.getCenter();
  const pin = addPin(c.lat, c.lng, { locked: false });
  pin.marker.openPopup();
});

// ---------- Live position tracking ----------
let positionWatchId = null;
let positionMarker = null;
let positionAccuracyCircle = null;

function startTracking() {
  if (positionWatchId !== null) return;
  if (!navigator.geolocation) { alert('Geolocation is not available.'); return; }
  positionWatchId = navigator.geolocation.watchPosition(
    pos => updateTrackedPosition(pos.coords),
    err => {
      console.warn('Position tracking error:', err.message);
      if (err.code === err.PERMISSION_DENIED) stopTracking();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
  );
  document.getElementById('track-location').classList.add('active');
  localStorage.setItem(TRACK_KEY, '1');
}

function stopTracking() {
  if (positionWatchId !== null) {
    navigator.geolocation.clearWatch(positionWatchId);
    positionWatchId = null;
  }
  if (positionMarker) { map.removeLayer(positionMarker); positionMarker = null; }
  if (positionAccuracyCircle) { map.removeLayer(positionAccuracyCircle); positionAccuracyCircle = null; }
  document.getElementById('track-location').classList.remove('active');
  localStorage.setItem(TRACK_KEY, '0');
}

function updateTrackedPosition(coords) {
  const { latitude, longitude, accuracy } = coords;
  const ll = [latitude, longitude];
  if (!positionMarker) {
    positionMarker = L.circleMarker(ll, {
      radius: 7, color: 'white', weight: 2, fillColor: '#0066cc', fillOpacity: 1,
      interactive: false,
    }).addTo(map);
    positionAccuracyCircle = L.circle(ll, {
      radius: accuracy || 10,
      color: '#0066cc', weight: 1,
      fillColor: '#0066cc', fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
  } else {
    positionMarker.setLatLng(ll);
    positionAccuracyCircle.setLatLng(ll);
    positionAccuracyCircle.setRadius(accuracy || 10);
  }
}

document.getElementById('track-location').addEventListener('click', () => {
  if (positionWatchId !== null) stopTracking();
  else startTracking();
});

export function initTrackingFromStorage() {
  if (localStorage.getItem(TRACK_KEY) === '1') startTracking();
}
