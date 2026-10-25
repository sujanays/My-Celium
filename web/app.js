// MYCELIUM frontend -- vanilla JS, no build step. MapLibre GL for the map.
const API = "";
let facilitiesById = {};
let markersById = {};
let map;
let hud = { inr: 0, co2: 0, deals: 0 };
let currentDiscovery = null;
let previousDiscovery = null;
let activeSource = null;
let lastSelectedMatch = null; // {type, payload} -- for the "renegotiate under shock" beat
let negotiationGen = 0; // bumped on every new negotiation start
let arcSeq = 0; // unique id counter for arc GeoJSON features/layers

const INDUSTRY_COLOR = {
  metallurgical: "#8fa3ff", cement: "#c9a24a", food_beverage: "#ff9f6b",
  energy: "#ff5d5d", textile: "#e06bd9", construction_materials: "#6bd9a8",
  agro_processing: "#9dd96b", paper_chemicals: "#6bc7d9",
};

function fmtINR(n) {
  n = Math.round(n);
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  if (n >= 1e7) return sign + "₹" + (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return sign + "₹" + (n / 1e5).toFixed(2) + " L";
  return sign + "₹" + n.toLocaleString("en-IN");
}
function fmtT(n) { return Math.round(n).toLocaleString("en-IN") + " t"; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- map init
function webglSupported() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch (e) { return false; }
}

function initMap() {
  if (typeof maplibregl === "undefined") {
    showFatalBanner("MapLibre GL failed to load from CDN (check network access to unpkg.com).\n"
      + "Facility list will still work below once this is resolved.");
    return Promise.resolve();
  }
  if (!webglSupported()) {
    showFatalBanner("This browser/environment has no WebGL available, so MapLibre cannot render.\n"
      + "This is a hardware/browser limitation, not an app bug -- try a different browser,\n"
      + "enable hardware acceleration, or run outside a restricted VM/remote-desktop session.");
    return Promise.resolve();
  }
  try {
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        sources: {
          "esri-dark-base": {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 16,
            attribution: "Esri, HERE, Garmin, FAO, NOAA, USGS",
          },
          "esri-dark-labels": {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256, maxzoom: 16,
            attribution: "",
          },
        },
        layers: [
          { id: "esri-dark-base-layer", type: "raster", source: "esri-dark-base" },
          { id: "esri-dark-labels-layer", type: "raster", source: "esri-dark-labels" },
        ],
      },
      center: [78.5, 18.5],
      zoom: 4.4,
      pitch: 0,
      bearing: 0,
      dragRotate: false,
      attributionControl: true,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("error", (e) => {
      console.error("MapLibre error:", e);
      const msg = (e && e.error && e.error.message) ? e.error.message : JSON.stringify(e).slice(0, 200);
      showFatalBanner("Map error: " + msg);
    });

    function addArcsLayer() {
      if (map.getSource("arcs")) return;
      map.addSource("arcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      map.addLayer({
        id: "arcs-glow", type: "line", source: "arcs",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["*", ["get", "width"], 5],
          "line-blur": 6,
          "line-opacity": ["*", ["get", "opacity"], 0.45],
        },
      });
      map.addLayer({
        id: "arcs-layer", type: "line", source: "arcs",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["get", "width"],
          "line-opacity": ["get", "opacity"],
        },
      });
      map.addSource("packets", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "packets-glow", type: "circle", source: "packets",
        paint: { "circle-radius": 11, "circle-color": ["get", "color"], "circle-blur": 1, "circle-opacity": 0.55 },
      });
      map.addLayer({
        id: "packets-layer", type: "circle", source: "packets",
        paint: { "circle-radius": 4, "circle-color": "#ffffff", "circle-opacity": 0.95 },
      });
      setupHoverPopup();
      startBreathing();
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; try { addArcsLayer(); } catch (e) { console.error(e); } resolve(); };
      map.on("load", finish);
      setTimeout(finish, 4000);
    });
  } catch (e) {
    console.error("MapLibre construction failed:", e);
    showFatalBanner("Map failed to initialize: " + (e && e.message ? e.message : e));
    return Promise.resolve();
  }
}

function showFatalBanner(text) {
  if (document.getElementById("fatal-banner")) return;
  const div = document.createElement("div");
  div.id = "fatal-banner";
  div.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;"
    + "background:#1a0f0f;border:1px solid #ff5d5d;color:#ff5d5d;font-family:Consolas,monospace;"
    + "padding:14px 18px;border-radius:8px;max-width:80%;font-size:12.5px;white-space:pre-wrap;";
  div.textContent = text;
  document.getElementById("map").appendChild(div);
}

function volumeOf(f) {
  const outs = (f.outputs || []).reduce((s, o) => s + o.qty_t_per_month, 0);
  const ins = (f.inputs || []).reduce((s, i) => s + i.qty_t_per_month, 0);
  return outs + ins;
}

function renderFacilities(facilities) {
  facilities.forEach((f) => { facilitiesById[f.id] = f; });
  if (!map) {
    const panel = document.getElementById("sidepanel");
    panel.style.display = "block";
    panel.innerHTML = "<h3>Facilities (map unavailable)</h3>" + facilities.map((f) =>
      "<div class=\"match-row\" style=\"cursor:default\"><div class=\"mr-title\">" + f.name + "</div>"
      + "<div class=\"mr-sub\">" + f.cluster + " · " + f.industry + "</div></div>").join("");
    return;
  }
  facilities.forEach((f) => {
    const vol = volumeOf(f);
    const diameter = 10 + Math.min(28, Math.sqrt(vol) / 2.5);
    const color = INDUSTRY_COLOR[f.industry] || "#9aa8a3";

    const el = document.createElement("div");
    el.className = "node-marker node-pulse";
    el.style.width = diameter + "px";
    el.style.height = diameter + "px";
    el.style.background = color + "8c";
    el.style.border = "1.5px solid " + color;
    el.style.color = color;

    const roleTxt = [
      f.outputs && f.outputs.length ? "<b>Produces:</b> " + f.outputs.map(o => o.material.replace(/_/g, " ")).join(", ") : "",
      f.inputs && f.inputs.length ? "<b>Needs:</b> " + f.inputs.map(i => i.material.replace(/_/g, " ")).join(", ") : "",
    ].filter(Boolean).join("<br>");
    const popup = new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(
      "<b style=\"color:" + color + "\">" + f.name + "</b><br><span style=\"opacity:0.7\">" + f.cluster + "</span><br>" + roleTxt
    );

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([f.lon, f.lat])
      .setPopup(popup)
      .addTo(map);
    f._el = el;
    markersById[f.id] = marker;
  });
}

// ---------------------------------------------------------------- arcs (GeoJSON line layer)
let arcFeatures = {};

function curvedLngLats(a, b, bend) {
  if (bend === undefined) bend = 0.18;
  const lat1 = a[0], lon1 = a[1], lat2 = b[0], lon2 = b[1];
  const mLat = (lat1 + lat2) / 2, mLon = (lon1 + lon2) / 2;
  const dx = lat2 - lat1, dy = lon2 - lon1;
  const nx = -dy, ny = dx;
  const ctrlLat = mLat + nx * bend, ctrlLon = mLon + ny * bend;
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.025) {
    const lat = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * ctrlLat + t * t * lat2;
    const lon = (1 - t) * (1 - t) * lon1 + 2 * (1 - t) * t * ctrlLon + t * t * lon2;
    pts.push([lon, lat]);
  }
  return pts;
}

function syncArcsSource() {
  if (!map) return;
  const src = map.getSource("arcs");
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: Object.values(arcFeatures).map((a) => a.feature) });
}

async function drawArc(fromId, toId, opts) {
  opts = opts || {};
  const a = facilitiesById[fromId], b = facilitiesById[toId];
  if (!a || !b) return;
  const fullCoords = curvedLngLats([a.lat, a.lon], [b.lat, b.lon], opts.bend);
  const id = "arc_" + (arcSeq++);
  const color = opts.color || "#35e0c0";
  const width = opts.weight || 2;
  const opacity = opts.opacity === undefined ? 0.75 : opts.opacity;
  const meta = opts.meta || {};
  const props = {
    color, width, opacity: 0, base_opacity: opacity, match_key: opts.matchKey || null,
    seller_name: meta.seller_name || a.name, buyer_name: meta.buyer_name || b.name,
    material_name: meta.material_name || null,
    distance_km: meta.distance_km != null ? meta.distance_km : null,
    total_saving_inr: meta.total_saving_inr != null ? meta.total_saving_inr : null,
    co2_avoided_t: meta.co2_avoided_t != null ? meta.co2_avoided_t : null,
  };

  arcFeatures[id] = {
    feature: { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: [fullCoords[0]] } },
  };
  syncArcsSource();

  const steps = fullCoords.length;
  const durationMs = opts.durationMs || 700;
  const stepMs = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    arcFeatures[id].feature.geometry.coordinates = fullCoords.slice(0, i + 1);
    arcFeatures[id].feature.properties.opacity = opacity;
    syncArcsSource();
    await sleep(stepMs);
  }
  return id;
}

function clearArcs() { arcFeatures = {}; syncArcsSource(); }

// ---------------------------------------------------------------- focus mode
function arcsWithMatchKey(matchKey) {
  return Object.values(arcFeatures).filter((a) => a.feature.properties.match_key === matchKey);
}

async function ensureMatchDrawn(type, idx) {
  const d = currentDiscovery;
  const matchKey = type + ":" + idx;
  if (arcsWithMatchKey(matchKey).length > 0) return matchKey;
  if (type === "pair") {
    const p = d.pairs[idx];
    await drawArc(p.seller_id, p.buyer_id, { color: "#35e0c0", weight: 2.5, opacity: 0.85, durationMs: 400, meta: p, matchKey });
  } else if (type === "cascade") {
    const c = d.cascades[idx];
    for (let i = 0; i < c.nodes.length - 1; i++) {
      await drawArc(c.nodes[i], c.nodes[i + 1], { color: "#6bc7d9", weight: 2.5, opacity: 0.85, durationMs: 400, meta: c.legs[i], matchKey });
    }
  } else if (type === "cycle") {
    const cyc = d.cycles[idx];
    const n = cyc.nodes.length;
    for (let i = 0; i < n; i++) {
      await drawArc(cyc.nodes[i], cyc.nodes[(i + 1) % n], { color: "#ffb454", weight: 3, opacity: 0.9, bend: 0.22, durationMs: 400, meta: cyc.legs[i], matchKey });
    }
  } else if (type === "ghost") {
    const g = d.rejected.slice().sort((a, b) => a.distance_km - b.distance_km)[0];
    await drawArc(g.seller_id, g.buyer_id, { color: "#ff5d5d", weight: 2, opacity: 0.7, durationMs: 400, meta: g, matchKey });
  }
  return matchKey;
}

let focusedMatchKey = null;
let layerVisible = { pair: true, cascade: true, cycle: true, ghost: true };

function applyArcVisibility() {
  Object.values(arcFeatures).forEach((a) => {
    const p = a.feature.properties;
    const layer = (p.match_key || "").split(":")[0];
    const visible = focusedMatchKey ? (p.match_key === focusedMatchKey) : (layerVisible[layer] !== false);
    p.opacity = visible ? p.base_opacity : 0;
  });
  syncArcsSource();
}

function toggleLayer(layer) {
  layerVisible[layer] = !layerVisible[layer];
  applyArcVisibility();
}

function focusMatch(matchKey, nodeIds) {
  focusedMatchKey = matchKey;
  applyArcVisibility();
  const nodeSet = new Set(nodeIds);
  Object.entries(facilitiesById).forEach(([id, f]) => {
    if (!f._el) return;
    if (nodeSet.has(id)) f._el.classList.remove("node-dimmed");
    else f._el.classList.add("node-dimmed");
  });
}

function clearFocus() {
  focusedMatchKey = null;
  applyArcVisibility();
  Object.values(facilitiesById).forEach((f) => { if (f._el) f._el.classList.remove("node-dimmed"); });
}

function igniteRing(nodeIds) {
  nodeIds.forEach((id) => {
    const f = facilitiesById[id];
    if (f && f._el) {
      const el = f._el;
      const w = parseFloat(el.style.width) || 16, h = parseFloat(el.style.height) || 16;
      const origW = el.style.width, origH = el.style.height;
      el.style.transition = "width 0.3s ease, height 0.3s ease";
      el.style.filter = "drop-shadow(0 0 16px #ffb454)";
      el.style.width = (w * 1.4) + "px";
      el.style.height = (h * 1.4) + "px";
      setTimeout(() => {
        el.style.filter = "";
        el.style.width = origW;
        el.style.height = origH;
      }, 2200);
    }
  });
}

// ---------------------------------------------------------------- hover tooltips on routes
let hoverPopup = null;
function setupHoverPopup() {
  hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px" });
  map.on("mousemove", "arcs-layer", (e) => {
    if (!e.features || !e.features.length) return;
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    if (!p.material_name) { hoverPopup.remove(); return; }
    const rows = [
      "<b style=\"color:#35e0c0\">" + escapeHtml(p.seller_name) + " → " + escapeHtml(p.buyer_name) + "</b>",
      escapeHtml(p.material_name),
    ];
    const stats = [];
    if (p.distance_km != null) stats.push(p.distance_km + " km");
    if (p.total_saving_inr != null) stats.push(fmtINR(p.total_saving_inr) + "/mo");
    if (p.co2_avoided_t != null) stats.push(fmtT(p.co2_avoided_t) + " CO2");
    if (stats.length) rows.push("<span style=\"color:var(--ink-dim)\">" + stats.join(" · ") + "</span>");
    hoverPopup.setLngLat(e.lngLat).setHTML(rows.join("<br>")).addTo(map);
  });
  map.on("mouseleave", "arcs-layer", () => {
    map.getCanvas().style.cursor = "";
    hoverPopup.remove();
  });
}

// ---------------------------------------------------------------- ambient glow "breathing"
function startBreathing() {
  setInterval(() => {
    if (!map || !map.getLayer("arcs-glow")) return;
    const factor = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 900));
    try { map.setPaintProperty("arcs-glow", "line-opacity", ["*", ["get", "opacity"], factor]); } catch (e) { }
  }, 120);
}

// ---------------------------------------------------------------- traveling light packets
let packetFeatures = {};
let packetSeq = 0;
function syncPacketsSource() {
  if (!map) return;
  const src = map.getSource("packets");
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: Object.values(packetFeatures) });
}
async function spawnPacket(sellerId, buyerId, durationMs, reverse, bend) {
  const a = facilitiesById[sellerId], b = facilitiesById[buyerId];
  if (!a || !b || !map) return;
  const myGen = negotiationGen;
  let path = curvedLngLats([a.lat, a.lon], [b.lat, b.lon], bend);
  if (reverse) path = path.slice().reverse();
  const id = "pkt_" + (packetSeq++);
  durationMs = durationMs || 2000;
  const steps = 44;
  const stepMs = durationMs / steps;
  for (let i = 0; i <= steps; i++) {
    if (myGen !== negotiationGen) break;
    const t = i / steps;
    const idx = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
    packetFeatures[id] = { type: "Feature", properties: { color: "#35e0c0" }, geometry: { type: "Point", coordinates: path[idx] } };
    syncPacketsSource();
    await sleep(stepMs);
  }
  delete packetFeatures[id];
  syncPacketsSource();
}

// ---------------------------------------------------------------- radar "thinking" ping
function startPing(facilityId) {
  const f = facilitiesById[facilityId];
  if (!f || !f._el || f._el.querySelector(".radar-ping")) return;
  const ping = document.createElement("div");
  ping.className = "radar-ping";
  f._el.appendChild(ping);
}
function stopPing(facilityId) {
  const f = facilitiesById[facilityId];
  if (!f || !f._el) return;
  const ping = f._el.querySelector(".radar-ping");
  if (ping) ping.remove();
}

// ---------------------------------------------------------------- camera fly-to on selection
function flyToMatch(nodeIds) {
  if (!map) return;
  const pts = nodeIds.map((id) => facilitiesById[id]).filter(Boolean);
  if (!pts.length) return;
  if (pts.length === 1) {
    map.flyTo({ center: [pts[0].lon, pts[0].lat], zoom: 8, duration: 1200 });
    return;
  }
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  pts.forEach((p) => {
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  });
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 120, duration: 1400, maxZoom: 9 });
}

// ---------------------------------------------------------------- engine log
function logShow() { document.getElementById("enginelog").classList.add("show"); }
function logClear() { document.getElementById("enginelog").innerHTML = ""; }
async function logLine(text, cls, delay) {
  const box = document.getElementById("enginelog");
  const div = document.createElement("div");
  div.className = "log-line" + (cls ? " " + cls : "");
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  await sleep(delay === undefined ? 260 : delay);
}

// ---------------------------------------------------------------- system monitor
function sysShow() { document.getElementById("sysmonitor").classList.add("show"); }
function sysClear() { document.getElementById("sysmonitor-body").innerHTML = ""; }
function sysLog(text, cls) {
  const box = document.getElementById("sysmonitor-body");
  const div = document.createElement("div");
  div.className = "sys-line" + (cls ? " " + cls : "");
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 40) box.removeChild(box.firstChild);
}

async function runDiscoveryLog(stats, cycles, cascades, pairs, rejected) {
  logClear(); logShow();
  await logLine("> Connecting to facility network (24 nodes, 6 industrial clusters)...", null, 220);
  await logLine("> Scanning " + stats.facilities_scanned + " facilities for byproduct/need declarations...", null, 260);
  await logLine("> Building directed compatibility graph: material match x quantity threshold...", null, 260);
  await logLine("> " + stats.candidate_pairs_evaluated + " candidate byproduct<->need pairs enumerated.", "dim", 220);
  await logLine("> Scoring routes: road-distance x freight tariff x emission factor, per pair...", null, 300);
  await logLine("> Cross-checking regulatory compliance (MoEFCC Fly Ash Notification 2009, CPCB Hazardous Waste Rules 2016)...", null, 340);
  if (rejected.length) await logLine("> " + rejected.length + " pair(s) REJECTED on compliance grounds.", "warn", 260);
  await logLine("> Running cycle detection across the directed graph (Johnson's algorithm, length <= 4)...", null, 340);
  if (cycles.length) await logLine("> *** CLOSED LOOP DETECTED *** " + cycles.length + " ring(s) found.", "hit", 300);
  else await logLine("> No closed loops in current graph state.", "dim", 200);
  await logLine("> Detecting 3-node cascades (shared intermediate facility)...", null, 260);
  await logLine("> " + cascades.length + " cascade chain(s) found.", "dim", 200);
  await logLine("> Ranking " + stats.viable_pairs + " viable matches by symbiosis score (Rs saved + shadow CO2 value)...", null, 280);
  await logLine("> Discovery complete. Rendering network...", "hit", 200);
}

// ---------------------------------------------------------------- discover
async function discover() {
  document.getElementById("btn-discover").disabled = true;
  const res = await fetch(API + "/api/discover");
  previousDiscovery = currentDiscovery;
  currentDiscovery = await res.json();
  clearArcs();
  clearFocus();

  await runDiscoveryLog(currentDiscovery.stats, currentDiscovery.cycles, currentDiscovery.cascades,
    currentDiscovery.pairs, currentDiscovery.rejected);

  renderNetworkReadout(currentDiscovery.network);
  renderSidepanel(currentDiscovery);
  document.getElementById("btn-discover").disabled = false;

  const pairsAll = currentDiscovery.pairs;
  for (let i = 0; i < pairsAll.length; i++) {
    const p = pairsAll[i];
    drawArc(p.seller_id, p.buyer_id, { color: "#35e0c0", weight: 1.5, opacity: 0.45, durationMs: 180, meta: p, matchKey: "pair:" + i });
    await sleep(35);
  }
  const cascadesAll = currentDiscovery.cascades;
  for (let ci = 0; ci < cascadesAll.length; ci++) {
    const c = cascadesAll[ci];
    for (let i = 0; i < c.nodes.length - 1; i++) {
      drawArc(c.nodes[i], c.nodes[i + 1], { color: "#6bc7d9", weight: 2, opacity: 0.6, durationMs: 220, meta: c.legs[i], matchKey: "cascade:" + ci });
      await sleep(45);
    }
  }
  if (currentDiscovery.cycles.length) {
    await sleep(300);
    for (let ci = 0; ci < currentDiscovery.cycles.length; ci++) {
      const cyc = currentDiscovery.cycles[ci];
      const n = cyc.nodes.length;
      for (let i = 0; i < n; i++) {
        await drawArc(cyc.nodes[i], cyc.nodes[(i + 1) % n], { color: "#ffb454", weight: 3, opacity: 0.9, bend: 0.22, durationMs: 500, meta: cyc.legs[i], matchKey: "cycle:" + ci });
      }
      igniteRing(cyc.nodes);
    }
  }
}

function shortName(id) {
  const f = facilitiesById[id];
  if (!f) return id;
  return f.name.split(" ").slice(0, 2).join(" ");
}

function renderSidepanel(d) {
  const panel = document.getElementById("sidepanel");
  panel.style.display = "block";
  let html = "";
  if (d.cycles.length) {
    html += "<h3>⟲ Closed Loops (" + d.cycles.length + ")</h3>";
    d.cycles.forEach((c, i) => {
      html += "<div class=\"match-row\" data-type=\"cycle\" data-idx=\"" + i + "\">"
        + "<div class=\"mr-title\">" + c.nodes.map(shortName).join(" → ") + " → ↩</div>"
        + "<div class=\"mr-sub\">" + fmtINR(c.total_saving_inr) + "/mo · " + fmtT(c.total_co2_avoided_t) + " CO2</div>"
        + "</div>";
    });
  }
  if (d.cascades.length) {
    html += "<h3>⇢ Cascades (" + d.cascades.length + ")</h3>";
    d.cascades.forEach((c, i) => {
      html += "<div class=\"match-row\" data-type=\"cascade\" data-idx=\"" + i + "\">"
        + "<div class=\"mr-title\">" + c.nodes.map(shortName).join(" → ") + "</div>"
        + "<div class=\"mr-sub\">" + fmtINR(c.total_saving_inr) + "/mo</div></div>";
    });
  }
  html += "<h3>⟷ Pairs (" + d.pairs.length + ")</h3>";
  d.pairs.forEach((p, i) => {
    html += "<div class=\"match-row\" data-type=\"pair\" data-idx=\"" + i + "\">"
      + "<div class=\"mr-title\">" + shortName(p.seller_id) + " → " + shortName(p.buyer_id) + "</div>"
      + "<div class=\"mr-sub\">" + p.material_name + " · " + fmtINR(p.total_saving_inr) + "/mo · " + p.distance_km + "km</div></div>";
  });
  if (d.rejected.length) {
    const ghost = d.rejected.slice().sort((a, b) => a.distance_km - b.distance_km)[0];
    html += "<h3 style=\"color:#ff5d5d\">✕ Ghost Match</h3>"
      + "<div class=\"match-row\" data-type=\"ghost\" data-idx=\"0\">"
      + "<div class=\"mr-title\">" + shortName(ghost.seller_id) + " → " + shortName(ghost.buyer_id) + "</div>"
      + "<div class=\"mr-sub\">" + ghost.material_name + " · " + ghost.distance_km + "km · chemically perfect, legally blocked</div></div>";
  }
  panel.innerHTML = html;
  panel.querySelectorAll(".match-row").forEach((row) => {
    row.addEventListener("click", () => onMatchClick(row.dataset.type, +row.dataset.idx));
  });
}

async function onMatchClick(type, idx) {
  const d = currentDiscovery;
  lastSelectedMatch = { type, idx };
  const matchKey = await ensureMatchDrawn(type, idx);

  if (type === "pair") {
    const nodes = [d.pairs[idx].seller_id, d.pairs[idx].buyer_id];
    focusMatch(matchKey, nodes); flyToMatch(nodes);
    startPairNegotiation(d.pairs[idx]);
  } else if (type === "ghost") {
    const g = d.rejected.slice().sort((a, b) => a.distance_km - b.distance_km)[0];
    const nodes = [g.seller_id, g.buyer_id];
    focusMatch(matchKey, nodes); flyToMatch(nodes);
    showGhostVeto(g);
  } else if (type === "cascade") {
    focusMatch(matchKey, d.cascades[idx].nodes); flyToMatch(d.cascades[idx].nodes);
    startCascade(d.cascades[idx]);
  } else if (type === "cycle") {
    focusMatch(matchKey, d.cycles[idx].nodes); flyToMatch(d.cycles[idx].nodes);
    startLoop(d.cycles[idx]);
  }
}

// ---------------------------------------------------------------- theatre
// The theatre is a chat history: every negotiation is a <details class="session">.
// Starting a new one collapses the previous session instead of wiping it, and the
// whole history is persisted to localStorage so it survives reloads.
const HISTORY_KEY = "mycelium_theatre_history";
const HISTORY_MAX_SESSIONS = 30;

function liveSession() { return document.querySelector("#theatre-body .session.live"); }

function renderSessionSummary(session) {
  const t = new Date(Number(session.dataset.started));
  session.querySelector(":scope > summary").innerHTML =
    "<span class=\"s-title\">" + escapeHtml(session.dataset.title) + "</span>"
    + "<span class=\"s-status\">" + escapeHtml(session.dataset.status || "running…") + "</span>"
    + "<span class=\"s-time\">" + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</span>";
}

function setSessionStatus(text, session, append) {
  session = session || liveSession();
  if (!session) return;
  session.dataset.status = append && session.dataset.status ? session.dataset.status + " · " + text : text;
  renderSessionSummary(session);
  saveHistory();
}

function archiveLiveSession() {
  const live = liveSession();
  if (!live) return;
  if (!live.querySelector(".turn-card, .deal-card, .veto-card, .loop-banner")) { live.remove(); return; }
  live.classList.remove("live");
  live.open = false;
  if (!live.dataset.status) setSessionStatus("interrupted", live);
}

function startSession(title) {
  const body = document.getElementById("theatre-body");
  archiveLiveSession();
  body.querySelectorAll(":scope > .theatre-empty").forEach((el) => el.remove());
  const s = document.createElement("details");
  s.className = "session live";
  s.open = true;
  s.dataset.title = title || "Session";
  s.dataset.started = Date.now();
  s.innerHTML = "<summary></summary><div class=\"session-content\"></div>";
  body.appendChild(s);
  renderSessionSummary(s);
  body.scrollTop = body.scrollHeight;
  saveHistory();
  return s;
}

// kept for existing callers: starts a fresh session, archiving (not erasing) the old one
function clearTheatre(title) {
  if (title) startSession(title);
  else { archiveLiveSession(); saveHistory(); }
}

function appendTheatre(html, session) {
  const target = session || liveSession() || startSession("Session");
  const div = document.createElement("div");
  div.innerHTML = html;
  target.querySelector(":scope > .session-content").appendChild(div.firstElementChild);
  if (target.classList.contains("live")) {
    const body = document.getElementById("theatre-body");
    body.scrollTop = body.scrollHeight;
  }
  saveHistory();
}

let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = document.getElementById("theatre-body");
    const sessions = body.querySelectorAll(":scope > .session");
    for (let i = 0; i < sessions.length - HISTORY_MAX_SESSIONS; i++) sessions[i].remove();
    try { localStorage.setItem(HISTORY_KEY, body.innerHTML); } catch (e) { /* storage full or blocked */ }
    updateHistoryCount();
  }, 300);
}

function restoreHistory() {
  let html = null;
  try { html = localStorage.getItem(HISTORY_KEY); } catch (e) { /* blocked */ }
  if (!html) return;
  const body = document.getElementById("theatre-body");
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const sessions = tmp.querySelectorAll(":scope > .session");
  if (!sessions.length) return;
  body.innerHTML = "";
  sessions.forEach((s) => {
    s.classList.remove("live");
    s.open = false;
    if (!s.dataset.status) s.dataset.status = "interrupted";
    body.appendChild(s);
    renderSessionSummary(s);
  });
  body.scrollTop = body.scrollHeight;
  updateHistoryCount();
}

function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* blocked */ }
  document.getElementById("theatre-body").innerHTML =
    "<div class=\"theatre-empty\">History cleared.<br><br>Click <b>DISCOVER</b> and pick a match to negotiate.</div>";
  updateHistoryCount();
}

function updateHistoryCount() {
  const n = document.querySelectorAll("#theatre-body > .session").length;
  const el = document.getElementById("history-count");
  if (el) el.textContent = n ? n + " session" + (n === 1 ? "" : "s") : "";
}

function dealFromCard(el) {
  const card = el.closest(".deal-card");
  try { return card && card.dataset.deal ? JSON.parse(decodeURIComponent(card.dataset.deal)) : null; } catch (e) { return null; }
}

function renderDecisionCard(kind, d, note) {
  const heads = { approve: "✓ Deal Approved", reject: "✕ Deal Rejected", navigate: "🧭 Navigation Opened" };
  const lines = {
    approve: "Human sign-off recorded. This deal is final.",
    reject: "Recorded as a hard constraint for the next negotiation between these two facilities.",
    navigate: "Live route opened in a new tab for the logistics run.",
  };
  const row = (k, v) => "<div class=\"deal-row\"><span class=\"k\">" + k + "</span><span>" + v + "</span></div>";
  let rows = "";
  if (d) {
    rows += row("Route", escapeHtml(d.seller_name) + " → " + escapeHtml(d.buyer_name));
    rows += row("Material", escapeHtml(d.material_name));
    rows += row("Price", "₹" + d.price_inr_per_t + "/t × " + d.tonnes + "t");
    if (kind === "navigate") rows += row("Distance", d.distance_km + " km");
    else {
      rows += row("Saving", fmtINR(d.total_saving_inr) + "/mo");
      rows += row("CO2 avoided", fmtT(d.co2_avoided_t));
    }
  }
  if (note) rows += row("Reason", escapeHtml(note));
  rows += row("At", new Date().toLocaleString());
  return "<div class=\"decision-card " + kind + "\"><h3>" + heads[kind] + "</h3>"
    + "<div class=\"decision-line\">" + lines[kind] + "</div>" + rows + "</div>";
}

function escapeHtml(s) { const d = document.createElement("div"); d.innerText = s == null ? "" : s; return d.innerHTML; }

function renderTurnCard(t) {
  return "<div class=\"turn-card\">"
    + "<div class=\"turn-head\"><span class=\"who " + t.agent_role + "\">" + t.agent_name + "</span>"
    + "<span class=\"action-badge " + t.action + "\">" + t.action + "</span></div>"
    + "<div class=\"turn-cols\">"
    + "<div class=\"turn-col public\"><span class=\"col-label\">Says out loud</span>" + escapeHtml(t.public_message) + "</div>"
    + "<div class=\"turn-col private\"><span class=\"col-label\">Actually thinking</span>" + escapeHtml(t.private_reasoning) + "</div>"
    + "</div>"
    + "<div class=\"turn-terms\">₹" + t.price_inr_per_t + "/t · " + t.volume_t_per_month + "t/mo · "
    + t.logistics_split.replace(/_/g, " ") + " · confidence " + (t.confidence * 100).toFixed(0) + "%</div></div>";
}

function renderToolChips(ev) {
  return "<div style=\"padding:2px 4px 8px\">"
    + "<span class=\"tool-chip\">⚙ route: " + ev.distance_km + "km</span>"
    + "<span class=\"tool-chip\">⚙ verdict: " + ev.compliance.verdict + "</span></div>";
}

function renderConvergenceChart(turns, settlementPrice) {
  if (!turns || turns.length === 0) return "";
  const W = 300, H = 130, padL = 12, padR = 12, padT = 22, padB = 24;
  const prices = turns.map((t) => t.price_inr_per_t);
  if (settlementPrice != null) prices.push(settlementPrice);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const pad = (maxP - minP) * 0.25 || Math.max(maxP * 0.1, 10);
  const yMin = minP - pad, yMax = maxP + pad;
  const maxRound = Math.max(...turns.map((t) => t.round), 1);

  const xScale = (r) => padL + (maxRound <= 1 ? 0.5 : (r - 1) / (maxRound - 1)) * (W - padL - padR);
  const yScale = (p) => padT + (1 - (p - yMin) / (yMax - yMin)) * (H - padT - padB);
  const path = (pts) => pts.length ? pts.map((t, i) => (i === 0 ? "M" : "L") + xScale(t.round).toFixed(1) + "," + yScale(t.price_inr_per_t).toFixed(1)).join(" ") : "";
  const dots = (pts, color) => pts.map((t) => "<circle cx=\"" + xScale(t.round).toFixed(1) + "\" cy=\"" + yScale(t.price_inr_per_t).toFixed(1) + "\" r=\"3.5\" fill=\"" + color + "\" />").join("");

  const sellerPts = turns.filter((t) => t.agent_role === "seller");
  const buyerPts = turns.filter((t) => t.agent_role === "buyer");

  let ticks = "";
  for (let r = 1; r <= maxRound; r++) {
    const x = xScale(r);
    ticks += "<text x=\"" + x.toFixed(1) + "\" y=\"" + (H - padB + 14) + "\" fill=\"#6f8b83\" font-size=\"8\" text-anchor=\"middle\">R" + r + "</text>";
  }

  const label = (t, color, dy) => "<text x=\"" + xScale(t.round).toFixed(1) + "\" y=\"" + (yScale(t.price_inr_per_t) + dy).toFixed(1)
    + "\" fill=\"" + color + "\" font-size=\"9\" font-weight=\"700\" text-anchor=\"middle\">₹" + t.price_inr_per_t + "</text>";

  let openLabels = "";
  if (sellerPts.length) openLabels += label(sellerPts[0], "#35e0c0", -10);
  if (buyerPts.length) openLabels += label(buyerPts[0], "#ffb454", buyerPts[0].round === (sellerPts[0] && sellerPts[0].round) ? 18 : -10);

  let settleMark = "", settleLabel = "";
  if (settlementPrice != null) {
    const sx = xScale(maxRound), sy = yScale(settlementPrice);
    settleMark = "<circle cx=\"" + sx.toFixed(1) + "\" cy=\"" + sy.toFixed(1) + "\" r=\"5.5\" fill=\"#0a0f0d\" stroke=\"#ffffff\" stroke-width=\"2\" />";
    settleLabel = "<text x=\"" + sx.toFixed(1) + "\" y=\"" + (sy - 12).toFixed(1) + "\" fill=\"#ffffff\" font-size=\"10\" font-weight=\"700\" text-anchor=\"end\">SETTLED ₹" + settlementPrice + "</text>";
  }

  const caption = settlementPrice != null
    ? "Opened " + turns.length + "-round negotiation → settled ₹" + settlementPrice + "/t"
    : "Gap never closed after " + maxRound + " round" + (maxRound === 1 ? "" : "s") + " — no deal";

  return "<div class=\"convergence-wrap\">"
    + "<div class=\"convergence-title\">PRICE PER TONNE (₹) BY NEGOTIATION ROUND</div>"
    + "<svg viewBox=\"0 0 " + W + " " + H + "\" class=\"convergence-chart\" preserveAspectRatio=\"none\">"
    + "<line x1=\"" + padL + "\" y1=\"" + (H - padB) + "\" x2=\"" + (W - padR) + "\" y2=\"" + (H - padB) + "\" stroke=\"#1c2a26\" stroke-width=\"1\" />"
    + ticks
    + "<path d=\"" + path(sellerPts) + "\" fill=\"none\" stroke=\"#35e0c0\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" />"
    + "<path d=\"" + path(buyerPts) + "\" fill=\"none\" stroke=\"#ffb454\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" />"
    + dots(sellerPts, "#35e0c0") + dots(buyerPts, "#ffb454")
    + openLabels + settleMark + settleLabel
    + "</svg>"
    + "<div class=\"convergence-caption\">" + caption + "</div>"
    + "<div class=\"convergence-legend\"><span><i style=\"background:#35e0c0\"></i>Seller asks</span><span><i style=\"background:#ffb454\"></i>Buyer offers</span></div>"
    + "</div>";
}

function renderDealCard(d, turns) {
  const sf = facilitiesById[d.seller_id] || {};
  const bf = facilitiesById[d.buyer_id] || {};
  const navUrl = "/static/navigate.html?" + new URLSearchParams({
    slat: sf.lat, slon: sf.lon, sname: d.seller_name,
    blat: bf.lat, blon: bf.lon, bname: d.buyer_name,
    material: d.material_name, price: d.price_inr_per_t, distance: d.distance_km,
    saving: d.total_saving_inr, co2: d.co2_avoided_t,
  }).toString();
  const dealData = encodeURIComponent(JSON.stringify({
    seller_name: d.seller_name, buyer_name: d.buyer_name, material_name: d.material_name,
    price_inr_per_t: d.price_inr_per_t, tonnes: d.tonnes, distance_km: d.distance_km,
    total_saving_inr: d.total_saving_inr, co2_avoided_t: d.co2_avoided_t,
  }));
  return "<div class=\"deal-card\" data-deal=\"" + dealData + "\"><h3>✓ Deal Closed</h3>"
    + "<div class=\"deal-row\"><span class=\"k\">Route</span><span>" + d.seller_name + " → " + d.buyer_name + "</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">Material</span><span>" + d.material_name + "</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">Price</span><span>₹" + d.price_inr_per_t + "/t × " + d.tonnes + "t</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">Distance</span><span>" + d.distance_km + " km</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">Total saving</span><span>" + fmtINR(d.total_saving_inr) + "/mo</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">CO2 avoided</span><span>" + fmtT(d.co2_avoided_t) + "</span></div>"
    + "<div class=\"deal-row\"><span class=\"k\">Rounds / outcome</span><span>" + d.rounds + " · " + d.outcome + "</span></div>"
    + renderConvergenceChart(turns, d.price_inr_per_t)
    + "<div class=\"signoff\">"
    + "<button class=\"btn primary\" data-approve=\"1\" data-seller=\"" + d.seller_id + "\" data-buyer=\"" + d.buyer_id + "\" data-buyername=\"" + escapeHtml(d.buyer_name) + "\" data-material=\"" + d.material + "\">✓ APPROVE</button>"
    + "<a class=\"btn navigate\" href=\"" + navUrl + "\" target=\"_blank\" rel=\"noopener\">🧭 NAVIGATE</a>"
    + "<button class=\"btn shock\" data-approve=\"0\" data-seller=\"" + d.seller_id + "\" data-buyer=\"" + d.buyer_id + "\" data-buyername=\"" + escapeHtml(d.buyer_name) + "\" data-material=\"" + d.material + "\">✕ REJECT</button>"
    + "</div></div>";
}

function renderVetoCard(ev) {
  const v = (ev.compliance.violations && ev.compliance.violations[0]) || {};
  return "<div class=\"veto-card\"><h3>✕ Compliance Veto</h3>"
    + "<div>" + shortName(ev.seller_id) + " → " + shortName(ev.buyer_id) + " (" + ev.material + ")</div>"
    + "<div class=\"cite\">" + (v.detail || "") + "<br><br>\"" + (v.citation || "") + "\"</div></div>";
}

document.getElementById("theatre-body").addEventListener("click", async (e) => {
  const nav = e.target.closest("a.navigate");
  if (nav) {
    // let the link open; just log a summary once per deal
    if (!nav.dataset.logged) {
      nav.dataset.logged = "1";
      const session = nav.closest(".session");
      appendTheatre(renderDecisionCard("navigate", dealFromCard(nav)), session);
      setSessionStatus("🧭 navigated", session, true);
    }
    return;
  }
  const btn = e.target.closest("button[data-approve]");
  if (!btn || btn.disabled) return;
  const allSignoffBtns = btn.closest(".signoff").querySelectorAll("button[data-approve]");
  allSignoffBtns.forEach((b) => { b.disabled = true; b.setAttribute("disabled", ""); });
  btn.classList.add("chosen");

  const approve = btn.dataset.approve === "1";
  const note = approve ? null : prompt("Reason for rejection (becomes a hard constraint next time):", "price too low");
  const params = new URLSearchParams({
    facility_id: btn.dataset.seller, counterparty_id: btn.dataset.buyer,
    counterparty_name: btn.dataset.buyername, material: btn.dataset.material, approve: approve,
  });
  if (note) params.set("note", note);
  await fetch(API + "/api/signoff?" + params.toString(), { method: "POST" });

  const session = btn.closest(".session");
  appendTheatre(renderDecisionCard(approve ? "approve" : "reject", dealFromCard(btn), note), session);
  setSessionStatus(approve ? "✓ approved" : "✕ rejected", session, true);
});

// ---------------------------------------------------------------- sound
let audioCtx = null;
function playChime(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = kind === "loop" ? [523.25, 659.25, 783.99, 1046.5] : [523.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.09;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    });
  } catch (e) { }
}

function renderNetworkReadout(network) {
  const el = document.getElementById("network-readout");
  if (!network) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    "<span>Network potential <b>" + fmtINR(network.annual_inr) + "</b>/yr</span>"
    + "<span class=\"nr-sep\">·</span>"
    + "<span><b>" + fmtT(network.annual_co2_t) + "</b> CO2e/yr</span>"
    + "<span class=\"nr-sep\">·</span>"
    + "<span><b>" + network.circularity_pct + "%</b> circular</span>";
}

function bumpHud(inr, co2, deals) {
  hud.inr += inr; hud.co2 += co2; hud.deals += deals;
  document.getElementById("hud-inr").textContent = fmtINR(hud.inr);
  document.getElementById("hud-co2").textContent = fmtT(hud.co2);
  document.getElementById("hud-deals").textContent = hud.deals;
}

// ---------------------------------------------------------------- streaming
function clearAllPings() {
  Object.values(facilitiesById).forEach((f) => { if (f._el) { const p = f._el.querySelector(".radar-ping"); if (p) p.remove(); } });
}

function streamEvents(url, onEvent) {
  if (activeSource) activeSource.close();
  negotiationGen++;
  clearAllPings();
  const es = new EventSource(url);
  activeSource = es;
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.event === "stream_end") { es.close(); return; }
    onEvent(ev);
  };
  es.onerror = () => { es.close(); };
}

function startPairNegotiation(pair) {
  clearTheatre("Pair · " + shortName(pair.seller_id) + " ⟷ " + shortName(pair.buyer_id) + " · " + pair.material_name);
  appendTheatre("<div class=\"theatre-empty\">Negotiating " + shortName(pair.seller_id) + " ⟷ " + shortName(pair.buyer_id) + " over " + pair.material_name + "...</div>");
  const url = API + "/api/negotiate/pair?seller_id=" + pair.seller_id + "&buyer_id=" + pair.buyer_id + "&material=" + pair.material;
  streamEvents(url, handleNegotiationEvent);
}

function sysLogMeta(prefix, meta) {
  const m = meta || {};
  if (m.cache_hit) { sysLog(prefix + " · " + (m.provider || "fixture") + " · FIXTURE REPLAY (offline-safe)", "cache"); return; }
  sysLog(prefix + " · " + (m.provider || "?") + "/" + (m.model || "?") + " · " + (m.elapsed_ms != null ? m.elapsed_ms + "ms" : "?")
    + " · schema valid" + (m.repaired ? " (repaired)" : ""), "ok");
}

let currentNegotiationTurns = [];

function handleNegotiationEvent(ev) {
  if (ev.event === "negotiation_start") {
    // stays inside the current session so cascade/loop legs accumulate instead of wiping each other
    appendTheatre("<div class=\"leg-divider\">" + shortName(ev.seller_id) + " → " + shortName(ev.buyer_id) + (ev.material_name ? " · " + escapeHtml(ev.material_name) : "") + "</div>");
    appendTheatre(renderToolChips(ev)); sysClear(); sysShow(); currentNegotiationTurns = [];
  }
  else if (ev.event === "llm_call_start") {
    sysLog("→ " + ev.agent_name + " (" + ev.role + ") · round " + (ev.round || "-") + " · calling LLM...", "call");
    startPing(ev.agent_id);
    spawnPacket(ev.seller_id, ev.buyer_id, 2200, ev.role === "buyer", ev.loop_id ? 0.22 : undefined);
  }
  else if (ev.event === "compliance_veto") { appendTheatre(renderVetoCard(ev)); setSessionStatus("✕ compliance veto", null, true); }
  else if (ev.event === "agent_turn") {
    appendTheatre(renderTurnCard(ev));
    currentNegotiationTurns.push(ev);
    stopPing(ev.agent_id);
    sysLogMeta("← " + ev.agent_name, ev._meta);
  }
  else if (ev.event === "broker_invoked") {
    appendTheatre("<div class=\"theatre-empty\">⚖ No convergence after 5 rounds. Broker agent stepping in...</div>");
    sysLog("→ Broker · calling LLM...", "call");
  }
  else if (ev.event === "broker_decision") {
    appendTheatre("<div class=\"theatre-empty\">⚖ Broker: " + ev.verdict + " — " + ev.reasoning + "</div>");
    sysLogMeta("← Broker", ev._meta);
  }
  else if (ev.event === "deal_closed") {
    appendTheatre(renderDealCard(ev, currentNegotiationTurns));
    setSessionStatus("✓ deal ₹" + ev.price_inr_per_t + "/t", null, true);
    bumpHud(ev.total_saving_inr, ev.co2_avoided_t, 1);
    playChime("deal");
  }
  else if (ev.event === "deal_failed") {
    appendTheatre("<div><div class=\"theatre-empty\">✕ No deal (" + ev.reason + ").</div>" + renderConvergenceChart(currentNegotiationTurns, null) + "</div>");
    setSessionStatus("✕ no deal", null, true);
    stopPing(ev.seller_id); stopPing(ev.buyer_id);
  }
  else if (ev.event === "llm_error") {
    appendTheatre("<div class=\"veto-card\"><h3>⚠ Agent unreachable</h3><div class=\"cite\">" + escapeHtml(ev.detail) + "</div></div>");
    setSessionStatus("⚠ agent error", null, true);
    sysLog("✕ LLM call failed: " + ev.detail, "err");
    stopPing(ev.seller_id); stopPing(ev.buyer_id);
  }
}

function showGhostVeto(edge) {
  clearTheatre("Blocked · " + shortName(edge.seller_id) + " → " + shortName(edge.buyer_id));
  appendTheatre(renderVetoCard({ seller_id: edge.seller_id, buyer_id: edge.buyer_id, material: edge.material, compliance: edge.compliance }));
  setSessionStatus("✕ compliance veto");
}

function startCascade(cascade) {
  clearTheatre("Cascade · " + cascade.nodes.map(shortName).join(" → "));
  appendTheatre("<div class=\"theatre-empty\">Running cascade: " + cascade.nodes.map(shortName).join(" → ") + "</div>");
  const legs = cascade.legs.map((leg) => ({ seller_id: leg.seller_id, buyer_id: leg.buyer_id, material: leg.material }));
  runLegsSequentially(legs);
}

async function runLegsSequentially(legs) {
  for (const leg of legs) {
    await new Promise((resolve) => {
      const url = API + "/api/negotiate/pair?seller_id=" + leg.seller_id + "&buyer_id=" + leg.buyer_id + "&material=" + leg.material;
      if (activeSource) activeSource.close();
      negotiationGen++;
      clearAllPings();
      const es = new EventSource(url);
      activeSource = es;
      es.onmessage = (msg) => {
        const ev = JSON.parse(msg.data);
        if (ev.event === "stream_end") { es.close(); resolve(); return; }
        handleNegotiationEvent(ev);
      };
      es.onerror = () => { es.close(); resolve(); };
    });
  }
}

function startLoop(cycle) {
  const nodes = cycle.nodes;
  clearTheatre("Loop · " + nodes.map(shortName).join(" → ") + " → ↩");
  const materials = cycle.legs.map((l) => l.material);
  appendTheatre("<div class=\"loop-banner\">⟲ CLOSED LOOP ATTEMPT: " + nodes.map(shortName).join(" → ") + " → ↩</div>");
  const loopId = "loop_" + Date.now();
  const url = API + "/api/negotiate/loop?nodes=" + nodes.join(",") + "&materials=" + materials.join(",") + "&loop_id=" + loopId;
  streamEvents(url, (ev) => {
    if (ev.event === "loop_closed") {
      igniteRing(ev.nodes);
      playChime("loop");
      appendTheatre("<div class=\"deal-card\"><h3>⟲ LOOP CLOSED</h3>"
        + "<div class=\"deal-row\"><span class=\"k\">Ring</span><span>" + ev.nodes.map(shortName).join(" → ") + " → ↩</span></div>"
        + "<div class=\"deal-row\"><span class=\"k\">Total saving</span><span>" + fmtINR(ev.total_saving_inr) + "/mo</span></div>"
        + "<div class=\"deal-row\"><span class=\"k\">CO2 avoided</span><span>" + fmtT(ev.total_co2_avoided_t) + "</span></div>"
        + "<div class=\"deal-row\"><span class=\"k\">Annualized</span><span>" + fmtINR(ev.total_saving_inr * 12) + "/yr</span></div>"
        + "<div class=\"deal-row\" style=\"margin-top:6px;padding-top:8px;border-top:1px dashed var(--border)\">"
        + "<span class=\"k\">Kalundborg, Denmark took</span><span style=\"color:var(--amber)\">40 years -> ~15 exchanges</span></div>"
        + "<div class=\"deal-row\"><span class=\"k\">This ring took</span><span style=\"color:var(--teal)\">seconds to find, minutes to negotiate</span></div>"
        + "</div>");
      setSessionStatus("⟲ loop closed · " + fmtINR(ev.total_saving_inr) + "/mo");
    } else if (ev.event === "loop_collapsed") {
      appendTheatre("<div class=\"veto-card\"><h3>⟲ RING COLLAPSED</h3><div>" + ev.reason + "</div></div>");
      setSessionStatus("⟲ ring collapsed");
    } else if (ev.event === "loop_pacing") {
      appendTheatre("<div class=\"theatre-empty\">↻ Leg " + ev.next_leg + " closed. Pausing briefly before the next leg negotiates...</div>");
    } else {
      handleNegotiationEvent(ev);
    }
  });
}

// ---------------------------------------------------------------- shock console
async function applyShock(params, label) {
  logClear(); logShow();
  await logLine("> ⚠ SHOCK APPLIED: " + label, "warn", 200);
  await logLine("> Pushing new world-state parameters to the network...", null, 240);
  await fetch(API + "/api/shock?" + new URLSearchParams(params).toString(), { method: "POST" });

  await logLine("> Re-computing routes, transport costs and reservation prices for all 35 candidate pairs...", null, 320);
  const res = await fetch(API + "/api/discover");
  const fresh = await res.json();
  await logLine("> Re-scoring symbiosis network under new conditions...", null, 260);

  const before = currentDiscovery;
  previousDiscovery = before;
  currentDiscovery = fresh;

  if (before) {
    const b0 = before.pairs[0], f0 = fresh.pairs.find(p => p.seller_id === b0.seller_id && p.buyer_id === b0.buyer_id) || fresh.pairs[0];
    const deltaPct = ((f0.total_saving_inr - b0.total_saving_inr) / Math.abs(b0.total_saving_inr) * 100).toFixed(1);
    await logLine("> Top match saving: " + fmtINR(b0.total_saving_inr) + " -> " + fmtINR(f0.total_saving_inr)
      + " (" + (deltaPct >= 0 ? "+" : "") + deltaPct + "%)", (deltaPct >= 0 ? "hit" : "warn"), 260);
    const newlyRejected = fresh.rejected.length - before.rejected.length;
    if (newlyRejected > 0) await logLine("> " + newlyRejected + " previously-viable match(es) now FAIL under new conditions.", "warn", 240);
  }
  await logLine("> Discovery complete. Network re-rendered.", "hit", 200);

  renderNetworkReadout(currentDiscovery.network);
  clearArcs();
  clearFocus();
  renderSidepanel(currentDiscovery);
  currentDiscovery.pairs.forEach((p, i) => {
    drawArc(p.seller_id, p.buyer_id, { color: "#35e0c0", weight: 1.5, opacity: 0.45, durationMs: 180, meta: p, matchKey: "pair:" + i });
  });
  currentDiscovery.cascades.forEach((c, ci) => {
    for (let i = 0; i < c.nodes.length - 1; i++) {
      drawArc(c.nodes[i], c.nodes[i + 1], { color: "#6bc7d9", weight: 2, opacity: 0.6, durationMs: 220, meta: c.legs[i], matchKey: "cascade:" + ci });
    }
  });
  currentDiscovery.cycles.forEach((cyc, ci) => {
    const n = cyc.nodes.length;
    for (let i = 0; i < n; i++) drawArc(cyc.nodes[i], cyc.nodes[(i + 1) % n], { color: "#ffb454", weight: 3, opacity: 0.9, bend: 0.22, durationMs: 300, meta: cyc.legs[i], matchKey: "cycle:" + ci });
  });

  appendTheatre("<div class=\"shock-diff\"><b>⚠ " + label + "</b><br>The network just re-scored every route under this shock. "
    + (lastSelectedMatch ? "Click the same match again in the side panel to watch agents renegotiate live under the new pressure." : "Pick a match from the side panel to see agents negotiate under the new pressure.")
    + "</div>");
}

document.querySelectorAll(".legend-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    chip.classList.toggle("active");
    toggleLayer(chip.dataset.layer);
  });
});

document.getElementById("btn-discover").addEventListener("click", discover);
document.getElementById("btn-diesel").addEventListener("click", () => applyShock({ diesel_mult: 1.18 }, "Diesel index +18%"));
document.getElementById("btn-tax").addEventListener("click", () => applyShock({ landfill_tax_inr_per_t: 2000 }, "Landfill tax +₹2000/t"));
document.getElementById("btn-reset").addEventListener("click", async () => {
  await fetch(API + "/api/shock/reset", { method: "POST" });
  hud = { inr: 0, co2: 0, deals: 0 };
  bumpHud(0, 0, 0);
  clearTheatre();
  clearArcs();
  logClear();
  sysClear();
  document.getElementById("enginelog").classList.remove("show");
  document.getElementById("sysmonitor").classList.remove("show");
  document.getElementById("sidepanel").style.display = "none";
  document.getElementById("network-readout").hidden = true;
  currentDiscovery = null; previousDiscovery = null; lastSelectedMatch = null;
  clearFocus();
  if (map) map.easeTo({ zoom: 4.4, center: [78.5, 18.5], duration: 1200 });
});

// ---------------------------------------------------------------- boot
document.getElementById("btn-clear-history").addEventListener("click", clearHistory);

(async function boot() {
  restoreHistory();
  await initMap();
  const res = await fetch(API + "/api/facilities");
  const facilities = await res.json();
  renderFacilities(facilities);
})();