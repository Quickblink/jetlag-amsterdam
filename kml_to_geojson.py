#!/usr/bin/env python3
"""Convert ../maps/*.kml into per-category GeoJSON in data/, and write a
manifest.json listing them. Stdlib only.

Each KML's <Style> blocks are parsed and emitted as a `_styles` dict on the
output FeatureCollection (a foreign member that Leaflet ignores). Each
feature carries its `_styleId` in `properties` so the frontend can look up
icon URLs, fill colors, line widths, etc."""

import json
from pathlib import Path
from xml.etree import ElementTree as ET

KML_NS = "{http://www.opengis.net/kml/2.2}"


def parse_coords(text):
    pairs = []
    for tok in text.strip().split():
        parts = tok.split(",")
        if len(parts) >= 2:
            pairs.append([float(parts[0]), float(parts[1])])
    return pairs


def kml_color_to_css(kml_color):
    """KML color is AABBGGRR (alpha + B + G + R, 8 hex chars).
    Returns (rgbHex, alpha 0..1) or None on parse failure."""
    if not kml_color or len(kml_color) != 8:
        return None
    try:
        a = int(kml_color[0:2], 16) / 255.0
        b = int(kml_color[2:4], 16)
        g = int(kml_color[4:6], 16)
        r = int(kml_color[6:8], 16)
    except ValueError:
        return None
    return f"#{r:02x}{g:02x}{b:02x}", round(a, 3)


def parse_styles(root):
    styles = {}
    for s in root.iter(f"{KML_NS}Style"):
        sid = s.get("id")
        if not sid:
            continue
        out = {}
        ic = s.find(f"{KML_NS}IconStyle")
        if ic is not None:
            href = ic.find(f"{KML_NS}Icon/{KML_NS}href")
            if href is not None and href.text:
                out["iconUrl"] = href.text.strip()
            scale = ic.find(f"{KML_NS}scale")
            if scale is not None and scale.text:
                try:
                    out["iconScale"] = float(scale.text)
                except ValueError:
                    pass
            c = ic.find(f"{KML_NS}color")
            if c is not None and c.text:
                rgb_a = kml_color_to_css(c.text.strip())
                if rgb_a:
                    out["iconColor"] = rgb_a[0]
        ps = s.find(f"{KML_NS}PolyStyle")
        if ps is not None:
            c = ps.find(f"{KML_NS}color")
            if c is not None and c.text:
                rgb_a = kml_color_to_css(c.text.strip())
                if rgb_a:
                    out["fillColor"], out["fillOpacity"] = rgb_a
        ls = s.find(f"{KML_NS}LineStyle")
        if ls is not None:
            c = ls.find(f"{KML_NS}color")
            if c is not None and c.text:
                rgb_a = kml_color_to_css(c.text.strip())
                if rgb_a:
                    out["color"], out["opacity"] = rgb_a
            w = ls.find(f"{KML_NS}width")
            if w is not None and w.text:
                try:
                    out["weight"] = float(w.text)
                except ValueError:
                    pass
        if out:
            styles[sid] = out
    return styles


def placemark_to_feature(pm):
    name = (pm.findtext(f"{KML_NS}name") or "").strip()
    desc = (pm.findtext(f"{KML_NS}description") or "").strip()
    style_url = (pm.findtext(f"{KML_NS}styleUrl") or "").strip()
    props = {"name": name, "description": desc}
    if style_url.startswith("#"):
        props["_styleId"] = style_url[1:]

    pt = pm.find(f"{KML_NS}Point/{KML_NS}coordinates")
    if pt is not None:
        cs = parse_coords(pt.text)
        if cs:
            return {"type": "Feature", "geometry": {"type": "Point", "coordinates": cs[0]}, "properties": props}

    poly = pm.find(f"{KML_NS}Polygon")
    if poly is not None:
        outer = poly.find(f"{KML_NS}outerBoundaryIs/{KML_NS}LinearRing/{KML_NS}coordinates")
        if outer is not None:
            rings = [parse_coords(outer.text)]
            for inner in poly.findall(f"{KML_NS}innerBoundaryIs/{KML_NS}LinearRing/{KML_NS}coordinates"):
                rings.append(parse_coords(inner.text))
            return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": rings}, "properties": props}

    ls = pm.find(f"{KML_NS}LineString/{KML_NS}coordinates")
    if ls is not None:
        cs = parse_coords(ls.text)
        if cs:
            return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": cs}, "properties": props}

    return None


def kml_to_geojson(kml_path):
    tree = ET.parse(kml_path)
    root = tree.getroot()
    styles = parse_styles(root)
    features = []
    for pm in root.iter(f"{KML_NS}Placemark"):
        f = placemark_to_feature(pm)
        if f:
            features.append(f)
    fc = {"type": "FeatureCollection", "features": features}
    if styles:
        fc["_styles"] = styles
    return fc


def main():
    src = Path(__file__).resolve().parent.parent / "maps"
    dst = Path(__file__).resolve().parent / "data"
    dst.mkdir(exist_ok=True)

    categories = []
    for kml in sorted(src.glob("*.kml")):
        category = kml.stem
        gj = kml_to_geojson(kml)
        out = dst / f"{category}.geojson"
        out.write_text(json.dumps(gj, separators=(",", ":")))
        print(f"{kml.name} -> data/{out.name} ({len(gj['features'])} features, {len(gj.get('_styles', {}))} styles)")
        categories.append({
            "file": out.name,
            "label": category.replace("_", " ").title(),
            # First-time visitors see an empty map. Once a user toggles layers,
            # their selection is persisted in localStorage and used on reload.
            "default": False,
        })

    (dst / "manifest.json").write_text(json.dumps({"categories": categories}, indent=2))
    print(f"Wrote data/manifest.json with {len(categories)} categories")


if __name__ == "__main__":
    main()
