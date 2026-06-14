/* =========================================================================
   FireOps Trainer — wildland fire training sandbox
   Satellite map + wind-driven cellular fire spread + placeable resources.
   Simplified training model — NOT a predictive fire-behavior tool.
   ========================================================================= */
'use strict';

/* ------------------------------ constants ------------------------------ */

const TICK_SECONDS = 10;          // simulated seconds per tick
const STEP_MS = 300;              // wall-clock ms between sim steps
const SPEEDS = [1, 2, 4, 8];

/* Spread calibration (slider wind = 10-m open wind, mph):
   - grass head ROS ~15% of wind — between Rothermel FM1/FM3 (~10-13%)
     and the CSIRO cured-grass 20% rule of thumb
   - ellipse L/W ~3 at 10 mph, ~6-7 at 25 mph — tracks Anderson (1983)
     as used by FARSITE/FlamMap (capped at 8)
   - backing fire ~0.5 m/min, nearly wind-independent
   - timber feels little wind (sheltered surface fire), brush is
     wind-dominated like chaparral */
const FUELS = ['grass', 'brush', 'timber'];
const R0 = { grass: 0.06, brush: 0.03, timber: 0.02 };    // calm rate of spread, m/s
const WIND_GAIN = { grass: 1.0, brush: 1.0, timber: 0.2 };// wind sensitivity per fuel
const BURN_TICKS = { grass: 4, brush: 9, timber: 18 };
const WIND_K = 0.40;              // upwind/flank damping per mph
const WIND_FLOOR = 0.15;          // residual upwind/flank creep
const HEAD_GAIN = 0.8;            // head ROS gain on ws^WIND_EXP
const WIND_EXP = 1.1;             // mildly superlinear wind response
const P_SUB_MAX = 0.85;           // per-substep ignition probability cap
const MAX_CELLS = 400000;         // runaway-fire safety stop (~10k ac @ 10 m)
const WET_TTL = 90;               // ticks a "wet" cell stays damp
const WET_FACTOR = 0.12;
const RET_FACTOR = 0.06;

const NEIGH = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/* hand-drawn SVG icons for gear that has no good emoji */
const SVG_ICONS = {
  hydrant: `<svg viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#6f1d18" stroke-width="1.1" stroke-linejoin="round">
      <path d="M6 38 L9 32 H23 L26 38 Z" fill="#b8332a"/>
      <rect x="10.5" y="13" width="11" height="20" rx="4.5" fill="#e0473b"/>
      <rect x="3" y="20" width="8.5" height="6" rx="3" fill="#cf3b30"/>
      <rect x="20.5" y="20" width="8.5" height="6" rx="3" fill="#cf3b30"/>
      <circle cx="4.6" cy="23" r="2.5" fill="#ecc94b"/>
      <circle cx="27.4" cy="23" r="2.5" fill="#ecc94b"/>
      <path d="M9.5 14 Q16 5 22.5 14 Z" fill="#e0473b"/>
      <circle cx="16" cy="23" r="3.7" fill="#ecc94b"/>
      <circle cx="16" cy="23" r="1.5" fill="#b8932f"/>
      <rect x="14.4" y="6.5" width="3.2" height="4.5" fill="#cf3b30"/>
      <polygon points="16,2.5 19.2,4.6 18,8 14,8 12.8,4.6" fill="#cf3b30"/>
    </g>
  </svg>`,
  droptank: `<svg viewBox="0 0 40 30" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#2b333b" stroke-width="1.1">
      <rect x="2" y="11" width="2.6" height="9" rx="1" fill="#5b6772"/>
      <rect x="35.4" y="11" width="2.6" height="9" rx="1" fill="#5b6772"/>
      <ellipse cx="20" cy="17" rx="18" ry="10" fill="#46525f"/>
      <ellipse cx="20" cy="15.6" rx="16" ry="8.3" fill="#1f5f86" stroke="none"/>
      <ellipse cx="20" cy="15" rx="14.5" ry="7.1" fill="#2f9bd8" stroke="none"/>
      <ellipse cx="14.5" cy="12.8" rx="5.4" ry="2.2" fill="#9fd6f0" stroke="none" opacity="0.75"/>
    </g>
  </svg>`,
  tender: `<svg viewBox="0 0 48 28" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#2b3138" stroke-width="1.1" stroke-linejoin="round">
      <rect x="4" y="20" width="40" height="3" rx="1" fill="#2b3138"/>
      <rect x="2.5" y="6.5" width="28" height="14" rx="7" fill="#d2d7db"/>
      <ellipse cx="3.6" cy="13.5" rx="2.5" ry="7" fill="#bcc2c7"/>
      <line x1="7" y1="13.5" x2="29" y2="13.5" stroke="#a9afb4" stroke-width="0.8"/>
      <path d="M16.5 8.6 C 20 12.5, 19 16, 16.5 16 C 14 16, 13 12.5, 16.5 8.6 Z" fill="#2f9bd8" stroke="#1f6f9e" stroke-width="0.7"/>
      <path d="M30.5 8 H39 l5.5 5.5 V20 H30.5 Z" fill="#e0473b"/>
      <path d="M38.4 9.6 h2.8 l2.6 3.1 h-5.4 Z" fill="#bfe3f5" stroke="#1f6f9e" stroke-width="0.6"/>
      <circle cx="12" cy="23" r="3.6" fill="#23282d"/>
      <circle cx="12" cy="23" r="1.5" fill="#6b7178"/>
      <circle cx="36" cy="23" r="3.6" fill="#23282d"/>
      <circle cx="36" cy="23" r="1.5" fill="#6b7178"/>
    </g>
  </svg>`,
};

const UNIT_TYPES = {
  engine:    { emoji: '🚒', label: 'Engine',    prefix: 'E',   sup: { r: 20, p: 0.50 }, cats: ['wild', 'struct', 'ems'] },
  ladder:    { emoji: '🪜', label: 'Ladder',    prefix: 'L',   sup: { r: 25, p: 0.55 }, cats: ['struct'] },
  brush:     { emoji: '🛻', label: 'Brush',     prefix: 'BR',  sup: { r: 15, p: 0.45 }, cats: ['wild'] },
  tender:    { svg: SVG_ICONS.tender, label: 'Tender',  prefix: 'T',   sup: { r: 12, p: 0.30 }, cats: ['wild', 'struct'] },
  dozer:     { emoji: '🚜', label: 'Dozer',     prefix: 'DZ',  line: true,              cats: ['wild'] },
  crew:      { emoji: '👷', label: 'Crew',      prefix: 'C',   sup: { r: 10, p: 0.35 }, cats: ['wild', 'struct'] },
  helo:      { emoji: '🚁', label: 'Helo',      prefix: 'H',   sup: { r: 28, p: 0.65 }, cats: ['wild', 'ems'] },
  tanker:    { emoji: '✈️', label: 'Tanker',    prefix: 'AT',  drop: true,              cats: ['wild'] },
  medic:     { emoji: '🚑', label: 'Medic',     prefix: 'M',                            cats: ['struct', 'ems'] },
  police:    { emoji: '🚓', label: 'Police',    prefix: 'PD',                           cats: ['wild', 'struct', 'ems'] },
  command:   { emoji: '⛺', label: 'ICP',       prefix: 'IC',                           cats: ['wild', 'struct', 'ems'] },
  sfire:     { emoji: '🏠🔥', label: 'Str. fire', prefix: 'SF', sfire: true,            cats: ['struct'] },
  hydrant:   { svg: SVG_ICONS.hydrant,  label: 'Hydrant',   prefix: 'HYD',              cats: ['struct'] },
  droptank:  { svg: SVG_ICONS.droptank, label: 'Drop tank', prefix: 'DT',               cats: ['struct'] },
  water:     { emoji: '💧', label: 'Water src', prefix: 'W',                            cats: ['wild', 'struct'] },
  structure: { emoji: '🏠', label: 'Exposure',  prefix: 'S',                            cats: ['wild', 'struct'] },
  victim:    { emoji: '🧍', label: 'Victim',    prefix: 'V',                            cats: ['wild', 'ems'] },
  patient:   { emoji: '🤕', label: 'Patient',   prefix: 'PT',                           cats: ['ems'] },
  staging:   { emoji: '🚩', label: 'Staging',   prefix: 'STG',                          cats: ['struct', 'ems'] },
  lz:        { badge: 'LZ', label: 'LZ',        prefix: 'LZ',                           cats: ['ems'] },
  hazard:    { emoji: '⚠️', label: 'Hazard',    prefix: 'HZ',                           cats: ['wild', 'struct', 'ems'] },
};
const PAL_CATS = [
  { id: 'wild', label: 'Wildland' },
  { id: 'struct', label: 'Structure' },
  { id: 'ems', label: 'EMS' },
];

/* structure-fire stage machine (sim-seconds since placement) */
const SF_STAGES = [
  { n: 'Smoke showing',  i: '🏠', b: '💨' },
  { n: 'Working fire',   i: '🏠', b: '🔥' },
  { n: 'Fully involved', i: '🏚️', b: '🔥' },
  { n: 'Burned out',     i: '🏚️', b: '' },
  { n: 'Knocked down',   i: '🏠', b: '💧' },
];
const SF_T_WORKING = 180, SF_T_INVOLVED = 480, SF_T_BURNOUT = 1500;

/* hose friction loss: FL = C * (gpm/100)^2 * (ft/100)  (IFSTA coefficients) */
const HOSE_C = { '1.75': 15.5, '2.5': 2, '3': 0.8, '4': 0.2, '5': 0.08 };

const BRUSH_SIZES = [
  { label: 'Sm', r: 0 },
  { label: 'Med', r: 1 },
  { label: 'Lg', r: 3 },
];

const LS_KEY = 'fireops_scenarios_v1';

/* -------------------------------- state -------------------------------- */

let CELL = 10;                    // meters per grid cell
let origin = null;                // {lat,lng} grid anchor (SW reference)
let dLat = 0, dLng = 0;           // degrees per cell

const cells = new Map();          // "i,j" -> {s:1 burning|2 burned, t, t0}
const burning = new Set();        // keys of burning cells
const mods = new Map();           // "i,j" -> {f:'grass'|'brush'|'timber'|'water'|'break'|'ret'}
const wet = new Map();            // "i,j" -> ttl
const units = [];                 // {id,type,name,working,notes,marker,circle,sf?}
let unitSeq = 0;
const typeCounts = {};
const hoses = [];                 // {id,pts,dia,gpm,line,label}
let hoseSeq = 0;
let palCat = 'wild';              // active unit-palette tab

let windFromDeg = 270;            // direction wind is FROM (meteorological)
let windSpeed = 10;               // mph
let running = false;
let speedIdx = 0;
let simTime = 0;                  // simulated seconds
let tool = 'pan';
let brushIdx = 1;
let smokeEnabled = true;
let lastScenarioName = '';

const particles = [];             // smoke

/* ------------------------------- helpers ------------------------------- */

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function cardinal(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function fmtClock(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* --------------------------------- map --------------------------------- */

const map = L.map('map', {
  zoomControl: false,
  attributionControl: true,
  worldCopyJump: true,
}).setView([39.8, -98.5], 5);

L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri & contributors' }
).addTo(map);

const labelLayers = [
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
];
labelLayers.forEach((l) => l.addTo(map));

/* fire + smoke canvases live in custom panes (above tiles, below markers)
   and are re-pinned to the viewport every frame */
const mapEl = map.getContainer();
function makeCanvas(paneName, z) {
  const pane = map.createPane(paneName);
  pane.style.zIndex = z;
  pane.style.pointerEvents = 'none';
  const c = document.createElement('canvas');
  pane.appendChild(c);
  return c;
}
const fireCanvas = makeCanvas('firepane', 350);
const smokeCanvas = makeCanvas('smokepane', 360);

function pinCanvases() {
  const tl = map.containerPointToLayerPoint([0, 0]);
  L.DomUtil.setPosition(fireCanvas, tl);
  L.DomUtil.setPosition(smokeCanvas, tl);
}
const fctx = fireCanvas.getContext('2d');
const sctx = smokeCanvas.getContext('2d');

function sizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  for (const [c, ctx] of [[fireCanvas, fctx], [smokeCanvas, sctx]]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  needsRedraw = true;
}
window.addEventListener('resize', sizeCanvases);
map.on('resize', sizeCanvases);

let needsRedraw = true;
map.on('move zoom zoomend viewreset', () => { needsRedraw = true; });

/* -------------------------------- grid --------------------------------- */

function ensureOrigin(latlng) {
  if (origin) return;
  origin = { lat: latlng.lat, lng: latlng.lng };
  recomputeDeg();
}
function recomputeDeg() {
  if (!origin) return;
  dLat = CELL / 111320;
  dLng = CELL / (111320 * Math.cos(origin.lat * Math.PI / 180));
}
function llToCell(latlng) {
  return [
    Math.floor((latlng.lng - origin.lng) / dLng),
    Math.floor((latlng.lat - origin.lat) / dLat),
  ];
}
function cellSW(i, j) {
  return [origin.lat + j * dLat, origin.lng + i * dLng];
}
function key(i, j) { return i + ',' + j; }
function parseKey(k) {
  const c = k.indexOf(',');
  return [+k.slice(0, c), +k.slice(c + 1)];
}

function fuelAt(k) {
  const m = mods.get(k);
  if (!m) return 'grass';
  if (m.f === 'break' || m.f === 'water') return null;
  if (m.f === 'ret') return 'grass';
  return m.f;
}

/* ------------------------------ rendering ------------------------------ */

const MOD_COLORS = {
  grass:  'rgba(173, 255, 47, 0.18)',
  brush:  'rgba(58, 95, 42, 0.45)',
  timber: 'rgba(20, 64, 30, 0.55)',
  water:  'rgba(53, 115, 185, 0.50)',
  break:  'rgba(210, 180, 140, 0.85)',
  ret:    'rgba(255, 100, 180, 0.65)',
};

function redrawFire() {
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  fctx.clearRect(0, 0, w, h);
  if (!origin) return;

  // visible cell range
  const b = map.getBounds();
  const i0 = Math.floor((b.getWest() - origin.lng) / dLng) - 1;
  const i1 = Math.ceil((b.getEast() - origin.lng) / dLng) + 1;
  const j0 = Math.floor((b.getSouth() - origin.lat) / dLat) - 1;
  const j1 = Math.ceil((b.getNorth() - origin.lat) / dLat) + 1;

  // x is linear in lng (Web Mercator); y computed per row
  const pA = map.latLngToContainerPoint([origin.lat, origin.lng]);
  const pB = map.latLngToContainerPoint([origin.lat, origin.lng + dLng]);
  const dx = pB.x - pA.x;
  const x0 = pA.x + i0 * dx;

  const rowY = new Map();
  const yFor = (j) => {
    let y = rowY.get(j);
    if (y === undefined) {
      y = map.latLngToContainerPoint([origin.lat + j * dLat, origin.lng]).y;
      rowY.set(j, y);
    }
    return y;
  };

  const drawCell = (i, j, fill) => {
    const yTop = yFor(j + 1), yBot = yFor(j);
    fctx.fillStyle = fill;
    fctx.fillRect(x0 + (i - i0) * dx, yTop, dx + 0.6, (yBot - yTop) + 0.6);
  };
  const inView = (i, j) => i >= i0 && i <= i1 && j >= j0 && j <= j1;

  // painted fuels / lines / retardant
  for (const [k, m] of mods) {
    const [i, j] = parseKey(k);
    if (!inView(i, j)) continue;
    const col = MOD_COLORS[m.f];
    if (col) drawCell(i, j, col);
  }
  // wet cells
  for (const k of wet.keys()) {
    const [i, j] = parseKey(k);
    if (!inView(i, j)) continue;
    drawCell(i, j, 'rgba(93, 177, 255, 0.30)');
  }
  // burned, then burning on top
  const flames = [];
  for (const [k, c] of cells) {
    const [i, j] = parseKey(k);
    if (!inView(i, j)) continue;
    if (c.s === 2) drawCell(i, j, 'rgba(28, 23, 20, 0.78)');
    else flames.push([i, j, c]);
  }
  for (const [i, j, c] of flames) {
    const heat = clamp(c.t / c.t0, 0, 1);            // 1 fresh -> 0 dying
    const r = 255;
    const g = Math.round(90 + 130 * heat + Math.random() * 25);
    const bch = Math.round(20 + 30 * (1 - heat));
    drawCell(i, j, `rgba(${r},${g},${bch},${0.82 + Math.random() * 0.15})`);
  }
}

/* -------------------------------- smoke -------------------------------- */

function puff(lat, lng, tone, sizeMul = 1) {
  if (particles.length > 750) return;
  particles.push({
    lat, lng,
    age: 0,
    life: 7 + Math.random() * 9,             // seconds (wall-clock)
    r0: CELL * (0.4 + Math.random() * 0.5) * sizeMul,
    jx: (Math.random() - 0.5) * 1.6,         // m/s sideways jitter
    jy: (Math.random() - 0.5) * 1.6,
    tone,
  });
}

function spawnSmoke() {
  if (!smokeEnabled) return;
  // wildland fire smoke
  if (burning.size > 0) {
    const n = clamp(Math.round(burning.size / 4), 1, 22);
    const keys = [...burning];
    for (let q = 0; q < n; q++) {
      const k = keys[(Math.random() * keys.length) | 0];
      const [i, j] = parseKey(k);
      const [lat, lng] = cellSW(i + Math.random(), j + Math.random());
      puff(lat, lng, Math.random() < 0.35 ? 'dark' : 'light');
    }
  }
  // structure-fire smoke columns
  for (const u of units) {
    if (!UNIT_TYPES[u.type].sfire) continue;
    const sf = u.sf;
    const ll = u.marker.getLatLng();
    const jit = () => (Math.random() - 0.5) * 0.00012;
    if (sf.stage === 0) puff(ll.lat + jit(), ll.lng + jit(), 'light', 0.8);
    else if (sf.stage === 1) { puff(ll.lat + jit(), ll.lng + jit(), 'dark', 1.2); puff(ll.lat + jit(), ll.lng + jit(), 'dark', 0.9); }
    else if (sf.stage === 2) for (let q = 0; q < 4; q++) puff(ll.lat + jit(), ll.lng + jit(), 'dark', 1.6);
    else if (sf.stage === 4 && simTime - sf.knockedAt < 120) puff(ll.lat + jit(), ll.lng + jit(), 'white', 1.1);
  }
}

function updateSmoke(dt) {
  if (particles.length === 0) return;
  const toRad = ((windFromDeg + 180) % 360) * Math.PI / 180;
  const v = windSpeed * 0.447 * 0.85;        // mph -> m/s, smoke drift factor
  const vx = Math.sin(toRad) * v;
  const vy = Math.cos(toRad) * v;
  const mLat = 111320;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    if (p.age >= p.life) { particles.splice(i, 1); continue; }
    const mLng = 111320 * Math.cos(p.lat * Math.PI / 180);
    p.lat += ((vy + p.jy) * dt) / mLat;
    p.lng += ((vx + p.jx) * dt) / mLng;
  }
}

function drawSmoke() {
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  sctx.clearRect(0, 0, w, h);
  if (particles.length === 0) return;
  const mpp = metersPerPixel();
  for (const p of particles) {
    const f = p.age / p.life;
    const pt = map.latLngToContainerPoint([p.lat, p.lng]);
    const rad = (p.r0 + f * CELL * 6) / mpp;
    if (pt.x < -rad || pt.y < -rad || pt.x > w + rad || pt.y > h + rad) continue;
    const tone = p.tone === 'dark' ? [60, 0.34] : p.tone === 'white' ? [225, 0.30] : [135, 0.22];
    const a = (1 - f) * tone[1];
    sctx.fillStyle = `rgba(${tone[0]},${tone[0]},${tone[0]},${a})`;
    sctx.beginPath();
    sctx.arc(pt.x, pt.y, Math.max(rad, 1.5), 0, Math.PI * 2);
    sctx.fill();
  }
}

function metersPerPixel() {
  const lat = map.getCenter().lat * Math.PI / 180;
  return 156543.03392 * Math.cos(lat) / Math.pow(2, map.getZoom());
}

/* ------------------------------ simulation ----------------------------- */

function tick() {
  simTime += TICK_SECONDS;
  const ws = clamp(windSpeed, 0, 40);
  const toRad = ((windFromDeg + 180) % 360) * Math.PI / 180;
  const DIAG = Math.SQRT2;

  // High winds advance more than one cell per tick: split the tick into
  // substeps so the head fire's rate of spread is honored, not prob-capped.
  const wsPow = Math.pow(ws, WIND_EXP);
  const lobe = 2 + ws / 12;       // higher wind -> narrower head lobe (skinnier ellipse)
  const maxRos = R0.grass * (1 + HEAD_GAIN * wsPow);
  const subs = Math.max(1, Math.ceil(maxRos * TICK_SECONDS / (CELL * P_SUB_MAX)));

  for (let step = 0; step < subs; step++) {
    const ignitions = [];
    for (const k of burning) {
      const [i, j] = parseKey(k);
      for (const [di, dj] of NEIGH) {
        const nk = key(i + di, j + dj);
        if (cells.has(nk)) continue;
        const m = mods.get(nk);
        let fuel = 'grass', mult = 1;
        if (m) {
          if (m.f === 'break' || m.f === 'water') continue;
          if (m.f === 'ret') mult = RET_FACTOR;
          else if (m.f) fuel = m.f;
        }
        if (wet.has(nk)) mult *= WET_FACTOR;

        const dist = (di !== 0 && dj !== 0) ? CELL * DIAG : CELL;
        const bearing = Math.atan2(di, dj);              // from north, cw
        const align = Math.cos(bearing - toRad);          // 1 = downwind
        const ros = R0[fuel]                               // m/s toward neighbor
          * (WIND_FLOOR + (1 - WIND_FLOOR) * Math.exp(WIND_K * ws * (align - 1)))
          * (1 + HEAD_GAIN * WIND_GAIN[fuel] * wsPow * Math.pow(Math.max(0, align), lobe))
          * mult;
        const p = Math.min(ros * TICK_SECONDS / (subs * dist), P_SUB_MAX);
        if (Math.random() < p) ignitions.push([nk, fuel]);
      }
    }
    for (const [nk, fuel] of ignitions) {
      if (cells.has(nk)) continue;
      const dur = BURN_TICKS[fuel] + ((Math.random() * 3) | 0);
      cells.set(nk, { s: 1, t: dur, t0: dur });
      burning.add(nk);
    }
  }

  // burn-down
  for (const k of burning) {
    const c = cells.get(k);
    c.t--;
    if (c.t <= 0) { c.s = 2; burning.delete(k); }
  }

  // unit suppression
  if (origin) {
    for (const u of units) {
      const def = UNIT_TYPES[u.type];
      if (!u.working || !def.sup) continue;
      const ll = u.marker.getLatLng();
      const [ci, cj] = llToCell(ll);
      const rc = Math.ceil(def.sup.r / CELL);
      for (let di = -rc; di <= rc; di++) {
        for (let dj = -rc; dj <= rc; dj++) {
          if ((di * di + dj * dj) * CELL * CELL > def.sup.r * def.sup.r) continue;
          const k = key(ci + di, cj + dj);
          const c = cells.get(k);
          if (c && c.s === 1 && Math.random() < def.sup.p) {
            c.s = 2;
            burning.delete(k);
          }
          wet.set(k, WET_TTL);
        }
      }
    }
  }

  // structure fires & exposures
  for (const u of units) {
    const def = UNIT_TYPES[u.type];
    if (def.sfire) sfireTick(u);
    else if (u.type === 'structure' && origin && simTime % 60 === 0) {
      // a wildland fire reaching an exposure sets it alight
      const [ci, cj] = llToCell(u.marker.getLatLng());
      let hit = false;
      for (let di = -2; di <= 2 && !hit; di++)
        for (let dj = -2; dj <= 2 && !hit; dj++)
          if (burning.has(key(ci + di, cj + dj))) hit = true;
      if (hit) {
        u.type = 'sfire';
        u.sf = { start: simTime, knock: 0, stage: 1, knockedAt: 0, embers: true };
        refreshUnitVisuals(u);
        toast(`${u.name} has caught fire!`, 3500);
      }
    }
  }

  // wet decay
  for (const [k, ttl] of wet) {
    if (ttl <= 1) wet.delete(k);
    else wet.set(k, ttl - 1);
  }

  spawnSmoke();
  needsRedraw = true;

  if (cells.size > MAX_CELLS && running) {
    running = false;
    $('#playBtn').textContent = '▶';
    $('#playBtn').classList.add('paused');
    toast('Fire exceeded simulation limits — paused. Reset fire to continue.', 4000);
  }
}

function sfireTick(u) {
  const sf = u.sf;
  if (sf.stage === 3 || sf.stage === 4) return;   // burned out / knocked

  // knockdown from Working suppression units close to the building
  let pow = 0;
  const ll = u.marker.getLatLng();
  for (const o of units) {
    const od = UNIT_TYPES[o.type];
    if (o !== u && o.working && od.sup &&
        ll.distanceTo(o.marker.getLatLng()) <= Math.max(30, od.sup.r)) {
      pow += od.sup.p;
    }
  }
  if (pow > 0) {
    sf.knock += pow * 0.10;                        // one engine ≈ 3 sim-min to knock
    if (sf.knock >= 1) {
      sf.stage = 4;
      sf.knockedAt = simTime;
      refreshUnitVisuals(u);
      toast(`${u.name} knocked down`);
      return;
    }
  } else {
    sf.knock = Math.max(0, sf.knock - 0.01);
  }

  const age = simTime - sf.start;
  const ns = age < SF_T_WORKING ? 0 : age < SF_T_INVOLVED ? 1 : age < SF_T_BURNOUT ? 2 : 3;
  if (ns !== sf.stage) { sf.stage = ns; refreshUnitVisuals(u); }

  // fully involved buildings throw embers into nearby fuels, downwind-biased
  if (sf.stage === 2 && sf.embers !== false && Math.random() < 0.12) {
    ensureOrigin(ll);
    const toRad = ((windFromDeg + 180) % 360) * Math.PI / 180;
    const br = toRad + (Math.random() - 0.5) * 1.6;
    const dM = 10 + Math.random() * 18;
    const lat = ll.lat + Math.cos(br) * dM / 111320;
    const lng = ll.lng + Math.sin(br) * dM / (111320 * Math.cos(ll.lat * Math.PI / 180));
    const [ci, cj] = llToCell({ lat, lng });
    const k = key(ci, cj);
    const fuel = fuelAt(k);
    if (!cells.has(k) && fuel) {
      const dur = BURN_TICKS[fuel] + ((Math.random() * 3) | 0);
      cells.set(k, { s: 1, t: dur, t0: dur });
      burning.add(k);
    }
  }
}

let stepTimer = null;
function startLoop() {
  if (stepTimer) return;
  stepTimer = setInterval(() => {
    if (!running) return;
    const n = SPEEDS[speedIdx];
    for (let q = 0; q < n; q++) tick();
    updateStats();
  }, STEP_MS);
}

function updateStats() {
  $('#clock').textContent = fmtClock(simTime);
  const acres = cells.size * CELL * CELL / 4046.86;
  $('#acres').textContent = acres >= 100 ? Math.round(acres) : acres.toFixed(1);
}

/* ------------------------------ frame loop ------------------------------ */

let lastTs = 0;
function frame(ts) {
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  pinCanvases();
  if (needsRedraw) { redrawFire(); needsRedraw = false; }
  updateSmoke(dt);
  drawSmoke();
  requestAnimationFrame(frame);
}

/* -------------------------------- tools -------------------------------- */

const PAINT_TOOLS = new Set(['ignite', 'extinguish', 'line', 'fuel']);

function setTool(t) {
  if (tool === 'hose' && t !== 'hose') cancelHoseDraft();
  tool = t;
  document.querySelectorAll('#toolbar .tool[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === t);
  });
  // only freehand paint tools lock the map; hose & unit placement keep pan/zoom live
  const lockMap = PAINT_TOOLS.has(t);
  if (lockMap) {
    map.dragging.disable();
    mapEl.classList.add('crosshair');
    mapEl.style.touchAction = 'none';
  } else {
    map.dragging.enable();
    mapEl.classList.remove('crosshair');
    mapEl.style.touchAction = '';
  }
  if (t === 'hose') startHoseDraft();
  else if (t.startsWith('unit:')) {
    toast(`Tap the map to place ${UNIT_TYPES[t.slice(5)].label}`);
  }
}

function brushR() { return BRUSH_SIZES[brushIdx].r; }

function paintAt(latlng) {
  ensureOrigin(latlng);
  const [ci, cj] = llToCell(latlng);
  const r = tool === 'line' ? Math.min(brushR(), 1) : brushR();
  const fuelSel = $('#fuelSelect').value;

  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      if (di * di + dj * dj > r * r + 0.1) continue;
      const k = key(ci + di, cj + dj);
      if (tool === 'ignite') {
        if (cells.has(k)) continue;
        const fuel = fuelAt(k);
        if (!fuel) continue;
        const dur = BURN_TICKS[fuel] + ((Math.random() * 3) | 0);
        cells.set(k, { s: 1, t: dur, t0: dur });
        burning.add(k);
      } else if (tool === 'extinguish') {
        cells.delete(k);
        burning.delete(k);
      } else if (tool === 'line') {
        mods.set(k, { f: 'break' });
      } else if (tool === 'fuel') {
        if (fuelSel === 'clear') mods.delete(k);
        else mods.set(k, { f: fuelSel });
      }
    }
  }
  needsRedraw = true;
  updateStats();
}

/* pointer painting (ignite / erase fire / fire line / fuel) */
let painting = false;

function evToLatLng(e) {
  const rect = mapEl.getBoundingClientRect();
  return map.containerPointToLatLng([e.clientX - rect.left, e.clientY - rect.top]);
}

mapEl.addEventListener('pointerdown', (e) => {
  if (!PAINT_TOOLS.has(tool)) return;
  if (e.target.closest('.leaflet-marker-icon') || e.target.closest('.leaflet-control')) return;
  painting = true;
  mapEl.setPointerCapture(e.pointerId);
  paintAt(evToLatLng(e));
  e.preventDefault();
});
mapEl.addEventListener('pointermove', (e) => { if (painting) paintAt(evToLatLng(e)); });
['pointerup', 'pointercancel'].forEach((ev) =>
  mapEl.addEventListener(ev, () => { painting = false; })
);

/* unit placement via map click */
map.on('click', (e) => {
  if (tool === 'hose') { addHoseVertex(e.latlng); return; }
  if (tool.startsWith('unit:')) {
    addUnit(tool.slice(5), e.latlng);
    setTool('pan');
  }
});

/* -------------------------------- units -------------------------------- */

function unitIcon(u) {
  const def = UNIT_TYPES[u.type];
  let face, tag = u.name;
  if (def.badge) {
    face = `<div class="lz-badge">${def.badge}</div>`;
  } else if (def.svg) {
    face = `<div class="unit-svg">${def.svg}</div>`;
  } else if (def.sfire) {
    const st = SF_STAGES[u.sf.stage];
    face = `<div class="unit-emoji">${st.i}<span class="sf-badge">${st.b}</span></div>`;
    tag = `${u.name} · ${st.n}`;
  } else {
    face = `<div class="unit-emoji">${def.emoji}</div>`;
  }
  if (u.notes) tag += ' 📝';
  return L.divIcon({
    className: '',
    html: `<div class="unit-icon">${face}` +
          `<div class="unit-tag ${u.working ? 'working' : ''}">${tag}</div></div>`,
    iconSize: [60, 46],
    iconAnchor: [30, 18],
  });
}

function addUnit(type, latlng, opts = {}) {
  const def = UNIT_TYPES[type];
  typeCounts[type] = (typeCounts[type] || 0) + 1;
  const u = {
    id: ++unitSeq,
    type,
    name: opts.name || `${def.prefix}${typeCounts[type]}`,
    working: opts.working || false,
    notes: opts.notes || '',
    marker: null,
    circle: null,
  };
  if (def.sfire) {
    u.sf = opts.sf || { start: simTime, knock: 0, stage: 0, knockedAt: 0, embers: true };
    if (u.sf.embers === undefined) u.sf.embers = true;   // default on for old saves
  }
  u.marker = L.marker(latlng, {
    draggable: true,
    autoPan: true,
    icon: unitIcon(u),
  }).addTo(map);

  u.marker.bindPopup(() => buildUnitPopup(u), { closeButton: false, offset: [0, -8] });

  u.marker.on('drag', (e) => {
    if (u.circle) u.circle.setLatLng(e.latlng);
    if (def.line && u.working) {
      ensureOrigin(e.latlng);
      const [ci, cj] = llToCell(e.latlng);
      const r = CELL <= 5 ? 1 : 0;
      for (let di = -r; di <= r; di++)
        for (let dj = -r; dj <= r; dj++)
          mods.set(key(ci + di, cj + dj), { f: 'break' });
      needsRedraw = true;
    }
  });

  units.push(u);
  refreshUnitVisuals(u);
  return u;
}

function refreshUnitVisuals(u) {
  const def = UNIT_TYPES[u.type];
  u.marker.setIcon(unitIcon(u));
  const wantCircle = u.working && def.sup;
  if (wantCircle && !u.circle) {
    u.circle = L.circle(u.marker.getLatLng(), {
      radius: def.sup.r,
      color: '#5db1ff',
      weight: 2,
      dashArray: '4 6',
      fill: true,
      fillOpacity: 0.07,
      interactive: false,
    }).addTo(map);
  } else if (!wantCircle && u.circle) {
    u.circle.remove();
    u.circle = null;
  }
  if (u.circle) u.circle.setLatLng(u.marker.getLatLng());
}

function removeUnit(u) {
  u.marker.remove();
  if (u.circle) u.circle.remove();
  const idx = units.indexOf(u);
  if (idx >= 0) units.splice(idx, 1);
}

function buildUnitPopup(u) {
  const def = UNIT_TYPES[u.type];
  const el = document.createElement('div');
  el.className = 'unit-popup';

  const title = document.createElement('div');
  title.innerHTML = `<b>${def.emoji} ${def.label}</b>`;
  el.appendChild(title);

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.value = u.name;
  nameIn.placeholder = 'Unit ID';
  nameIn.addEventListener('input', () => {
    u.name = nameIn.value || def.prefix;
    refreshUnitVisuals(u);
  });
  el.appendChild(nameIn);

  const notesIn = document.createElement('textarea');
  notesIn.value = u.notes;
  notesIn.rows = 2;
  notesIn.placeholder = 'Notes (patient info, flow, assignment…)';
  notesIn.className = 'unit-notes';
  notesIn.addEventListener('input', () => {
    u.notes = notesIn.value;
    refreshUnitVisuals(u);
  });
  el.appendChild(notesIn);

  if (def.sfire) {
    const info = document.createElement('div');
    info.className = 'sf-info';
    const renderInfo = () => {
      info.textContent = `${SF_STAGES[u.sf.stage].n}` +
        (u.sf.stage < 3 ? ` · knockdown ${Math.round(Math.min(u.sf.knock, 1) * 100)}%` : '');
    };
    renderInfo();
    const iv = setInterval(() => { if (!info.isConnected) clearInterval(iv); else renderInfo(); }, 800);
    el.appendChild(info);

    const restart = document.createElement('button');
    restart.className = 'btn';
    restart.textContent = '🔁 Restart fire (smoke showing)';
    restart.addEventListener('click', () => {
      u.sf = { start: simTime, knock: 0, stage: 0, knockedAt: 0, embers: u.sf.embers };
      refreshUnitVisuals(u);
      renderInfo();
    });
    el.appendChild(restart);

    const erow = document.createElement('label');
    erow.className = 'row';
    erow.innerHTML = '<span>Cast embers into wildland fuels</span>';
    const echk = document.createElement('input');
    echk.type = 'checkbox';
    echk.checked = u.sf.embers !== false;
    echk.style.cssText = 'width:24px;height:24px;accent-color:#ff7a1a;';
    echk.addEventListener('change', () => { u.sf.embers = echk.checked; });
    erow.appendChild(echk);
    el.appendChild(erow);
  }

  if (def.sup || def.line) {
    const row = document.createElement('label');
    row.className = 'row';
    const what = def.line ? 'Cutting line (drag to cut)' :
      `Working (knocks down ~${def.sup.r} m)`;
    row.innerHTML = `<span>${what}</span>`;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = u.working;
    chk.style.cssText = 'width:24px;height:24px;accent-color:#ff7a1a;';
    chk.addEventListener('change', () => {
      u.working = chk.checked;
      refreshUnitVisuals(u);
    });
    row.appendChild(chk);
    el.appendChild(row);
  }

  if (def.drop) {
    const dropBtn = document.createElement('button');
    dropBtn.className = 'btn';
    dropBtn.textContent = '🩸 Drop retardant here';
    dropBtn.addEventListener('click', () => {
      dropRetardant(u.marker.getLatLng());
      u.marker.closePopup();
    });
    el.appendChild(dropBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger';
  delBtn.textContent = '🗑 Remove unit';
  delBtn.addEventListener('click', () => removeUnit(u));
  el.appendChild(delBtn);

  return el;
}

function dropRetardant(latlng) {
  ensureOrigin(latlng);
  // strip perpendicular to the wind, to cut off the head
  const toRad = ((windFromDeg + 180) % 360) * Math.PI / 180;
  const perp = toRad + Math.PI / 2;
  const lenM = 90, halfWidthCells = Math.max(0, Math.round(6 / CELL));
  const mLat = 111320, mLng = 111320 * Math.cos(latlng.lat * Math.PI / 180);
  for (let d = -lenM / 2; d <= lenM / 2; d += CELL / 2) {
    const lat = latlng.lat + (Math.cos(perp) * d) / mLat;
    const lng = latlng.lng + (Math.sin(perp) * d) / mLng;
    const [ci, cj] = llToCell({ lat, lng });
    for (let di = -halfWidthCells; di <= halfWidthCells; di++)
      for (let dj = -halfWidthCells; dj <= halfWidthCells; dj++)
        mods.set(key(ci + di, cj + dj), { f: 'ret' });
  }
  needsRedraw = true;
  toast('Retardant line dropped');
}

/* -------------------------------- hoses --------------------------------- */

function hoseLenM(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += map.distance(pts[i - 1], pts[i]);
  }
  return m;
}
const hoseColor = (dia) => (parseFloat(dia) >= 4 ? '#ffd23f' : '#ff5d5d');

function addHose(pts, dia = '5', gpm = 800) {
  const h = { id: ++hoseSeq, pts, dia, gpm, line: null, label: null };
  h.line = L.polyline(pts, { color: hoseColor(dia), weight: 5, opacity: 0.92 }).addTo(map);
  h.label = L.marker(pts[Math.floor(pts.length / 2)], {
    icon: L.divIcon({ className: '', html: '<div class="hose-label"></div>', iconSize: [0, 0] }),
    interactive: true,
    keyboard: false,
  }).addTo(map);
  h.line.bindPopup(() => buildHosePopup(h), { closeButton: false });
  h.label.bindPopup(() => buildHosePopup(h), { closeButton: false });
  updateHose(h);
  hoses.push(h);
  return h;
}

function updateHose(h) {
  const ft = Math.round(hoseLenM(h.pts) * 3.28084);
  h.line.setStyle({ color: hoseColor(h.dia) });
  const el = h.label.getElement();
  const lab = el && el.querySelector('.hose-label');
  if (lab) {
    lab.textContent = `${ft} ft · ${h.dia}″`;
    lab.style.borderColor = hoseColor(h.dia);
    lab.style.color = hoseColor(h.dia);
  }
}

function removeHose(h) {
  h.line.remove();
  h.label.remove();
  const i = hoses.indexOf(h);
  if (i >= 0) hoses.splice(i, 1);
}

function buildHosePopup(h) {
  const el = document.createElement('div');
  el.className = 'unit-popup';
  const ft = Math.round(hoseLenM(h.pts) * 3.28084);

  const title = document.createElement('div');
  title.innerHTML = `<b>🚒 Hose lay — ${ft} ft</b>`;
  el.appendChild(title);

  const row1 = document.createElement('label');
  row1.className = 'row';
  row1.innerHTML = '<span>Diameter</span>';
  const diaSel = document.createElement('select');
  for (const d of Object.keys(HOSE_C)) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d + '″' + (parseFloat(d) >= 4 ? ' (supply)' : ' (attack)');
    if (d === h.dia) o.selected = true;
    diaSel.appendChild(o);
  }
  row1.appendChild(diaSel);
  el.appendChild(row1);

  const row2 = document.createElement('label');
  row2.className = 'row';
  row2.innerHTML = '<span>Flow (GPM)</span>';
  const gpmIn = document.createElement('input');
  gpmIn.type = 'number';
  gpmIn.value = h.gpm;
  gpmIn.min = 50; gpmIn.max = 2000; gpmIn.step = 50;
  gpmIn.style.width = '80px';
  row2.appendChild(gpmIn);
  el.appendChild(row2);

  const fl = document.createElement('div');
  fl.className = 'sf-info';
  const recompute = () => {
    const loss = HOSE_C[h.dia] * Math.pow(h.gpm / 100, 2) * (ft / 100);
    fl.textContent = `Friction loss ≈ ${Math.round(loss)} psi (flat ground)`;
  };
  recompute();
  diaSel.addEventListener('change', () => { h.dia = diaSel.value; updateHose(h); recompute(); });
  gpmIn.addEventListener('input', () => { h.gpm = +gpmIn.value || 0; recompute(); });
  el.appendChild(fl);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger';
  delBtn.textContent = '🗑 Remove hose';
  delBtn.addEventListener('click', () => removeHose(h));
  el.appendChild(delBtn);

  return el;
}

/* hose drawing: tap to drop points; pan & zoom stay live between taps.
   (drag-to-draw was unusable on touch — a pan gesture drew a hose) */
const hoseDraft = { active: false, pts: [], verts: [], preview: null };

function startHoseDraft() {
  cleanupHoseDraft();
  hoseDraft.active = true;
  hoseDraft.preview = L.polyline([], { color: '#ffd23f', weight: 4, dashArray: '6 6' }).addTo(map);
  map.doubleClickZoom.disable();
  $('#hoseHint').hidden = false;
  updateHoseHint();
}
function addHoseVertex(latlng) {
  if (!hoseDraft.active) return;
  hoseDraft.pts.push(latlng);
  hoseDraft.verts.push(
    L.circleMarker(latlng, {
      radius: 5, color: '#ffd23f', weight: 2,
      fillColor: '#14181d', fillOpacity: 1, interactive: false,
    }).addTo(map)
  );
  hoseDraft.preview.setLatLngs(hoseDraft.pts);
  updateHoseHint();
}
function undoHoseVertex() {
  if (!hoseDraft.pts.length) return;
  hoseDraft.pts.pop();
  const v = hoseDraft.verts.pop();
  if (v) v.remove();
  hoseDraft.preview.setLatLngs(hoseDraft.pts);
  updateHoseHint();
}
function updateHoseHint() {
  const n = hoseDraft.pts.length;
  const ft = Math.round(hoseLenM(hoseDraft.pts) * 3.28084);
  $('#hoseHintText').textContent =
    n === 0 ? 'Tap the map to start the hose lay — pan & zoom still work' :
    n === 1 ? 'Tap to add the next point along the route' :
    `${ft} ft · ${n} points — tap to extend, then Finish`;
}
function finishHoseDraft() {
  const pts = hoseDraft.pts.slice();
  const ok = pts.length >= 2 && hoseLenM(pts) >= 8;
  cleanupHoseDraft();
  tool = 'pan';
  setTool('pan');
  if (ok) {
    const h = addHose(pts.map((p) => [p.lat, p.lng]));
    toast(`Hose lay: ${Math.round(hoseLenM(h.pts) * 3.28084)} ft — tap it to set diameter & GPM`);
  } else {
    toast('A hose lay needs at least two points');
  }
}
function cancelHoseDraft() { cleanupHoseDraft(); }
function cleanupHoseDraft() {
  if (hoseDraft.preview) hoseDraft.preview.remove();
  hoseDraft.verts.forEach((v) => v.remove());
  hoseDraft.active = false;
  hoseDraft.pts = [];
  hoseDraft.verts = [];
  hoseDraft.preview = null;
  if (map.doubleClickZoom) map.doubleClickZoom.enable();
  const hint = $('#hoseHint');
  if (hint) hint.hidden = true;
}

$('#hoseUndo').addEventListener('click', undoHoseVertex);
$('#hoseFinish').addEventListener('click', finishHoseDraft);
$('#hoseCancel').addEventListener('click', () => setTool('pan'));

/* build unit palette (tabbed by scenario type) */
function buildPalette() {
  const pal = $('#unitPalette');
  pal.innerHTML = '';
  for (const t of Object.keys(UNIT_TYPES)) {
    const def = UNIT_TYPES[t];
    if (!def.cats.includes(palCat)) continue;
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = 'unit:' + t;
    b.title = 'Place ' + def.label;
    const face = def.badge ? `<span class="lz-mini">${def.badge}</span>`
      : def.svg ? `<span class="pal-svg">${def.svg}</span>`
      : def.emoji;
    b.innerHTML = `${face}<span>${def.label}</span>`;
    b.addEventListener('click', () => setTool(tool === 'unit:' + t ? 'pan' : 'unit:' + t));
    pal.appendChild(b);
  }
}
(function buildPalTabs() {
  const tabs = $('#palTabs');
  for (const c of PAL_CATS) {
    const b = document.createElement('button');
    b.className = 'pal-tab' + (c.id === palCat ? ' active' : '');
    b.dataset.cat = c.id;
    b.textContent = c.label;
    b.addEventListener('click', () => {
      palCat = c.id;
      tabs.querySelectorAll('.pal-tab').forEach((x) =>
        x.classList.toggle('active', x.dataset.cat === palCat));
      if (tool.startsWith('unit:')) setTool('pan');
      buildPalette();
    });
    tabs.appendChild(b);
  }
  buildPalette();
})();

/* tool buttons */
document.querySelectorAll('#toolbar .group:first-child .tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.tool === 'fuel') $('#fuelSelect').focus?.();
    setTool(b.dataset.tool);
  });
});
$('#fuelSelect').addEventListener('change', () => setTool('fuel'));
$('#brushBtn').addEventListener('click', () => {
  brushIdx = (brushIdx + 1) % BRUSH_SIZES.length;
  $('#brushLabel').textContent = BRUSH_SIZES[brushIdx].label;
});

/* ------------------------------- wind UI ------------------------------- */

const compass = $('#compass');
const needle = $('#needle');

function setWind(deg) {
  windFromDeg = ((Math.round(deg / 5) * 5) % 360 + 360) % 360;
  needle.setAttribute('transform', `rotate(${windFromDeg} 50 50)`);
  $('#windLabel').innerHTML = `Wind <b>${windFromDeg}° ${cardinal(windFromDeg)}</b>`;
}

let compassDrag = false;
function compassAngle(e) {
  const r = compass.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return Math.atan2(dx, -dy) * 180 / Math.PI;
}
compass.addEventListener('pointerdown', (e) => {
  compassDrag = true;
  compass.setPointerCapture(e.pointerId);
  setWind(compassAngle(e));
  e.preventDefault();
});
compass.addEventListener('pointermove', (e) => { if (compassDrag) setWind(compassAngle(e)); });
['pointerup', 'pointercancel'].forEach((ev) =>
  compass.addEventListener(ev, () => { compassDrag = false; })
);

$('#windSpeed').addEventListener('input', (e) => {
  windSpeed = +e.target.value;
  $('#windSpeedLabel').textContent = `${windSpeed} mph`;
});

/* ----------------------------- sim controls ---------------------------- */

$('#playBtn').addEventListener('click', () => {
  running = !running;
  const b = $('#playBtn');
  b.textContent = running ? '⏸' : '▶';
  b.classList.toggle('paused', !running);
  if (running && burning.size === 0) toast('No fire yet — use 🔥 Ignite, then ▶');
});

$('#speedBtn').addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $('#speedBtn').textContent = SPEEDS[speedIdx] + '×';
});

$('#resetFireBtn').addEventListener('click', () => {
  cells.clear(); burning.clear(); wet.clear();
  particles.length = 0;
  simTime = 0;
  running = false;
  $('#playBtn').textContent = '▶';
  $('#playBtn').classList.add('paused');
  needsRedraw = true;
  updateStats();
  toast('Fire reset (lines, fuels and units kept)');
});

/* ------------------------------ persistence ---------------------------- */

function serialize() {
  const c = map.getCenter();
  return {
    v: 1,
    name: lastScenarioName,
    cell: CELL,
    origin,
    windFromDeg, windSpeed, simTime,
    view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
    cells: [...cells].map(([k, x]) => [k, x.s, x.t, x.t0]),
    mods: [...mods].map(([k, m]) => [k, m.f]),
    wet: [...wet],
    units: units.map((u) => {
      const ll = u.marker.getLatLng();
      return { type: u.type, lat: ll.lat, lng: ll.lng, name: u.name, working: u.working,
               notes: u.notes || '', sf: u.sf || null };
    }),
    hoses: hoses.map((h) => ({ pts: h.pts, dia: h.dia, gpm: h.gpm })),
  };
}

function loadScenario(d) {
  // wipe
  cells.clear(); burning.clear(); mods.clear(); wet.clear();
  particles.length = 0;
  [...units].forEach(removeUnit);
  [...hoses].forEach(removeHose);
  for (const t in typeCounts) typeCounts[t] = 0;

  CELL = d.cell || 10;
  $('#cellSizeSel').value = String(CELL);
  origin = d.origin || null;
  recomputeDeg();
  setWind(d.windFromDeg ?? 270);
  windSpeed = d.windSpeed ?? 10;
  $('#windSpeed').value = windSpeed;
  $('#windSpeedLabel').textContent = `${windSpeed} mph`;
  simTime = d.simTime || 0;
  lastScenarioName = d.name || '';

  for (const [k, s, t, t0] of d.cells || []) {
    cells.set(k, { s, t, t0 });
    if (s === 1) burning.add(k);
  }
  for (const [k, f] of d.mods || []) mods.set(k, { f });
  for (const [k, ttl] of d.wet || []) wet.set(k, ttl);
  for (const u of d.units || [])
    addUnit(u.type, [u.lat, u.lng], { name: u.name, working: u.working, notes: u.notes, sf: u.sf || undefined });
  for (const h of d.hoses || []) addHose(h.pts, h.dia, h.gpm);

  if (d.view) map.setView([d.view.lat, d.view.lng], d.view.zoom);
  running = false;
  $('#playBtn').textContent = '▶';
  $('#playBtn').classList.add('paused');
  needsRedraw = true;
  updateStats();
}

function getStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
function setStore(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

$('#saveBtn').addEventListener('click', () => {
  const name = prompt('Scenario name:', lastScenarioName || 'Scenario 1');
  if (!name) return;
  lastScenarioName = name;
  const store = getStore();
  store[name] = serialize();
  try {
    setStore(store);
    toast(`Saved “${name}”`);
  } catch {
    toast('Too large for browser storage — use Export instead');
  }
  closePanels();
});

$('#loadBtn').addEventListener('click', () => {
  const list = $('#scenarioList');
  list.innerHTML = '';
  const store = getStore();
  const names = Object.keys(store);
  if (names.length === 0) {
    list.innerHTML = '<div class="empty-note">No saved scenarios yet.</div>';
  }
  for (const n of names) {
    const row = document.createElement('div');
    row.className = 'scenario-row';
    const open = document.createElement('button');
    open.className = 'menu-item name';
    open.textContent = '📂 ' + n;
    open.addEventListener('click', () => {
      loadScenario(store[n]);
      closePanels();
      toast(`Loaded “${n}”`);
    });
    const del = document.createElement('button');
    del.className = 'btn del';
    del.textContent = '🗑';
    del.addEventListener('click', () => {
      if (!confirm(`Delete scenario “${n}”?`)) return;
      const s = getStore();
      delete s[n];
      setStore(s);
      row.remove();
    });
    row.append(open, del);
    list.appendChild(row);
  }
  $('#menuPanel').hidden = true;
  $('#loadPanel').hidden = false;
});

$('#exportBtn').addEventListener('click', () => {
  const data = serialize();
  const name = (lastScenarioName || 'scenario').replace(/[^\w-]+/g, '_');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fireops-${name}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  closePanels();
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then((txt) => {
    try {
      loadScenario(JSON.parse(txt));
      toast('Scenario imported');
    } catch {
      toast('Could not read that file');
    }
  });
  e.target.value = '';
  closePanels();
});

/* ------------------------------ menu & misc ----------------------------- */

function closePanels() {
  $('#menuPanel').hidden = true;
  $('#loadPanel').hidden = true;
}
$('#menuBtn').addEventListener('click', () => {
  const p = $('#menuPanel');
  $('#loadPanel').hidden = true;
  p.hidden = !p.hidden;
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => { $(b.dataset.close).hidden = true; });
});

$('#labelsChk').addEventListener('change', (e) => {
  labelLayers.forEach((l) => e.target.checked ? l.addTo(map) : l.remove());
});
$('#smokeChk').addEventListener('change', (e) => {
  smokeEnabled = e.target.checked;
  if (!smokeEnabled) particles.length = 0;
});

$('#cellSizeSel').addEventListener('change', (e) => {
  const v = +e.target.value;
  if (cells.size || mods.size) {
    if (!confirm('Changing cell size clears fire and painted layers. Continue?')) {
      e.target.value = String(CELL);
      return;
    }
  }
  cells.clear(); burning.clear(); mods.clear(); wet.clear();
  particles.length = 0;
  CELL = v;
  origin = null;
  needsRedraw = true;
  updateStats();
});

$('#clearUnitsBtn').addEventListener('click', () => {
  if (units.length && !confirm('Remove all units?')) return;
  [...units].forEach(removeUnit);
  for (const t in typeCounts) typeCounts[t] = 0;
  closePanels();
});

$('#clearAllBtn').addEventListener('click', () => {
  if (!confirm('Clear fire, lines, fuels, hoses AND units?')) return;
  cells.clear(); burning.clear(); mods.clear(); wet.clear();
  particles.length = 0;
  [...units].forEach(removeUnit);
  [...hoses].forEach(removeHose);
  for (const t in typeCounts) typeCounts[t] = 0;
  simTime = 0;
  origin = null;
  running = false;
  $('#playBtn').textContent = '▶';
  needsRedraw = true;
  updateStats();
  closePanels();
});

$('#helpBtn').addEventListener('click', () => {
  $('#helpOverlay').hidden = false;
  closePanels();
});

/* ------------------------------ guided tour ----------------------------- */

const TOUR_STEPS = [
  { center: true, title: '👋 Welcome to FireOps Trainer',
    text: 'Set up a live wildland scenario in about a minute. This quick tour points out where everything lives — nothing burns until you say so.',
    cta: 'Start tour' },
  { sel: '#searchBox', title: '1 · Find the property',
    text: 'Type an address or landmark here and press Enter to fly the map there.' },
  { sel: '#locateBtn', title: '2 · …or use your GPS',
    text: 'Out on the training ground? Tap 📍 and the map jumps to where you’re standing.' },
  { sel: '.wind-group', title: '3 · Set the wind',
    text: 'Drag the compass needle — it points the direction the wind is coming FROM. The slider sets speed. Change either mid-burn and the fire reacts.' },
  { sel: '[data-tool="ignite"]', title: '4 · Light the fire',
    text: 'Tap Ignite, then tap or drag on the map to set fire. The ⭕ button changes brush size.' },
  { sel: '.sim-controls', title: '5 · Run the scenario',
    text: '▶ starts and pauses. Tap 1× to fast-forward up to 8×. Elapsed time and acres burned show here, and Reset fire reruns the same problem.' },
  { sel: '[data-tool="unit:engine"]', title: '6 · Assign resources',
    text: 'Tap a unit type, then tap the map to place it. Drag to move; tap one to rename it, add notes, set it Working, or remove it. The tabs switch between Wildland, Structure and EMS kits — including 🏠🔥 structure fires, 🚰 hydrants, 🛢️ drop tanks, 🤕 patients and LZs.' },
  { sel: '[data-tool="line"]', title: '7 · Go defensive',
    text: 'Fire line paints a fuel break, the 🚜 dozer cuts line as you drag it, the ✈️ tanker drops retardant — and the 🪢 Hose tool lays hose: tap points along the route (pan freely between taps), Finish, then tap the lay for length & friction loss.' },
  { sel: '#menuBtn', title: '8 · Scenarios & more',
    text: 'Save and share scenarios, paint fuels, see the legend — or run this tour again any time.',
    cta: 'Finish' },
];

const tour = { i: -1, layer: null, spot: null, card: null };

function startTour() {
  if (tour.layer) endTour();
  closePanels();
  $('#helpOverlay').hidden = true;
  setTool('pan');

  const layer = document.createElement('div');
  layer.id = 'tourLayer';
  const spot = document.createElement('div');
  spot.className = 'tour-spotlight hidden-spot';
  const card = document.createElement('div');
  card.className = 'tour-card';
  layer.append(spot, card);
  document.body.appendChild(layer);
  Object.assign(tour, { i: -1, layer, spot, card });

  window.addEventListener('resize', tourReposition);
  showTourStep(0);
}

function endTour() {
  if (!tour.layer) return;
  window.removeEventListener('resize', tourReposition);
  tour.layer.remove();
  Object.assign(tour, { i: -1, layer: null, spot: null, card: null });
  localStorage.setItem('fireops_tour_done', '1');
}

function showTourStep(n) {
  tour.i = n;
  const step = TOUR_STEPS[n];
  const card = tour.card;

  card.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = step.title;
  const p = document.createElement('p');
  p.textContent = step.text;
  const row = document.createElement('div');
  row.className = 'tour-row';

  const dots = document.createElement('div');
  dots.className = 'tour-dots';
  dots.textContent = `${n + 1} / ${TOUR_STEPS.length}`;

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'tour-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };

  if (n > 0) row.appendChild(mkBtn('‹', 'ghost', () => showTourStep(n - 1)));
  row.appendChild(dots);
  if (n < TOUR_STEPS.length - 1) {
    row.appendChild(mkBtn('Skip', 'ghost', endTour));
    row.appendChild(mkBtn(step.cta || 'Next', 'primary', () => showTourStep(n + 1)));
  } else {
    row.appendChild(mkBtn(step.cta || 'Done', 'primary', endTour));
  }
  card.append(h, p, row);

  // bring the target on-screen first (top/bottom bars scroll on phones)
  const target = step.sel ? document.querySelector(step.sel) : null;
  if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  setTimeout(tourReposition, target ? 330 : 0);
}

function tourReposition() {
  if (!tour.layer || tour.i < 0) return;
  const step = TOUR_STEPS[tour.i];
  const { spot, card } = tour;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = Math.min(340, vw - 20);

  const target = step.sel ? document.querySelector(step.sel) : null;
  if (!target || step.center) {
    spot.classList.add('hidden-spot');
    spot.style.boxShadow = 'none';
    card.style.left = (vw - cw) / 2 + 'px';
    card.style.top = Math.max(14, vh / 2 - card.offsetHeight / 2 - 40) + 'px';
    tour.layer.style.background = 'rgba(6, 9, 13, .66)';
    return;
  }
  tour.layer.style.background = 'transparent';
  spot.classList.remove('hidden-spot');
  spot.style.boxShadow = '';

  const pad = 6;
  const r = target.getBoundingClientRect();
  const top = Math.max(2, r.top - pad);
  const left = Math.max(2, r.left - pad);
  const w = Math.min(r.width + pad * 2, vw - left - 2);
  const hgt = r.height + pad * 2;
  spot.style.top = top + 'px';
  spot.style.left = left + 'px';
  spot.style.width = w + 'px';
  spot.style.height = hgt + 'px';

  // card above or below the spotlight, whichever has room
  const ch = card.offsetHeight || 170;
  let cy = (top + hgt + 14 + ch < vh - 10) ? top + hgt + 14 : top - ch - 14;
  cy = clamp(cy, 10, vh - ch - 10);
  let cx = clamp(r.left + r.width / 2 - cw / 2, 10, vw - cw - 10);
  card.style.top = cy + 'px';
  card.style.left = cx + 'px';
}

$('#tourBtn').addEventListener('click', () => { closePanels(); startTour(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') endTour(); });

/* --------------------------- search & locate ---------------------------- */

$('#searchBox').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  e.target.blur();
  toast('Searching…');
  fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)
    .then((r) => r.json())
    .then((res) => {
      if (res && res[0]) {
        map.setView([+res[0].lat, +res[0].lon], 16);
        toast(res[0].display_name.split(',').slice(0, 2).join(','), 3000);
      } else toast('No results found');
    })
    .catch(() => toast('Search failed — check connection'));
});

$('#locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Geolocation not available');
  toast('Locating…');
  navigator.geolocation.getCurrentPosition(
    (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 17),
    () => toast('Could not get location'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

/* --------------------------------- init --------------------------------- */

setWind(windFromDeg);
sizeCanvases();
updateStats();
startLoop();
requestAnimationFrame(frame);

/* quiet first-load locate attempt */
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (map.getZoom() <= 6) map.setView([pos.coords.latitude, pos.coords.longitude], 16);
    },
    () => {},
    { timeout: 4000, maximumAge: 120000 }
  );
}

setTimeout(() => {
  if (!localStorage.getItem('fireops_tour_done')) startTour();
}, 700);
