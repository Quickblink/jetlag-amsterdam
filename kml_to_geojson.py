#!/usr/bin/env python3
"""Convert ../maps/*.kml into per-category GeoJSON in data/, and write a
manifest.json listing them. Stdlib only."""

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


def placemark_to_feature(pm):
    name = (pm.findtext(f"{KML_NS}name") or "").strip()
    desc = (pm.findtext(f"{KML_NS}description") or "").strip()
    props = {"name": name, "description": desc}

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
    features = []
    for pm in root.iter(f"{KML_NS}Placemark"):
        f = placemark_to_feature(pm)
        if f:
            features.append(f)
    return {"type": "FeatureCollection", "features": features}


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
        print(f"{kml.name} -> data/{out.name} ({len(gj['features'])} features)")
        categories.append({
            "file": out.name,
            "label": category.replace("_", " ").title(),
            # transit_stations has 1641 points — too noisy to show by default
            "default": category != "transit_stations",
        })

    (dst / "manifest.json").write_text(json.dumps({"categories": categories}, indent=2))
    print(f"Wrote data/manifest.json with {len(categories)} categories")


if __name__ == "__main__":
    main()
