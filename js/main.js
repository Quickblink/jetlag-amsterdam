// Bootstrap: import side-effecting modules (which set up map, panes, sidebar
// toggle, and DOM handlers), wire the layers-loaded callback into pins, and
// kick off the initial loads.

import './map.js';   // side effect: map, panes, sidebar toggle
import './tools.js'; // side effect: tool button handlers, tracking listener
import { loadLayers, onLayersLoaded } from './layers.js';
import { loadPins, loadThermometers, refreshAllPinPopups, reapplyMeasuring } from './pins.js';
import { initTrackingFromStorage } from './tools.js';

onLayersLoaded(() => {
  // Pins were loaded before layer data was available — re-render their
  // popups (so the measuring-circles dropdown is populated) and redraw any
  // measuring circles that depend on the now-available category data.
  reapplyMeasuring();
  refreshAllPinPopups();
});

loadPins();
loadThermometers();
loadLayers();
initTrackingFromStorage();
