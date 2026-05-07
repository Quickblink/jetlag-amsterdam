// Coordinate parsing utilities: Open Location Code (Plus codes) and decimal pairs
// (bare lat/lng, Google Maps URLs, Apple Maps URLs).

const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_REF = [52.37, 4.89]; // Amsterdam — used for short-code recovery

function olcEncode(lat, lng, len = 10) {
  let la = lat + 90, lo = lng + 180;
  if (la >= 180) la = 180 - 1e-10;
  if (lo >= 360) lo -= 360;
  if (la < 0) la = 0; if (lo < 0) lo = 0;
  let code = '', res = 400;
  for (let i = 0; i < len / 2; i++) {
    res /= 20;
    const li = Math.min(Math.floor(la / res), 19);
    const oi = Math.min(Math.floor(lo / res), 19);
    code += OLC_ALPHABET[li] + OLC_ALPHABET[oi];
    la -= li * res; lo -= oi * res;
  }
  return code;
}

function olcDecodeFull(code) {
  let lat = 0, lng = 0, res = 400;
  for (let i = 0; i < Math.min(code.length, 10); i += 2) {
    res /= 20;
    lat += OLC_ALPHABET.indexOf(code[i]) * res;
    if (i + 1 < code.length) lng += OLC_ALPHABET.indexOf(code[i + 1]) * res;
  }
  let latCell = res, lngCell = res;
  if (code.length > 10) {
    let rf = res / 4, cf = res / 5;
    for (let i = 10; i < Math.min(code.length, 15); i++) {
      const c = OLC_ALPHABET.indexOf(code[i]);
      lat += Math.floor(c / 5) * rf;
      lng += (c % 5) * cf;
      latCell = rf; lngCell = cf;
      rf /= 4; cf /= 5;
    }
  }
  return [lat - 90 + latCell / 2, lng - 180 + lngCell / 2];
}

function decodePlusCode(text) {
  const m = text.toUpperCase().match(/([23456789CFGHJMPQRVWX0]{2,8})\+([23456789CFGHJMPQRVWX]{0,7})/);
  if (!m) return null;
  const prefix = m[1].replace(/0/g, '');
  const suffix = m[2];
  let full;
  if (prefix.length === 8) full = prefix + suffix;
  else if (prefix.length >= 2) {
    const refFull = olcEncode(OLC_REF[0], OLC_REF[1]);
    full = refFull.slice(0, 8 - prefix.length) + prefix + suffix;
  } else return null;
  try { return olcDecodeFull(full); }
  catch (e) { return null; }
}

export function parseCoords(text) {
  if (!text) return null;
  const plus = decodePlusCode(text);
  if (plus) return plus;
  const patterns = [
    /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/,
    /(-?\d+\.\d+)\s*[,\s]\s*(-?\d+\.\d+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lat, lng];
    }
  }
  return null;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
