// Map setup, custom panes, sidebar toggle. No app-level dependencies — only
// reads from the DOM and the global L from Leaflet's CDN script.

export const AMSTERDAM = [52.37, 4.89];

export const map = L.map('map', { preferCanvas: true }).setView(AMSTERDAM, 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

// Pane for measuring circles. Inside the pane each circle is rendered with
// fillOpacity:1.0 + stroke:false so overlaps merge into one shape on the
// pane's canvas; the pane's CSS opacity then makes the merged shape
// translucent — visually the union of all circles rather than stacked disks.
//
// The pane has pointer-events: none because its canvas would otherwise sit
// at zIndex 410 above the regular overlayPane (400) and intercept clicks
// for the whole map area, breaking selection of polygons (voronoi cells)
// underneath. Measuring circles are non-interactive anyway.
const measuringPane = map.createPane('measuring');
measuringPane.style.opacity = '0.35';
measuringPane.style.zIndex = '410';
measuringPane.style.pointerEvents = 'none';
export const measuringRenderer = L.canvas({ pane: 'measuring' });

// Sidebar toggle
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menu-toggle');

export function toggleSidebar(force) {
  const willOpen = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', willOpen);
  // body class drives CSS that hides map-side buttons (e.g. the +) while
  // the sidebar is open, so they don't sit in front of the menu.
  document.body.classList.toggle('sidebar-open', willOpen);
}

menuBtn.addEventListener('click', e => { e.stopPropagation(); toggleSidebar(); });
document.addEventListener('click', e => {
  if (!sidebar.contains(e.target) && e.target !== menuBtn) toggleSidebar(false);
});
