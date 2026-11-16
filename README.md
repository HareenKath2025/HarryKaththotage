# Harry Kaththotage: portfolio

Static site, no build step. Pages:

- `index.html`: portfolio (Projects · About · Skills · Contact)
- `projects/galileo-starlink-toulouse/`: live 3D Galileo vs Starlink demo over Toulouse (ECEF / ICRF)

## Before you publish
1. In `index.html`, search for `TODO` and add your real email and LinkedIn URL.
2. (Optional) Add more project cards by copying the `<article class="project">` block.

## Deploy on GitHub Pages (free)
1. Create a repo, e.g. `yourname.github.io` (it's served at the root) or any name (served at `/repo-name/`).
2. Upload all files in this folder, keeping the structure, then commit.
3. Go to Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)` → Save.
4. Wait about a minute. The site is live at `https://yourname.github.io/`.

Netlify / Cloudflare Pages / Vercel also work: drag-and-drop the folder, no build command.

## Test locally
```
python -m http.server 8000
```
Then open http://localhost:8000. Opening the file directly (`file://`) blocks the live data fetch.

## How the satellite demo works
- **Data**: CelesTrak GP TLEs (`GROUP=galileo`, `GROUP=starlink`) fetched in the browser and cached
  in localStorage for 2 h, as CelesTrak asks. If CelesTrak is unreachable, the page uses an idealised Walker
  constellation and labels it clearly as simulated.
- **Propagation**: SGP4 via satellite.js → TEME → ECEF using GMST; az/el computed from Toulouse
  (43.6045° N, 1.4440° E), with a 10° mask.
- **Frames**: ECEF = camera fixed to the Earth. ICRF = camera locked to the inertial frame (TEME-of-date
  used as the ICRF stand-in, ≈0.4° precession offset, not visible at this scale).
- **Libraries** (CDN, pinned): CesiumJS 1.147.0, satellite.js 5.0.0. No Cesium ion token is needed:
  imagery is Cesium's bundled Natural Earth II.
