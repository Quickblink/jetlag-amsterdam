# Jet Lag Amsterdam

Static webmap for a Jet Lag *Hide and Seek* game in Amsterdam. Replaces Google My Maps as the
authoritative source for location-category questions, with extra in-play tools (drop pin at
current location, draw radius circles).

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Geolocation requires HTTPS (or `localhost`, which counts as secure).

## Adding / updating category data

1. Drop a new `amsterdam-<category>.kml` into the parent directory (the data-prep folder).
2. Run `python3 kml_to_geojson.py` from this directory.
3. The script regenerates `data/<category>.geojson` and `data/manifest.json`.

Edit `manifest.json` afterwards if you want to change a layer's display label or whether it's
on by default.

## Deploying to GitHub Pages

In the repo's GitHub *Settings → Pages*, set source to `main` branch, root folder. Site goes
live at `https://<user>.github.io/jetlag-amsterdam/`.

## MVP feature scope

- Toggle category overlays via the layer control (top-left).
- Drop a pin at your current location (top-right button). Pins persist in `localStorage`.
- Tap a pin → choose a radius preset (250 m, 500 m, 1 km, 2 km, 5 km, 10 km) → circle drawn.
- Pins are draggable; the circle follows.

Planned next: export pin coordinates, paste pin from clipboard, "measuring question" circles
across a whole category, thermometer perpendicular bisector between two pins.
