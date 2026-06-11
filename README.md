# FireOps Trainer

A touch-friendly web sandbox for fire department training scenarios: satellite imagery,
wind-driven wildland fire spread, drifting smoke, and placeable apparatus/personnel.

> The spread model is a simplified wind-driven cellular model meant to drive training
> discussion ("the fire is now at the fence line — what's your move?"). It is **not**
> a predictive fire-behavior tool.

## Run it

No build step. Either:

- double-click `index.html` (internet required for map tiles), or
- serve the folder: `python3 -m http.server 8000` → http://localhost:8000

Works on tablets — open it from a local server on the same Wi-Fi, or host the folder
anywhere static (GitHub Pages, Netlify, etc.). Geolocation ("📍") requires HTTPS or localhost.

## Using it

1. **Find the property** — search box or 📍 to use device GPS (handy in the field).
2. **Set weather** — drag the compass needle (points the direction the wind is FROM),
   set speed with the slider. Change it mid-scenario to force tactics changes.
3. **Paint fuels (optional)** — 🌿 tool: grass / brush / timber / water·bare. Unpainted
   ground burns as grass.
4. **Ignite** — 🔥 tool, tap or drag on the map, then press ▶. Speeds: 1–8×.
5. **Assign resources** — tap a unit type, tap the map. Drag to move. Tap a unit to
   rename it, toggle **Working** (knocks down fire inside its dashed circle), or remove it.
   - 🚜 Dozer: enable *Cutting line*, then drag it — it leaves a fuel break behind.
   - ✈️ Tanker: *Drop retardant* paints a 90 m retardant line across the wind.
   - 🚧 Fire line tool paints breaks by hand; 🧯 erases fire.
6. **Track the clock** — elapsed scenario time and acreage in the top bar. **Reset fire**
   clears fire but keeps units/lines so you can rerun the same problem.

## Scenarios

☰ menu → Save/Load (stored in the browser) or Export/Import as `.json` files to share
between devices or pre-build problems for drill night.

## Tech

Single page: Leaflet 1.9 + Esri World Imagery tiles, vanilla JS canvas overlays.
Files: `index.html`, `styles.css`, `app.js`.
