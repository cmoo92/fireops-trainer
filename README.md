# FireOps Trainer

**Live app:** https://cmoo92.github.io/fireops-trainer/ — open it on any phone/tablet/laptop.

A touch-friendly web sandbox for fire department training scenarios: satellite imagery,
wind-driven wildland fire spread, structure fires with water-supply planning, EMS call
setup, drifting smoke, and placeable apparatus/personnel.

> The spread model is a simplified wind-driven cellular model meant to drive training
> discussion ("the fire is now at the fence line — what's your move?"). It is **not**
> a predictive fire-behavior tool.

## Fire model calibration

The wind slider is treated as 10-m open wind. Measured model behavior on flat,
continuous cured grass:

| Wind | Head fire | % of wind | Fire shape (L/W) |
|------|-----------|-----------|-------------------|
| calm | ~0.5 m/min creep | — | round |
| 10 mph | ~2.0 mph | ~20% | ~2.5 |
| 25 mph | ~4.5 mph | ~18% | ~3.5 |
| 40 mph | ~7 mph | ~18% | ~5 |

Anchors: the CSIRO "head fire ≈ 20% of 10-m wind" rule of thumb for cured grass
(Cheney & Sullivan), Anderson (1983) elliptical length-to-width ratios as used by
FARSITE/FlamMap, Rothermel grass fuel models, and typical backing rates
(~0.5–2 m/min, nearly wind-independent). Brush spreads at roughly half grass speed
(wind-dominated, chaparral-like); timber models a sheltered surface fire that barely
feels wind. Not modeled: slope, spotting, fuel moisture/curing, diurnal change —
which is why it stays a discussion driver, not a prediction.

## Run it

No build step. Either:

- double-click `index.html` (internet required for map tiles), or
- serve the folder: `python3 -m http.server 8000` → http://localhost:8000

Works on tablets — open it from a local server on the same Wi-Fi, or host the folder
anywhere static (GitHub Pages, Netlify, etc.). Geolocation ("📍") requires HTTPS or localhost.

## Using it

First open runs a short guided tour that spotlights each control (re-run it any time
from ☰ → *Take the tour*).

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

## Structure fires & water supply

The unit bar has **Wildland / Structure / EMS** tabs.

- **🏠🔥 Str. fire** — place it on a building; it progresses *smoke showing → working
  fire → fully involved → burned out* on the scenario clock. Park units with
  **Working** enabled next to it to knock it down (one engine ≈ 3 sim-minutes).
  Fully involved buildings throw embers into surrounding fuels, downwind-biased —
  toggle **Cast embers into wildland fuels** off in the unit's popup for a pure
  structure drill that won't kick off a brush fire.
- **🏠 Exposure** — a plain structure that converts to a structure fire if the
  wildland fire reaches it (WUI drills).
- **🪢 Hose tool** — tap points along the route of a lay (pan & zoom stay live
  between taps), then **Finish**; it shows live length in feet. Tap the lay to set
  diameter (1¾″–5″) and GPM — it computes friction loss with the standard
  `C·(Q/100)²·(L/100)` coefficients. Supply lines draw yellow, attack lines red.
- **🚰 Hydrant, 🛢️ Drop tank, 💧 Water source, 🚩 Staging** — placeable water/ops
  points for tender-shuttle and relay planning.

## EMS calls

🤕 Patients, 🧍 victims, LZ (landing-zone) markers, staging, medic, engine, 🚓 police
and a helo — every unit takes free-text **notes** (tap it), so you can script "62M,
chest pain, 2nd floor" and run the call against the scenario clock. Police can be
placed on wildland and structure-fire calls too (traffic, evac, scene security).

## Scenarios

☰ menu → Save/Load (stored in the browser) or Export/Import as `.json` files to share
between devices or pre-build problems for drill night. Saves include fire state,
fuels/lines, units (with notes and structure-fire stage), and hose lays.

## Tech

Single page: Leaflet 1.9 + Esri World Imagery tiles, vanilla JS canvas overlays.
Files: `index.html`, `styles.css`, `app.js`.
