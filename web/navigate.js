// MYCELIUM -- standalone route view. Opened in a new tab from a Deal Card's NAVIGATE
// button. Intentionally minimal: just the map, two pins, the connecting route, and the
// deal's headline numbers -- nothing else from the main app.
const params = new URLSearchParams(location.search);
const sLat = parseFloat(params.get("slat")), sLon = parseFloat(params.get("slon"));
const bLat = parseFloat(params.get("blat")), bLon = parseFloat(params.get("blon"));
const sName = params.get("sname") || "Seller";
const bName = params.get("bname") || "Buyer";
const material = params.get("material") || "";
const price = params.get("price");
const distance = params.get("distance");
const saving = params.get("saving");
const co2 = params.get("co2");

function fmtINR(n) {
  n = Math.round(Number(n));
  if (!isFinite(n)) return "";
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return "₹" + (n / 1e5).toFixed(2) + " L";
  return "₹" + n.toLocaleString("en-IN");
}

document.getElementById("navinfo").innerHTML =
  "<h2>" + sName + " → " + bName + "</h2>"
  + "<div class=\"sub\">" + material + "</div>"
  + (distance ? "<div class=\"row\"><span class=\"k\">Distance</span><span>" + distance + " km</span></div>" : "")
  + (price ? "<div class=\"row\"><span class=\"k\">Price</span><span>₹" + price + "/t</span></div>" : "")
  + (saving ? "<div class=\"row\"><span class=\"k\">Saving</span><span>" + fmtINR(saving) + "/mo</span></div>" : "")
  + (co2 ? "<div class=\"row\"><span class=\"k\">CO2 avoided</span><span>" + co2 + " t</span></div>" : "");

// Same curve math as the main app's map (app.js curvedLngLats) -- kept identical so a
// route opened here always matches what was drawn on the main map for this pair.
function curvedLngLats(a, b, bend) {
  if (bend === undefined) bend = 0.18;
  const lat1 = a[0], lon1 = a[1], lat2 = b[0], lon2 = b[1];
  const mLat = (lat1 + lat2) / 2, mLon = (lon1 + lon2) / 2;
  const dx = lat2 - lat1, dy = lon2 - lon1;
  const nx = -dy, ny = dx;
  const ctrlLat = mLat + nx * bend, ctrlLon = mLon + ny * bend;
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const lat = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * ctrlLat + t * t * lat2;
    const lon = (1 - t) * (1 - t) * lon1 + 2 * (1 - t) * t * ctrlLon + t * t * lon2;
    pts.push([lon, lat]);
  }
  return pts;
}

const map = new maplibregl.Map({
  container: "navmap",
  style: {
    version: 8,
    sources: {
      "esri-dark-base": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16, attribution: "Esri, HERE, Garmin, FAO, NOAA, USGS",
      },
      "esri-dark-labels": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16, attribution: "",
      },
    },
    layers: [
      { id: "base", type: "raster", source: "esri-dark-base" },
      { id: "labels", type: "raster", source: "esri-dark-labels" },
    ],
  },
  center: [(sLon + bLon) / 2, (sLat + bLat) / 2],
  zoom: 6, pitch: 0, bearing: 0, dragRotate: false, attributionControl: true,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

function addMarker(lat, lon, color, label) {
  const el = document.createElement("div");
  el.style.cssText = "width:18px;height:18px;border-radius:50%;background:" + color + "8c;"
    + "border:2px solid " + color + ";box-shadow:0 0 14px " + color + ";";
  new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML("<b style=\"color:" + color + "\">" + label + "</b>"))
    .addTo(map);
}

map.on("load", () => {
  const coords = curvedLngLats([sLat, sLon], [bLat, bLon]);
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({
    id: "route-glow", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#35e0c0", "line-width": 9, "line-blur": 7, "line-opacity": 0.4 },
  });
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#35e0c0", "line-width": 3, "line-opacity": 0.95 },
  });

  addMarker(sLat, sLon, "#35e0c0", sName + " (seller)");
  addMarker(bLat, bLon, "#ffb454", bName + " (buyer)");

  const lons = [sLon, bLon], lats = [sLat, bLat];
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 110, maxZoom: 9, duration: 0 }
  );
});
