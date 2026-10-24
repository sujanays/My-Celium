import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.15.0/dist/maplibre-gl.mjs';
import * as THREE from 'three';

let userCoordinates = null;
let mapInstance = null;
let userMarker = null;
let isDarkMode = false; // Initial theme (bright/light mode)

// Inject CSS styles for the pulsating GPS marker
const styleElement = document.createElement('style');
styleElement.innerHTML = `
    .gps-user-marker {
        width: 20px;
        height: 20px;
        position: relative;
    }
    .gps-user-dot {
        width: 14px;
        height: 14px;
        background-color: #ff3b30;
        border: 2px solid #ffffff;
        border-radius: 50%;
        position: absolute;
        top: 3px;
        left: 3px;
        box-shadow: 0 0 8px rgba(255, 59, 48, 0.8);
        z-index: 2;
    }
    .gps-user-pulse {
        width: 100%;
        height: 100%;
        background-color: rgba(255, 59, 48, 0.4);
        border-radius: 50%;
        position: absolute;
        top: 0;
        left: 0;
        animation: gpsPulse 1.8s infinite ease-out;
        z-index: 1;
    }
    @keyframes gpsPulse {
        0% {
            transform: scale(0.6);
            opacity: 1;
        }
        100% {
            transform: scale(2.4);
            opacity: 0;
        }
    }
`;
document.head.appendChild(styleElement);

// Formatting helpers
function fmtINR(n) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return "";
    if (n >= 1e7) return "₹" + (n / 1e7).toFixed(2) + " Cr";
    if (n >= 1e5) return "₹" + (n / 1e5).toFixed(2) + " L";
    return "₹" + n.toLocaleString("en-IN");
}

function fmtT(n) {
    return Math.round(Number(n)).toLocaleString("en-IN") + " t";
}

// Curved arc calculation fallback
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

// Parse URL parameters with full fallbacks
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

const START_COORDS = [sellerLon, sellerLat];
const DESTINATION_COORDS = [buyerLon, buyerLat];

// Map Styles Configuration
const STYLES = {
    bright: 'https://tiles.openfreemap.org/styles/bright',
    dark: {
        version: 8,
        sources: {
            'esri-dark-base': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS'
            },
            'esri-dark-labels': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: ''
            }
        },
        layers: [
            { id: 'esri-dark-layer', type: 'raster', source: 'esri-dark-base' },
            { id: 'esri-dark-labels-layer', type: 'raster', source: 'esri-dark-labels' }
        ]
    }
};

// Continuous Geolocation Tracking
if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
        (position) => {
            userCoordinates = [position.coords.longitude, position.coords.latitude];
            if (!mapInstance) {
                startMap(userCoordinates[0], userCoordinates[1]);
            } else {
                updateUserMarker(userCoordinates);
            }
        },
        (error) => {
            console.warn('Geolocation unavailable, defaulting to origin coordinates:', error.message);
            if (!mapInstance) {
                userCoordinates = START_COORDS;
                startMap(userCoordinates[0], userCoordinates[1]);
            }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
} else {
    userCoordinates = START_COORDS;
    startMap(userCoordinates[0], userCoordinates[1]);
}

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
        map.addSource('openfreemap', {
            url: 'https://tiles.openfreemap.org/planet',
            type: 'vector',
        });
    }

    map.addLayer(
        {
            'id': '3d-buildings',
            'source': 'openfreemap',
            'source-layer': 'building',
            'type': 'fill-extrusion',
            'minzoom': 15,
            'filter': ['!=', ['get', 'hide_3d'], true],
            'paint': {
                'fill-extrusion-color': [
                    'interpolate',
                    ['linear'],
                    ['get', 'render_height'], 0, 'lightgray', 200, 'royalblue', 400, 'lightblue'
                ],
                'fill-extrusion-height': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15,
                    0,
                    16,
                    ['get', 'render_height']
                ],
                'fill-extrusion-base': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15,
                    0,
                    16,
                    ['get', 'render_min_height']
                ]
            }
        },
        labelLayerId
    );
}

function startMap(longitude, latitude) {
    const map = new maplibregl.Map({
        container: 'map',
        style: STYLES.bright,
        center: START_COORDS,
        zoom: 15.5,
        pitch: 45,
        bearing: -17.6,
        canvasContextAttributes: { antialias: true }
    });

    mapInstance = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    addThemeToggleControl(map);
    addRecenterButton(map);
    createNavigationInfoCard();

    map.on('style.load', () => {
        if (!isDarkMode) {
            add3DBuildingsLayer(map);
        }

        addThreejsShadowModel(map, START_COORDS);

        // Origin (Seller) Marker
        new maplibregl.Marker({ color: '#35e0c0' })
            .setLngLat(START_COORDS)
            .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(`<b style="font-family: sans-serif; color: #35e0c0;">${sName} (seller)</b>`))
            .addTo(map);

        // Destination (Buyer) Marker
        new maplibregl.Marker({ color: '#ffb454' })
            .setLngLat(DESTINATION_COORDS)
            .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(`<b style="font-family: sans-serif; color: #ffb454;">${bName} (buyer)</b>`))
            .addTo(map);

        if (userCoordinates) {
            updateUserMarker(userCoordinates);
        }

        fetchAndDrawRoute(map, START_COORDS, DESTINATION_COORDS);
    });
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
            .setPopup(new maplibregl.Popup({ offset: 15 }).setHTML('<b style="font-family: sans-serif; color: #ff3b30;">Your Live GPS Location</b>'))
            .addTo(mapInstance);
    } else {
        userMarker.setLngLat(coords);
    }
}

function addThreejsShadowModel(map, coords) {
    if (map.getLayer('3d-shadow-model')) return;

    const modelOrigin = coords;
    const modelAltitude = 0;
    const modelRotate = [Math.PI / 2, 0, 0];

    const modelAsMercatorCoordinate = maplibregl.MercatorCoordinate.fromLngLat(modelOrigin, modelAltitude);
    const modelTransform = {
        translateX: modelAsMercatorCoordinate.x,
        translateY: modelAsMercatorCoordinate.y,
        translateZ: modelAsMercatorCoordinate.z,
        rotateX: modelRotate[0],
        rotateY: modelRotate[1],
        rotateZ: modelRotate[2],
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
            directionalLight.castShadow = true;
            this.scene.add(directionalLight);

            const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
            this.scene.add(ambientLight);

            const geometry = new THREE.BoxGeometry(40, 40, 80);
            const material = new THREE.MeshStandardMaterial({ color: 0x35e0c0, roughness: 0.2 });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(0, 0, 40);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.scene.add(mesh);

            this.renderer = new THREE.WebGLRenderer({
                canvas: map.getCanvas(),
                context: gl,
                antialiasing: true
            });
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

async function fetchAndDrawRoute(map, startCoordinates, endCoordinates) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startCoordinates[0]},${startCoordinates[1]};${endCoordinates[0]},${endCoordinates[1]}?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        let routeGeometry;
        if (data.routes && data.routes.length > 0) {
            const routeData = data.routes[0];
            routeGeometry = routeData.geometry;
            const distanceKm = (routeData.distance / 1000).toFixed(1);
            updateNavigationInfo(distanceKm);
        } else {
            const curvedPts = curvedLngLats([startCoordinates[1], startCoordinates[0]], [endCoordinates[1], endCoordinates[0]]);
            routeGeometry = { type: 'LineString', coordinates: curvedPts };
            if (paramDistance) updateNavigationInfo(paramDistance);
        }

        renderRouteLayers(map, routeGeometry);

        const bounds = new maplibregl.LngLatBounds().extend(startCoordinates).extend(endCoordinates);
        map.fitBounds(bounds, { padding: 100, pitch: 45 });
    } catch (err) {
        console.warn('Falling back to curved arc route calculation:', err);
        const curvedPts = curvedLngLats([startCoordinates[1], startCoordinates[0]], [endCoordinates[1], endCoordinates[0]]);
        const routeGeometry = { type: 'LineString', coordinates: curvedPts };
        renderRouteLayers(map, routeGeometry);
        if (paramDistance) updateNavigationInfo(paramDistance);
    }
}

function renderRouteLayers(map, routeGeometry) {
    if (map.getSource('route')) {
        map.getSource('route').setData({ type: 'Feature', properties: {}, geometry: routeGeometry });
    } else {
        map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: routeGeometry } });

        map.addLayer({
            id: 'route-casing',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#002a80', 'line-width': 9 }
        });

        map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#35e0c0', 'line-width': 5 }
        });
    }
}

function addThemeToggleControl(map) {
    class ThemeToggleControl {
        onAdd(mapInstance) {
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const button = document.createElement('button');
            button.type = 'button';
            button.title = 'Toggle Dark / Bright Mode';
            button.id = 'theme-toggle-btn';

            button.style.width = '30px';
            button.style.height = '30px';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.cursor = 'pointer';
            button.style.backgroundColor = '#ffffff';
            button.style.border = 'none';
            button.style.outline = 'none';
            button.style.borderRadius = '4px';

            button.innerHTML = `
                <svg id="theme-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#333333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="5"></circle>
                    <line x1="12" y1="1" x2="12" y2="3"></line>
                    <line x1="12" y1="21" x2="12" y2="23"></line>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                    <line x1="1" y1="12" x2="3" y2="12"></line>
                    <line x1="21" y1="12" x2="23" y2="12"></line>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
            `;

            button.onclick = () => {
                isDarkMode = !isDarkMode;
                const newStyle = isDarkMode ? STYLES.dark : STYLES.bright;
                mapInstance.setStyle(newStyle);
                updateThemeUI(isDarkMode);
            };

            this._container.appendChild(button);
            return this._container;
        }

        onRemove() {
            if (this._container.parentNode) {
                this._container.parentNode.removeChild(this._container);
            }
        }
    }

    map.addControl(new ThemeToggleControl(), 'top-right');
}

function updateThemeUI(darkMode) {
    const card = document.getElementById('nav-info-card');
    const title = document.getElementById('nav-title');
    const distance = document.getElementById('nav-distance');
    const materialElem = document.getElementById('nav-material');
    const priceElem = document.getElementById('nav-price');
    const savingElem = document.getElementById('nav-saving');
    const co2Elem = document.getElementById('nav-co2');

    const toggleBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-icon');

    if (darkMode) {
        if (card) {
            card.style.backgroundColor = '#1e2624';
            card.style.border = '1px solid #2d3b37';
            card.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
        }
        if (title) title.style.color = '#e2ede9';
        if (distance) distance.style.color = '#35e0c0';
        if (materialElem) materialElem.style.color = '#6f8b83';
        if (priceElem) priceElem.style.color = '#d7e8e2';
        if (savingElem) savingElem.style.color = '#35e0c0';
        if (co2Elem) co2Elem.style.color = '#ffb454';

        if (toggleBtn) toggleBtn.style.backgroundColor = '#1e2624';
        if (themeIcon) {
            themeIcon.setAttribute('stroke', '#e2ede9');
            themeIcon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
        }
    } else {
        if (card) {
            card.style.backgroundColor = '#ffffff';
            card.style.border = '1px solid #e0e0e0';
            card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        }
        if (title) title.style.color = '#111111';
        if (distance) distance.style.color = '#0066cc';
        if (materialElem) materialElem.style.color = '#555555';
        if (priceElem) priceElem.style.color = '#222222';
        if (savingElem) savingElem.style.color = '#00875a';
        if (co2Elem) co2Elem.style.color = '#d97706';

        if (toggleBtn) toggleBtn.style.backgroundColor = '#ffffff';
        if (themeIcon) {
            themeIcon.setAttribute('stroke', '#333333');
            themeIcon.innerHTML = `
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            `;
        }
    }
}

function createNavigationInfoCard() {
    const card = document.createElement('div');
    card.id = 'nav-info-card';
    card.style.position = 'absolute';
    card.style.top = '15px';
    card.style.left = '15px';
    card.style.zIndex = '10';
    card.style.backgroundColor = isDarkMode ? '#1e2624' : '#ffffff';
    card.style.border = isDarkMode ? '1px solid #2d3b37' : '1px solid #e0e0e0';
    card.style.padding = '14px 18px';
    card.style.borderRadius = '10px';
    card.style.boxShadow = isDarkMode ? '0 4px 16px rgba(0,0,0,0.35)' : '0 4px 12px rgba(0,0,0,0.15)';
    card.style.fontFamily = 'system-ui, sans-serif';
    card.style.transition = 'all 0.3s ease';

    let extraDetails = '';
    if (material) {
        const matColor = isDarkMode ? '#6f8b83' : '#555555';
        extraDetails += `<div id="nav-material" style="font-size: 11px; color: ${matColor}; text-transform: uppercase; margin-top: 4px;">${material}</div>`;
    }
    if (price) {
        const priceColor = isDarkMode ? '#d7e8e2' : '#222222';
        extraDetails += `<div id="nav-price" style="font-size: 12px; color: ${priceColor}; margin-top: 4px;">Price: ₹${price}/t</div>`;
    }
    if (saving) {
        const savColor = isDarkMode ? '#35e0c0' : '#00875a';
        extraDetails += `<div id="nav-saving" style="font-size: 12px; color: ${savColor};">Saving: ${fmtINR(saving)}/mo</div>`;
    }
    if (co2) {
        const co2Color = isDarkMode ? '#ffb454' : '#d97706';
        extraDetails += `<div id="nav-co2" style="font-size: 12px; color: ${co2Color};">CO2 Avoided: ${fmtT(co2)}</div>`;
    }

    const titleColor = isDarkMode ? '#e2ede9' : '#111111';
    const distColor = isDarkMode ? '#35e0c0' : '#0066cc';

    card.innerHTML = `
        <div id="nav-title" style="font-weight: 700; font-size: 14px; color: ${titleColor};">${dealTitle}</div>
        ${extraDetails}
        <div style="display: flex; align-items: baseline; margin-top: 6px;">
            <span id="nav-distance" style="font-size: 18px; font-weight: 800; color: ${distColor};">${paramDistance ? `${paramDistance} km` : '-- km'}</span>
        </div>
    `;

    document.body.appendChild(card);
}

function updateNavigationInfo(distanceKm) {
    const distanceElement = document.getElementById('nav-distance');
    if (distanceElement) {
        distanceElement.textContent = `${distanceKm} km`;
    }
}

function addRecenterButton(map) {
    class RecenterControl {
        onAdd(map) {
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const button = document.createElement('button');
            button.type = 'button';
            button.title = 'Re-center on user GPS location';
            button.innerHTML = `
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ff3b30" stroke-width="2">
                    <circle cx="12" cy="12" r="8"></circle>
                    <line x1="12" y1="2" x2="12" y2="6"></line>
                    <line x1="12" y1="18" x2="12" y2="22"></line>
                    <line x1="2" y1="12" x2="6" y2="12"></line>
                    <line x1="18" y1="12" x2="22" y2="12"></line>
                    <circle cx="12" cy="12" r="3" fill="#ff3b30"></circle>
                </svg>
            `;

            button.onclick = () => {
                if (userCoordinates) {
                    map.flyTo({ center: userCoordinates, zoom: 16, pitch: 60, essential: true });
                }
            };

            this._container.appendChild(button);
            return this._container;
        }

        onRemove() {
            if (this._container.parentNode) {
                this._container.parentNode.removeChild(this._container);
            }
        }
    }

    map.addControl(new RecenterControl(), 'top-right');
}