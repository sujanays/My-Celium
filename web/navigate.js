import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.15.0/dist/maplibre-gl.mjs';
import * as THREE from 'three';

/* ------------------------------------------------------------------ state */
let userCoordinates = null;      // [lon, lat] from GPS
let userHeading = null;          // degrees, only when moving
let mapInstance = null;
let userMarker = null;
let isDarkMode = false;
let styleReady = false;          // true while map style is loaded
let fittedWithUser = false;
let followMe = false;
let gpsMessage = 'Waiting for GPS fix…';
let activeTarget = 'seller';     // 'seller' | 'buyer'
let routeInFlight = false;
let lastRoutedFrom = null;

const routeCache = {};           // 'trade' | 'user-seller' | 'user-buyer' -> route data

/* ----------------------------------------------------------------- styles */
const styleElement = document.createElement('style');
styleElement.innerHTML = `
    :root {
        --p-bg:#ffffff; --p-bd:#e0e0e0; --p-fg:#111111; --p-mute:#6b7a76;
        --p-hover:#f2f5f4; --p-sh:0 4px 12px rgba(0,0,0,.15);
    }
    body.dark {
        --p-bg:#1e2624; --p-bd:#2d3b37; --p-fg:#e2ede9; --p-mute:#8fa8a0;
        --p-hover:#27322f; --p-sh:0 4px 16px rgba(0,0,0,.35);
    }
    .mc-panel {
        position:absolute; z-index:10; background:var(--p-bg); color:var(--p-fg);
        border:1px solid var(--p-bd); border-radius:10px; box-shadow:var(--p-sh);
        font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    }
    #nav-info-card { top:15px; left:15px; padding:14px 18px; min-width:280px; max-width:calc(100% - 70px); }
    .nav-row { display:flex; justify-content:space-between; gap:12px; font-size:12px; margin-bottom:4px; }
    .nav-row strong { text-align:right; }
    .gps-pill { display:inline-block; margin-top:8px; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:600;
        background:var(--p-hover); color:var(--p-mute); }
    .gps-pill.ok { color:#1f9d55; background:rgba(31,157,85,0.1); } 
    .gps-pill.warn { color:#b7791f; background:rgba(183,121,31,0.1); } 
    .gps-pill.error { color:#d93025; background:rgba(217,48,37,0.1); }

    #dir-panel { left:15px; bottom:28px; width:320px; max-width:calc(100% - 30px); padding:12px; }
    .dir-tabs { display:flex; gap:6px; margin-bottom:8px; }
    .dir-tab { flex:1; padding:8px 6px; font:600 12px system-ui,sans-serif; cursor:pointer;
        background:var(--p-hover); color:var(--p-fg); border:2px solid transparent; border-radius:8px; text-align:center; }
    .dir-tab.active { border-color:var(--tab-c); background:rgba(0,122,255,0.08); }
    .dir-tab:focus-visible, .dir-follow:focus-visible, .dir-summary:focus-visible { outline:2px solid #007aff; outline-offset:2px; }
    .dir-summary { font-size:13px; font-weight:600; cursor:pointer; display:flex; justify-content:space-between; align-items:center; }
    .dir-summary::after { content:' ▾'; color:var(--p-mute); }
    #dir-panel.collapsed .dir-summary::after { content:' ▸'; }
    #dir-panel.collapsed .dir-steps { display:none; }
    .dir-steps { list-style:none; margin:8px 0 0; padding:0; max-height:30vh; overflow-y:auto; }
    .dir-steps li { display:grid; grid-template-columns:24px 1fr auto; gap:8px; align-items:baseline;
        padding:7px 2px; font-size:12px; border-top:1px solid var(--p-bd); }
    .dir-steps .arrow { font-size:15px; text-align:center; color:#007aff; font-weight:bold; }
    .dir-steps .dist { color:var(--p-mute); white-space:nowrap; }
    .dir-steps .dir-note { display:block; color:var(--p-mute); }
    .dir-follow { margin-top:10px; width:100%; padding:9px; font:700 12px system-ui,sans-serif; cursor:pointer;
        border:none; border-radius:8px; background:#007aff; color:#ffffff; transition:background 0.2s; }
    .dir-follow:hover { background:#0056b3; }
    .dir-follow.on { background:#ff3b30; color:#fff; }
    @media (max-width:600px) { .dir-steps { max-height:20vh; } }

    .gps-user-marker { width:22px; height:22px; position:relative; }
    .gps-user-dot { width:14px; height:14px; background-color:#007aff; border:2px solid #fff; border-radius:50%;
        position:absolute; top:4px; left:4px; box-shadow:0 0 10px rgba(0,122,255,.9); z-index:2; }
    .gps-user-pulse { width:100%; height:100%; background-color:rgba(0,122,255,.35); border-radius:50%;
        position:absolute; top:0; left:0; animation:gpsPulse 1.8s infinite ease-out; z-index:1; }
    @keyframes gpsPulse { 0% { transform:scale(.6); opacity:1; } 100% { transform:scale(2.5); opacity:0; } }
    @media (prefers-reduced-motion: reduce) { .gps-user-pulse { animation:none; opacity:.5; } }
`;
document.head.appendChild(styleElement);

/* ---------------------------------------------------------------- helpers */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const $ = (id) => document.getElementById(id);

function fmtINR(n) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return '';
    if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
    if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
    return '₹' + n.toLocaleString('en-IN');
}
function fmtT(n) { return Math.round(Number(n)).toLocaleString('en-IN') + ' t'; }
function fmtDist(m) {
    if (!isFinite(m)) return '--';
    return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}
function fmtDur(s) {
    if (!isFinite(s)) return '--';
    const min = Math.max(1, Math.round(s / 60));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
function haversineM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function curvedLngLats(a, b, bend = 0.18) {
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

/* ------------------------------------------------------------- URL params */
const urlParams = new URLSearchParams(window.location.search);
const sellerLon = parseFloat(urlParams.get('slon') || urlParams.get('seller_lon')) || 77.5946;
const sellerLat = parseFloat(urlParams.get('slat') || urlParams.get('seller_lat')) || 12.9716;
const buyerLon = parseFloat(urlParams.get('blon') || urlParams.get('buyer_lon')) || 76.10343;
const buyerLat = parseFloat(urlParams.get('blat') || urlParams.get('buyer_lat')) || 12.998037;

const sName = urlParams.get('sname') || 'Seller';
const bName = urlParams.get('bname') || 'Buyer';
const dealTitle = urlParams.get('title') || `${sName} → ${bName}`;
const material = urlParams.get('material') || '';
const price = urlParams.get('price');
const paramDistance = urlParams.get('distance');
const saving = urlParams.get('saving');
const co2 = urlParams.get('co2');

const SELLER_COORDS = [sellerLon, sellerLat];
const BUYER_COORDS = [buyerLon, buyerLat];

// Distinct Color Map for Routes
const ROUTE_STYLES = {
    'trade':       { color: '#35e0c0', casing: '#00362c', width: 5 },
    'user-seller': { color: '#007aff', casing: '#002654', width: 5, dash: [2, 1] }, // Distinct Live GPS to Seller Route (Vivid Electric Blue)
    'user-buyer':  { color: '#d435e0', casing: '#38093c', width: 4, dash: [2, 2] },
};

/* ------------------------------------------------------------ map styles */
const STYLES = {
    bright: 'https://tiles.openfreemap.org/styles/bright',
    dark: {
        version: 8,
        sources: {
            'esri-dark-base': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256, maxzoom: 16,
                attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS'
            },
            'esri-dark-labels': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256, maxzoom: 16, attribution: ''
            }
        },
        layers: [
            { id: 'esri-dark-layer', type: 'raster', source: 'esri-dark-base' },
            { id: 'esri-dark-labels-layer', type: 'raster', source: 'esri-dark-labels' }
        ]
    }
};

/* -------------------------------------------------------------------- GPS */
function startGeolocation() {
    if (!('geolocation' in navigator)) {
        setGps('This device/browser has no GPS support.', 'error');
        startMap(SELLER_COORDS);
        return;
    }
    if (!window.isSecureContext) {
        setGps('GPS blocked on insecure http:// context. Use https:// or localhost.', 'warn');
    }
    navigator.geolocation.getCurrentPosition(onFix, onGpsError,
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
    navigator.geolocation.watchPosition(onFix, onGpsError,
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
}

function onFix(position) {
    const c = position.coords;
    userCoordinates = [c.longitude, c.latitude];
    if (c.heading != null && !isNaN(c.heading) && c.speed > 0.5) userHeading = c.heading;
    setGps(`GPS Fix ±${Math.round(c.accuracy)} m`, 'ok');

    if (!mapInstance) { startMap(userCoordinates); return; }
    updateUserMarker(userCoordinates);
    refreshUserRoutes();
    if (followMe) followUser();
    else if (!fittedWithUser && styleReady) fitAll();
}

function onGpsError(err) {
    const msgs = {
        1: 'Location permission denied. Enable GPS to get directions to seller.',
        2: 'Position unavailable. Check device GPS.',
        3: 'GPS acquisition timed out.'
    };
    if (!userCoordinates) {
        setGps(msgs[err.code] || err.message, err.code === 3 ? 'warn' : 'error');
        ['dist-user-seller', 'dist-user-buyer'].forEach((id) => updateDistText(id, 'No GPS'));
    }
    if (!mapInstance) startMap(SELLER_COORDS);
}

function setGps(message, level) {
    gpsMessage = message;
    const pill = $('gps-pill');
    if (pill) { pill.textContent = message; pill.className = `gps-pill ${level || ''}`; }
    renderDirections();
}

/* ---------------------------------------------------------------- map */
function startMap(centerCoords) {
    if (mapInstance) return;
    const map = new maplibregl.Map({
        container: 'map',
        style: STYLES.bright,
        center: centerCoords,
        zoom: 12,
        pitch: 40,
        bearing: 0,
        canvasContextAttributes: { antialias: true }
    });
    mapInstance = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    addControlButton(map, 'Toggle Dark / Light Theme', `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#333" stroke-width="2">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
        </svg>`, toggleTheme);
    addControlButton(map, 'Re-center on Live GPS', `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#007aff" stroke-width="2">
            <circle cx="12" cy="12" r="8"></circle>
            <line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line>
            <circle cx="12" cy="12" r="3" fill="#007aff"></circle>
        </svg>`, () => {
        if (userCoordinates) map.flyTo({ center: userCoordinates, zoom: 15, pitch: 45, essential: true });
    });
    addControlButton(map, 'Fit All Destinations in View', `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#333" stroke-width="2">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path>
        </svg>`, () => { setFollow(false); fitAll(); });

    createNavigationInfoCard();
    createDirectionsPanel();

    new maplibregl.Marker({ color: '#35e0c0' })
        .setLngLat(SELLER_COORDS)
        .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(
            `<b style="font-family:sans-serif;color:#1aa58b;">🏭 ${esc(sName)} (Seller)</b>`))
        .addTo(map);
    new maplibregl.Marker({ color: '#ffb454' })
        .setLngLat(BUYER_COORDS)
        .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(
            `<b style="font-family:sans-serif;color:#c27c10;">🏗️ ${esc(bName)} (Buyer)</b>`))
        .addTo(map);

    if (userCoordinates) updateUserMarker(userCoordinates);

    map.on('dragstart', () => { if (followMe) setFollow(false); });

    map.on('style.load', async () => {
        styleReady = true;
        if (!isDarkMode) add3DBuildingsLayer(map);
        addThreejsShadowModel(map, SELLER_COORDS);

        if (!routeCache['trade']) {
            routeCache['trade'] = await fetchRoute(SELLER_COORDS, BUYER_COORDS);
            if (routeCache['trade'].approximate && paramDistance) {
                routeCache['trade'].distanceM = parseFloat(paramDistance) * 1000;
            }
        }
        drawAllRoutes();
        updateCardReadouts();
        await refreshUserRoutes(true);
        if (!fittedWithUser || !userCoordinates) fitAll();
    });
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('dark', isDarkMode);
    styleReady = false;
    mapInstance.setStyle(isDarkMode ? STYLES.dark : STYLES.bright);
}

function addControlButton(map, title, html, onClick) {
    class Ctrl {
        onAdd() {
            this._c = document.createElement('div');
            this._c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            const b = document.createElement('button');
            b.type = 'button';
            b.title = title;
            b.style.cssText = 'display:flex;align-items:center;justify-content:center;cursor:pointer;';
            b.innerHTML = html;
            b.onclick = onClick;
            this._c.appendChild(b);
            return this._c;
        }
        onRemove() { this._c.remove(); }
    }
    map.addControl(new Ctrl(), 'top-right');
}

function fitAll() {
    if (!mapInstance) return;
    const bounds = new maplibregl.LngLatBounds().extend(SELLER_COORDS).extend(BUYER_COORDS);
    if (userCoordinates) { bounds.extend(userCoordinates); fittedWithUser = true; }
    mapInstance.fitBounds(bounds, { padding: { top: 90, bottom: 190, left: 90, right: 90 }, pitch: 35, maxZoom: 15 });
}

function updateUserMarker(coords) {
    if (!mapInstance) return;
    if (!userMarker) {
        const el = document.createElement('div');
        el.className = 'gps-user-marker';
        const pulse = document.createElement('div');
        pulse.className = 'gps-user-pulse';
        const dot = document.createElement('div');
        dot.className = 'gps-user-dot';
        el.appendChild(pulse);
        el.appendChild(dot);
        userMarker = new maplibregl.Marker({ element: el })
            .setLngLat(coords)
            .setPopup(new maplibregl.Popup({ offset: 15 }).setHTML(
                '<b style="font-family:sans-serif;color:#007aff;">📍 Live GPS Location</b>'))
            .addTo(mapInstance);
    } else {
        userMarker.setLngLat(coords);
    }
}

/* ---------------------------------------------------------------- routing */
async function fetchRoute(startCoords, endCoords) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}?overview=full&geometries=geojson&steps=true`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
        const response = await fetch(url, { signal: ctrl.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        const route = data.routes && data.routes[0];
        if (route) {
            return {
                geometry: route.geometry,
                distanceM: route.distance,
                durationS: route.duration,
                steps: (route.legs || []).flatMap((l) => l.steps || []),
                approximate: false
            };
        }
    } catch (err) {
        console.warn('OSRM route fetch failed, falling back to arc geometry:', err);
    } finally {
        clearTimeout(timer);
    }
    const straight = haversineM(startCoords, endCoords);
    return {
        geometry: { type: 'LineString', coordinates: curvedLngLats([startCoords[1], startCoords[0]], [endCoords[1], endCoords[0]]) },
        distanceM: straight * 1.3,
        durationS: (straight * 1.3) / (40 / 3.6),
        steps: [],
        approximate: true
    };
}

async function refreshUserRoutes(force = false) {
    if (!userCoordinates || !styleReady || routeInFlight) return;
    const minMove = followMe ? 40 : 75;
    if (!force && lastRoutedFrom && haversineM(lastRoutedFrom, userCoordinates) < minMove) return;

    routeInFlight = true;
    lastRoutedFrom = [...userCoordinates];
    try {
        const [toSeller, toBuyer] = await Promise.all([
            fetchRoute(userCoordinates, SELLER_COORDS),
            fetchRoute(userCoordinates, BUYER_COORDS)
        ]);
        routeCache['user-seller'] = toSeller;
        routeCache['user-buyer'] = toBuyer;
        drawAllRoutes();
        updateCardReadouts();
        renderDirections();
    } finally {
        routeInFlight = false;
    }
}

function drawAllRoutes() {
    if (!mapInstance || !styleReady) return;
    Object.keys(routeCache).forEach((id) => {
        const s = ROUTE_STYLES[id];
        renderRouteLayer(mapInstance, id, routeCache[id].geometry, s.color, s.width, s.casing, s.dash || null);
    });
    applyRouteEmphasis();
}

function renderRouteLayer(map, layerId, geometry, lineColor, lineWidth = 4, casingColor = '#000000', dashArray = null) {
    const feature = { type: 'Feature', properties: {}, geometry };
    if (map.getSource(layerId)) {
        map.getSource(layerId).setData(feature);
        return;
    }
    map.addSource(layerId, { type: 'geojson', data: feature });
    map.addLayer({
        id: `${layerId}-casing`, type: 'line', source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': casingColor, 'line-width': lineWidth + 4 }
    });
    const linePaint = { 'line-color': lineColor, 'line-width': lineWidth };
    if (dashArray) linePaint['line-dasharray'] = dashArray;
    map.addLayer({
        id: `${layerId}-line`, type: 'line', source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: linePaint
    });
}

function applyRouteEmphasis() {
    if (!mapInstance || !styleReady) return;
    const activeId = activeTarget === 'seller' ? 'user-seller' : 'user-buyer';
    ['user-seller', 'user-buyer'].forEach((id) => {
        if (!mapInstance.getLayer(`${id}-line`)) return;
        const on = id === activeId;
        const w = on ? 6 : 3;
        mapInstance.setPaintProperty(`${id}-line`, 'line-width', w);
        mapInstance.setPaintProperty(`${id}-line`, 'line-opacity', on ? 1 : 0.5);
        mapInstance.setPaintProperty(`${id}-casing`, 'line-width', w + 4);
        mapInstance.setPaintProperty(`${id}-casing`, 'line-opacity', on ? 1 : 0.35);
    });
}

/* ------------------------------------------------------------------- UI */
function createNavigationInfoCard() {
    const card = document.createElement('div');
    card.id = 'nav-info-card';
    card.className = 'mc-panel';

    let extra = '';
    if (material) extra += `<div style="font-size:11px;color:var(--p-mute);text-transform:uppercase;margin-top:4px;">Material: ${esc(material)}</div>`;
    if (price) extra += `<div style="font-size:12px;margin-top:2px;">Price: ₹${esc(price)}/t</div>`;
    if (saving) extra += `<div style="font-size:12px;color:#1aa58b;font-weight:600;">Savings: ${esc(fmtINR(saving))}/mo</div>`;
    if (co2) extra += `<div style="font-size:12px;color:#c27c10;font-weight:600;">CO2 Avoided: ${esc(fmtT(co2))}</div>`;

    card.innerHTML = `
        <div style="font-weight:700;font-size:14px;">${esc(dealTitle)}</div>
        ${extra}
        <div style="margin-top:10px;padding-top:8px;border-top:1px dashed rgba(120,120,120,.3);">
            <div style="font-size:11px;font-weight:700;color:var(--p-mute);text-transform:uppercase;margin-bottom:6px;">Live GPS & Route Info</div>
            <div class="nav-row"><span style="color:#1aa58b;">🟢 Seller → Buyer:</span>
                <strong id="dist-trade">${paramDistance ? esc(paramDistance) + ' km' : '-- km'}</strong></div>
            <div class="nav-row"><span style="color:#007aff;font-weight:700;">🔵 Live GPS → Seller:</span>
                <strong id="dist-user-seller" style="color:#007aff;">Calculating...</strong></div>
            <div class="nav-row"><span style="color:#b02ab8;">🟣 Live GPS → Buyer:</span>
                <strong id="dist-user-buyer">Calculating...</strong></div>
            <span id="gps-pill" class="gps-pill" role="status">${esc(gpsMessage)}</span>
        </div>`;
    document.body.appendChild(card);
}

function createDirectionsPanel() {
    const panel = document.createElement('div');
    panel.id = 'dir-panel';
    panel.className = 'mc-panel';
    panel.innerHTML = `
        <div class="dir-tabs" role="tablist">
            <button class="dir-tab active" role="tab" data-target="seller" style="--tab-c:#007aff">To Seller (GPS)</button>
            <button class="dir-tab" role="tab" data-target="buyer" style="--tab-c:#d435e0">To Buyer</button>
        </div>
        <div id="dir-summary" class="dir-summary" role="button" tabindex="0" aria-live="polite">Acquiring GPS fix…</div>
        <ol id="dir-steps" class="dir-steps"></ol>
        <button id="dir-follow" class="dir-follow" type="button">▶ Start Navigation to Seller</button>`;
    document.body.appendChild(panel);

    panel.querySelectorAll('.dir-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            activeTarget = tab.dataset.target;
            panel.querySelectorAll('.dir-tab').forEach((t) => t.classList.toggle('active', t === tab));
            $('dir-follow').textContent = activeTarget === 'seller' ? '▶ Start Navigation to Seller' : '▶ Start Navigation to Buyer';
            applyRouteEmphasis();
            renderDirections();
            if (followMe) followUser();
        });
    });
    const toggleSteps = () => panel.classList.toggle('collapsed');
    $('dir-summary').addEventListener('click', toggleSteps);
    $('dir-summary').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSteps(); }
    });
    $('dir-follow').addEventListener('click', () => setFollow(!followMe));
    renderDirections();
}

const ARROWS = {
    'left': '←', 'slight left': '↖', 'sharp left': '↙',
    'right': '→', 'slight right': '↗', 'sharp right': '↘',
    'straight': '↑', 'uturn': '↶'
};
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

function stepText(s) {
    const m = s.maneuver || {};
    const mod = m.modifier || '';
    const onto = s.name ? ` onto ${s.name}` : '';
    const on = s.name ? ` on ${s.name}` : '';
    switch (m.type) {
        case 'depart': return `Head ${COMPASS[Math.round((m.bearing_after || 0) / 45) % 8]}${on}`;
        case 'arrive': return mod ? `Arrive at ${activeTarget === 'seller' ? 'Seller' : 'Buyer'} destination` : 'Arrive at destination';
        case 'roundabout':
        case 'rotary': return `At the roundabout${m.exit ? `, take exit ${m.exit}` : ''}${onto}`;
        case 'merge': return `Merge${mod ? ' ' + mod : ''}${onto}`;
        case 'fork': return `Keep ${mod.includes('left') ? 'left' : 'right'} at the fork${onto}`;
        case 'end of road': return `Turn ${mod} at the end of the road${onto}`;
        case 'new name': return `Continue${on}`;
        case 'continue': return !mod || mod === 'straight' ? `Continue straight${on}` : `Continue ${mod}${onto}`;
        default: return mod === 'straight' || !mod ? `Continue straight${on}` : `Turn ${mod}${onto}`;
    }
}

function renderDirections() {
    const sum = $('dir-summary'), list = $('dir-steps');
    if (!sum || !list) return;
    const target = activeTarget === 'seller' ? `${sName} (Seller)` : `${bName} (Buyer)`;
    const route = routeCache[activeTarget === 'seller' ? 'user-seller' : 'user-buyer'];

    if (!userCoordinates) { sum.textContent = gpsMessage; list.innerHTML = ''; return; }
    if (!route) { sum.textContent = 'Calculating GPS route…'; list.innerHTML = ''; return; }

    sum.textContent = `${route.approximate ? '~' : ''}${fmtDist(route.distanceM)} · ${fmtDur(route.durationS)} to ${target}`;
    list.innerHTML = route.steps.length
        ? route.steps.map((s) => {
            const mod = (s.maneuver && s.maneuver.modifier) || 'straight';
            return `<li><span class="arrow" aria-hidden="true">${ARROWS[mod] || '↑'}</span>` +
                   `<span>${esc(stepText(s))}</span><span class="dist">${fmtDist(s.distance)}</span></li>`;
        }).join('')
        : '<li class="dir-note">Road routing service unreachable. Showing straight-line direction line.</li>';
}

function updateCardReadouts() {
    const t = routeCache['trade'];
    if (t) updateDistText('dist-trade', `${t.approximate && !paramDistance ? '~' : ''}${fmtDist(t.distanceM)} · ${fmtDur(t.durationS)}`);
    [['user-seller', 'dist-user-seller'], ['user-buyer', 'dist-user-buyer']].forEach(([key, id]) => {
        const r = routeCache[key];
        if (r) updateDistText(id, `${r.approximate ? '~' : ''}${fmtDist(r.distanceM)} · ${fmtDur(r.durationS)}`);
    });
}

function updateDistText(elementId, text) {
    const elem = $(elementId);
    if (elem) elem.textContent = text;
}

/* ------------------------------------------------------- follow-me mode */
function setFollow(on) {
    followMe = on && !!userCoordinates;
    const btn = $('dir-follow');
    if (btn) {
        btn.classList.toggle('on', followMe);
        btn.textContent = followMe ? '■ Stop Navigation' : (activeTarget === 'seller' ? '▶ Start Navigation to Seller' : '▶ Start Navigation to Buyer');
    }
    if (followMe) followUser();
}

function followUser() {
    if (!mapInstance || !userCoordinates) return;
    mapInstance.easeTo({
        center: userCoordinates,
        zoom: Math.max(mapInstance.getZoom(), 15.5),
        pitch: 55,
        bearing: userHeading != null ? userHeading : mapInstance.getBearing(),
        duration: 800,
        essential: true
    });
}

/* --------------------------------------------------------- 3D / three.js */
function add3DBuildingsLayer(map) {
    if (map.getLayer('3d-buildings')) return;
    const layers = map.getStyle().layers;
    let labelLayerId;
    if (layers) {
        for (let i = 0; i < layers.length; i++) {
            if (layers[i].type === 'symbol' && layers[i].layout && layers[i].layout['text-field']) {
                labelLayerId = layers[i].id;
                break;
            }
        }
    }
    if (!map.getSource('openfreemap')) {
        map.addSource('openfreemap', { url: 'https://tiles.openfreemap.org/planet', type: 'vector' });
    }
    map.addLayer({
        'id': '3d-buildings',
        'source': 'openfreemap',
        'source-layer': 'building',
        'type': 'fill-extrusion',
        'minzoom': 15,
        'filter': ['!=', ['get', 'hide_3d'], true],
        'paint': {
            'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'render_height'], 0, 'lightgray', 200, 'royalblue', 400, 'lightblue'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'render_height']],
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'render_min_height']]
        }
    }, labelLayerId);
}

function addThreejsShadowModel(map, coords) {
    if (map.getLayer('3d-shadow-model')) return;
    const modelAsMercatorCoordinate = maplibregl.MercatorCoordinate.fromLngLat(coords, 0);
    const modelTransform = {
        translateX: modelAsMercatorCoordinate.x,
        translateY: modelAsMercatorCoordinate.y,
        translateZ: modelAsMercatorCoordinate.z,
        scale: modelAsMercatorCoordinate.meterInMercatorCoordinateUnits()
    };

    const customLayer = {
        id: '3d-shadow-model',
        type: 'custom',
        renderingMode: '3d',
        onAdd: function (map, gl) {
            this.camera = new THREE.Camera();
            this.scene = new THREE.Scene();

            const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
            directionalLight.position.set(50, 100, 50).normalize();
            this.scene.add(directionalLight);
            this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));

            const geometry = new THREE.BoxGeometry(40, 40, 80);
            const mat = new THREE.MeshStandardMaterial({ color: 0x35e0c0, roughness: 0.2 });
            const mesh = new THREE.Mesh(geometry, mat);
            mesh.position.set(0, 0, 40);
            this.scene.add(mesh);

            this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialiasing: true });
            this.renderer.autoClear = false;
        },
        render: function (gl, matrix) {
            const m = new THREE.Matrix4().fromArray(matrix);
            const l = new THREE.Matrix4()
                .makeTranslation(modelTransform.translateX, modelTransform.translateY, modelTransform.translateZ)
                .scale(new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale));
            this.camera.projectionMatrix = m.multiply(l);
            this.renderer.resetState();
            this.renderer.render(this.scene, this.camera);
            mapInstance.triggerRepaint();
        }
    };
    map.addLayer(customLayer);
}

/* ---------------------------------------------------------------- boot */
startGeolocation();