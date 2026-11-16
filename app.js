/* Galileo vs Starlink: Toulouse sky in real time
 * CesiumJS (rendering) + satellite.js (SGP4) + CelesTrak GP data (TLE).
 * No Cesium ion token required: imagery is the Natural Earth II set bundled with Cesium.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ config
  const OBS = { name: 'Toulouse', latDeg: 43.6045, lonDeg: 1.4440, hKm: 0.15 };
  const MASK_DEG = 10;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MU = 398600.4418;            // km^3/s^2
  const RE = 6378.137;               // km
  const CACHE_MS = 2 * 3600 * 1000;  // CelesTrak asks clients not to re-download within 2 h
  const CELESTRAK = g => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;
  const COLORS = {
    GALILEO: { base: '#4cc9f0', focus: ['#4cc9f0', '#3a86ff'] },
    STARLINK: { base: '#ff7a59', focus: ['#ff4d5a', '#ff9f1c'] }
  };
  const OBS_GD = { latitude: OBS.latDeg * D2R, longitude: OBS.lonDeg * D2R, height: OBS.hKm };

  const $ = id => document.getElementById(id);
  const state = {
    frame: 'ECEF',
    sats: [], galileo: [], starlink: [],
    starlinkPool: [], starlinkTotal: 0, starlinkN: 60,
    focus: [], source: 'live', retrieved: null, notes: [],
    lastUi: 0, lastSky: 0, gmst: 0, date: new Date()
  };

  // ------------------------------------------------------------------ storage (best effort)
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } }
  };

  // ------------------------------------------------------------------ data
  async function fetchGroup(group) {
    const key = 'celestrak-tle:' + group;
    const cached = store.get(key);
    if (cached && Date.now() - cached.t < CACHE_MS) return { text: cached.text, t: cached.t, from: 'cache' };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(CELESTRAK(group), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!/^1 \d/m.test(text)) throw new Error(text.slice(0, 80) || 'empty response');
      const t = Date.now();
      store.set(key, { t, text });
      return { text, t, from: 'network' };
    } catch (err) {
      if (cached) return { text: cached.text, t: cached.t, from: 'stale cache' };
      throw new Error(`${group}: ${err.message}`);
    }
  }

  function parseTle(text) {
    const L = text.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(Boolean);
    const out = [];
    for (let i = 0; i < L.length - 1; i++) {
      if (L[i].startsWith('1 ') && L[i + 1].startsWith('2 ')) {
        const prev = L[i - 1];
        const name = prev && !/^[12] /.test(prev) ? prev.trim() : 'NORAD ' + L[i].slice(2, 7).trim();
        out.push({ name, l1: L[i], l2: L[i + 1] });
        i++;
      }
    }
    return out;
  }

  const meanMotion = t => parseFloat(t.l2.slice(52, 63)); // rev/day

  function shortName(name, con) {
    if (con === 'GALILEO') {
      const prn = name.match(/PRN\s*(E\d+)/i);
      return name.split(/[\s(]/)[0] + (prn ? ` · ${prn[1]}` : '');
    }
    return name.split(/[\s(]/)[0];
  }

  function tleSat(t, con) {
    const satrec = satellite.twoline2satrec(t.l1, t.l2);
    const n = meanMotion(t);
    return {
      id: con + ':' + t.l1.slice(2, 7).trim(), name: t.name, short: shortName(t.name, con), con,
      periodMin: 1440 / n,
      teme(d) {
        const pv = satellite.propagate(satrec, d);
        const p = pv && pv.position;
        return p && typeof p === 'object' && isFinite(p.x) ? p : null;
      }
    };
  }

  // Idealised circular orbit, used only if live data can't be loaded.
  function synthSat(name, con, aKm, incDeg, raanDeg, m0Deg, epochMs) {
    const n = Math.sqrt(MU / aKm ** 3);
    const i = incDeg * D2R, O = raanDeg * D2R, m0 = m0Deg * D2R;
    const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i);
    return {
      id: con + ':' + name, name, short: name, con, periodMin: 2 * Math.PI / n / 60,
      teme(d) {
        const u = m0 + n * (d.getTime() - epochMs) / 1000;
        const cu = Math.cos(u), su = Math.sin(u);
        return { x: aKm * (cO * cu - sO * su * ci), y: aKm * (sO * cu + cO * su * ci), z: aKm * su * si };
      }
    };
  }

  function synthGalileo() {
    // Walker 24/3/1 at 29,600 km semi-major axis, 56°
    const ep = Date.UTC(2026, 0, 1), out = [];
    for (let p = 0; p < 3; p++) for (let s = 0; s < 8; s++)
      out.push(synthSat(`GAL-SIM-${'ABC'[p]}${s + 1}`, 'GALILEO', 29600, 56, 120 * p, 45 * s + 15 * p, ep));
    return out;
  }

  function synthStarlinkPool() {
    const ep = Date.UTC(2026, 0, 1), out = [];
    const planes = 72, per = 22;
    for (let p = 0; p < planes; p++) for (let s = 0; s < per; s++)
      out.push(synthSat(`SL-SIM-${String(p * per + s + 1).padStart(4, '0')}`, 'STARLINK', RE + 550, 53, 5 * p, (360 / per) * s + 2.5 * p, ep));
    return out;
  }

  // Evenly spaced sample so the subset covers all planes/shells.
  function sample(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [], step = arr.length / n;
    for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * step)]);
    return out;
  }

  async function loadData() {
    const [gal, sl] = await Promise.allSettled([fetchGroup('galileo'), fetchGroup('starlink')]);

    if (gal.status === 'fulfilled') {
      state.galileo = parseTle(gal.value.text).map(t => tleSat(t, 'GALILEO'));
      state.retrieved = new Date(gal.value.t);
      state.galFrom = gal.value.from;
    }
    if (sl.status === 'fulfilled') {
      const all = parseTle(sl.value.text);
      // operational satellites only: mean motion > 15 rev/day (≈ below 600 km, excludes raising/deorbiting)
      const op = all.filter(t => { const n = meanMotion(t); return n > 15.0 && n < 16.0; });
      state.starlinkTotal = op.length;
      state.starlinkPool = op.map(t => tleSat(t, 'STARLINK'));
      state.retrieved = state.retrieved || new Date(sl.value.t);
      state.slFrom = sl.value.from;
    }
    if (!state.galileo.length || !state.starlinkPool.length) {
      state.source = 'sim';
      const reasons = [gal, sl].filter(r => r.status === 'rejected').map(r => r.reason.message);
      state.notes.push(reasons.join('; ') || 'no usable TLEs');
      if (!state.galileo.length) state.galileo = synthGalileo();
      if (!state.starlinkPool.length) { state.starlinkPool = synthStarlinkPool(); state.starlinkTotal = 0; }
    }
  }

  // ------------------------------------------------------------------ Cesium setup
  const viewer = new Cesium.Viewer('cesium', {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'))
    ),
    baseLayerPicker: false, geocoder: false, sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: true, fullscreenButton: true, homeButton: true,
    infoBox: false, selectionIndicator: false, shouldAnimate: true
  });
  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.skyAtmosphere.show = true;
  viewer.cesiumWidget.creditContainer.style.opacity = '0.6';

  const C = Cesium.Cartesian3;
  const cart = e => new C(e.x * 1000, e.y * 1000, e.z * 1000);
  const obsCart = C.fromDegrees(OBS.lonDeg, OBS.latDeg, OBS.hKm * 1000);

  // Observer marker
  viewer.entities.add({
    position: obsCart,
    point: { pixelSize: 9, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#3ddc84'), outlineWidth: 2 },
    label: {
      text: 'Toulouse', font: '600 13px Inter, sans-serif', fillColor: Cesium.Color.WHITE,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, outlineColor: Cesium.Color.BLACK,
      pixelOffset: new Cesium.Cartesian2(-12, -6), horizontalOrigin: Cesium.HorizontalOrigin.RIGHT
    }
  });

  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const losLines = scene.primitives.add(new Cesium.PolylineCollection());
  const trails = scene.primitives.add(new Cesium.PolylineCollection());
  const labels = scene.primitives.add(new Cesium.LabelCollection());

  const colorCache = {};
  const col = (css, a = 1) => (colorCache[css + a] ||= Cesium.Color.fromCssColorString(css).withAlpha(a));
  const matCache = {};
  const mat = (css, a) => (matCache[css + a] ||= Cesium.Material.fromType('Color', { color: col(css, a) }));

  function addSatGraphics(s) {
    s.point = points.add({ position: C.ZERO, pixelSize: 5, color: col(COLORS[s.con].base), id: { sat: s } });
    s.los = losLines.add({ show: false, positions: [obsCart, obsCart], width: 1.2, material: mat('#7ee2a8', 0.55) });
  }
  function removeSatGraphics(s) {
    if (s.point) points.remove(s.point);
    if (s.los) losLines.remove(s.los);
    s.point = s.los = null;
  }

  function setStarlinkSample(n) {
    state.starlinkN = n;
    const keepFocus = state.focus.filter(f => f.con === 'STARLINK');
    state.starlink.forEach(s => { if (!keepFocus.includes(s)) removeSatGraphics(s); });
    const next = sample(state.starlinkPool, n);
    keepFocus.forEach(f => { if (!next.includes(f)) next.push(f); });
    next.forEach(s => { if (!s.point) addSatGraphics(s); });
    state.starlink = next;
    state.sats = state.galileo.concat(state.starlink);
    computeAll(state.date);
  }

  // ------------------------------------------------------------------ per-frame physics
  function computeSat(s, d, gmst) {
    const p = s.teme(d);
    if (!p) { s.ok = false; return; }
    s.ok = true;
    const e = satellite.eciToEcf(p, gmst);
    const la = satellite.ecfToLookAngles(OBS_GD, e);
    s.ecf = e; s.az = (la.azimuth * R2D + 360) % 360; s.el = la.elevation * R2D; s.range = la.rangeSat;
    s.vis = s.el >= MASK_DEG;
  }

  function computeAll(d) {
    const gmst = satellite.gstime(d);
    state.date = d; state.gmst = gmst;
    for (const s of state.sats) {
      computeSat(s, d, gmst);
      if (!s.point) continue;
      if (!s.ok) { s.point.show = false; s.los.show = false; continue; }
      const pos = cart(s.ecf);
      const focused = state.focus.includes(s);
      s.point.show = true;
      s.point.position = pos;
      const lo = s.con === 'STARLINK' ? 3.5 : 5;
      s.point.pixelSize = focused ? 11 : s.vis ? 8 : lo;
      s.point.color = focused ? col(s.focusColor) : col(COLORS[s.con].base, s.vis ? 1 : 0.5);
      s.point.outlineColor = Cesium.Color.WHITE;
      s.point.outlineWidth = s.vis || focused ? 1.5 : 0;
      s.los.show = s.vis;
      if (s.vis) s.los.positions = [obsCart, pos];
      if (s.label) s.label.position = pos;
    }
  }

  // Orbit trail: samples over one period centred on now.
  //   ECEF  → each sample rotated with its own GMST (Earth-relative path: loops / twisted rosettes)
  //   ICRF  → all samples rotated with the *current* GMST (rigid inertial ellipse)
  function refreshTrailSamples(s, d) {
    const per = s.periodMin * 60000;
    const N = s.con === 'GALILEO' ? 280 : 180;
    const smp = [];
    for (let k = 0; k <= N; k++) {
      const t = new Date(d.getTime() - per / 2 + (per * k) / N);
      const p = s.teme(t);
      if (!p) continue;
      const g = satellite.gstime(t);
      const ecf = satellite.eciToEcf(p, g);
      const la = satellite.ecfToLookAngles(OBS_GD, ecf);
      smp.push({ teme: p, ecf, az: la.azimuth * R2D, el: la.elevation * R2D });
    }
    s.samples = smp; s.samplesAt = d.getTime();
  }

  function updateTrails(d, force) {
    for (const s of state.focus) {
      const per = s.periodMin * 60000;
      const stale = !s.samples || Math.abs(d.getTime() - s.samplesAt) > per / 300;
      if (stale) refreshTrailSamples(s, d);
      if (state.frame === 'ECEF') {
        if (stale || force) s.trail.positions = s.samples.map(x => cart(x.ecf));
      } else {
        const g = state.gmst;
        s.trail.positions = s.samples.map(x => cart(satellite.eciToEcf(x.teme, g)));
      }
    }
  }

  // ------------------------------------------------------------------ focus management
  function focusColorFor(con) {
    const used = state.focus.filter(f => f.con === con).map(f => f.focusColor);
    return COLORS[con].focus.find(c => !used.includes(c)) || COLORS[con].focus[0];
  }
  function addFocus(s) {
    if (!s || state.focus.includes(s)) return;
    const same = state.focus.filter(f => f.con === s.con);
    if (same.length >= 2) removeFocus(same[0], true);
    s.focusColor = focusColorFor(s.con);
    s.trail = trails.add({ positions: [obsCart, obsCart], width: 1.8, material: mat(s.focusColor, 0.9) });
    s.label = labels.add({
      position: s.point ? s.point.position : C.ZERO, text: s.short,
      font: '600 12px Inter, sans-serif', fillColor: Cesium.Color.WHITE,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, outlineColor: Cesium.Color.BLACK,
      pixelOffset: new Cesium.Cartesian2(10, 0), horizontalOrigin: Cesium.HorizontalOrigin.LEFT
    });
    state.focus.push(s);
    s.samples = null;
    updateTrails(state.date, true);
    renderFocusList();
  }
  function removeFocus(s, silent) {
    state.focus = state.focus.filter(f => f !== s);
    if (s.trail) trails.remove(s.trail);
    if (s.label) labels.remove(s.label);
    s.trail = s.label = s.samples = null;
    if (!silent) renderFocusList();
  }
  function pickDefaultFocus() {
    for (const list of [state.galileo, state.starlink]) {
      list.filter(s => s.ok).sort((a, b) => b.el - a.el).slice(0, 2).forEach(addFocus);
    }
  }

  // ------------------------------------------------------------------ reference frames
  function temeToFixed(g) {
    const c = Math.cos(g), s = Math.sin(g);
    return new Cesium.Matrix3(c, s, 0, -s, c, 0, 0, 0, 1);  // row-major: same rotation as satellite.eciToEcf
  }
  function setFrame(f) {
    if (f === state.frame) return;
    state.frame = f;
    $('frameEcef').classList.toggle('on', f === 'ECEF');
    $('frameIcrf').classList.toggle('on', f === 'ICRF');
    const cam = viewer.camera;
    if (f === 'ICRF') {
      const M = temeToFixed(state.gmst);
      const offset = Cesium.Matrix3.multiplyByVector(Cesium.Matrix3.transpose(M, new Cesium.Matrix3()), cam.positionWC, new C());
      cam.lookAtTransform(Cesium.Matrix4.fromRotationTranslation(M), offset);
    } else {
      cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    frameNote();
    updateTrails(state.date, true);
  }
  function frameNote() {
    $('frameNote').innerHTML = state.frame === 'ECEF'
      ? 'Earth-fixed view: the camera turns with the Earth. Toulouse stays put, the stars drift, and orbits are drawn as the twisted paths the satellites trace <i>relative to the ground</i>.'
      : 'Inertial view: the camera is fixed to the stars. The Earth spins underneath and each orbit is a clean, fixed ellipse. This is the frame orbital dynamics are written in.';
  }
  // keep the camera locked to the inertial frame while time runs
  scene.postUpdate.addEventListener(() => {
    if (state.frame !== 'ICRF') return;
    const cam = viewer.camera;
    const offset = C.clone(cam.position);
    cam.lookAtTransform(Cesium.Matrix4.fromRotationTranslation(temeToFixed(state.gmst)), offset);
  });

  // ------------------------------------------------------------------ sky plot
  const sky = $('sky');
  const sctx = sky.getContext('2d');
  function sizeSky() {
    const dpr = window.devicePixelRatio || 1, css = sky.clientWidth || 240;
    sky.width = sky.height = Math.round(css * dpr);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function drawSky() {
    const W = sky.clientWidth || 240, cx = W / 2, cy = W / 2, R = W / 2 - 14;
    const P = (az, el) => { const r = R * (90 - el) / 90, a = az * D2R; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    sctx.clearRect(0, 0, W, W);
    // dome
    const grd = sctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grd.addColorStop(0, '#13264d'); grd.addColorStop(1, '#0a1530');
    sctx.fillStyle = grd; sctx.beginPath(); sctx.arc(cx, cy, R, 0, 2 * Math.PI); sctx.fill();
    sctx.strokeStyle = 'rgba(150,180,240,.35)'; sctx.lineWidth = 1;
    for (const el of [0, 30, 60]) { sctx.beginPath(); sctx.arc(cx, cy, R * (90 - el) / 90, 0, 2 * Math.PI); sctx.stroke(); }
    sctx.beginPath(); sctx.moveTo(cx - R, cy); sctx.lineTo(cx + R, cy); sctx.moveTo(cx, cy - R); sctx.lineTo(cx, cy + R); sctx.stroke();
    sctx.setLineDash([3, 3]); sctx.strokeStyle = 'rgba(255,204,102,.75)';
    sctx.beginPath(); sctx.arc(cx, cy, R * (90 - MASK_DEG) / 90, 0, 2 * Math.PI); sctx.stroke(); sctx.setLineDash([]);
    sctx.fillStyle = '#c9d6ee'; sctx.font = '600 10px JetBrains Mono, monospace'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText('N', cx, cy - R - 7); sctx.fillText('S', cx, cy + R + 7); sctx.fillText('E', cx + R + 7, cy); sctx.fillText('W', cx - R - 7, cy);
    sctx.fillStyle = 'rgba(200,215,240,.5)'; sctx.font = '9px JetBrains Mono, monospace';
    sctx.fillText('30°', cx + 4, cy - R * 60 / 90 + 7); sctx.fillText('60°', cx + 4, cy - R * 30 / 90 + 7);

    // tracks for focused satellites (one period centred on now)
    for (const s of state.focus) {
      if (!s.samples) continue;
      sctx.strokeStyle = s.focusColor; sctx.lineWidth = 1.4; sctx.globalAlpha = 0.85;
      sctx.beginPath(); let pen = false;
      for (const x of s.samples) {
        if (x.el < 0) { pen = false; continue; }
        const [px, py] = P(x.az, x.el);
        pen ? sctx.lineTo(px, py) : sctx.moveTo(px, py); pen = true;
      }
      sctx.stroke(); sctx.globalAlpha = 1;
    }
    // satellites above horizon
    let nG = 0, nS = 0;
    for (const s of state.sats) {
      if (!s.ok || s.el < 0) continue;
      const focused = state.focus.includes(s);
      if (s.vis) s.con === 'GALILEO' ? nG++ : nS++;
      const [px, py] = P(s.az, s.el);
      sctx.globalAlpha = s.vis ? 1 : 0.45;
      sctx.fillStyle = focused ? s.focusColor : COLORS[s.con].base;
      sctx.beginPath(); sctx.arc(px, py, focused ? 4.5 : s.con === 'GALILEO' ? 3.5 : 2.6, 0, 2 * Math.PI); sctx.fill();
      if (focused) { sctx.strokeStyle = '#fff'; sctx.lineWidth = 1.2; sctx.stroke(); }
      if (focused || (s.vis && s.con === 'GALILEO')) {
        sctx.fillStyle = '#dfe8fa'; sctx.font = '8.5px JetBrains Mono, monospace'; sctx.textAlign = 'left';
        sctx.fillText(s.short.split(' ')[0].replace('GSAT', 'G').replace('STARLINK-', 'SL-'), px + 5, py - 5);
      }
      sctx.globalAlpha = 1;
    }
    $('skyNote').textContent = nG + nS === 0
      ? `No satellite above the ${MASK_DEG}° mask right now`
      : `${nG} Galileo · ${nS} Starlink above ${MASK_DEG}° (dimmed: 0–${MASK_DEG}°)`;
  }

  // ------------------------------------------------------------------ UI
  const fmtUtc = d => d.toISOString().replace('T', ' ').slice(0, 19);
  const fmtPeriod = m => m > 120 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${m.toFixed(1)} min`;

  function blurb(s) {
    if (s.con === 'GALILEO')
      return `MEO navigation satellite, one orbit every ${fmtPeriod(s.periodMin)}. A slow, wide wave between ~56° N and S; once up, it stays in Toulouse's sky for hours.`;
    return `LEO broadband satellite, ~${Math.round(1440 / s.periodMin)} laps a day (${fmtPeriod(s.periodMin)} each). A pass over Toulouse lasts minutes, and each one lands further west as the Earth turns.`;
  }

  function renderFocusList() {
    const box = $('focusList');
    box.innerHTML = '';
    for (const s of state.focus) {
      const d = document.createElement('div');
      d.className = 'sat-card';
      d.innerHTML = `<div class="sat-head"><i style="background:${s.focusColor}"></i><b></b><span class="tag">${s.con === 'GALILEO' ? 'Galileo · MEO' : 'Starlink · LEO'}</span>
        <span class="el" data-el></span><button class="x" title="Stop tracking">×</button></div>
        <p data-geo></p><p>${blurb(s)}</p>`;
      d.querySelector('b').textContent = s.short;
      d.querySelector('.x').onclick = () => removeFocus(s);
      s.card = d;
      box.appendChild(d);
    }
    if (!state.focus.length) box.innerHTML = '<p class="small muted">Nothing tracked. Click a satellite on the globe.</p>';
  }

  function updateUi() {
    $('utc').textContent = fmtUtc(state.date);
    let g = 0, sl = 0;
    for (const s of state.galileo) if (s.ok && s.vis) g++;
    for (const s of state.starlink) if (s.ok && s.vis) sl++;
    $('galCount').textContent = `${g}/${state.galileo.length}`;
    $('slCount').textContent = `${sl}/${state.starlink.length}`;
    $('slExtrap').textContent = state.starlinkTotal
      ? `Scaled to the full fleet of ${state.starlinkTotal.toLocaleString('en')} operational Starlinks: ≈ ${Math.round(sl * state.starlinkTotal / state.starlink.length)} above the mask.`
      : '';
    for (const s of state.focus) {
      if (!s.card || !s.ok) continue;
      const el = s.card.querySelector('[data-el]');
      el.textContent = `el ${s.el.toFixed(0)}°`;
      el.classList.toggle('up', s.vis);
      s.card.querySelector('[data-geo]').textContent =
        `az ${s.az.toFixed(0)}° · range ${Math.round(s.range).toLocaleString('en')} km · alt ${Math.round(Math.hypot(s.ecf.x, s.ecf.y, s.ecf.z) - RE).toLocaleString('en')} km`;
    }
  }

  function renderDataInfo() {
    const c = viewer.clock;
    const win = `<b>${fmtUtc(Cesium.JulianDate.toDate(c.startTime)).slice(0, 16)} → ${fmtUtc(Cesium.JulianDate.toDate(c.stopTime)).slice(0, 16)} UTC</b>`;
    if (state.source === 'live') {
      $('dataInfo').innerHTML = `DATA WINDOW ${win}<br>CelesTrak GP data (TLE, SGP4): GALILEO ${state.galileo.length} sats; STARLINK ${state.starlink.length} of ${state.starlinkTotal.toLocaleString('en')} operational (mean motion 15–16 rev/day). Retrieved ${fmtUtc(state.retrieved).slice(0, 16)} UTC${state.galFrom === 'cache' ? ' (cached)' : state.galFrom === 'stale cache' ? ' (stale cache)' : ''}.`;
    } else {
      document.querySelector('.panel-title span').textContent = 'Toulouse sky · simulated';
      $('dataInfo').innerHTML = `DATA WINDOW ${win}<br><span class="warn">⚠ Live CelesTrak data unavailable (${state.notes.join('; ')}). Showing idealised constellations: Galileo Walker 24/3/1 at 23,222 km / 56°, Starlink shell at 550 km / 53°. Geometry is realistic; positions are not the real satellites.</span>`;
    }
  }

  // controls
  const playBtn = $('playBtn');
  const syncPlay = () => { playBtn.textContent = viewer.clock.shouldAnimate ? '❚❚ Pause' : '▶ Play'; };
  playBtn.onclick = () => { viewer.clock.shouldAnimate = !viewer.clock.shouldAnimate; syncPlay(); };
  $('speed').onchange = e => { viewer.clock.multiplier = +e.target.value; };
  $('nowBtn').onclick = () => { viewer.clock.currentTime = Cesium.JulianDate.now(); };
  $('frameEcef').onclick = () => setFrame('ECEF');
  $('frameIcrf').onclick = () => setFrame('ICRF');
  $('slN').onchange = e => setStarlinkSample(+e.target.value);
  $('panelCollapse').onclick = () => $('panel').classList.toggle('collapsed');
  const navToggle = document.querySelector('.nav-toggle'), navLinks = document.querySelector('.nav-links');
  navToggle.onclick = () => navLinks.classList.toggle('open');

  // click a satellite to track it
  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(ev => {
    const picked = scene.pick(ev.position);
    const s = picked && picked.id && picked.id.sat;
    if (s) state.focus.includes(s) ? removeFocus(s) : addFocus(s);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ------------------------------------------------------------------ main loop
  scene.preUpdate.addEventListener((sc, time) => {
    if (!state.sats.length) return;
    const d = Cesium.JulianDate.toDate(time);
    computeAll(d);
    updateTrails(d, false);
    const now = performance.now();
    if (now - state.lastSky > 100) { drawSky(); state.lastSky = now; }
    if (now - state.lastUi > 250) { updateUi(); state.lastUi = now; }
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    sizeSky(); frameNote(); drawSky();
    viewer.camera.setView({ destination: C.fromDegrees(OBS.lonDeg, OBS.latDeg - 8, 1.0e8) });
    const home = C.fromDegrees(OBS.lonDeg, OBS.latDeg - 8, 1.0e8);
    viewer.homeButton.viewModel.command.beforeExecute.addEventListener(e => {
      e.cancel = true;
      if (state.frame === 'ICRF') setFrame('ECEF');
      viewer.camera.flyTo({ destination: home, duration: 1.2 });
    });

    try { await loadData(); }
    catch (err) { state.source = 'sim'; state.notes.push(err.message); state.galileo = synthGalileo(); state.starlinkPool = synthStarlinkPool(); }

    const now = Cesium.JulianDate.now();
    const clock = viewer.clock;
    clock.startTime = Cesium.JulianDate.addHours(now, -2, new Cesium.JulianDate());
    clock.stopTime = Cesium.JulianDate.addHours(now, 24, new Cesium.JulianDate());
    clock.currentTime = now.clone();
    clock.clockRange = Cesium.ClockRange.CLAMPED;
    clock.multiplier = +$('speed').value;
    clock.shouldAnimate = true;
    viewer.timeline.zoomTo(clock.startTime, clock.stopTime);

    state.galileo.forEach(addSatGraphics);
    setStarlinkSample(state.starlinkN);       // also computes positions
    pickDefaultFocus();
    renderDataInfo();
    updateUi(); drawSky(); syncPlay();
    $('loading').classList.add('hidden');
  }

  window.addEventListener('resize', () => { sizeSky(); drawSky(); });
  boot();
})();
