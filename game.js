'use strict';
const CELL = 4, WALL_H = 3.2, MAX_LEVEL = 10, SAVE_KEY = 'hollow_depths_save3';
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NAMES = ['The Gate', 'Drowned Cellar', 'Ossuary', 'Pale Corridor', 'The Furnace',
  'Weeping Halls', 'Black Archive', 'The Understair', 'Hollow Heart', 'The Last Door'];
const $ = id => document.getElementById(id);
const rnd = n => Math.random() * n | 0;
const UA_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobile = () => UA_MOBILE || matchMedia('(pointer: coarse)').matches; // phones and tablets get the touch version
let mobile = false;

/* ---------- Renderer, camera, lights ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: !UA_MOBILE, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMappingExposure = 1.0;
renderer.setClearColor(0x04060a, 1); renderer.autoClear = false; // two passes: the world first, then the first-person hands on a fresh depth buffer (no wall clipping)
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060a);
scene.fog = new THREE.FogExp2(0x04060a, 0.072);
const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 90);
camera.rotation.order = 'YXZ';
scene.add(camera, new THREE.HemisphereLight(0x3b4768, 0x1c1815, .55));
// viewmodel scene: own camera and lights, so the hands never clip into walls and never inherit the world's fisheye
const vmScene = new THREE.Scene(), vmCam = new THREE.PerspectiveCamera(46, 1, 0.01, 6);
vmScene.add(vmCam, new THREE.HemisphereLight(0x8a96b8, 0x2a2420, .6));
const vmKey = new THREE.PointLight(0xffe6c0, .9, 2.4, 2); vmKey.position.set(0, .12, .12); vmCam.add(vmKey);
const vmRim = new THREE.DirectionalLight(0x6a80b0, .55); vmRim.position.set(-1, .6, .8); vmScene.add(vmRim);
function resize() {
  mobile = isMobile(); document.body.classList.toggle('mobile', mobile);
  renderer.setPixelRatio(mobile ? 1 : Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = vmCam.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix(); vmCam.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const torch = new THREE.SpotLight(0xffeccc, 2.7, 30, 0.58, 0.55, 1.5);
torch.castShadow = true; torch.shadow.mapSize.set(UA_MOBILE ? 1024 : 2048, UA_MOBILE ? 1024 : 2048); torch.shadow.bias = -0.0005; torch.shadow.normalBias = .02;
torch.target.position.set(0, 0, -1);
camera.add(torch, torch.target);
// two persistent effect lights (the shader light count must never change while playing): chest glow and portal glow
const chestLight = new THREE.PointLight(0xffc860, 0, 9, 2), portalLight = new THREE.PointLight(0xff3010, 0, 12, 2);
scene.add(chestLight, portalLight);

/* ---------- Procedural PBR textures: colour, normal and roughness maps built from one soft height field ---------- */
const cv = s => Object.assign(document.createElement('canvas'), { width: s, height: s });
const AN = Math.min(16, renderer.capabilities.getMaxAnisotropy()), TEX = UA_MOBILE ? 512 : 1024, MID = UA_MOBILE ? 256 : 512, SM = 256;
function fbm(s, oct = 6) { // smooth, seamlessly tiling cloud noise: each octave is wrap-padded before it is upscaled
  const c = cv(s), g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, s, s); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  for (let o = 0; o < oct; o++) {
    const n = 4 << o, m = n + 2, t = cv(m), tg = t.getContext('2d'), im = tg.createImageData(m, m), v = Array.from({ length: n * n }, () => rnd(256));
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) { const i = (y * m + x) * 4, a = v[((y - 1 + n) % n) * n + (x - 1 + n) % n]; im.data[i] = im.data[i + 1] = im.data[i + 2] = a; im.data[i + 3] = 255; }
    tg.putImageData(im, 0, 0); g.globalAlpha = .5 / (o * .6 + 1); const k = s / n; g.drawImage(t, -k, -k, k * m, k * m);
  }
  g.globalAlpha = 1; return c;
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v, smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
function field(s, oct) { // fbm canvas -> zero-mean float field in about [-1, 1] (same amplitude whatever the octave count)
  const d = fbm(s, oct).getContext('2d').getImageData(0, 0, s, s).data, N = s * s, f = new Float32Array(N);
  let m = 0, q = 0; for (let i = 0; i < N; i++) m += d[i * 4]; m /= N;
  for (let i = 0; i < N; i++) { const v = d[i * 4] - m; q += v * v; }
  const k = 1 / (Math.sqrt(q / N) * 2.4 || 1);
  for (let i = 0; i < N; i++) f[i] = Math.max(-1, Math.min(1, (d[i * 4] - m) * k));
  return f;
}
function blur(a, s, r, passes = 2) { // separable, wrap-around box blur (two passes ~ a smooth bell); keeps tiles seamless
  if (r < 1) return a;
  const t = new Float32Array(a.length), k = 1 / (2 * r + 1), w = v => (v + s) % s;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < s; y++) {
      const row = y * s; let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + w(x)];
      for (let x = 0; x < s; x++) { t[row + x] = acc * k; acc += a[row + w(x + r + 1)] - a[row + w(x - r)]; }
    }
    for (let x = 0; x < s; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += t[w(y) * s + x];
      for (let y = 0; y < s; y++) { a[y * s + x] = acc * k; acc += t[w(y + r + 1) * s + x] - t[w(y - r) * s + x]; }
    }
  }
  return a;
}
function pbr(base, joints, rough, s = MID, wet = 0, o = {}) {
  // joints(ctx) paints a 256-unit pattern on mid-grey: black = groove or mortar, light/dark rectangles = per-stone tint
  const N = s * s, k = s / 256, bev = Math.max(1, Math.round((o.bevel ?? 1.3) * k)), str = (o.str ?? 5) * k, grain = (o.grain ?? .012) / k;
  const pc = cv(s), pg = pc.getContext('2d'); pg.fillStyle = '#808080'; pg.fillRect(0, 0, s, s);
  pg.save(); pg.scale(k, k); pg.lineJoin = pg.lineCap = 'round'; pg.strokeStyle = '#000'; pg.lineWidth = 3; joints(pg); pg.restore();
  const pd = pg.getImageData(0, 0, s, s).data, pat = new Float32Array(N), G = new Float32Array(N);
  for (let i = 0; i < N; i++) { pat[i] = pd[i * 4] / 255; G[i] = clamp01(pat[i] / .4); }          // G: 0 in a groove, 1 on the stone face
  const tint = blur(Float32Array.from(pat), s, 1, 1), face = blur(Float32Array.from(G), s, Math.max(1, bev >> 1), 1), ao = blur(Float32Array.from(G), s, bev * 3, 1);
  const nz = field(s, 5), mot = new Float32Array(N), fine = new Float32Array(N), wd = wet ? new Float32Array(N) : null, off = (s * 5 + 37) | 0;
  for (let i = 0; i < N; i++) mot[i] = Math.random() * 2 - 1;
  blur(mot, s, Math.max(2, 2 * k | 0), 1); { let q = 0; for (let i = 0; i < N; i += 7) q += mot[i] * mot[i]; const g = 1 / (Math.sqrt(q / (N / 7)) * 2.4 || 1); for (let i = 0; i < N; i++) mot[i] = Math.max(-1, Math.min(1, mot[i] * g)); }   // soft mottling (cheap: blurred noise)
  if (wd) for (let i = 0; i < N; i++) wd[i] = nz[(i + off) % N];
  for (let i = 0; i < N; i++) fine[i] = Math.random() * 2 - 1;
  blur(fine, s, 1, 1);
  const hgt = blur(Float32Array.from(G), s, bev, 2); // bevelled edges: the groove profile is a smooth ramp, not a hard step
  for (let i = 0; i < N; i++) hgt[i] = hgt[i] * .55 + nz[i] * .045 + fine[i] * grain + (tint[i] - .5) * .08;
  const rgb = [1, 3, 5].map(i => parseInt(base.substr(i, 2), 16)), col = cv(s), cg = col.getContext('2d'), ci = cg.createImageData(s, s);
  const nor = cv(s), ng = nor.getContext('2d'), ni = ng.createImageData(s, s), rgh = cv(s), rg = rgh.getContext('2d'), ri = rg.createImageData(s, s);
  const H = (x, y) => hgt[((y + s) % s) * s + ((x + s) % s)];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const p = y * s + x, i = p * 4;
    let wm = 0; if (wd) wm = smooth(.42, .95, wd[p]);                                              // wet patches: a slight darkening, and mirror-smooth
    const f = (.5 + .5 * face[p]) * (.84 + .16 * ao[p]) * (1 + (tint[p] - .5) * face[p] * 1.4) * (1 + nz[p] * .17 + mot[p] * .09) * (1 + fine[p] * .03) * (1 - wm * .08);
    ci.data[i] = Math.min(255, rgb[0] * f); ci.data[i + 1] = Math.min(255, rgb[1] * f); ci.data[i + 2] = Math.min(255, rgb[2] * f); ci.data[i + 3] = 255;
    const nx = -(H(x + 1, y) - H(x - 1, y)) * str * .5, ny = (H(x, y + 1) - H(x, y - 1)) * str * .5, l = Math.hypot(nx, ny, 1);
    ni.data[i] = (nx / l * .5 + .5) * 255; ni.data[i + 1] = (ny / l * .5 + .5) * 255; ni.data[i + 2] = (1 / l * .5 + .5) * 255; ni.data[i + 3] = 255;
    let r = rough + nz[p] * .1 + (1 - face[p]) * .12; r += (.07 - r) * wm;
    ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = clamp01(r) * 255; ri.data[i + 3] = 255;
  }
  cg.putImageData(ci, 0, 0); ng.putImageData(ni, 0, 0); rg.putImageData(ri, 0, 0);
  const T = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = AN; if (srgb) t.encoding = THREE.sRGBEncoding; return t; };
  return new THREE.MeshStandardMaterial({ map: T(col, 1), normalMap: T(nor), normalScale: new THREE.Vector2(1, 1), roughnessMap: T(rgh), roughness: 1, metalness: o.metal ?? .04 });
}
/* pattern painters (256-unit space, tile-safe) */
const tintStyle = (a = .17) => { const l = rnd(2) ? 0 : 255; return `rgba(${l},${l},${l},${.03 + Math.random() * a})`; };
const tintRect = (g, x, y, w, h, a = .17) => { g.fillStyle = tintStyle(a); g.fillRect(x, y, w, h); };
const wrapRect = (g, x, y, w, h, fn) => { for (const dx of [0, -256]) if (x + dx + w > 0 && x + dx < 256) fn(x + dx, y, w, h); };
function blocks(g, rows, cols, off = .5) { // running-bond masonry: every block gets one tint (also across the tile seam) and a mortar joint
  const bh = 256 / rows, bw = 256 / cols;
  for (let r = 0; r < rows; r++) for (let c = 0; c < (off ? cols + 1 : cols); c++) {
    const x = c * bw + (r % 2) * bw * off - bw * off, st = tintStyle();
    wrapRect(g, x, r * bh, bw, bh, (a, b, w, h) => { g.fillStyle = st; g.fillRect(a, b, w, h); g.strokeRect(a, b, w, h); });
  }
}
const slabs = g => blocks(g, 2, 2, 0);
const cracks = (g, n) => { g.lineWidth = .7; g.strokeStyle = 'rgba(0,0,0,.5)'; for (let i = 0; i < n; i++) { let x = rnd(256), y = rnd(256); g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) g.lineTo(x += rnd(26) - 13, y += rnd(26) - 13); g.stroke(); } g.strokeStyle = '#000'; };
const scratches = (g, n, a = .5) => { g.lineWidth = .9; g.strokeStyle = `rgba(0,0,0,${a})`; for (let i = 0; i < n; i++) { const x = rnd(256), y = rnd(256), l = 8 + rnd(40), t = Math.random() * 6.28; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(t) * l, y + Math.sin(t) * l); g.stroke(); } };
function planks(g, n) { // vertical planks with wavy, tile-periodic grain
  const w = 256 / n;
  for (let i = 0; i < n; i++) {
    tintRect(g, i * w, 0, w, 256, .22); g.lineWidth = 2.6; g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, 256); g.stroke();
    for (let k = 0; k < 9; k++) {
      const x0 = i * w + 3 + Math.random() * (w - 6), A = 1 + Math.random() * 2, m = 1 + rnd(3), ph = Math.random() * 6.28;
      const l = rnd(2) ? 0 : 255; g.lineWidth = .5 + Math.random() * .9; g.strokeStyle = `rgba(${l},${l},${l},${.07 + Math.random() * .12})`; g.beginPath();
      for (let y = 0; y <= 256; y += 8) { const x = x0 + A * Math.sin(y / 256 * 6.283 * m + ph); y ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
    g.strokeStyle = '#000';
  }
}
function weave(g, step, a = .35) { g.lineWidth = step * .22; g.strokeStyle = `rgba(0,0,0,${a})`; for (let i = 0; i < 256; i += step) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } g.strokeStyle = '#000'; }
const grime = g => { const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(0,0,0,.38)'); gr.addColorStop(.16, 'rgba(0,0,0,0)'); gr.addColorStop(.82, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.45)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); };

const wallMat = pbr('#8d8478', g => { g.lineWidth = 2.6; blocks(g, 8, 4); grime(g); }, .88, TEX, 0, { bevel: 1.8, str: 3.6 });
const floorMat = pbr('#757069', g => { g.lineWidth = 2.4; blocks(g, 4, 4, .5); cracks(g, 7); }, .5, TEX, 1, { bevel: 1.7, str: 3.4 });
const ceilMat = pbr('#5d5851', g => { g.lineWidth = 2.6; slabs(g); }, .9, MID, 0, { bevel: 1.5 });
const trimMat = pbr('#7c746a', g => { g.lineWidth = 2.4; blocks(g, 3, 2, .5); }, .78, MID, 0, { bevel: 1.5 });
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.35, 'rgba(255,255,255,.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
/* ---------- Pipeline: model -> UV unwrap -> paint -> shade ---------- */
function uvRegion(geo, u0, v0, w, h) { // re-unwrap a primitive's UVs into one island of the 2x2 skin atlas
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * w, v0 + uv.getY(i) * h);
  return geo;
}
function norm(hc, k = .05) { // height canvas -> tangent-space normal map
  const s = hc.width, hd = hc.getContext('2d').getImageData(0, 0, s, s).data, c = cv(s), g = c.getContext('2d'), im = g.createImageData(s, s);
  const H = (x, y) => hd[(((y + s) % s) * s + ((x + s) % s)) * 4];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * k, ny = (H(x, y + 1) - H(x, y - 1)) * k, l = Math.hypot(nx, ny, 1), i = (y * s + x) * 4;
    im.data[i] = (nx / l * .5 + .5) * 255; im.data[i + 1] = (ny / l * .5 + .5) * 255; im.data[i + 2] = (.5 / l + .5) * 255; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0); return c;
}
const skinCache = {}, bone = new THREE.MeshStandardMaterial({ color: 0xd8cfb8, roughness: .5 });
function skinMat(key, base, accent) { // painted atlas islands: torso | head | limbs | claws
  if (skinCache[key]) return skinCache[key];
  const s = 256, h = fbm(s), hg = h.getContext('2d'), col = cv(s), cg = col.getContext('2d'), em = cv(s), eg = em.getContext('2d');
  const css = n => '#' + new THREE.Color(n).getHexString();
  cg.fillStyle = new THREE.Color(base).multiplyScalar(2.6).getStyle(); cg.fillRect(0, 0, s, s);
  cg.globalCompositeOperation = 'overlay'; cg.drawImage(h, 0, 0); cg.drawImage(h, 0, 0); cg.globalCompositeOperation = 'source-over';
  eg.fillStyle = '#000'; eg.fillRect(0, 0, s, s);
  for (let i = 0; i < 28; i++) { // veins: dark on the colour map, glowing on the emissive map
    let x = rnd(s), y = rnd(s); const pts = [[x, y]];
    for (let k = 0; k < 6; k++) pts.push([x += rnd(34) - 17, y += rnd(34) - 17]);
    for (const [g, c, w] of [[cg, 'rgba(60,8,18,.6)', 1.6], [eg, css(accent), 1.2]]) {
      g.strokeStyle = c; g.lineWidth = w; g.beginPath(); pts.forEach(([a, b], k) => k ? g.lineTo(a, b) : g.moveTo(a, b)); g.stroke();
    }
  }
  for (let i = 0; i < 16; i++) { cg.fillStyle = 'rgba(80,0,10,.55)'; cg.beginPath(); cg.arc(rnd(s), rnd(s), 2 + rnd(9), 0, 7); cg.fill(); } // blood
  hg.strokeStyle = '#000'; hg.lineWidth = 3; cg.strokeStyle = 'rgba(12,6,6,.9)'; cg.lineWidth = 2;
  for (let i = 0; i < 7; i++) { // stitched wounds, carved into the height map as well
    const x = rnd(s - 40), y = rnd(s);
    for (const g of [cg, hg]) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + 36, y + rnd(10)); for (let k = 0; k < 5; k++) { g.moveTo(x + k * 8, y - 4); g.lineTo(x + k * 8, y + 4); } g.stroke(); }
  }
  const T = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.anisotropy = 4; if (srgb) t.encoding = THREE.sRGBEncoding; return t; };
  return skinCache[key] = new THREE.MeshPhysicalMaterial({ map: T(col, 1), normalMap: T(norm(h)), normalScale: new THREE.Vector2(1.3, 1.3),
    emissive: new THREE.Color(accent), emissiveMap: T(em, 1), emissiveIntensity: .7, roughness: .55, metalness: .05, clearcoat: .35, clearcoatRoughness: .35 });
}

/* ---------- Shared materials ---------- */
const metal = pbr('#6a7078', g => scratches(g, 40, .55), .32, SM, 0, { bevel: .8, str: 2, metal: .9 });
const iron = pbr('#33363b', g => scratches(g, 70, .5), .5, SM, 0, { bevel: .8, str: 2.4, metal: .85 });
const cloth = pbr('#3b4738', g => weave(g, 4, .4), .95, SM, 0, { bevel: .8, str: 2.2 });
const poly = pbr('#2c2e30', g => { g.fillStyle = '#000'; for (let i = 0; i < 420; i++) g.fillRect(rnd(256), rnd(256), 2, 2); }, .8, SM, 0, { bevel: .6, str: 2.6 }); // stippled polymer
const alu = pbr('#3b3f45', g => { g.lineWidth = 1.2; for (let x = 0; x < 256; x += 5) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); } }, .38, SM, 0, { bevel: .7, str: 2.4, metal: .85 }); // knurled aluminium
const leather = pbr('#1f1c1b', g => { g.fillStyle = '#000'; for (let i = 0; i < 700; i++) g.fillRect(rnd(256), rnd(256), 1.5, 1.5); }, .55, SM, 0, { bevel: .7, str: 1.8 }); // glove leather
const robeMat = pbr('#9a9a9a', g => weave(g, 3, .3), .95, SM, 0, { bevel: .8, str: 1.8 });                                                        // enemy cloth (tinted per creature)
const wood = pbr('#6e4c30', g => planks(g, 4), .7, MID, 0, { bevel: 1.2, str: 2.8 });
const gold = new THREE.MeshStandardMaterial({ color: 0xd8b040, metalness: .9, roughness: .3 });
const skinTone = new THREE.MeshStandardMaterial({ color: 0xc89a82, roughness: .6 });
const envTex = (() => { try { // a tiny baked room of warm and cold light panels so metal, brass and wet stone have something to reflect
  const es = new THREE.Scene(); es.background = new THREE.Color(0x07090e);
  for (const [x, y, z, c, w] of [[0, 4, 0, 0xffd9a8, 5], [-6, 1, 0, 0x6a82b0, 3], [6, 1, 2, 0xff9a60, 3], [0, 1, -6, 0x8090a8, 4]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m); }
  const pm = new THREE.PMREMGenerator(renderer), t = pm.fromScene(es, .04).texture; pm.dispose(); return t; } catch (e) { return null; } })();
if (envTex) for (const [m, k] of [[metal, 1], [alu, 1], [iron, .9], [gold, 1], [floorMat, .5], [wallMat, .08], [trimMat, .1], [leather, .2], [bone, .5]]) { m.envMap = envTex; m.envMapIntensity = k; }
const SHARED = new Set([metal, iron, cloth, poly, alu, leather, robeMat, wood, gold, skinTone, wallMat, floorMat, ceilMat, trimMat, bone]); // never disposed with a level

/* ---------- Geometry helpers ---------- */
function roundedBox(w, h, d, r, tile) { // a box with softly rounded edges and corners (smooth normals, world-scale UVs): no hard CG-looking edges
  const H = [w / 2, h / 2, d / 2]; r = Math.max(1e-4, Math.min(r, H[0] - 1e-4, H[1] - 1e-4, H[2] - 1e-4));
  const coords = a => { const o = [a - r, a - r + r * .4142, a]; return [...o.map(v => -v).reverse(), ...o]; }; // vertices placed exactly where the 90-degree bevel arc needs them
  const pos = [], nor = [], uv = [], idx = [];
  for (const [n, s, ua, ud, va, vd] of [[2, 1, 0, 1, 1, 1], [2, -1, 0, -1, 1, 1], [0, 1, 2, -1, 1, 1], [0, -1, 2, 1, 1, 1], [1, 1, 0, 1, 2, -1], [1, -1, 0, 1, 2, 1]]) {
    const U = coords(H[ua]), V = coords(H[va]); if (ud < 0) U.reverse(); if (vd < 0) V.reverse();
    const base = pos.length / 3, nu = U.length;
    for (let j = 0; j < V.length; j++) for (let i = 0; i < nu; i++) {
      const q = [0, 0, 0]; q[n] = s * H[n]; q[ua] = U[i]; q[va] = V[j];
      const inn = q.map((v, k) => Math.max(-(H[k] - r), Math.min(H[k] - r, v))), dv = q.map((v, k) => v - inn[k]), len = Math.hypot(dv[0], dv[1], dv[2]);
      let P = q, N = [0, 0, 0]; if (len > 1e-9) { N = dv.map(v => v / len); P = inn.map((v, k) => v + N[k] * r); } else N[n] = s;
      pos.push(P[0], P[1], P[2]); nor.push(N[0], N[1], N[2]); uv.push((P[ua] * ud + H[ua]) / tile, (P[va] * vd + H[va]) / tile);
    }
    for (let j = 0; j < V.length - 1; j++) for (let i = 0; i < nu - 1; i++) { const a = base + j * nu + i, b = a + 1, c = a + nu + 1, e = a + nu; idx.push(a, b, c, a, c, e); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2)); g.setIndex(idx);
  return g;
}
const bx = (p, w, h, d, mat, x, y, z, r = Math.min(w, h, d) * .16) => { const m = new THREE.Mesh(roundedBox(w, h, d, r, 1), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; p.add(m); return m; };
const sbox = (p, w, h, d, mat, x, y, z, tile = 1.2, r = Math.min(.03, Math.min(w, h, d) * .3)) => { // rounded box whose texture keeps its real-world scale (a tile is `tile` metres)
  const m = new THREE.Mesh(roundedBox(w, h, d, r, tile), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; p.add(m); return m;
};
const mk3 = (p, geo, mat, x = 0, y = 0, z = 0, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; p.add(m); return m; };
const B = THREE.BoxGeometry, Cy = (a, b, l, n = 24) => new THREE.CylinderGeometry(a, b, l, n).rotateX(Math.PI / 2); // Cy: radius at +z, radius at -z, length (axis along z)
const seg = (p, a, b, r1, r2, mat, caps = true) => { // tapered limb segment between two points, with round joints
  const A = new THREE.Vector3(...a), E = new THREE.Vector3(...b), d = E.clone().sub(A), m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, d.length(), 20), mat);
  m.position.copy(A).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); p.add(m);
  if (caps) for (const [P, r] of [[A, r1], [E, r2]]) { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat); s.position.copy(P); p.add(s); }
  return m;
};
const chain = (p, pts, r1, r2, mat) => { for (let i = 0; i < pts.length - 1; i++) seg(p, pts[i], pts[i + 1], r1 + (r2 - r1) * i / (pts.length - 1), r1 + (r2 - r1) * (i + 1) / (pts.length - 1), mat); };
const blob = (p, sx, sy, sz, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); p.add(m); return m; };

/* ---------- First-person viewmodel: pistol and flashlight, gloved hands, jacket sleeves (drawn in their own pass) ---------- */
const gun = new THREE.Group(), lamp = new THREE.Group(); vmCam.add(gun, lamp);
gun.position.set(.14, -.108, -.36); lamp.position.set(-.165, -.118, -.36);
// pistol (local origin: top of the grip, barrel points down -z)
const slide = new THREE.Group(); slide.position.set(0, .033, -.08); gun.add(slide);
bx(slide, .03, .034, .2, metal, 0, 0, 0).castShadow = false;
bx(slide, .026, .006, .196, metal, 0, .018, 0).castShadow = false;                                              // flat top
for (let k = 0; k < 3; k++) { bx(slide, .032, .03, .003, poly, 0, 0, .088 - k * .007); bx(slide, .032, .03, .003, poly, 0, 0, -.074 - k * .007); } // serrations
bx(slide, .012, .008, .008, metal, 0, .024, .088); bx(slide, .004, .01, .006, metal, 0, .025, -.094);          // sights
bx(slide, .002, .012, .04, poly, .0155, .006, -.01);                                                           // ejection port
mk3(slide, Cy(.007, .007, .024, 14), metal, 0, -.002, -.105, false);                                           // barrel tip
bx(gun, .028, .024, .17, poly, 0, .007, -.065);                                                                // frame and dust cover
const grip = bx(gun, .03, .1, .05, poly, 0, -.05, .035); grip.rotation.x = -.2;
const magBase = bx(gun, .032, .012, .054, metal, 0, -.105, .046); magBase.rotation.x = -.2;
bx(gun, .006, .004, .05, poly, 0, -.03, -.045); bx(gun, .006, .022, .004, poly, 0, -.019, -.07);              // trigger guard
const trig = bx(gun, .005, .02, .005, metal, 0, -.02, -.03); trig.rotation.x = .3;
// right glove: palm on the back strap, fingers around the grip, trigger finger along the frame, thumb on the left
blob(gun, .031, .052, .026, leather, .022, -.05, .075);
for (const yk of [-.05, -.071, -.092]) chain(gun, [[.027, yk, .066], [.027, yk, .026], [.012, yk, .006], [-.006, yk, .0]], .0095, .0086, leather);
chain(gun, [[.027, -.015, .07], [.027, -.012, .0], [.025, -.01, -.05]], .0095, .0085, leather);               // index finger, off the trigger
chain(gun, [[-.012, -.035, .085], [-.027, -.018, .05], [-.028, -.008, -.01], [-.027, -.004, -.06]], .011, .0092, leather); // thumb
seg(gun, [.03, -.08, .09], [.075, -.165, .24], .028, .032, leather);                                           // glove cuff and wrist
seg(gun, [.06, -.138, .19], [.068, -.152, .215], .035, .035, cloth, false);                                    // strap
seg(gun, [.07, -.155, .22], [.13, -.3, .52], .042, .06, cloth);                                                // jacket sleeve
const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc060, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
muzzle.scale.set(.28, .28, 1); muzzle.position.set(0, .033, -.205); muzzle.visible = false; gun.add(muzzle);
let muzzleT = 0;
// flashlight (local origin: middle of the barrel, beam points down -z)
bx(lamp, .001, .001, .001, alu, 0, 0, 0).visible = false;
mk3(lamp, Cy(.024, .024, .26, 32), alu, 0, 0, 0, false);                                                       // knurled barrel
mk3(lamp, Cy(.029, .037, .065, 32), alu, 0, 0, -.16, false);                                                   // flared head
mk3(lamp, new THREE.TorusGeometry(.036, .004, 10, 36), metal, 0, 0, -.1955, false);                            // bezel
mk3(lamp, Cy(.022, .022, .03, 24), alu, 0, 0, .145, false);                                                    // tail cap
mk3(lamp, Cy(.008, .008, .012, 12), new THREE.MeshStandardMaterial({ color: 0xaa2020, roughness: .5 }), 0, 0, .165, false); // rubber switch
for (let k = 0; k < 3; k++) mk3(lamp, new THREE.TorusGeometry(.0245, .0015, 6, 28), metal, 0, 0, -.06 + k * .02, false); // grip rings
const lens = mk3(lamp, Cy(.031, .031, .006, 28), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffeccc, emissiveIntensity: 2 }), 0, 0, -.1925, false);
// left glove: palm on the left side, four fingers wrap underneath, thumb along the top
blob(lamp, .026, .038, .044, leather, -.047, -.016, .05);
for (let k = 0; k < 4; k++) {
  const z = .015 + k * .02, R = .0335, pts = [205, 245, 285, 325].map(a => [R * Math.cos(a * Math.PI / 180), R * Math.sin(a * Math.PI / 180), z]);
  chain(lamp, pts, .0095, .0087, leather);
}
chain(lamp, [[-.04, .012, .085], [-.026, .03, .05], [-.012, .036, .0], [-.008, .037, -.05]], .011, .0092, leather);
seg(lamp, [-.05, -.04, .09], [-.085, -.14, .27], .028, .032, leather);
seg(lamp, [-.075, -.115, .21], [-.082, -.13, .235], .035, .035, cloth, false);
seg(lamp, [-.08, -.13, .24], [-.14, -.3, .52], .042, .06, cloth);

// pool of real lights that hop between ceiling lamps near the player (keeps the shader light count fixed)
const pool = Array.from({ length: 6 }, () => { const l = new THREE.PointLight(0xffd9a8, 0, 12, 2); scene.add(l); return l; });
const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position',
  new THREE.BufferAttribute(new Float32Array(900).map(() => (Math.random() - .5) * 16), 3)),
  new THREE.PointsMaterial({ size: .09, map: glowTex, transparent: true, opacity: .45, depthWrite: false, color: 0xbfb8a8 }));
dust.frustumCulled = false; scene.add(dust);

/* ---------- Game state ---------- */
let grid = [], dist = null, levelGroup = null, exit = null, explored = [], boss = null, mapBig = false, tension = 0, dying = [], lamps = [], blackout = 0, eventT = 30, voiceT = 12, shake = 0, lastPh = 0, rooms = [], chests = [], hasDK = 0, hasXK = false, focus = null;
let state = 'menu', level = 1, hp = 100, ammo = 15, score = 0, shards = 0, shardsNeeded = 0;
let enemies = [], items = [], recoil = 0, hurt = 0, lastShot = -9, pathTimer = 0, msgTimer = 0;
let torchOn = true, noise = 9, beatT = 0, clock = 0, last = performance.now();
let bobP = 0, bobA = 0, sprintK = 0, swayX = 0, swayY = 0, lastYaw = 0, lastPitch = 0; // hand bob, sprint pose and turn sway
let warp = 0, warpFade = 0;            // portal transition: warp ramps 0..1 while you step in, warpFade eases the next level in
const blockers = new Set();            // door cells whose gate is still rising: solid until the bars are clear (not saved)
const player = { x: 0, z: 0, yaw: 0, pitch: 0 }, keys = {};

/* ---------- Maze, collision, pathfinding ---------- */
function genMaze(W) {
  const n = 2 * W + 1, g = Array.from({ length: n }, () => Array(n).fill(1)), st = [[1, 1]];
  g[1][1] = 0;
  while (st.length) {
    const [x, y] = st[st.length - 1];
    const o = DIRS.map(([a, b]) => [a * 2, b * 2])
      .filter(([a, b]) => x + a > 0 && x + a < n - 1 && y + b > 0 && y + b < n - 1 && g[y + b][x + a]);
    if (!o.length) { st.pop(); continue; }
    const [a, b] = o[rnd(o.length)];
    g[y + b / 2][x + a / 2] = g[y + b][x + a] = 0; st.push([x + a, y + b]);
  }
  for (let k = 0; k < W * 3; k++) { // open loops so enemies can flank you
    const x = 1 + rnd(n - 2), y = 1 + rnd(n - 2);
    if (x % 2 !== y % 2) g[y][x] = 0;
  }
  return g;
}
function hit(px, pz, r) { // circle vs wall cells
  const cx = Math.round(px / CELL), cz = Math.round(pz / CELL);
  for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    if (grid[j] && grid[j][i] === 0 && !(blockers.size && blockers.has(i + ',' + j))) continue; // gates still rising count as walls
    const nx = Math.max(i * CELL - CELL / 2, Math.min(px, i * CELL + CELL / 2));
    const nz = Math.max(j * CELL - CELL / 2, Math.min(pz, j * CELL + CELL / 2));
    if ((px - nx) ** 2 + (pz - nz) ** 2 < r * r) return true;
  }
  return false;
}
function los(ax, az, bx, bz) { // clear line of sight through the maze?
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / .6);
  for (let k = 1; k < n; k++) if (hit(ax + (bx - ax) * k / n, az + (bz - az) * k / n, .02)) return false;
  return true;
}
function conn(g) { // every open cell reachable from the start?
  const seen = new Set(['1,1']), q = [[1, 1]]; let open = 0;
  g.forEach(r => r.forEach(v => v || open++));
  for (let k = 0; k < q.length; k++) for (const [a, b] of DIRS) {
    const x = q[k][0] + a, z = q[k][1] + b;
    if (g[z] && g[z][x] === 0 && !seen.has(x + ',' + z)) { seen.add(x + ',' + z); q.push([x, z]); }
  }
  return q.length === open;
}
function repair(g, blocks) { // reopen wall cells between cut-off pockets and the main maze (room rings stay sealed)
  const n = g.length, inBlock = (x, z) => blocks.some(b => x >= b.x0 && x <= b.x0 + 4 && z >= b.y0 && z <= b.y0 + 4);
  for (let it = 0; it < 80 && !conn(g); it++) {
    const seen = new Set(['1,1']), q = [[1, 1]], cand = [];
    for (let k = 0; k < q.length; k++) for (const [a, b] of DIRS) {
      const x = q[k][0] + a, z = q[k][1] + b;
      if (g[z] && g[z][x] === 0 && !seen.has(x + ',' + z)) { seen.add(x + ',' + z); q.push([x, z]); }
    }
    for (let z = 1; z < n - 1; z++) for (let x = 1; x < n - 1; x++) if (g[z][x] && !inBlock(x, z)) {
      let near = false, cut = false;
      for (const [a, b] of DIRS) if (g[z + b][x + a] === 0) { if (seen.has((x + a) + ',' + (z + b))) near = true; else cut = true; }
      if (near && cut) cand.push([x, z]);
    }
    if (!cand.length) return;
    const [x, z] = cand[rnd(cand.length)]; g[z][x] = 0;
  }
}
function carveRoom(g, rooms) { // 3x3 chamber inside a wall ring with one doorway facing a corridor
  const n = g.length, W = (n - 1) / 2;
  for (let tries = 0; tries < 300; tries++) {
    const x0 = 1 + 2 * rnd(W - 2), y0 = 1 + 2 * rnd(W - 2);
    if (x0 + 4 > n - 2 || y0 + 4 > n - 2 || (x0 < 6 && y0 < 6)) continue;
    if (rooms.some(r => Math.abs(r.x0 - x0) < 6 && Math.abs(r.y0 - y0) < 6)) continue;
    const c = g.map(r => r.slice());
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) c[y0 + j][x0 + i] = i > 0 && i < 4 && j > 0 && j < 4 ? 0 : 1;
    const [dx, dz, ox, oz] = [[2, 4, 0, 1], [2, 0, 0, -1], [0, 2, -1, 0], [4, 2, 1, 0]][rnd(4)];
    const di = x0 + dx, dj = y0 + dz, ex = di + ox, ez = dj + oz;
    if (ex < 1 || ez < 1 || ex > n - 2 || ez > n - 2) continue;
    c[ez][ex] = 0; c[dj][di] = 0;
    if (!conn(c)) repair(c, [...rooms, { x0, y0 }]);
    if (!conn(c)) continue;
    c.forEach((row, j) => row.forEach((v, i) => g[j][i] = v));
    return { x0, y0, di, dj, ox, oz, cx: x0 + 2, cz: y0 + 2, open: true };
  }
  return null;
}
function genRooms(g, level) { // one boss chamber, locked vaults and open side rooms; more of them on deeper levels
  const kinds = ['boss', 'vault', 'open', 'open']; if (level > 1) kinds.push('vault'); if (level > 3) kinds.push('open', 'vault'); if (level > 6) kinds.push('open', 'vault');
  const rooms = [];
  for (const kind of kinds) { const r = carveRoom(g, rooms); if (r) { r.kind = kind; rooms.push(r); } }
  for (const r of rooms) if (r.kind === 'vault') { r.open = false; g[r.dj][r.di] = 1; } // vault doors are solid until unlocked
  return rooms;
}
/* ---------- Props: treasure chest, iron gates, level portal ---------- */
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeBack = t => { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }; // overshoots a little, then settles
const velvet = new THREE.MeshStandardMaterial({ color: 0x5c1119, roughness: .92 });
const coinMat = new THREE.MeshStandardMaterial({ color: 0xe6bd48, metalness: .9, roughness: .3, emissive: 0x6a4608, emissiveIntensity: .6 });
const coinGeo = new THREE.CylinderGeometry(.05, .05, .009, 16), rivetGeo = new THREE.SphereGeometry(.018, 10, 8), studGeo = new THREE.SphereGeometry(.014, 10, 8);
const gemMat = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.6, roughness: .15 });
const rugTex = (() => { // woven rug: gold border, diamond field
  const s = 256, c = cv(s), g = c.getContext('2d'); g.fillStyle = '#5a1a1a'; g.fillRect(0, 0, s, s);
  g.strokeStyle = '#c9a24a'; g.lineWidth = 6; g.strokeRect(10, 10, s - 20, s - 20); g.lineWidth = 2; g.strokeRect(24, 24, s - 48, s - 48);
  g.strokeStyle = 'rgba(201,162,74,.8)'; g.lineWidth = 2.5; for (const r of [90, 60, 30]) { g.beginPath(); g.moveTo(s / 2, s / 2 - r); g.lineTo(s / 2 + r, s / 2); g.lineTo(s / 2, s / 2 + r); g.lineTo(s / 2 - r, s / 2); g.closePath(); g.stroke(); }
  g.globalAlpha = .12; g.fillStyle = '#000'; for (let i = 0; i < 2400; i++) g.fillRect(rnd(s), rnd(s), 1, 2);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = AN; return t;
})();

function makeChest(c, rot, kind, open) {
  const big = kind === 'boss', g = new THREE.Group(), lid = new THREE.Group(), trim = big ? gold : iron;
  const W = 1.2, D = .72, Hb = .5, t = .05, y0 = big ? .16 : 0;
  g.position.set(c[0] * CELL, 0, c[1] * CELL); g.rotation.y = rot; g.scale.setScalar(big ? 1.2 : 1);
  if (big) { sbox(g, 1.8, .1, 1.2, trimMat, 0, .05, 0); sbox(g, 1.5, .06, .96, trimMat, 0, .13, 0); } // stepped stone plinth
  // open-topped planked body, lined with velvet
  sbox(g, W, t, D, wood, 0, y0 + t / 2, 0); sbox(g, W, Hb, t, wood, 0, y0 + Hb / 2, D / 2 - t / 2); sbox(g, W, Hb, t, wood, 0, y0 + Hb / 2, -D / 2 + t / 2);
  for (const s of [-1, 1]) sbox(g, t, Hb, D - 2 * t, wood, s * (W / 2 - t / 2), y0 + Hb / 2, 0);
  mk3(g, new THREE.PlaneGeometry(W - 2 * t, D - 2 * t).rotateX(-Math.PI / 2), velvet, 0, y0 + t + .002, 0, false);
  // ironwork: straps around the body, corner posts, base band, studs
  for (const s of [-1, 1]) {
    sbox(g, .07, Hb + .012, D + .024, trim, s * .38, y0 + Hb / 2, 0, .5);
    for (const zz of [-1, 1]) sbox(g, .08, Hb + .02, .08, trim, s * (W / 2 - .005), y0 + Hb / 2, zz * (D / 2 - .005), .5);
    for (let k = 0; k < 3; k++) mk3(g, studGeo, trim, s * .38, y0 + .1 + k * .15, D / 2 + .016, false);
  }
  sbox(g, W + .03, .05, D + .03, trim, 0, y0 + .025, 0, .5);
  // barrel lid on a back hinge: a half-cylinder with iron straps and a hasp
  lid.position.set(0, y0 + Hb, -D / 2); g.add(lid);
  const half = (r, len, openEnd) => new THREE.CylinderGeometry(r, r, len, 40, 1, !!openEnd, 0, Math.PI).rotateZ(Math.PI / 2);
  mk3(lid, half(D / 2, W), wood, 0, 0, D / 2);
  mk3(lid, new THREE.PlaneGeometry(W - .02, D - .02).rotateX(Math.PI / 2), velvet, 0, .004, D / 2, false); // padded underside, seen when it is open
  for (const x of big ? [-.38, 0, .38] : [-.38, .38]) mk3(lid, half(D / 2 + .014, .07, true), trim, x, 0, D / 2);
  sbox(lid, .15, .2, .025, trim, 0, .07, D + .006, .4);
  sbox(g, .1, .14, .04, trim, 0, y0 + Hb - .05, D / 2 + .02, .3);                                           // lock body on the chest front
  mk3(g, new THREE.CylinderGeometry(.012, .012, .012, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x050505 }), 0, y0 + Hb - .04, D / 2 + .043, false);
  if (big) mk3(lid, new THREE.OctahedronGeometry(.06), gemMat(0xd02030), 0, D / 2 + .035, D / 2);
  // contents: a heap of coins, or the glowing exit key in the guardian's chest
  const treasure = new THREE.Group(); treasure.position.y = y0; g.add(treasure);
  if (!big) { // (the guardian's chest holds the real, pickable exit key instead of a prop)
    const im = new THREE.InstancedMesh(coinGeo, coinMat, 56), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < 56; i++) {
      const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()), px = Math.cos(a) * rr * .48, pz = Math.sin(a) * rr * .24, py = t + .05 + (1 - rr * rr) * .18 + Math.random() * .03;
      eu.set(Math.random() * .8, Math.random() * 6.28, Math.random() * .8); q.setFromEuler(eu); m4.compose(new THREE.Vector3(px, py, pz), q, one); im.setMatrixAt(i, m4);
    }
    treasure.add(im);
  }
  treasure.visible = !!open;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc860, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  glow.scale.set(2.6, 2.6, 1); glow.position.set(0, y0 + Hb + .25, 0); g.add(glow);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.8, .012, 8, 72).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff2a1a })); // the guardian's seal
  ring.position.y = y0 + Hb + .15; ring.visible = false; g.add(ring);
  levelGroup.add(g);
  return { x: c[0] * CELL, z: c[1] * CELL, rot, kind, open: !!open, g, lid, t: open ? 1 : 0, treasure, glow, ring, big, y0, rad: big ? .95 : .75 };
}

function makeGate(kind) { // 'vault': iron-bound plank door. 'exit': portcullis you can see the portal through. Width runs along x, the lock faces +z
  const g = new THREE.Group(), bars = new THREE.Group(), ex = kind === 'exit', Hd = WALL_H, iw = CELL - 1.24, doorH = Hd - .85 + .1;
  g.add(bars);
  for (const s of [-1, 1]) { // stone frame: pillars with plinths and capitals, one heavy lintel
    sbox(g, .62, Hd, .9, trimMat, s * (CELL / 2 - .31), Hd / 2, 0);
    sbox(g, .78, .24, 1.04, trimMat, s * (CELL / 2 - .39), .12, 0); sbox(g, .78, .18, 1.04, trimMat, s * (CELL / 2 - .39), Hd - .85 - .09, 0);
  }
  sbox(g, CELL, .85, .9, trimMat, 0, Hd - .425, 0);
  for (const z of [-.47, .47]) mk3(g, new THREE.OctahedronGeometry(.15), ex ? gemMat(0xff2a10) : gold, 0, Hd - .42, z);
  let eye = null;
  if (!ex) {
    sbox(bars, iw, doorH, .2, wood, 0, doorH / 2, 0);
    for (const y of [.45, 1.2, 1.95]) { sbox(bars, iw + .02, .13, .26, iron, 0, y, 0, .5); for (let k = -3; k <= 3; k++) mk3(bars, rivetGeo, iron, k * .4, y, .14, false); }
    for (const s of [-1, 1]) { mk3(bars, new THREE.TorusGeometry(.08, .014, 10, 24), iron, s * .26, .98, .13, false); sbox(bars, .06, .06, .02, iron, s * .26, 1.06, .115, .3); }
    sbox(bars, .2, .24, .1, gold, 0, .76, .15, .3); mk3(bars, new THREE.TorusGeometry(.065, .016, 8, 18, Math.PI), iron, 0, .88, .15, false); // brass padlock
  } else {
    for (let k = -6; k <= 6; k++) {
      mk3(bars, new THREE.CylinderGeometry(.035, .035, doorH + .1, 12), iron, k * .216, .2 + (doorH + .1) / 2, 0);
      mk3(bars, new THREE.ConeGeometry(.05, .2, 12).rotateX(Math.PI), iron, k * .216, .1, 0);
    }
    for (const y of [.5, 1.4, 2.3]) for (const z of [-.045, .045]) sbox(bars, iw, .07, .05, iron, 0, y, z, .5);
    mk3(bars, new THREE.CylinderGeometry(.22, .22, .07, 32).rotateX(Math.PI / 2), gold, 0, 1.4, .09);
    eye = mk3(bars, new THREE.SphereGeometry(.07, 18, 14), gemMat(0xff2a10), 0, 1.4, .14, false);
  }
  return { g, bars, rise: ex ? 2.75 : 2.6, eye };
}

const runeTex = (() => { // ring of invented glyphs
  const s = 512, c = cv(s), g = c.getContext('2d'); g.translate(s / 2, s / 2); g.strokeStyle = '#fff'; g.lineCap = 'round';
  g.lineWidth = 2.5; for (const r of [.99, .71]) { g.beginPath(); g.arc(0, 0, r * s / 2, 0, 7); g.stroke(); }
  g.lineWidth = 3.5;
  for (let i = 0; i < 28; i++) {
    g.save(); g.rotate(i / 28 * 6.2832); g.translate(0, -s / 2 * .85); g.beginPath();
    for (let k = 0, n = 3 + rnd(2); k < n; k++) { g.moveTo((Math.random() - .5) * 22, (Math.random() - .5) * 34); g.lineTo((Math.random() - .5) * 22, (Math.random() - .5) * 34); }
    g.stroke(); g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.anisotropy = AN; return t;
})();
const sigilTex = (() => { // floor sigil: rings, two interlocked triangles, glyph band
  const s = 512, c = cv(s), g = c.getContext('2d'); g.translate(s / 2, s / 2); g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineWidth = 3;
  for (const r of [.97, .9, .62]) { g.beginPath(); g.arc(0, 0, r * s / 2, 0, 7); g.stroke(); }
  for (const a0 of [0, Math.PI]) { g.beginPath(); for (let k = 0; k < 3; k++) { const a = a0 + k * 2.0944 - 1.5708, x = Math.cos(a) * .62 * s / 2, y = Math.sin(a) * .62 * s / 2; k ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); g.stroke(); }
  g.lineWidth = 3;
  for (let i = 0; i < 24; i++) { g.save(); g.rotate(i / 24 * 6.2832); g.translate(0, -s / 2 * .8); g.beginPath(); for (let k = 0; k < 3; k++) { g.moveTo((Math.random() - .5) * 16, (Math.random() - .5) * 22); g.lineTo((Math.random() - .5) * 16, (Math.random() - .5) * 22); } g.stroke(); g.restore(); }
  const t = new THREE.CanvasTexture(c); t.anisotropy = AN; return t;
})();
const VORTEX_FS = `varying vec2 vUv; uniform float uTime, uOn, uDir; uniform vec3 uCol;
void main() {
  vec2 p = vUv * 2. - 1.; float r = length(p); if (r > 1.) discard;
  float a = atan(p.y, p.x), t = uTime * uDir;
  float arms = sin(a * 5. + (1. - r) * 9. - t * 2.2) * .5 + .5, arms2 = sin(a * 3. - (1. - r) * 14. + t * 3.1 + 1.7) * .5 + .5;
  float swirl = pow(arms * .65 + arms2 * .35, 1.6), core = pow(1. - r, 2.2), rim = smoothstep(.72, .97, r), edge = 1. - smoothstep(.92, 1., r);
  vec3 c = uCol * (.25 + swirl * 1.25) + vec3(1.) * core * 1.1 + uCol * rim * 1.2;
  float al = (swirl * .55 + core * .9 + rim * .5 + .12) * edge * uOn;
  gl_FragColor = vec4(c * uOn, al);
}`;
const vortexMat = dir => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { uTime: { value: 0 }, uOn: { value: .4 }, uDir: { value: dir }, uCol: { value: new THREE.Color(1, .16, .08) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: VORTEX_FS });

function makePortal() { // stone ring with a swirling energy disc, rune band, spiralling motes and a floor sigil; faces +z, stands against the wall
  const g = new THREE.Group(), spin = new THREE.Group(), cy = 1.5, N = 110;
  mk3(g, new THREE.CircleGeometry(1.55, 48), trimMat, 0, cy, -.32, false);
  sbox(g, 2.9, .3, .9, trimMat, 0, .15, -.1);
  mk3(g, new THREE.TorusGeometry(1.02, .17, 20, 72), trimMat, 0, cy, 0);
  spin.position.set(0, cy, 0); g.add(spin);
  const runes = new THREE.Mesh(new THREE.RingGeometry(.84, 1.2, 72), new THREE.MeshBasicMaterial({ map: runeTex, color: 0xff3010, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  runes.position.z = .175; spin.add(runes);
  const m1 = vortexMat(1), m2 = vortexMat(-1), d1 = new THREE.Mesh(new THREE.CircleGeometry(.88, 72), m1), d2 = new THREE.Mesh(new THREE.CircleGeometry(.86, 72), m2);
  d1.position.set(0, cy, .03); d2.position.set(0, cy, .07); g.add(d1, d2);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff3010, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .5 }));
  halo.scale.set(4.4, 4.4, 1); halo.position.set(0, cy, -.05); g.add(halo);
  const pa = new Float32Array(N * 3), pr = new Float32Array(N), pg = new Float32Array(N), ps = new Float32Array(N);
  for (let i = 0; i < N; i++) { pr[i] = Math.random(); pg[i] = Math.random() * 6.28; ps[i] = .8 + Math.random() * 1.6; }
  const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pa, 3)), new THREE.PointsMaterial({ size: .12, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xff6a40, opacity: .9 }));
  pts.frustumCulled = false; pts.position.set(0, cy, .08); g.add(pts);
  const sig = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.8), new THREE.MeshBasicMaterial({ map: sigilTex, color: 0xff3010, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
  sig.rotation.x = -Math.PI / 2; sig.position.set(0, .012, 1.5); g.add(sig);
  const cLock = [1, .16, .08], cOpen = [.2, 1, .72], rgb = [0, 0, 0];
  function step(dt, k, clk) { // k: 0 sealed .. 1 open
    for (let i = 0; i < 3; i++) rgb[i] = cLock[i] + (cOpen[i] - cLock[i]) * k;
    const [r, gg, b] = rgb, on = .38 + .62 * k;
    m1.uniforms.uTime.value = m2.uniforms.uTime.value = clk; m1.uniforms.uOn.value = on; m2.uniforms.uOn.value = on * .6;
    m1.uniforms.uCol.value.setRGB(r, gg, b); m2.uniforms.uCol.value.setRGB(r, gg, b);
    runes.material.color.setRGB(r, gg, b); runes.material.opacity = .4 + .5 * k; spin.rotation.z -= dt * (.12 + .45 * k);
    halo.material.color.setRGB(r, gg, b); halo.material.opacity = (.22 + .38 * k) * (.88 + .12 * Math.sin(clk * 3)); halo.scale.setScalar(4.2 + Math.sin(clk * 2) * .15);
    sig.material.color.setRGB(r, gg, b); sig.material.opacity = .22 + .4 * k; sig.rotation.z += dt * (.08 + .2 * k);
    pts.material.color.setRGB(Math.min(1, r * .8 + .2), Math.min(1, gg * .8 + .2), Math.min(1, b * .8 + .2));
    for (let i = 0; i < N; i++) {
      pg[i] += dt * ps[i] * (1 + k); pr[i] -= dt * .22 * (.5 + k);
      if (pr[i] < .04) { pr[i] = .85 + Math.random() * .15; pg[i] = Math.random() * 6.28; }
      pa[i * 3] = Math.cos(pg[i]) * pr[i]; pa[i * 3 + 1] = Math.sin(pg[i]) * pr[i]; pa[i * 3 + 2] = Math.sin(pg[i] * 3) * .04;
    }
    pts.geometry.attributes.position.needsUpdate = true;
    return rgb;
  }
  return { g, step };
}

function bfs(sx, sz) { // q comes back sorted by distance, so q's last cell is the farthest
  const d = grid.map(r => r.map(() => -1)), q = [[sx, sz]];
  d[sz][sx] = 0;
  for (let k = 0; k < q.length; k++) {
    const [x, z] = q[k];
    for (const [a, b] of DIRS) {
      const X = x + a, Z = z + b;
      if (grid[Z] && grid[Z][X] === 0 && d[Z][X] < 0) { d[Z][X] = d[z][x] + 1; q.push([X, Z]); }
    }
  }
  return { d, q };
}

/* ---------- Level building ---------- */
// fog, wall tint, floor tint, torch colour: the look changes every two levels
const TH = [[0x04070b, 0xffffff, 0xffffff, 0xffeccc], [0x0a0605, 0xe0a890, 0xd0a898, 0xffd9a8], [0x040a0c, 0x9fc0d0, 0x90b0c0, 0xcce8ff],
  [0x080510, 0xb8a0d8, 0xa890c8, 0xe0d0ff], [0x100403, 0xd07858, 0xc06848, 0xffb070]];
const TYPES = [ // sorted by the level they first appear on
  { n: 'Acolyte', min: 1, hp: 2, spd: 1, dmg: 12, sc: 1, col: 0x1b1214, eye: 0xff2020 },
  { n: 'Hound', min: 2, hp: 1, spd: 1.8, dmg: 8, sc: .75, col: 0x2a1c10, eye: 0xffa020, low: 1, smell: 1, pounce: 1 },
  { n: 'Digger', min: 4, hp: 6, spd: .65, dmg: 26, sc: 1.35, col: 0x2a1a1a, eye: 0xff0000 },
  { n: 'Veiled', min: 6, hp: 3, spd: 1.5, dmg: 16, sc: 1.1, col: 0x101828, eye: 0x60c0ff, stalk: 1 }]; // freezes while you look at it
const BOSSES = [['The Warden', 0, 0x4a1010], ['Gravedigger', 2, 0x3a2f18], ['Bone Choir', 1, 0x55554a], ['The Hollow Mother', 3, 0x40185a],
  ['Cinder King', 2, 0x7a2400], ['The Weeper', 3, 0x143a52], ['The Archivist', 0, 0x1c4a36], ['Understair Thing', 1, 0x2a102a],
  ['Heart-Eater', 2, 0x700018], ['The Last Door', 3, 0x050505]]; // name, base enemy type, colour

function disposeTree(o) { // free GPU memory of everything a level owned (shared materials and textures stay)
  o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) for (const mt of Array.isArray(c.material) ? c.material : [c.material]) if (!SHARED.has(mt)) mt.dispose(); });
}
function buildLevel(S) { // S = saved level state to restore, or undefined for a fresh level
  if (levelGroup) { scene.remove(levelGroup); disposeTree(levelGroup); }
  blockers.clear(); warp = 0;
  levelGroup = new THREE.Group(); scene.add(levelGroup);
  enemies = []; items = []; chests = []; dying = []; boss = null; shards = 0;
  const th = TH[(level - 1) >> 1];
  scene.fog.color.setHex(th[0]); scene.background.setHex(th[0]);
  wallMat.color.setHex(th[1]).multiplyScalar(.78); floorMat.color.setHex(th[2]).multiplyScalar(.72); ceilMat.color.setHex(th[2]).multiplyScalar(.6); trimMat.color.setHex(th[1]).multiplyScalar(.78); // a darker crypt torch.color.setHex(th[3]);
  const W = 5 + level, n = 2 * W + 1;
  grid = S ? S.grid : genMaze(W);
  rooms = S ? S.rooms || [] : genRooms(grid, level); hasDK = S ? S.dk | 0 : 0; hasXK = S ? !!S.xk : false;
  explored = S ? S.ex.map(r => [...r].map(Number)) : grid.map(r => r.map(() => 0));

  const walls = [];
  const hold = new Set(rooms.filter(r => !r.open).map(r => r.di + ',' + r.dj)); if (S && !S.xo) hold.add(S.exit.join(','));
  grid.forEach((row, j) => row.forEach((v, i) => v && !hold.has(i + ',' + j) && walls.push([i, j])));
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, WALL_H, CELL), wallMat, walls.length);
  const m = new THREE.Matrix4();
  walls.forEach(([i, j], k) => im.setMatrixAt(k, m.makeTranslation(i * CELL, WALL_H / 2, j * CELL)));
  im.castShadow = im.receiveShadow = true; levelGroup.add(im);

  const size = n * CELL, mid = (n - 1) * CELL / 2;
  for (const mt of [floorMat, ceilMat]) for (const k of ['map', 'normalMap', 'roughnessMap']) mt[k].repeat.set(n, n);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.set(mid, 0, mid); floor.receiveShadow = true;
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(size, size), ceilMat);
  ceil.rotation.x = Math.PI / 2; ceil.position.set(mid, WALL_H, mid); ceil.receiveShadow = true;
  levelGroup.add(floor, ceil);
  lamps = []; // ceiling lamps: emissive fixtures, lit by the light pool
  grid.forEach((row, j) => row.forEach((v, i) => { if (!v && (i * 7 + j * 3) % 5 === 0 && (Math.abs(i - 1) + Math.abs(j - 1) < 5 || Math.random() > .16 + level * .02)) lamps.push({ x: i * CELL, z: j * CELL, k: 0 }); /* some lamps are simply dead: long dark stretches */ }));
  pool.forEach(l => l.color.setHex(th[3]));
  for (const r of rooms) { // rug, lamp, crates and (for vaults) an iron-bound gate
    Object.assign(r, { x: r.di * CELL, z: r.dj * CELL, fx: (r.di + r.ox / 2) * CELL, fz: (r.dj + r.oz / 2) * CELL });
    const wx = r.cx * CELL, wz = r.cz * CELL;
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshStandardMaterial({ map: rugTex, color: r.kind === 'boss' ? 0xb08080 : 0xffffff, roughness: 1 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(wx, .02, wz); rug.receiveShadow = true; levelGroup.add(rug);
    lamps.push({ x: wx, z: wz, k: 0 });
    if (r.kind !== 'boss') for (const [a, b] of [[-1, -1], [1, 1]]) { // iron-banded crates
      const cr = new THREE.Group(); cr.position.set(wx + a * 5, 0, wz + b * 5); cr.rotation.y = rnd(6); levelGroup.add(cr);
      sbox(cr, .8, .8, .8, wood, 0, .4, 0); for (const y of [.12, .68]) sbox(cr, .84, .07, .84, iron, 0, y, 0, .5);
    }
    if (!r.open) { const gate = makeGate('vault'); gate.g.position.set(r.x, 0, r.z); gate.g.rotation.y = Math.atan2(r.ox, r.oz); levelGroup.add(gate.g); Object.assign(r, { gate, door: gate.g, gt: 0 }); }
    else r.gt = 1;
  }
  const nl = lamps.length, lanBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(.1, .08, .3, 14), new THREE.MeshBasicMaterial({ color: th[3] }), nl),
    lanCap = new THREE.InstancedMesh(new THREE.ConeGeometry(.17, .13, 14), iron, nl), lanChain = new THREE.InstancedMesh(new THREE.CylinderGeometry(.012, .012, .5, 6), iron, nl),
    halo = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(lamps.flatMap(p => [p.x, WALL_H - .75, p.z])), 3)),
      new THREE.PointsMaterial({ size: 1.3, map: glowTex, color: th[3], transparent: true, opacity: .5, depthWrite: false, blending: THREE.AdditiveBlending }));
  lamps.forEach((p, k) => { // hanging lanterns: chain, iron cap and a glowing glass body
    lanChain.setMatrixAt(k, m.makeTranslation(p.x, WALL_H - .25, p.z)); lanCap.setMatrixAt(k, m.makeTranslation(p.x, WALL_H - .54, p.z)); lanBody.setMatrixAt(k, m.makeTranslation(p.x, WALL_H - .75, p.z));
  });
  halo.frustumCulled = false; levelGroup.add(lanChain, lanCap, lanBody, halo);

  const { d, q } = bfs(1, 1); dist = d;
  const leaf = c => DIRS.filter(([a, b]) => grid[c[1] + b] && grid[c[1] + b][c[0] + a] === 0).length === 1; // a dead end: exactly one way in
  const ec = S ? S.exit : ([...q].reverse().find(leaf) || q[q.length - 1]);                                  // the portal chamber goes in the farthest dead end, never a room corner
  player.pitch = 0;
  if (S) {
    [player.x, player.z, player.yaw] = S.p; shards = S.shards; shardsNeeded = S.need;
    chests = S.chests.map(c => makeChest([c.x / CELL, c.z / CELL], c.r, c.k, c.o));
    S.items.forEach(([t, x, z, y, n]) => addItem(t, [x, z], y || 1, n ? { n } : {}));
    S.en.forEach(([ti, bi, x, z, h]) => addEnemy(ti, [x, z], bi, h));
  } else {
    player.x = player.z = CELL; player.yaw = grid[1][2] === 0 ? -Math.PI / 2 : Math.PI;
    const free = q.filter(c => d[c[1]][c[0]] > 4 && c !== ec).sort(() => Math.random() - .5);
    const spawn = free.filter(c => d[c[1]][c[0]] > 8);
    shardsNeeded = 3 + level;
    for (let i = 0; i < shardsNeeded; i++) addItem('shard', free.pop());
    for (let i = 0; i < 3 + (level >> 1); i++) addItem('ammo', free.pop());
    for (let i = 0; i < (level > 4 ? 2 : 1); i++) addItem('med', free.pop());
    const avail = TYPES.filter(t => t.min <= level).length;
    for (let i = 0; i < 1 + Math.ceil(level * .8); i++) addEnemy(rnd(avail), spawn.pop() || free.pop(), -1);
    const face = r => Math.atan2(Math.sign(r.di - r.cx), Math.sign(r.dj - r.cz));
    const br = rooms.find(r => r.kind === 'boss'), bc = br ? [br.cx - br.ox, br.cz - br.oz] : q[Math.max(0, q.length - 4)];
    addEnemy(BOSSES[level - 1][1], bc, level - 1); // the guardian waits in its chamber beside the key chest
    chests.push(br ? makeChest([br.cx, br.cz], face(br), 'boss') : makeChest([bc[0] + .6, bc[1]], 0, 'boss'));
    for (const r of rooms) {
      if (r.kind === 'vault') { chests.push(makeChest([r.cx, r.cz], face(r), 'loot')); addItem('ammo', [r.cx - 1, r.cz - 1]); addItem('med', [r.cx + 1, r.cz + 1]); addItem('shard', [r.cx + 1, r.cz - 1]); addItem('dkey', free.pop()); }
      if (r.kind === 'open') { addItem('ammo', [r.cx, r.cz]); addItem('shard', [r.cx - 1, r.cz + 1]); addEnemy(rnd(avail), [r.cx + 1, r.cz - 1], -1); }
    }
  }

  const [xi, xj] = ec, xo = S ? !!S.xo : false, nb = DIRS.find(([a, b]) => grid[xj + b]?.[xi + a] === 0) || [0, 1];
  const cx = xi * CELL, cz = xj * CELL, portal = makePortal();
  portal.g.position.set(cx - nb[0] * (CELL / 2 - .6), 0, cz - nb[1] * (CELL / 2 - .6)); portal.g.rotation.y = Math.atan2(nb[0], nb[1]); levelGroup.add(portal.g);
  exit = { x: cx, z: cz, fx: cx + nb[0] * CELL / 2, fz: cz + nb[1] * CELL / 2, i: xi, j: xj, nb, open: xo, portal, px: portal.g.position.x, pz: portal.g.position.z, k: xo ? 1 : 0, gt: xo ? 1 : 0, gate: null, door: null };
  if (!xo) { // locked portcullis across the chamber mouth: needs the key from the boss chest
    grid[xj][xi] = 1;
    const gate = makeGate('exit'); gate.g.position.set(cx + nb[0] * (CELL / 2 - .45), 0, cz + nb[1] * (CELL / 2 - .45)); gate.g.rotation.y = Math.atan2(nb[0], nb[1]);
    levelGroup.add(gate.g); exit.gate = gate; exit.door = gate.g;
  }
  rescueStrays(q, d, ec);
  planScare();
}
function rescueStrays(q, d, ec) { // anything that ended up inside a wall (or the sealed portal chamber) is moved to open floor, so every item can be touched and no creature is trapped
  const spots = q.filter(c => c !== ec && d[c[1]][c[0]] > 2 && grid[c[1]][c[0]] === 0);
  const pick = () => spots[rnd(spots.length)];
  for (const it of items) if (hit(it.mesh.position.x, it.mesh.position.z, .3) && spots.length) { const c = pick(); it.mesh.position.x = c[0] * CELL + (Math.random() - .5) * 1.5; it.mesh.position.z = c[1] * CELL + (Math.random() - .5) * 1.5; }
  for (const e of enemies) if (hit(e.x, e.z, .4) && spots.length) { const c = pick(); e.x = e.tx = c[0] * CELL; e.z = e.tz = c[1] * CELL; e.pi = c[0]; e.pj = c[1]; e.g.position.x = e.x; e.g.position.z = e.z; }
}

const ITEM = { shard: 0x45d0ff, ammo: 0xffc14a, med: 0xff4a5a, dkey: 0xb8bcc4, ckey: 0xd8b040, coins: 0xe6bd48 };
function itemModel(type, col) { // ammo box, first-aid kit, crystal, coin pouch, keys
  const g = new THREE.Group();
  const M = (geo, c, x = 0, y = 0, z = 0, o = {}) => { const k = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: .55, ...o })); k.position.set(x, y, z); g.add(k); return k; };
  if (type === 'shard') M(new THREE.OctahedronGeometry(.28), col, 0, 0, 0, { emissive: col, emissiveIntensity: 1.2, roughness: .2 });
  else if (type === 'med') { M(new THREE.BoxGeometry(.4, .26, .28), 0xf2f2ee); M(new THREE.BoxGeometry(.22, .02, .06), 0xc8202a, 0, .14); M(new THREE.BoxGeometry(.06, .02, .22), 0xc8202a, 0, .14); }
  else if (type === 'ammo') { M(new THREE.BoxGeometry(.34, .2, .22), 0x4a5a3a); M(new THREE.BoxGeometry(.2, .01, .1), 0xe0c050, 0, .105); for (let k = -1; k <= 1; k++) M(new THREE.CylinderGeometry(.018, .018, .12, 8), 0xc89a3a, k * .06, .12, 0, { metalness: .8, roughness: .3 }); }
  else if (type === 'coins') { const o = { metalness: .9, roughness: .28, emissive: col, emissiveIntensity: .35 }; // a stack of old gold coins with two leaning on it
    for (let k = 0; k < 4; k++) M(new THREE.CylinderGeometry(.1, .1, .022, 20), col, 0, -.1 + k * .026, 0, o);
    for (const [x, z, r] of [[.1, .06, .5], [-.09, -.05, -.4]]) M(new THREE.CylinderGeometry(.09, .09, .02, 20), col, x, -.02, z, o).rotation.set(r, 0, .5); }
  else { const o = { metalness: .9, roughness: .3, emissive: col, emissiveIntensity: .2 };
    M(new THREE.TorusGeometry(.11, .03, 8, 14), col, 0, .2, 0, o); M(new THREE.BoxGeometry(.045, .34, .045), col, 0, -.03, 0, o);
    M(new THREE.BoxGeometry(.14, .045, .04), col, .05, -.15, 0, o); M(new THREE.BoxGeometry(.1, .045, .04), col, .03, -.06, 0, o); }
  return g;
}
function addItem(type, c, y = 1, o = {}) { // o.delay: rises out of an opening chest after that many seconds; o.chest: lies inside that chest; o.n: how many rounds an ammo box holds
  if (!c) return;
  const col = ITEM[type], mesh = itemModel(type, col);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.set(2, 2, 1); mesh.add(glow);
  mesh.position.set(c[0] * CELL, o.delay ? y - .45 : y, c[1] * CELL); if (o.delay) mesh.scale.setScalar(.01);
  levelGroup.add(mesh); items.push({ type, mesh, y0: y, ready: !o.delay, rise: o.delay ? -o.delay : 1, chest: o.chest || null, n: o.n || 0 });
}

function addEnemy(ti, c, bi, hpNow) {
  if (!c) return;
  const t = TYPES[ti], B = bi >= 0 ? BOSSES[bi] : null, sc = t.sc * (B ? 1.7 : 1), g = new THREE.Group();
  const skin = skinMat(B ? 'b' + bi : t.n, B ? B[2] : t.col, t.eye).clone(); // clone so each enemy flashes on its own
  if (t.stalk) { skin.transparent = true; skin.opacity = .85; }
  const mesh = (geo, u, v, mat = skin) => { const m = new THREE.Mesh(uvRegion(geo, u, v, .5, .5), mat); m.castShadow = true; return m; };
  const limb = (x, y, len, r, z = 0) => { const m = mesh(new THREE.CylinderGeometry(r, r * .7, len, 8).translate(0, -len / 2, 0), 0, .5); m.position.set(x, y, z); g.add(m); return m; };
  let P;
  if (t.low) { // feral dog: horizontal torso, four legs, snout, ears, wagging tail
    const trunk = mesh(new THREE.SphereGeometry(.4, 14, 10).scale(1, .75, 1.7), 0, 0); trunk.position.y = .75; g.add(trunk);
    const head = mesh(new THREE.SphereGeometry(.2, 12, 10).scale(1, .9, 1.2), .5, 0); head.position.set(0, .95, -.78); g.add(head);
    const snout = mesh(new THREE.ConeGeometry(.09, .3, 8), .5, 0); snout.rotation.x = -Math.PI / 2; snout.position.set(0, -.06, -.26); head.add(snout);
    for (const x of [-.1, .1]) { const ear = mesh(new THREE.ConeGeometry(.06, .16, 5), .5, 0); ear.position.set(x, .2, .02); head.add(ear); }
    const tail = new THREE.Group(); tail.position.set(0, .9, .65); g.add(tail);
    const tc = mesh(new THREE.ConeGeometry(.04, .5, 5), 0, .5); tc.rotation.x = Math.PI / 2; tc.position.z = .25; tail.add(tc);
    P = { body: trunk, head, tail, legL: limb(-.2, .6, .6, .07, -.5), legR: limb(.2, .6, .6, .07, -.5), armL: limb(-.2, .6, .6, .07, .5), armR: limb(.2, .6, .6, .07, .5) };
    g.rotation.order = 'YXZ';
  } else {
  const body = mesh(new THREE.LatheGeometry([[.01, 0], [.3, .05], [.44, .3], [.5, .55], [.42, .8], [.26, .95], [.1, 1]].map(([a, b]) => new THREE.Vector2(a, b)), 14), 0, 0);
  body.position.y = .62; g.add(body);
  for (const [y, r] of [[.95, .47], [1.15, .52], [1.35, .46]]) { const rib = mesh(new THREE.TorusGeometry(r, .03, 6, 14), .5, .5, bone); rib.rotation.x = Math.PI / 2; rib.position.set(0, y, -.02); g.add(rib); }
  const head = mesh(new THREE.SphereGeometry(.28, 16, 12).scale(1, 1.15, 1), .5, 0); head.position.set(0, 1.72, -.1); g.add(head);
  const jaw = mesh(new THREE.BoxGeometry(.3, .09, .26), .5, 0); jaw.position.set(0, -.24, -.06); head.add(jaw);
  for (let k = -2; k <= 2; k++) { const tooth = mesh(new THREE.ConeGeometry(.018, .08, 4), .5, .5, bone); tooth.position.set(k * .055, .07, -.1); jaw.add(tooth); }
  if (B) for (let k = 0; k < 4; k++) { const sp = mesh(new THREE.ConeGeometry(.05, .3, 5), .5, .5, bone); sp.rotation.x = Math.PI / 2; sp.position.set(0, 1.5 - k * .22, .42); g.add(sp); }
  g.rotation.order = 'YXZ';
  P = { body, head, legL: limb(-.2, .75, .75, .12), legR: limb(.2, .75, .75, .12), armL: limb(-.5, 1.4, .8, .09), armR: limb(.5, 1.4, .8, .09) };
  [P.legL, P.legR].forEach(l => { const f = mesh(new THREE.BoxGeometry(.22, .08, .36), 0, .5); f.position.set(0, -.75, -.08); l.add(f); });
  [P.armL, P.armR].forEach(a => { for (let k = -1; k <= 1; k++) { const c = mesh(new THREE.ConeGeometry(.025, .22, 5), .5, .5, bone); c.position.set(k * .05, -.9, 0); c.rotation.x = Math.PI; a.add(c); } });
  const robe = (col, y, h, r1, r2) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 14, 1, true), robeMat.clone()); m.material.color.setHex(col); m.material.side = THREE.DoubleSide; m.position.y = y; m.castShadow = true; g.add(m); };
  if (t.n === 'Acolyte' || t.n === 'Veiled') { // hooded choir robe / pale funeral veil
    const col = t.n === 'Veiled' ? 0xcfd6de : 0x8a3030; robe(col, 1.0, .95, .5, .75);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(.33, .55, 12, 1, true), robeMat.clone()); hood.material.color.setHex(col); hood.material.side = THREE.DoubleSide;
    hood.position.set(0, 1.95, -.08); g.add(hood);
  } else { // gravedigger: flat cap and a shovel held upright
    const cap = mesh(new THREE.CylinderGeometry(.3, .32, .08, 12), .5, 0, cloth); cap.position.set(0, 1.97, -.1); g.add(cap);
    const sh = new THREE.Group(); sh.position.y = -.8; P.armR.add(sh);
    const hd = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, 1.5, 6).rotateX(Math.PI / 2), wood); hd.position.z = -.5; sh.add(hd);
    const bl = new THREE.Mesh(new THREE.BoxGeometry(.28, .03, .4), metal); bl.position.z = -1.3; sh.add(bl);
  }
  }
  const eyeMat = new THREE.MeshBasicMaterial({ color: t.eye });
  for (const x of [-.1, .1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(B ? .07 : .05, 6, 6), eyeMat); e.position.set(x * (t.low ? .8 : 1), t.low ? .98 : 1.78, t.low ? -.9 : -.35); g.add(e); }
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: t.eye, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: .55 }));
  gl.scale.set(.8, .8, 1); gl.position.set(0, t.low ? .98 : 1.78, t.low ? -.95 : -.42); g.add(gl); // eye glow
  if (B && !t.low) for (let k = 0; k < 6; k++) { // crown of spikes marks a boss
    const a = k * 1.047, sp = new THREE.Mesh(new THREE.ConeGeometry(.07, .4, 5), skin);
    sp.position.set(Math.cos(a) * .25, 2.05, Math.sin(a) * .25); sp.rotation.set(Math.sin(a) * .5, 0, -Math.cos(a) * .5); g.add(sp);
  }
  g.scale.setScalar(sc);
  const x = c[0] * CELL, z = c[1] * CELL, max = B ? 8 + level * 3 : Math.ceil(t.hp * (1 + level * .12));
  g.position.set(x, 0, z); levelGroup.add(g);
  const e = { g, skin, x, z, tx: x, tz: z, ti, bi, boss: !!B, max, hp: hpNow ?? max, flash: 0, cd: 0, P, home: c.map(Math.round), lose: 0, saw: false, wind: 0, stun: 0, pc: 0, lunge: 0, fs: 0, lane: (Math.random() - .5) * 2.2, pi: -1, pj: -1, idle: 0, ph: Math.random() * 6, atk: 0, was: false, sy: sc * (t.low ? .6 : 1), r: Math.max(.65, .55 * sc),
    speed: Math.min(Math.min(1.7 + level * .17, 3.2) * t.spd * (B ? .9 : 1), 4.6) };
  enemies.push(e); if (B) boss = e;
}

/* ---------- Combat ---------- */
function shoot() {
  if (state !== 'play' || warp > 0) return;
  if (ammo <= 0) { if (clock - lastShot > .25) { lastShot = clock; sfxClick(); } return; }
  if (clock - lastShot < .3) return;
  lastShot = clock; ammo--; recoil = 1; muzzleT = .06; torch.intensity = 7; vmKey.intensity = 3.2; sfxShot();
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  let best = null, bt = 1e9;
  for (const e of enemies) for (const h of [.5, 1.1, 1.7]) {
    const v = new THREE.Vector3(e.x - player.x, h * e.sy - 1.6, e.z - player.z), t = v.dot(dir);
    if (t > 0 && t < bt && v.addScaledVector(dir, -t).length() < e.r) { best = e; bt = t; }
  }
  if (best) for (let s = .5; s < bt; s += .3)
    if (hit(player.x + dir.x * s, player.z + dir.z * s, .02)) { best = null; break; }
  if (best) { best.hp -= 1 + (level >> 2); best.flash = .12; best.stun = .3; sfxHit(); if (best.hp <= 0) killEnemy(best); else vox('hurt', best); }
  hud();
}
function killEnemy(e) {
  dying.push({ g: e.g, t: 0 }); vox('die', e); enemies.splice(enemies.indexOf(e), 1); score += e.boss ? 1000 : 100;
  const c = [e.x / CELL, e.z / CELL];
  if (e.boss) { boss = null; addItem('ammo', c); addItem('med', [c[0] + .4, c[1]]); sfxUnseal(); say(`${BOSSES[level - 1][0]} has fallen. Its chest is unsealed.`, 3500); voice('Impossible.', .05); }
  else if (Math.random() < .5) addItem('ammo', c);
  save();
}
function damage(n) {
  hp -= n; hurt = .35; shake = .4; sfxHurt(n);
  if (hp <= 0) {
    state = 'dead'; document.exitPointerLock();
    const covered = deathScare(); if (!covered) sfxDeath();                // the killer's face fills the screen, then the game-over screen
    const menu = () => showMenu('You died', `Level ${level}, score ${score}. Continue returns you to the start of this level.`, false, 'dead');
    if (covered) setTimeout(menu, 1000); else menu();
  }
  hud();
}

/* ---------- Update loop: creature animation, props, atmosphere ---------- */
const fw = new THREE.Vector3(), damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
function animate(e, dt, spd, chase, seen) { // gait follows real ground speed; every pose value eases toward its target, so nothing snaps
  const P = e.P, t = TYPES[e.ti], size = Math.max(.5, e.g.scale.x * (t.low ? .6 : 1));
  if (e.mv === undefined) { e.mv = 0; e.ch = 0; e.au = 0; }
  e.mv = damp(e.mv, Math.min(1, spd / (t.low ? 3.2 : 2.4)), 7, dt);   // 0 standing .. 1 full stride
  e.ch = damp(e.ch, chase ? 1 : 0, 5, dt);                             // 0 relaxed .. 1 hunting posture
  e.ph += dt * spd * 2.3 / size;
  const s = Math.sin(e.ph), prev = e.fs; e.fs = s;
  e.atk = Math.max(0, e.atk - dt);
  if (spd > .3 && prev * s < 0) stepSfx(e, size); // audible, positional footfalls
  const amp = (t.low ? .85 : .6) * e.mv + .02;
  if (t.low) { // quadruped: diagonal trot, nose down when sniffing, wagging tail
    P.legL.rotation.x = s * amp; P.legR.rotation.x = -s * amp; P.armL.rotation.x = -s * amp; P.armR.rotation.x = s * amp;
    P.body.rotation.x = damp(P.body.rotation.x, -.1 * e.ch, 8, dt);
    P.head.rotation.x = damp(P.head.rotation.x, e.ch > .5 ? .1 : .3 + Math.sin(clock * 2 + e.x) * .15, 6, dt);
    if (P.tail) P.tail.rotation.y = Math.sin(clock * 8) * (.15 + .35 * e.ch);
    e.g.position.y = damp(e.g.position.y, Math.abs(s) * .06 * e.mv, 14, dt); return;
  }
  e.au = damp(e.au, e.atk > 0 ? 1.25 + Math.sin(e.atk * 18) * .3 : e.ch > .5 ? 1.4 : 0, 9, dt); // arms rise to grab
  const sw = s * .65 * e.mv * (.6 - .45 * e.ch);
  P.legL.rotation.x = s * amp; P.legR.rotation.x = -s * amp * (t.n === 'Acolyte' ? .55 : 1); // acolytes drag a leg
  P.armL.rotation.x = e.au - sw; P.armR.rotation.x = e.au + sw;
  P.body.rotation.x = damp(P.body.rotation.x, e.stun > 0 ? .4 : -.3 * e.ch + (.05 + Math.sin(clock * 1.5) * .03) * (1 - e.ch), e.stun > 0 ? 20 : 7, dt); // flinch when shot
  P.body.rotation.z = damp(P.body.rotation.z, s * .07 * e.mv, 10, dt); // hip sway
  P.head.rotation.z = damp(P.head.rotation.z, seen ? Math.sin(clock * 45) * .15 : Math.sin(clock * 1.7 + e.x) * .08, 12, dt);
  P.head.rotation.y = damp(P.head.rotation.y, e.ch < .3 && e.mv < .15 ? Math.sin(clock * .8 + e.x) * .7 : 0, 3, dt); // idle ones look around
  e.g.position.y = damp(e.g.position.y, Math.abs(s) * .09 * e.mv, 14, dt);
}
function gateStep(o, dt, key) { // gate rises into its lintel; the doorway stays solid until the bars are clear
  o.gt = Math.min(1, o.gt + dt / 2.1);
  o.gate.bars.position.y = easeIO(o.gt) * o.gate.rise + (o.gt < .25 ? Math.sin(clock * 70) * .006 : 0);
  if (o.gt > .75) blockers.delete(key);
  if (o.gt >= 1) o.gate.bars.visible = false;
}
function atmos(dt) { // gates, chests, portal, lamp pool, flicker, blackouts, dust, corpses, random whispers
  for (const r of rooms) if (r.open && r.gate && r.gt < 1) gateStep(r, dt, r.di + ',' + r.dj);
  if (exit.open && exit.gate && exit.gt < 1) gateStep(exit, dt, exit.i + ',' + exit.j);
  chestLight.intensity = 0; let near = null, nd = 1e9;
  for (const c of chests) {
    if (c.open && c.t < 1) c.t = Math.min(1, c.t + dt / 1.2);
    c.lid.rotation.x = -(c.open ? easeBack(c.t) : 0) * 1.95;
    const sealed = c.big && !!boss && !c.open, ready = c.big && !boss && !c.open;
    c.ring.visible = sealed; if (sealed) { c.ring.rotation.y += dt * .8; c.ring.position.y = c.y0 + .65 + Math.sin(clock * 1.5) * .04; }
    c.treasure.visible = c.t > .02; const key = c.treasure.userData.key; if (key) key.rotation.y += dt * 1.6;
    c.glow.material.opacity = c.open ? c.t * (.8 + Math.sin(clock * 4) * .12) : ready ? .35 + Math.sin(clock * 3) * .2 : 0;
    const d = (c.x - player.x) ** 2 + (c.z - player.z) ** 2; if (c.open && c.t > .05 && d < nd) { nd = d; near = c; }
  }
  if (near && nd < 100) { chestLight.position.set(near.x, 1.1, near.z); chestLight.intensity = near.t * 1.3; }
  const pd = Math.hypot(exit.px - player.x, exit.pz - player.z);
  exit.k += ((exit.open ? 1 : 0) - exit.k) * Math.min(1, dt * 1.6);
  if (pd < 30) {
    const c = exit.portal.step(dt, exit.k, clock);
    portalLight.color.setRGB(c[0], c[1], c[2]); portalLight.position.set(exit.px + exit.nb[0] * 1.1, 1.5, exit.pz + exit.nb[1] * 1.1);
    portalLight.intensity = pd < 16 ? (.5 + 1.8 * exit.k) * (.92 + Math.sin(clock * 5) * .06) * Math.min(1, (16 - pd) / 6) : 0;
  } else portalLight.intensity = 0;
  blackout -= dt; shake = Math.max(0, shake - dt * 2);
  if ((eventT -= dt) < 0) { eventT = (level > 1 ? 18 : 40) + rnd(22); blackout = 1 + Math.random(); growl(55, 1.3, .35); pendingApp = SCARES && Math.random() < .45; } // sometimes something is standing there when the lights return
  if ((voiceT -= dt) < 0) { voiceT = 22 + rnd(25); voice(LINES[rnd(LINES.length)]); }
  lamps.sort((a, b) => (a.x - player.x) ** 2 + (a.z - player.z) ** 2 - (b.x - player.x) ** 2 - (b.z - player.z) ** 2);
  pool.forEach((l, i) => {
    const p = lamps[i]; if (!p) return;
    if (Math.random() < .02) p.k = .1 + Math.random() * .25; p.k = Math.max(0, p.k - dt);
    l.position.set(p.x, WALL_H - .5, p.z);
    l.intensity += ((blackout > 0 ? 0 : p.k > 0 ? .15 : 1.1) - l.intensity) * Math.min(1, dt * 14);
  });
  for (const d of dying) { // corpses topple with an ease-out, then sink; removed and freed after a while
    d.t += dt; d.g.rotation.x = -(1 - Math.pow(1 - Math.min(d.t / .9, 1), 3)) * 1.5; d.g.position.y = -Math.min(Math.max(d.t - .6, 0), 1.5) * .25;
    if (d.t > 3.5 && d.g.parent) { levelGroup.remove(d.g); disposeTree(d.g); }
  }
  const A = dust.geometry.attributes.position, a = A.array;
  for (let i = 0; i < a.length; i += 3) {
    a[i] += dt * .05; a[i + 1] += Math.sin(clock + i) * dt * .1;
    if (a[i + 1] > 3 || a[i + 1] < 0) a[i + 1] = Math.random() * 3;
    for (const k of [0, 2]) { const c = k ? player.z : player.x; if (a[i + k] - c > 8) a[i + k] -= 16; else if (a[i + k] + 8 < c) a[i + k] += 16; }
  }
  A.needsUpdate = true; mistStep(dt);
}
function updateEnemies(dt) {} // replaced by enemies.js (patrol / chase / search / return state machine)

/* ---------- Jump scares: a face that lunges at the screen, a figure that rushes you out of the dark, a game-over shriek ---------- */
// Triggers (all rate-limited, never during a chase): opening some chests and vault doors, one planned spot on the way to the exit,
// the lights coming back after a blackout, and your death. Add ?scares=0 to the address to switch every one of them off.
let SCARES = new URLSearchParams(location.search).get('scares') !== '0' && (() => { try { return JSON.parse(localStorage.getItem('hd_set') || '{}').sc !== 0; } catch (e) { return true; } })();
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
let scareCd = 30, scareNum = 0, scarePlan = null, scare = null, pendingApp = false, scareUntil = 0, levelClock = 0, faceFx = null, faces = null;
const overlay = (id, css) => { let el = $(id); if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); } el.style.cssText += ';' + css; return el; };
overlay('warp', 'position:fixed;inset:0;opacity:0;pointer-events:none;z-index:6;background:radial-gradient(circle at 50% 50%,#f2fffa 0%,#6ff5c8 26%,#0a2a22 78%,#020807 100%)');
const scareEl = overlay('scare', 'position:fixed;inset:0;opacity:0;pointer-events:none;z-index:7;overflow:hidden;background:#000');
const scareImg = document.createElement('canvas'); scareImg.width = scareImg.height = 768;
scareImg.style.cssText = 'position:absolute;left:50%;top:50%;height:118vh;width:118vh;transform:translate(-50%,-50%);will-change:transform'; scareEl.appendChild(scareImg);

function drawFace(kind) { // a procedural screaming face: pale skin with veins, black hollow eyes with pinprick pupils, split mouth full of teeth, hanging hair
  const S = 768, c = cv(S), g = c.getContext('2d'), R = Math.random, P = { hollow: { skin: ['#e9ebde', '#929a8b', '#2b302a'], hair: 1, tears: 0, mouth: 1 }, weeper: { skin: ['#e3e2d8', '#9d9f95', '#30322e'], hair: 1, tears: 1, mouth: .72 }, choir: { skin: ['#dcd5c2', '#8d8573', '#2a2620'], hair: 0, tears: 0, mouth: 1.3 } }[kind];
  g.scale(S / 512, S / 512); g.lineCap = 'round';
  const el = (x, y, rx, ry, f) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fillStyle = f; g.fill(); }, hx = 256, hy = 262;
  const head = () => { g.beginPath(); g.moveTo(hx, hy - 232); g.bezierCurveTo(hx + 172, hy - 232, hx + 180, hy + 60, hx + 92, hy + 192); g.bezierCurveTo(hx + 50, hy + 248, hx - 50, hy + 248, hx - 92, hy + 192); g.bezierCurveTo(hx - 180, hy + 60, hx - 172, hy - 232, hx, hy - 232); g.closePath(); };
  head(); const sk = g.createRadialGradient(hx - 30, hy - 70, 20, hx, hy, 270); sk.addColorStop(0, P.skin[0]); sk.addColorStop(.55, P.skin[1]); sk.addColorStop(1, P.skin[2]); g.fillStyle = sk; g.fill();
  g.save(); head(); g.clip();
  for (let i = 0; i < 170; i++) el(hx + (R() - .5) * 360, hy + (R() - .5) * 480, 8 + R() * 40, 8 + R() * 40, `rgba(${R() < .5 ? '10,12,8' : '255,255,245'},${.04 + R() * .08})`); // mottled skin
  g.lineWidth = 1.1; for (let i = 0; i < 46; i++) { const x = hx + (R() - .5) * 300, y = hy + (R() - .5) * 420; g.strokeStyle = `rgba(${90 + rnd(50)},20,35,${.18 + R() * .3})`; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + R() * 60 - 30, y + R() * 60 - 30, x + R() * 90 - 45, y + R() * 90 - 45); g.stroke(); } // veins
  g.strokeStyle = 'rgba(12,6,6,.5)'; g.lineWidth = .9; for (let i = 0; i < 14; i++) { let x = hx + (R() - .5) * 260, y = hy + (R() - .5) * 380; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) g.lineTo(x += R() * 24 - 12, y += R() * 24 - 12); g.stroke(); } // cracks
  g.restore();
  for (const sx of [-1, 1]) { // eyes: hollow black pits, a pinprick of light, a faint red glow
    const ex = hx + sx * 63, ey = hy - 40; g.save(); g.translate(ex, ey); g.scale(78, 94); const sg = g.createRadialGradient(0, 0, .1, 0, 0, 1); sg.addColorStop(0, 'rgba(8,4,5,.75)'); sg.addColorStop(.55, 'rgba(8,4,5,.4)'); sg.addColorStop(1, 'rgba(8,4,5,0)'); g.fillStyle = sg; g.beginPath(); g.arc(0, 0, 1, 0, 7); g.fill(); g.restore(); // soft shadow around the socket
    const gr = g.createRadialGradient(ex, ey, 3, ex, ey, 58); gr.addColorStop(0, '#000'); gr.addColorStop(.75, '#0b0405'); gr.addColorStop(1, 'rgba(10,4,5,0)'); g.beginPath(); g.ellipse(ex, ey, 52, 66, sx * -.08, 0, 7); g.fillStyle = gr; g.fill();
    el(ex - sx * 5, ey + 10, 14, 14, 'rgba(200,20,20,.22)'); el(ex - sx * 5, ey + 10, 3.4, 3.4, '#fff');
  }
  el(hx - 10, hy + 46, 5, 17, '#110607'); el(hx + 10, hy + 46, 5, 17, '#110607'); // nose slits
  const mw = 80 * P.mouth, mh = 118 * P.mouth, my = hy + 126 + (P.mouth > 1 ? 14 : 0); // the mouth
  g.save(); g.beginPath(); g.ellipse(hx, my, mw, mh, 0, 0, 7); g.clip();
  const mg = g.createRadialGradient(hx, my + 20, 8, hx, my, mh); mg.addColorStop(0, '#000'); mg.addColorStop(.6, '#12040a'); mg.addColorStop(1, '#3a0a0e'); g.fillStyle = mg; g.fillRect(hx - mw, my - mh, mw * 2, mh * 2);
  el(hx, my + mh * .62, mw * .6, mh * .3, '#5a1018'); // tongue
  const teeth = (dir, n) => { for (let i = 0; i < n; i++) { const t = (i + .5) / n * 2 - 1, edge = my - dir * mh * Math.sqrt(Math.max(0, 1 - t * t)) * .98, x = hx + t * mw * .97, w = mw * 2 / n * (.55 + R() * .2), L = 14 + R() * 32 * (1 - Math.abs(t) * .5);
    g.beginPath(); g.moveTo(x - w / 2, edge); g.lineTo(x + (R() - .5) * 5, edge + dir * L); g.lineTo(x + w / 2, edge); g.closePath(); const tg = g.createLinearGradient(0, edge, 0, edge + dir * L); tg.addColorStop(0, '#9c9378'); tg.addColorStop(.5, '#e2dcc0'); tg.addColorStop(1, '#8f8668'); g.fillStyle = tg; g.fill(); g.strokeStyle = 'rgba(30,20,10,.6)'; g.lineWidth = .8; g.stroke(); } };
  teeth(1, 13); teeth(-1, 11); g.restore();
  g.beginPath(); g.ellipse(hx, my, mw, mh, 0, 0, 7); g.strokeStyle = 'rgba(30,6,8,.9)'; g.lineWidth = 3; g.stroke();
  g.strokeStyle = 'rgba(20,5,6,.8)'; g.lineWidth = 1.6; for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(hx + sx * mw * .92, my - 8 + k * 7); g.quadraticCurveTo(hx + sx * (mw + 24), my - 14 + k * 14, hx + sx * (mw + 52 + R() * 30), my - 36 + k * 30); g.stroke(); } // split lip corners
  g.strokeStyle = 'rgba(235,235,225,.5)'; g.lineWidth = 1.3; for (let i = 0; i < 7; i++) { const x = hx + (R() - .5) * mw * 1.2; g.beginPath(); g.moveTo(x, my + mh * .8); g.lineTo(x + R() * 6 - 3, my + mh * .8 + 18 + R() * 50); g.stroke(); } // drool
  if (P.tears) for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) { const x = hx + sx * (63 + (k - 1) * 20), tg = g.createLinearGradient(0, hy + 20, 0, hy + 230); tg.addColorStop(0, 'rgba(0,0,0,.95)'); tg.addColorStop(1, 'rgba(0,0,0,0)'); g.strokeStyle = tg; g.lineWidth = 7 - k * 1.6; g.beginPath(); g.moveTo(x, hy + 20); g.bezierCurveTo(x + sx * 12, hy + 80, x - sx * 8, hy + 150, x + sx * 4, hy + 215 + k * 10); g.stroke(); } // black tears
  if (P.hair) for (let i = 0; i < 90; i++) { const x0 = hx + (R() - .5) * 280, y0 = hy - 215 + R() * 50, drift = (x0 - hx) * .5 + (R() - .5) * 60; g.strokeStyle = `rgba(${6 + rnd(10)},${6 + rnd(8)},${6 + rnd(8)},${.55 + R() * .4})`; g.lineWidth = 1 + R() * 3.4; g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(x0 + drift * .3, y0 + 140, x0 + drift, y0 + 250, x0 + drift * 1.15 + (R() - .5) * 40, y0 + 330 + R() * 160); g.stroke(); } // hair hanging over the face
  const vg = g.createRadialGradient(hx, hy, 150, hx, hy, 300); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = vg; g.fillRect(0, 0, 512, 512); // dark surround
  g.fillStyle = 'rgba(70,0,0,.14)'; g.fillRect(0, 0, 512, 512);
  return c;
}
function initScares() { if (!faces) faces = { hollow: drawFace('hollow'), weeper: drawFace('weeper'), choir: drawFace('choir') }; }

/* --- the screen part: lunge, shake, hold, fade (also runs while dead, so the game-over scare plays) --- */
function showFace(kind, dur = .62, power = 1) {
  if (!faces) initScares(); const src = faces[kind] || faces.hollow, x = scareImg.getContext('2d'); x.clearRect(0, 0, 768, 768); x.drawImage(src, 0, 0);
  faceFx = { t: 0, dur, power: REDUCED ? power * .5 : power }; scareEl.style.opacity = 1; shake = Math.max(shake, 1); hurt = Math.max(hurt, .18); scareUntil = clock + 8;
}
function faceStep(dt) {
  if (!faceFx) return; const f = faceFx; f.t += dt;
  const k = f.t / f.dur, lunge = 1 - Math.pow(1 - Math.min(1, f.t / .16), 3), s = (.55 + .62 * lunge + .3 * k) * (REDUCED ? .85 : 1);
  const j = f.power * (f.t < .35 ? 10 : 3) * (REDUCED ? .3 : 1), jx = (Math.random() - .5) * j, jy = (Math.random() - .5) * j;
  scareImg.style.transform = `translate(calc(-50% + ${jx}px), calc(-50% + ${jy}px)) scale(${s})`;
  scareEl.style.background = f.t < .06 ? `rgba(${REDUCED ? '120,110,110' : '235,225,225'},1)` : '#000';          // one hard flash on the first frames, never a strobe
  scareEl.style.opacity = f.t < f.dur * .62 ? 1 : Math.max(0, 1 - (f.t - f.dur * .62) / (f.dur * .38));
  if (f.t >= f.dur) { faceFx = null; scareEl.style.opacity = 0; }
}

/* --- the world part: something stands where the corridor ends and comes at you --- */
function clearAhead(maxD) { camera.getWorldDirection(fw); const dx = fw.x, dz = fw.z, l = Math.hypot(dx, dz) || 1; let d = 0; while (d < maxD && !hit(player.x + dx / l * (d + .5), player.z + dz / l * (d + .5), .5)) d += .5; return [d, dx / l, dz / l]; }
function triggerScare(kind, delay = 0) {
  if (!SCARES || scare) return; initScares();
  scareCd = 38 + rnd(30) + scareNum * 12; scareNum++;
  scare = { kind, t: -delay, stage: 0, app: null, d0: 0, T: kind === 'rush' ? .62 : .38, dir: null };
  if (delay > 0) sfxScarePre(); // the music drops out: the silence before the shock
}
function startApparition() { // place the figure in front of you on clear floor; if there is no room, the face alone does the job
  const want = scare.kind === 'rush' ? 7 : 3.4, [clear, dx, dz] = clearAhead(want + .5), d0 = Math.min(want, clear - .7);
  if (d0 < 2 || !window.makeApparition) { scare.kind = 'face'; return; }
  const a = window.makeApparition([3, 5, 9, 6][rnd(4)]); a.g.scale.setScalar(a.S * .82); scare.app = a; scare.d0 = d0; scare.dir = [dx, dz]; levelGroup.add(a.g); a.g.position.set(player.x + dx * d0, 0, player.z + dz * d0);
  a.g.rotation.y = Math.atan2(dx, dz); // faces you
  sfxScare('rush');
}
function scareStep(dt) {
  levelClock += dt; scareCd -= dt;
  if (SCARES && scarePlan && !scarePlan.done && !scare && levelClock > 12 && !enemies.some(e => e.st === 'chase') && Math.hypot(player.x - scarePlan.x, player.z - scarePlan.z) < 2.4) { scarePlan.done = true; triggerScare(level >= 3 && Math.random() < .5 ? 'face' : 'rush'); }
  if (pendingApp && blackout <= 0) { pendingApp = false; if (scareOk()) triggerScare('apparition'); }
  if (!scare) return;
  const s = scare; s.t += dt; if (s.t < 0) return;
  if (s.stage === 0) {
    s.stage = 1; if (s.kind !== 'face') startApparition();                 // may downgrade itself to a face when there is no room
    if (s.kind === 'face') { showFace(['hollow', 'weeper', 'choir'][rnd(3)], .62); sfxScare('face'); scare = null; return; }
  }
  if (s.app) { // the rush: slow start, violent finish
    const k = Math.min(1, s.t / s.T), dist = s.d0 - (s.d0 - .75) * k * k, g = s.app.g, P = s.app.P;
    g.position.set(player.x + s.dir[0] * dist, Math.sin(clock * 30) * .03, player.z + s.dir[1] * dist); g.rotation.y = Math.atan2(s.dir[0], s.dir[1]);
    P.armL.rotation.x = P.armR.rotation.x = 1.5 + Math.sin(clock * 22) * .15; P.body.rotation.x = -.35; P.head.rotation.x = -.25; P.legL.rotation.x = Math.sin(clock * 26) * .9; P.legR.rotation.x = -Math.sin(clock * 26) * .9;
    chestLight.color.setHex(0xc4ccff); chestLight.position.set(g.position.x - s.dir[0] * .8, 1.7, g.position.z - s.dir[1] * .8); chestLight.intensity = 3.2; // cold light on its face, even in a blackout
    if (s.t >= s.T) { levelGroup.remove(g); disposeTree(g); chestLight.color.setHex(0xffc860); chestLight.intensity = 0; showFace(['hollow', 'weeper', 'choir'][rnd(3)], .5, 1.2); sfxScare('hit'); scare = null; }
  }
}
const scareOk = () => SCARES && state === 'play' && warp === 0 && !scare && scareCd <= 0 && !enemies.some(e => e.st === 'chase');
function planScare() { // once per level: pick a spot on the shortest route from the start to the exit, somewhere in the middle
  scare = null; pendingApp = false; scarePlan = null; levelClock = 0; scareCd = 30; scareNum = 0;
  try {
    const d = bfs(exit.i, exit.j).d; let x = 1, z = 1; const path = [];
    for (let guard = 0; guard < 400 && d[z] && d[z][x] > 0; guard++) { path.push([x, z]); const nx = DIRS.map(([a, b]) => [x + a, z + b]).filter(([a, b]) => d[b] && d[b][a] >= 0 && d[b][a] < d[z][x]); if (!nx.length) break; [x, z] = nx[rnd(nx.length)]; }
    if (path.length > 6) { const c = path[Math.floor(path.length * (.38 + Math.random() * .24))]; scarePlan = { x: c[0] * CELL, z: c[1] * CELL, done: false }; }
  } catch (e) { scarePlan = null; }
}
function deathScare() { if (!SCARES) return false; initScares(); showFace('choir', .95, 1.3); sfxScare('death'); return true; } // returns true if it will cover the game-over screen for a moment

/* ---------- Atmosphere: creeping mist along the floor and a red dread vignette that throbs with the heartbeat when you are hunted ---------- */
const mist = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(Array.from({ length: 210 }, (_, i) => i % 3 === 1 ? .2 + Math.random() * 1.2 : (Math.random() - .5) * 28)), 3)),
  new THREE.PointsMaterial({ size: 5.5, map: glowTex, color: 0x6a7388, transparent: true, opacity: .07, depthWrite: false }));
mist.frustumCulled = false; scene.add(mist);
function mistStep(dt) {
  const a = mist.geometry.attributes.position.array;
  for (let i = 0; i < a.length; i += 3) {
    a[i] += dt * .12 * Math.sin(clock * .05 + i); a[i + 2] += dt * .08 * Math.cos(clock * .04 + i);
    for (const k of [0, 2]) { const c = k ? player.z : player.x; if (a[i + k] - c > 14) a[i + k] -= 28; else if (a[i + k] + 14 < c) a[i + k] += 28; }
  }
  mist.geometry.attributes.position.needsUpdate = true;
}
const dread = overlay('dread', 'position:fixed;inset:0;opacity:0;pointer-events:none;z-index:1;background:radial-gradient(ellipse at center,transparent 38%,rgba(75,0,0,.7) 100%)');
function dreadStep(dt) {
  const k = Math.min(1, intensity), pulse = .5 + .5 * Math.sin(clock * (5 + k * 6));
  dread.style.opacity = (k * (.45 + .3 * pulse) + (hp < 35 ? (35 - hp) / 35 * .3 : 0)).toFixed(3);
}

/* ---------- Map: fog of war, minimap, full map (M) ---------- */
function reveal() {
  const ci = Math.round(player.x / CELL), cj = Math.round(player.z / CELL);
  for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++)
    if (explored[j] && explored[j][i] !== undefined && Math.hypot(i - ci, j - cj) < 2.7) explored[j][i] = 1;
}
function drawMap() {
  const c = $('map'), g = c.getContext('2d'), S = c.width, n = grid.length, view = mapBig ? n : 15, cs = S / view;
  const px = player.x / CELL, pz = player.z / CELL, ox = mapBig ? -.5 : px - view / 2, oz = mapBig ? -.5 : pz - view / 2;
  g.clearRect(0, 0, S, S); g.fillStyle = 'rgba(6,5,5,.72)'; g.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (explored[j][i]) {
    g.fillStyle = grid[j][i] ? '#2c2723' : '#8a7a64'; g.fillRect((i - .5 - ox) * cs, (j - .5 - oz) * cs, cs + .5, cs + .5);
  }
  const dot = (x, z, col, r) => { g.fillStyle = col; g.beginPath(); g.arc((x / CELL - ox) * cs, (z / CELL - oz) * cs, r, 0, 7); g.fill(); };
  for (const it of items) {
    const p = it.mesh.position;
    if (it.type === 'shard' && explored[Math.round(p.z / CELL)][Math.round(p.x / CELL)]) dot(p.x, p.z, '#45d0ff', cs * .25);
  }
  for (const r of rooms) if (!r.open && explored[r.dj][r.di]) dot(r.x, r.z, '#d09a40', cs * .3);
  if (explored[Math.round(exit.z / CELL)][Math.round(exit.x / CELL)]) dot(exit.x, exit.z, exit.open ? '#30ff70' : '#ff3a1a', cs * .35);
  g.save(); g.translate((px - ox) * cs, (pz - oz) * cs); g.rotate(Math.atan2(-Math.cos(player.yaw), -Math.sin(player.yaw)));
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cs * .6, 0); g.lineTo(-cs * .4, cs * .35); g.lineTo(-cs * .4, -cs * .35); g.fill(); g.restore();
}

function update(dt) {
  const warping = warp > 0;
  const f = warping ? 0 : Math.max(-1, Math.min(1, (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) - joy.y)), s = warping ? 0 : Math.max(-1, Math.min(1, (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + joy.x));
  player.sprint = !warping && (!!keys.ShiftLeft || touchRun) && f > 0;
  if (touchFire) shoot();
  const moving = !!(f || s);
  if (moving) {
    const sp = (player.sprint ? 6.2 : 3.8) * (player.slow || 1) * dt / Math.max(1, Math.hypot(f, s)); // slow: set by the Hollow Mother's lullaby
    const dx = (-Math.sin(player.yaw) * f + Math.cos(player.yaw) * s) * sp;
    const dz = (-Math.cos(player.yaw) * f - Math.sin(player.yaw) * s) * sp;
    if (!hit(player.x + dx, player.z, .35) && !chestBlock(player.x + dx, player.z)) player.x += dx;
    if (!hit(player.x, player.z + dz, .35) && !chestBlock(player.x, player.z + dz)) player.z += dz;
  }
  bobA = damp(bobA, moving ? 1 : 0, 8, dt); sprintK = damp(sprintK, player.sprint ? 1 : 0, 8, dt); bobP += dt * (player.sprint ? 12 : 8) * (moving ? 1 : 0);
  const ph = Math.sin(bobP); if (moving && ph < 0 && lastPh >= 0) stepSfx(null, 1); lastPh = ph;
  camera.position.set(player.x + (Math.random() - .5) * shake * .3, 1.6 + ph * .05 * bobA, player.z);
  camera.rotation.set(player.pitch + recoil * .03, player.yaw, Math.sin(clock * .7) * .003 * (1 + intensity * 3)); // the camera breathes, more heavily when hunted
  // hands: breathing, walk bob, sprint carry, sway that lags behind the camera turn, recoil with slide blowback
  const dy = player.yaw - lastYaw, dp = player.pitch - lastPitch; lastYaw = player.yaw; lastPitch = player.pitch;
  swayY = damp(swayY, Math.max(-.12, Math.min(.12, dy * 2.2)), 9, dt); swayX = damp(swayX, Math.max(-.1, Math.min(.1, dp * 2.2)), 9, dt);
  const bx_ = Math.cos(bobP * .5) * .006 * bobA, by_ = ph * .008 * bobA, br = Math.sin(clock * 1.7) * .0016;
  gun.position.set(.14 + bx_ - sprintK * .03, -.108 + by_ + br - sprintK * .045, -.36 + recoil * .05 + sprintK * .02);
  gun.rotation.set(-swayX + recoil * .22 + sprintK * .35, -swayY - sprintK * .25, bx_ * 2);
  slide.position.z = -.08 + recoil * .045;
  lamp.position.set(-.165 - bx_ - sprintK * .02, -.118 - by_ + br * .6 - sprintK * .05, -.36 + sprintK * .02);
  lamp.rotation.set(-swayX * .8 + sprintK * .25, -swayY * .8 + sprintK * .2, -bx_ * 2);
  recoil *= 1 - Math.min(1, dt * 12);
  const target = torchOn && blackout <= 0 ? (level > 1 && Math.random() < .014 ? .9 : 2.7) : 0;
  torch.intensity += (target - torch.intensity) * Math.min(1, dt * 12);
  vmKey.intensity += ((.22 + torch.intensity * .22) - vmKey.intensity) * Math.min(1, dt * 14);
  lens.material.emissiveIntensity = torch.intensity * .7; muzzle.visible = (muzzleT -= dt) > 0;

  updateEnemies(dt); atmos(dt); scareStep(dt); audioFrame(dt); dreadStep(dt); reveal(); drawMap();
  focus = warping ? null : findFocus(); $('prompt').hidden = !focus; if (focus) $('prompt').textContent = promptText(focus);

  for (let i = 0; i < items.length; i++) { // items spin and bob; those in an opening chest rise out of it first
    const it = items[i], m = it.mesh; m.rotation.y += dt * 2;
    if (!it.ready) { it.rise += dt / .7; const k = Math.max(0, Math.min(1, it.rise)); if (it.rise >= 1) it.ready = true; m.scale.setScalar(Math.max(.01, easeBack(k))); m.position.y = it.y0 - .45 * (1 - k); }
    else m.position.y = it.y0 + Math.sin(clock * 3 + i) * (it.chest ? .05 : .1);
  }
  for (const it of items.slice()) if (it.ready && !it.chest && Math.hypot(it.mesh.position.x - player.x, it.mesh.position.z - player.z) < .95 && (it.type !== 'med' || hp < 100)) takeItem(it); // walk into it: touched, taken

  // stepping into the open portal: the world stretches, the screen floods with light, the next level fades in
  if (!warping && exit.open && exit.gt > .8 && Math.hypot(exit.px - player.x, exit.pz - player.z) < .95) { warp = .001; sfxWarp(); }
  if (warp > 0) {
    warp += dt / 1.1; const k = Math.min(1, warp);
    player.x += (exit.px - player.x) * Math.min(1, dt * 2.5); player.z += (exit.pz - player.z) * Math.min(1, dt * 2.5);
    camera.fov = 72 + k * k * 55; camera.updateProjectionMatrix(); $('warp').style.opacity = Math.min(1, Math.max(0, (k - .3) / .6));
    if (warp >= 1) { warp = 0; camera.fov = 72; camera.updateProjectionMatrix(); warpFade = 1; nextLevel(); return; }
  } else if (warpFade > 0) { warpFade = Math.max(0, warpFade - dt / 1.1); $('warp').style.opacity = warpFade; }

  hurt = Math.max(0, hurt - dt);
  $('flash').style.opacity = hurt * 2 + (hp < 30 ? .25 + Math.sin(clock * 6) * .1 : 0);
  if ((msgTimer -= dt) < 0) $('msg').style.opacity = 0;
}

/* ---------- Progression, save, UI ---------- */
function save() { // full snapshot: maze, position, items, enemies, explored map
  if (!levelGroup) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ level, hp, ammo, score, grid, exit: [exit.x / CELL, exit.z / CELL],
      p: [player.x, player.z, player.yaw], shards, need: shardsNeeded, ex: explored.map(r => r.join('')),
      items: items.map(i => [i.type, i.mesh.position.x / CELL, i.mesh.position.z / CELL, i.y0, i.n || 0]),
      en: enemies.map(e => [e.ti, e.bi, e.x / CELL, e.z / CELL, e.hp]),
      rooms: rooms.map(r => ({ kind: r.kind, di: r.di, dj: r.dj, ox: r.ox, oz: r.oz, cx: r.cx, cz: r.cz, open: r.open })),
      chests: chests.map(c => ({ k: c.kind, x: c.x, z: c.z, r: c.rot, o: c.open })), dk: hasDK, xk: hasXK, xo: exit.open }));
  } catch (e) { /* storage blocked */ }
}
function startLevel(S) {
  buildLevel(S); save(); hud(); if (!S) voice(BOSSES[level - 1][0] + ' is waiting.', .05);
  say(S ? `Resumed: ${NAMES[level - 1]}` : `${level}. ${NAMES[level - 1]}: slay ${BOSSES[level - 1][0]}, take the key from its chest, open the gate`, 4500);
}
function nextLevel() {
  score += 500; hp = Math.min(100, hp + 30);
  if (++level > MAX_LEVEL) {
    state = 'win'; document.exitPointerLock(); localStorage.removeItem(SAVE_KEY);
    showMenu('You escaped the Hollow', `Final score ${score}.`, false, 'win'); return;
  }
  startLevel();
}
const ITEMN = { shard: 'the relic shard', ammo: 'the ammo box', med: 'the first-aid kit', dkey: 'the iron key', ckey: 'the exit key', coins: 'the coin pouch' };
function findFocus() { // nearest touchable thing you are looking at
  camera.getWorldDirection(fw); let best = null, bd = 2.8;
  const look = (x, z, kind, ref) => { const dx = x - player.x, dz = z - player.z, d = Math.hypot(dx, dz); if (d < bd && (dx * fw.x + dz * fw.z) / (d || 1) > .5) { bd = d; best = { kind, ref }; } };
  items.forEach(it => it.ready && look(it.mesh.position.x, it.mesh.position.z, 'item', it));
  rooms.forEach(r => r.open || look(r.fx, r.fz, 'door', r));
  chests.forEach(c => c.open || look(c.x, c.z, 'chest', c));
  if (!exit.open) look(exit.fx, exit.fz, 'exit', exit);
  return best;
}
function promptText(f) {
  if (f.kind === 'item') return 'E  take ' + ITEMN[f.ref.type];
  if (f.kind === 'door') return hasDK > 0 ? 'E  unlock the vault gate' : 'Locked: needs an iron key';
  if (f.kind === 'chest') return f.ref.kind === 'boss' && boss ? 'Sealed until the guardian dies' : 'E  open the chest';
  return hasXK ? 'E  unlock the exit gate' : 'Sealed: the key is in the guardian\'s chest';
}
function openGate(r) { r.open = true; grid[r.dj][r.di] = 0; blockers.add(r.di + ',' + r.dj); r.gt = 0; sfxGate(false); shake = Math.max(shake, .3); if (scareOk() && Math.random() < .35) triggerScare('face', 1.3); }
function openExit() {
  exit.open = true; grid[exit.j][exit.i] = 0; blockers.add(exit.i + ',' + exit.j); exit.gt = 0; sfxGate(true); sfxPortal(); shake = Math.max(shake, .4);
  if (exit.gate && exit.gate.eye) { exit.gate.eye.material.color.setHex(0x30ffa0); exit.gate.eye.material.emissive.setHex(0x30ffa0); }
}
function takeItem(it) { // by hand (E / Use) or by touch
  items.splice(items.indexOf(it), 1); levelGroup.remove(it.mesh); sfxPickup(it.type);
  if (it.type === 'shard') { shards++; score += 75; say(`Relic shard ${shards} of ${shardsNeeded} (+75)`, 1500); }
  else if (it.type === 'ammo') { const n = it.n || 8; ammo += n; say(`Picked up ${n} rounds.`, 1200); }
  else if (it.type === 'med') { hp = Math.min(100, hp + 35); say('You patch yourself up.', 1200); }
  else if (it.type === 'coins') { score += 300; say('A pouch of old coins (+300).', 1800); }
  else if (it.type === 'ckey') { hasXK = true; score += 200; say('The exit key! Find the sealed gate at the end of the maze.', 4500); }
  else { hasDK++; say('An iron key. It looks made for a vault gate.', 3000); }
  hud(); save();
}
function chestLoot(c) { // what lies inside rises out of the open chest and can be picked up one by one
  const k = c.big ? 1.2 : 1, cs = Math.cos(c.rot), sn = Math.sin(c.rot), y = (c.y0 + .8) * k;
  const put = (type, lx, n) => addItem(type, [(c.x + lx * k * cs) / CELL, (c.z - lx * k * sn) / CELL], y, { chest: c, delay: .45, n });
  if (c.big) { put('ckey', 0); put('ammo', -.4, 15); put('med', .4); } else { put('coins', -.4); put('ammo', 0, 15); put('med', .4); }
}
function chestBlock(x, z) { // chests are solid for the player; you can still back away from one you are too close to
  for (const c of chests) { const d = Math.hypot(x - c.x, z - c.z); if (d < c.rad + .35 && d < Math.hypot(player.x - c.x, player.z - c.z)) return true; }
  return false;
}
function interact() {
  const f = focus; if (!f || warp > 0) return;
  const no = m => { sfxNo(); say(m, 2200); };
  if (f.kind === 'item') takeItem(f.ref);
  else if (f.kind === 'door') {
    if (hasDK < 1) return no('Locked. It needs an iron key.');
    hasDK--; openGate(f.ref); say('The vault gate grinds upward.', 2500);
  } else if (f.kind === 'chest') {
    const c = f.ref; if (c.kind === 'boss' && boss) return no('Sealed. The guardian still lives.');
    c.open = true; sfxChest(c.big); chestLoot(c);
    if (c.kind !== 'boss' && level >= 2 && scareOk() && Math.random() < .4) triggerScare('face', .95);
    say(c.big ? 'The chest is open. Reach in and take the glowing key.' : 'The chest is open. Take what is inside.', 4000);
  } else {
    if (!hasXK) return no('Sealed. The key is in the guardian\'s chest.');
    hasXK = false; openExit(); say('The portcullis grinds up. The portal is open: step through.', 3200);
  }
  hud(); save();
}
function hud() {
  $('lv').textContent = level; $('sh').textContent = shards; $('shn').textContent = shardsNeeded;
  $('am').textContent = ammo; $('ky').textContent = [hasDK > 0 && 'iron x' + hasDK, hasXK && 'exit key'].filter(Boolean).join(' + ') || 'none'; $('sc').textContent = score; $('hp').style.width = Math.max(hp, 0) + '%';
}
function say(t, ms = 2200) { $('msg').textContent = t; $('msg').style.opacity = 1; msgTimer = ms / 1000; }
/* ---------- Menus: a living title screen, pause menu with Save and Save & exit, sound options ---------- */
const mbg = $('mbg'), mx = mbg.getContext('2d');
let mW = 0, mH = 0, mClock = 0, mAcc = 0, mFlash = 0, mFig = { t: 14 + Math.random() * 14, on: 0 }, mEyes = [], mEmbers = [], mMouse = [.5, .5], mNextEye = 1.2, menuKind = 'title', gated = true;
function mResize() { const s = mobile ? .45 : .6; mW = mbg.width = Math.max(160, Math.ceil(innerWidth * s)); mH = mbg.height = Math.max(120, Math.ceil(innerHeight * s)); }
addEventListener('resize', mResize); mResize();
addEventListener('pointermove', e => { mMouse = [e.clientX / innerWidth, e.clientY / innerHeight]; });
for (let i = 0; i < (mobile ? 26 : 55); i++) mEmbers.push({ x: Math.random(), y: Math.random(), s: .5 + Math.random() * 1.1, v: .012 + Math.random() * .03, p: Math.random() * 6.28 });
function menuBg(dt) { // a torch-lit vault: ribbed arches receding to a glowing doorway, drifting fog and embers, eyes that open in the dark, something that stands in the doorway now and then
  mAcc += dt; if (mAcc < .032) return; dt = mAcc; mAcc = 0; mClock += dt;
  const W = mW, H = mH, g = mx, cx = W / 2 + (mMouse[0] - .5) * W * .035, vy = H * .5 + (mMouse[1] - .5) * H * .03, fl = Math.max(.35, .82 + .18 * Math.sin(mClock * 9) * Math.sin(mClock * 3.1) + (Math.random() < .035 ? -.3 : 0));
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#030205'); gr.addColorStop(.55, '#09070e'); gr.addColorStop(1, '#170608'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 10; i++) { // nested arches, each a little brighter and warmer than the one outside it
    const k = Math.pow(.68, i), w = W * .95 * k, h = H * 1.08 * k, lit = i * i * .55 * fl;
    g.beginPath(); g.moveTo(cx - w / 2, vy + h * .5); g.lineTo(cx - w / 2, vy - h * .12); g.quadraticCurveTo(cx - w / 2, vy - h * .6, cx, vy - h * .6); g.quadraticCurveTo(cx + w / 2, vy - h * .6, cx + w / 2, vy - h * .12); g.lineTo(cx + w / 2, vy + h * .5); g.closePath();
    g.fillStyle = `rgb(${8 + lit * 2.1 | 0},${6 + lit * .9 | 0},${9 + lit * .5 | 0})`; g.fill(); g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = Math.max(1, 4 * k); g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; for (let i = -6; i <= 6; i++) { g.beginPath(); g.moveTo(cx, vy + H * .06); g.lineTo(cx + i * W * .22, H); g.stroke(); } // floor flags
  g.globalCompositeOperation = 'lighter'; const dg = g.createRadialGradient(cx, vy, 0, cx, vy, H * .42); dg.addColorStop(0, `rgba(255,170,90,${.5 * fl})`); dg.addColorStop(.35, `rgba(190,70,30,${.2 * fl})`); dg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = dg; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  mFig.t -= dt; if (mFig.t < 0 && !mFig.on) { mFig.on = 1.5; if (audioLive && !gated) sfxUi('whisper'); } // a tall figure in the doorway for a moment
  if (mFig.on > 0) { mFig.on -= dt; if (mFig.on <= 0) mFig.t = 26 + Math.random() * 26;
    const a = Math.min(1, mFig.on * 3) * (Math.random() < .12 ? .3 : .95), s = H * .0105; g.fillStyle = `rgba(0,0,0,${a})`; g.beginPath(); g.arc(cx, vy - s * 6.5, s * 1.3, 0, 7); g.fill();
    g.beginPath(); g.moveTo(cx - s * 1.2, vy - s * 5); g.lineTo(cx + s * 1.2, vy - s * 5); g.lineTo(cx + s * .9, vy + s * 7); g.lineTo(cx - s * .9, vy + s * 7); g.fill(); g.strokeStyle = `rgba(0,0,0,${a})`; g.lineWidth = Math.max(1, s * .5); g.beginPath(); g.moveTo(cx - s, vy - s * 4); g.lineTo(cx - s * 2.6, vy + s * 3); g.moveTo(cx + s, vy - s * 4); g.lineTo(cx + s * 2.6, vy + s * 3); g.stroke(); }
  for (let i = 0; i < 4; i++) { const fx = ((mClock * (i % 2 ? 7 : -6) + i * W * .37) % (W * 1.7) + W * 1.7) % (W * 1.7) - W * .35, fy = H * (.35 + i * .17), fg = g.createRadialGradient(fx, fy, 0, fx, fy, W * .5); fg.addColorStop(0, 'rgba(120,130,160,.075)'); fg.addColorStop(1, 'rgba(120,130,160,0)'); g.fillStyle = fg; g.fillRect(0, 0, W, H); } // fog banks
  for (const e of mEmbers) { e.y -= e.v * dt; e.x += Math.sin(mClock * .7 + e.p) * .0016; if (e.y < -.05) { e.y = 1.05; e.x = Math.random(); } g.fillStyle = `rgba(255,${120 + (e.p * 20 | 0)},60,${.35 + .35 * Math.sin(mClock * 3 + e.p)})`; g.fillRect(e.x * W, e.y * H, e.s, e.s); }
  mNextEye -= dt; if (mNextEye < 0 && mEyes.length < 4) { mNextEye = 2 + Math.random() * 3.5; let x = .06 + Math.random() * .88; if (Math.abs(x - .5) < .14) x += x < .5 ? -.18 : .18; mEyes.push({ x, y: .14 + Math.random() * .72, s: 1 + Math.random() * 1.6, t: 0, life: 4 + Math.random() * 3.5, bl: 1 + Math.random() * 2 }); }
  g.globalCompositeOperation = 'lighter';
  for (let i = mEyes.length - 1; i >= 0; i--) { const e = mEyes[i]; e.t += dt; if (e.t > e.life) { mEyes.splice(i, 1); continue; }
    const a = Math.min(1, e.t / .8, (e.life - e.t) / .8), bl = (e.t % e.bl) < .14 ? .12 : 1, ex = (e.x + (mMouse[0] - .5) * .015) * W, ey = e.y * H, d = 6 * e.s * (W / 700 + .5);
    for (const sx of [-1, 1]) { const rg = g.createRadialGradient(ex + sx * d, ey, 0, ex + sx * d, ey, d * 2.2); rg.addColorStop(0, `rgba(255,70,50,${.9 * a})`); rg.addColorStop(.25, `rgba(210,25,20,${.5 * a})`); rg.addColorStop(1, 'rgba(120,0,0,0)'); g.fillStyle = rg; g.beginPath(); g.ellipse(ex + sx * d, ey, d * 2.2, d * 2.2 * bl, 0, 0, 7); g.fill(); } }
  g.globalCompositeOperation = 'source-over';
  const vg = g.createRadialGradient(W / 2, H / 2, H * .15, W / 2, H / 2, H * .85); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.92)'); g.fillStyle = vg; g.fillRect(0, 0, W, H);
  if (mFlash > 0) { g.fillStyle = `rgba(200,210,255,${mFlash * .13})`; g.fillRect(0, 0, W, H); mFlash -= dt * 3.5; } else if (Math.random() < dt * .04) mFlash = 1; // distant lightning through a crack in the roof
}

const hasSave = () => { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } };
function showMenu(title, sub, resume, kind) { // kind: 'title' | 'pause' | 'dead' | 'win'
  kind = kind || (resume ? 'pause' : 'title'); menuKind = kind; const pz = kind === 'pause', m = $('menu');
  m.hidden = false; m.className = 'k-' + kind + (gated ? ' gated' : '');
  document.body.classList.add('inmenu'); // the game's HUD and touch controls hide behind any menu
  $('title').textContent = title; $('title').dataset.text = title; $('sub').textContent = sub; $('sub').classList.remove('saved');
  $('btns').hidden = false; $('optpanel').hidden = true;
  $('res').hidden = !pz; $('sv').hidden = !pz; $('ex').hidden = !pz; $('cont').hidden = pz || !hasSave(); $('new').hidden = pz;
  $('warp').style.opacity = 0;
  if (ac) { if (kind === 'title' || kind === 'win') { audioResume(); setMusicMode('menu'); } else audioPause(pz ? 0 : 2800); } // pause: silence at once; death: after the sting; title and ending: the theme
}
function pause() { if (state !== 'play') return; state = 'paused'; save(); showMenu('Paused', `Level ${level}  ·  Score ${score}  ·  progress saved`, true, 'pause'); }
function lock() { state = 'play'; $('menu').hidden = true; document.body.classList.remove('inmenu'); audioResume(); setMusicMode('game'); if (!mobile) $('c').requestPointerLock(); }
document.addEventListener('visibilitychange', () => document.hidden && pause());
function begin(S) {
  initAudio(); setMusicMode('game'); startLevel(S); lock();
  if (mobile) { document.documentElement.requestFullscreen?.().catch(() => {}); screen.orientation?.lock?.('landscape').catch(() => {}); }
}
function exitToTitle() { // Save & exit: back to the title screen, the run kept on disk
  save(); state = 'menu'; document.exitPointerLock?.(); enemies = []; items = []; boss = null; intensity = 0; faceFx = null; scare = null; scareEl.style.opacity = 0;
  if (levelGroup) { scene.remove(levelGroup); disposeTree(levelGroup); levelGroup = null; }
  for (const id of ['prompt', 'boss']) $(id).hidden = true; $('cap').style.opacity = 0; $('msg').style.opacity = 0; $('flash').style.opacity = 0; mapBig = false; $('map').classList.remove('big');
  showMenu('Hollow Depths', hasSave() ? 'Your progress is saved.' : '', false, 'title');
}
$('new').onclick = () => { level = 1; hp = 100; ammo = 15; score = 0; begin(); };
$('cont').onclick = () => {
  const S = JSON.parse(localStorage.getItem(SAVE_KEY)); ({ level, hp, ammo, score } = S);
  hp = Math.max(hp, 40); ammo = Math.max(ammo, 6); begin(S); // mercy if the save was taken at low health
};
$('res').onclick = lock;
$('sv').onclick = () => { save(); $('sub').textContent = 'Game saved.'; $('sub').classList.add('saved'); sfxUi('save'); };
$('ex').onclick = exitToTitle;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== $('c') && state === 'play') { state = 'paused'; save(); showMenu('Paused', `Level ${level}  ·  Score ${score}  ·  progress saved`, true, 'pause'); }
});
// options: volume sliders and the jump-scare switch, remembered between visits
function syncOpts() { $('vm').value = Math.round(vol.m * 100); $('vs').value = Math.round(vol.s * 100); $('scb').textContent = 'Jump scares: ' + (SCARES ? 'on' : 'off'); }
$('opt').onclick = () => { $('btns').hidden = true; $('optpanel').hidden = false; syncOpts(); };
$('ob').onclick = () => { $('optpanel').hidden = true; $('btns').hidden = false; saveVol(); };
$('vm').oninput = e => { vol.m = e.target.value / 100; applyVol(); saveVol(); };
$('vs').oninput = e => { vol.s = e.target.value / 100; applyVol(); saveVol(); sfxUi('hover'); };
$('scb').onclick = () => { SCARES = !SCARES; vol.sc = SCARES ? 1 : 0; saveVol(); syncOpts(); };
document.querySelectorAll('#menu button').forEach(b => { b.addEventListener('pointerenter', () => sfxUi('hover')); b.addEventListener('click', () => sfxUi('click')); });
function enterGate() { // the first tap or key press: sound is unlocked (phones need this), the theme begins, the menu appears
  if (!gated) return; gated = false; $('menu').classList.remove('gated'); initAudio(); setMusicMode('menu'); sfxUi('click');
}
$('menu').addEventListener('pointerdown', enterGate); addEventListener('keydown', enterGate);

/* ---------- Input ---------- */
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyF') torchOn = !torchOn;
  if (e.code === 'KeyE' && state === 'play') interact();
  if (e.code === 'KeyM') { mapBig = !mapBig; $('map').classList.toggle('big', mapBig); }
  if (e.code === 'KeyK' && state === 'play') { save(); say('Game saved.', 1200); }
});
addEventListener('beforeunload', () => state === 'play' && save());
addEventListener('keyup', e => keys[e.code] = false);
addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  player.yaw -= e.movementX * .0022;
  player.pitch = Math.max(-1.4, Math.min(1.4, player.pitch - e.movementY * .0022));
});
addEventListener('mousedown', () => document.pointerLockElement && shoot());

/* ---------- Audio: stone-crypt reverb, positional creature voices, generative choir score, sound effects ---------- */
let ac, master, musicBus, sfxBus, send, noiseBuf, capT, mus = null, hum = null, audioOff = 0, audioLive = true, intensity = 0;
const LINES = ['Turn back.', 'I see you.', 'Do not look.', 'You cannot leave.', 'It is behind you.', 'Join us.', 'Run.', 'We are still here.'];
function caption(t) { const c = $('cap'); c.textContent = t; c.style.opacity = 1; clearTimeout(capT); capT = setTimeout(() => c.style.opacity = 0, 3000); }

/* --- plumbing --- */
const LITE = UA_MOBILE; // phones and tablets get a lighter audio graph (no HRTF, shorter reverb, fewer oscillators, lower voice sample rate)
const vol = Object.assign({ m: .85, s: .9, sc: 1 }, (() => { try { return JSON.parse(localStorage.getItem('hd_set') || '{}'); } catch (e) { return {}; } })());
const musicLevel = () => .6 * vol.m, saveVol = () => { try { localStorage.setItem('hd_set', JSON.stringify(vol)); } catch (e) { } };
function applyVol() { if (ac && musicBus) { musicBus.gain.setTargetAtTime(musicLevel(), ac.currentTime, .1); sfxBus.gain.setTargetAtTime(vol.s, ac.currentTime, .1); } }
const hz = (root, semi) => root * Math.pow(2, semi / 12);
const setPos = (p, x, y, z) => { if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z); };
function impulse(sec, decay) { // synthetic stone-hall impulse response: noise that darkens as it fades
  const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++) { const t = i / n; lp += ((Math.random() * 2 - 1) - lp) * (.55 - .4 * t); d[i] = lp * Math.pow(1 - t, decay) * (i < 300 ? i / 300 : 1); } }
  return b;
}
function bus(wet = .3, dest = sfxBus) { const g = ac.createGain(); g.connect(dest); if (wet) { const w = ac.createGain(); w.gain.value = wet; g.connect(w); w.connect(send); } return g; }
function spatial(x, z, wet = .35) { // everything played through this seems to come from (x, z) in the maze
  const p = ac.createPanner(); p.panningModel = LITE ? 'equalpower' : 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 2.5; p.maxDistance = 70; p.rolloffFactor = 1.35;
  setPos(p, x, 1.4, z); p.connect(sfxBus); const w = ac.createGain(); w.gain.value = wet; p.connect(w); w.connect(send); return p;
}
function nz(dest, t, dur, o) { // filtered noise burst with an exponential tail
  const n = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); n.buffer = noiseBuf; n.loop = true;
  f.type = o.type || 'bandpass'; f.Q.value = o.q || 1; f.frequency.setValueAtTime(o.f, t); if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(o.g, t + (o.att ?? .005)); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  n.connect(f).connect(g).connect(dest); n.start(t, Math.random()); n.stop(t + dur + .05);
}
function ping(dest, t, f, dur, v, type = 'sine', f2 = 0, att = .004) { // decaying tone
  const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(v, t + Math.min(att, dur * .5)); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g).connect(dest); o.start(t); o.stop(t + dur + .05);
}

/* --- voice synthesis: a sawtooth glottis through three formant filters, with vibrato, growl and breath --- */
/* --- voice synthesis: a small Klatt-style formant synthesizer rendered into a buffer. Glottal pulses with jitter and shimmer, breath noise through a
       four-resonator vocal tract that glides between vowels, vocal fry and growl. Smooth and human-shaped, not a buzzing saw through filters --- */
const VOWF = { a: [800, 1150, 2900, 3500], o: [500, 900, 2800, 3500], u: [350, 700, 2700, 3500], e: [520, 1700, 2500, 3400], i: [300, 2200, 3000, 3700] }, VBW = [80, 100, 150, 250];
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
function klatt(o) { // o: f0 f1 dur vow[2] shift rasp breath voice grow sub fry vib vibD scoop att rel bright sr
  const SR = o.sr || (LITE ? 16000 : 22050), dur = o.dur, n = Math.max(64, Math.floor((dur + .06) * SR)), x = new Float32Array(n);
  const f0 = o.f0, f1 = Math.max(30, o.f1 || f0), sh = o.shift || 1, V0 = VOWF[o.vow[0]], V1 = VOWF[o.vow[1]];
  const rasp = o.rasp || 0, grow = o.grow || 0, breath = o.breath ?? .12, voiced = o.voice ?? 1, sub = o.sub || 0, fry = o.fry || 0;
  const jit = .003 + rasp * .02 + grow * .015, shim = .04 + rasp * .1, vibR = o.vib ?? 5.2, vibD = o.vibD ?? .012, scoop = o.scoop ?? .05, bwS = 1 + rasp * .9 + grow * .5;
  const y1 = [0, 0, 0, 0], y2 = [0, 0, 0, 0], A = [1, 1, 1, 1], B = [0, 0, 0, 0], C = [0, 0, 0, 0];
  let ph = 0, ph2 = 0, jf = 1, ja = 1, cyc = 0, uPrev = 0, uPrev2 = 0, vph = Math.random() * 6.28, wander = 0, gph = Math.random(), w1 = Math.random() * 6.28, w2 = Math.random() * 6.28;
  const coef = t => { // vocal-tract resonators (re-tuned every 32 samples): vowel glide plus a slow organic wobble
    const k = Math.min(1, t / (dur * .75)), s = k * k * (3 - 2 * k), wob = 1 + .012 * Math.sin(t * 2.3 + w1);
    for (let j = 0; j < 4; j++) { const F = (V0[j] + (V1[j] - V0[j]) * s) * sh * (j < 2 ? wob : 1 + .008 * Math.sin(t * 3.1 + w2)), bw = VBW[j] * bwS, c = -Math.exp(-2 * Math.PI * bw / SR);
      C[j] = c; B[j] = 2 * Math.exp(-Math.PI * bw / SR) * Math.cos(2 * Math.PI * Math.min(F, SR * .45) / SR); A[j] = 1 - B[j] - c; }
  };
  const pulse = p => p < .42 ? .5 * (1 - Math.cos(Math.PI * p / .42)) : p < .58 ? Math.cos(Math.PI / 2 * (p - .42) / .16) : 0; // glottal flow: slow opening, quick closing
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const t = i / SR; if ((i & 31) === 0) coef(t);
    wander += (Math.random() - .5) * .0006 - wander * .0015;
    const f = f0 * Math.pow(f1 / f0, Math.min(1, t / dur)) * (1 - scoop * Math.exp(-t * 14)) * (1 + vibD * Math.sin(vph) * Math.min(1, t * 2.5)) * (1 + wander) * jf;
    vph += 2 * Math.PI * vibR * (1 + .05 * Math.sin(t * 1.9)) / SR;
    ph += f / SR; if (ph >= 1) { ph -= 1; cyc++; jf = 1 + jit * gauss(); ja = (1 + shim * gauss()) * (fry && cyc % 2 ? 1 - fry * .5 : 1); } // new pitch period: jitter, shimmer, vocal fry
    ph2 += f / 2 / SR; if (ph2 >= 1) ph2 -= 1;
    const u = pulse(ph); let src = (u - uPrev) * (SR / f) * .08 * ja * voiced; uPrev = u;
    if (sub) { const u2 = pulse(ph2); src += (u2 - uPrev2) * (SR / (f / 2)) * .08 * sub; uPrev2 = u2; }
    src += (Math.random() * 2 - 1) * breath * .22 * (.35 + .65 * u);
    if (grow) { gph += (24 + 5 * Math.sin(t * 3.7)) / SR; src *= 1 - grow * (.5 + .5 * Math.sin(6.2832 * gph)) * (.6 + .4 * Math.random()); }
    let y = src; for (let j = 0; j < 4; j++) { const v = A[j] * y + B[j] * y1[j] + C[j] * y2[j]; y2[j] = y1[j]; y1[j] = v; y = v; }
    x[i] = y; if (Math.abs(y) > peak) peak = Math.abs(y);
  }
  const att = Math.min(o.att ?? .06, dur * .45), rel = Math.min(o.rel ?? dur * .45, dur * .9), drive = 1 + rasp * 6, kT = o.bright ?? .5; let lp = 0, pk = 1e-9;
  for (let i = 0; i < n; i++) { // normalise, saturate a little for rasp, soften, shape with the envelope
    const t = i / SR; let v = x[i] / peak; if (rasp) v = Math.tanh(v * drive) / Math.tanh(drive);
    lp += (v - lp) * kT; v = lp; const a = Math.min(1, t / att), r = Math.max(0, Math.min(1, (dur - t) / rel)); v *= a * a * (3 - 2 * a) * r * r * (3 - 2 * r);
    x[i] = v; if (Math.abs(v) > pk) pk = Math.abs(v);
  }
  const gn = .95 / pk; for (let i = 0; i < n; i++) x[i] *= gn;
  return { x, SR };
}
function vnote(dest, t, o) { // same options as klatt(), plus v (volume); played from a buffer at time t
  const { x, SR } = klatt(o), b = ac.createBuffer(1, x.length, SR); b.getChannelData(0).set(x);
  const s = ac.createBufferSource(), g = ac.createGain(); s.buffer = b; g.gain.value = o.v; s.connect(g).connect(dest); s.start(t);
}
const VOICE = [ // per creature base type: Acolyte, Hound, Digger, Veiled
  { f: 112, sh: 1, vw: ['o', 'a'], ra: .35 }, { f: 205, sh: .95, vw: ['a', 'o'], ra: .7 }, { f: 64, sh: .82, vw: ['u', 'o'], ra: .55 }, { f: 240, sh: 1.18, vw: ['i', 'a'], ra: .12 }];
const KINDS = { // d: seconds, f: pitch multiplier start/end, v: volume, gr: growl, br: breath, r: rasp
  idle: { d: 1.6, f: [1, .84], v: .16, gr: .1, br: .35, r: .5 }, alert: { d: .75, f: [.9, 1.55], v: .5, gr: .3, br: .25, r: 1 },
  attack: { d: .5, f: [1.2, .8], v: .5, gr: .7, br: .3, r: 1.2 }, hurt: { d: .34, f: [1.5, .9], v: .45, gr: .2, br: .2, r: .9 },
  die: { d: 1.8, f: [1, .35], v: .45, gr: .45, br: .35, r: 1 }, roar: { d: 2, f: [.95, .5], v: .6, gr: .5, br: .4, r: 1.2 } };
function vox(kind, e, scale = 1) { // a creature calls out from where it stands: idle mutter, alert cry, attack snarl, pain, death, boss roar
  if (!ac || !audioLive || !e) return;
  const K = KINDS[kind], V = VOICE[e.ti], f0 = V.f * (e.boss ? .6 + (e.bi % 4) * .05 : 1) * (.92 + (e.ph % 1) * .16);
  const d = spatial(e.x, e.z, e.boss ? .55 : .35), t = ac.currentTime + .01;
  if (e.ti === 1 && (kind === 'alert' || kind === 'attack')) { // hounds bark in bursts
    for (let i = 0, n = kind === 'alert' ? 3 : 1; i < n; i++) vnote(d, t + i * .26, { f0: f0 * 1.6, f1: f0, dur: .2, v: K.v * scale, vow: ['a', 'o'], shift: V.sh, rasp: .8, breath: .2, grow: .5, att: .01 });
    return;
  }
  if (e.ti === 1 && kind === 'idle') { for (let i = 0; i < 3; i++) nz(d, t + i * .38, .22, { f: 1400, f2: 700, q: .8, g: .12 * scale }); return; } // panting
  vnote(d, t, { f0: f0 * K.f[0], f1: f0 * K.f[1], dur: K.d * (e.boss ? 1.25 : 1), v: K.v * scale * (e.boss ? 1.3 : 1), vow: V.vw, shift: V.sh, rasp: V.ra * K.r,
    breath: K.br, grow: K.gr + (e.ti === 2 ? .2 : 0), att: kind === 'idle' ? .25 : .03, vib: e.ti === 3 ? 6.5 : 5, vibD: e.ti === 3 ? .03 : .01, sub: e.boss || e.ti === 2 ? .4 : 0 });
}
function voice(t, pitch = .3) { // scripted lines and whispers: shown as subtitles, heard as a wordless murmur close behind you
  caption(t);
  if (!ac || !audioLive) return;
  const [x, z] = behind(1.8 + Math.random() * 1.5, 1.4), d = spatial(x, z, .8), f = 80 + Math.min(pitch, 1) * 120, n = Math.min(5, 2 + (t.length >> 3)), VW = ['a', 'e', 'i', 'o', 'u'], t0 = ac.currentTime + .05;
  for (let i = 0; i < n; i++) vnote(d, t0 + i * .3, { f0: f * (1 - i * .025), f1: f * .93, dur: .34, v: .5, vow: [VW[rnd(5)], VW[rnd(5)]], voice: .35, breath: .9, vib: 4.6, vibD: .008, att: .05, rel: .15 });
  musicBus.gain.cancelScheduledValues(ac.currentTime); musicBus.gain.setTargetAtTime(musicLevel() * .45, ac.currentTime, .15); musicBus.gain.setTargetAtTime(musicLevel(), ac.currentTime + n * .3 + .6, .9); // the score ducks under it
}
function growl(f = 70, d = .8, v = .25) { // non-positional monster growl (lights dying, kills, big events)
  if (!ac || v <= 0) return;
  vnote(bus(.5), ac.currentTime + .01, { f0: f * 1.2, f1: f * .6, dur: d, v: v * 1.6, vow: ['u', 'o'], shift: .85, rasp: .6, breath: .2, grow: .5, att: .05, sub: .5 });
}
function beep(f, d, type = 'sine', v = .1) { if (ac) ping(bus(.2), ac.currentTime, f, d, v, type, Math.max(20, f / 2)); }

/* --- sound effects --- */
function creak(dest, t, dur) { // wood and iron straining
  const o = ac.createOscillator(), bp = ac.createBiquadFilter(), g = ac.createGain(), l = ac.createOscillator(), lg = ac.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.linearRampToValueAtTime(150, t + dur * .6); o.frequency.linearRampToValueAtTime(95, t + dur);
  l.frequency.value = 17; lg.gain.value = 14; l.connect(lg).connect(o.frequency);
  bp.type = 'bandpass'; bp.Q.value = 7; bp.frequency.setValueAtTime(420, t); bp.frequency.linearRampToValueAtTime(980, t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(1.4, t + .08); g.gain.setValueAtTime(1.4, t + dur - .2); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(bp).connect(g).connect(dest); o.start(t); l.start(t); o.stop(t + dur + .05); l.stop(t + dur + .05);
}
function sfxShot() { if (!ac) return; const t = ac.currentTime, o = bus(.5);
  nz(o, t, .09, { type: 'highpass', f: 1800, q: .6, g: .9, att: .001 }); nz(o, t, .35, { type: 'lowpass', f: 2400, f2: 200, q: .8, g: 1, att: .002 });
  ping(o, t, 150, .3, 1, 'sine', 38); nz(o, t + .02, 1.1, { f: 600, q: .3, g: .1, att: .02 }); }
function sfxClick() { if (!ac) return; const t = ac.currentTime, o = bus(.1); ping(o, t, 1800, .04, .25, 'square', 900); nz(o, t, .03, { f: 3500, q: 2, g: .25 }); }
function sfxHit() { if (!ac) return; const t = ac.currentTime, o = bus(.2); nz(o, t, .14, { type: 'lowpass', f: 1000, f2: 200, g: .8 }); ping(o, t, 130, .16, .6, 'sine', 60); }
function sfxHurt(n) { if (!ac) return; const t = ac.currentTime, o = bus(.15); ping(o, t, 95, .35, .7, 'sawtooth', 45); nz(o, t, .3, { type: 'lowpass', f: 700, f2: 150, g: .8 }); if (n > 15) ping(o, t + .02, 60, .5, .5, 'sine', 30); }
function sfxDeath() { if (!ac) return; const t = ac.currentTime; musicBus.gain.setTargetAtTime(.02, t, 1); vnote(bus(.7), t, { f0: 60, f1: 28, dur: 2.6, v: .38, vow: ['u', 'o'], rasp: .4, breath: .3, grow: .5, att: .1, sub: .45 }); }
function sfxUnseal() { if (!ac) return; const t = ac.currentTime, o = bus(.85); [880, 1318, 1760].forEach((f, i) => ping(o, t + .15 + i * .14, f, 1.6, .16, 'sine')); nz(o, t, 1.4, { f: 300, f2: 2400, q: 1, g: .3, att: .7 }); }
function sfxPickup(type) { if (!ac) return; const t = ac.currentTime, o = bus(.5);
  if (type === 'shard') [1568, 2093, 2637].forEach((f, i) => ping(o, t + i * .06, f, .7, .2, 'sine'));
  else if (type === 'ammo') { nz(o, t, .05, { f: 3200, q: 3, g: .45 }); ping(o, t + .05, 780, .08, .3, 'triangle', 500); nz(o, t + .11, .05, { f: 2400, q: 3, g: .4 }); }
  else if (type === 'med') { ping(o, t, 660, .4, .26, 'sine'); ping(o, t + .1, 880, .5, .24, 'sine'); }
  else { ping(o, t, 2400, .35, .24, 'triangle'); ping(o, t + .07, 3100, .45, .2, 'triangle'); nz(o, t, .12, { f: 4200, q: 4, g: .25 }); } }
function sfxNo() { if (!ac) return; const t = ac.currentTime, o = bus(.1); ping(o, t, 150, .12, .6, 'square', 90); nz(o, t, .08, { type: 'lowpass', f: 500, g: .5 }); }
function sfxChest(big) { if (!ac) return; const t = ac.currentTime, o = bus(.45);
  ping(o, t, 220, .12, .4, 'square', 110); nz(o, t, .08, { f: 2600, q: 4, g: .3 }); creak(o, t + .12, .9); ping(o, t + 1, 90, .25, .5, 'sine', 50);
  if (big) { [523, 659, 784, 1047].forEach((f, i) => ping(bus(.9), t + .9 + i * .08, f, 2.4, .12, 'sine')); nz(bus(.9), t + .9, 1.6, { f: 400, f2: 3000, q: 1, g: .25, att: .8 }); }
  else for (let i = 0; i < 9; i++) ping(bus(.5), t + 1 + Math.random() * .4, 2200 + rnd(1800), .22, .1, 'triangle'); }
function sfxGate(isExit) { if (!ac) return; const t = ac.currentTime, o = bus(.5);
  ping(o, t, 330, .09, .35, 'square', 160); nz(o, t, .06, { type: 'highpass', f: 3000, g: .3 });
  for (let i = 0; i < 9; i++) nz(o, t + .2 + i * .17 + Math.random() * .08, .06, { f: 3800 + rnd(800), q: 8, g: .16 });         // chain rattle
  nz(o, t + .15, 2, { f: 170, f2: 260, q: 2, g: .6, att: .3 }); ping(o, t + .1, 46, 2.2, .5, 'sine', 38, .4);                     // stone grinding, deep rumble
  ping(o, t + 2.1, 82, .3, .6, 'sine', 40); nz(o, t + 2.1, .15, { type: 'lowpass', f: 600, g: .5 });                              // bars hit their stops
  if (isExit) ping(bus(.9), t + .6, 196, 2.6, .1, 'sine'); }
function sfxPortal() { if (!ac) return; const t = ac.currentTime, o = bus(.85);
  nz(o, t, 2.4, { f: 300, f2: 3500, q: 1.2, g: .4, att: 1.2 }); [196, 294, 392, 587].forEach((f, i) => ping(o, t + .2 + i * .15, f, 3, .1, 'sine', 0, .8)); }
function sfxWarp() { if (!ac) return; const t = ac.currentTime, o = bus(.8); nz(o, t, 1.3, { f: 200, f2: 6000, q: 1, g: .6, att: .9 });
  ping(o, t, 100, 1.1, .45, 'sine', 900, .6); ping(o, t + 1, 70, .8, .7, 'sine', 30); musicBus.gain.setTargetAtTime(.1, t, .3); musicBus.gain.setTargetAtTime(musicLevel(), t + 1.8, 1); }
function sfxScarePre() { if (!ac) return; const t = ac.currentTime; musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(.0001, t, .12); } // the music drops out: the silence before the shock
function sfxScare(kind) { // 'face' / 'hit' / 'death': slam of noise, chest-thump boom, dissonant cluster and a shriek. 'rush': a climbing shriek over a low roar as it closes in
  if (!ac) return; const t = ac.currentTime, o = bus(.7), W = kind === 'death' ? 1.35 : 1, K = kind === 'death' ? .48 : .6; // K keeps the loudest sounds in the game just under clipping
  musicBus.gain.cancelScheduledValues(t); musicBus.gain.setTargetAtTime(.0001, t, .05); musicBus.gain.setTargetAtTime(musicLevel(), t + (kind === 'death' ? 3.4 : 2.4), 1.1); // silence, then the score creeps back
  if (kind === 'rush') {
    vnote(o, t, { f0: 360, f1: 1500, dur: .75, v: .6 * K, vow: ['a', 'i'], rasp: 1.3, breath: .5, grow: .6, vib: 9, vibD: .02, att: .02, rel: .25 });
    vnote(o, t, { f0: 90, f1: 150, dur: .8, v: .5 * K, vow: ['o', 'a'], rasp: .9, grow: .7, sub: .5, att: .05 });
    nz(o, t, .8, { f: 800, f2: 5000, q: .8, g: .35 * K, att: .5 }); return;
  }
  nz(o, t, .55, { f: 2400, f2: 7000, q: .7, g: .9 * K, att: .004 });
  ping(o, t, 62, 1.4, K, 'sine', 28); ping(o, t, 124, .9, .6 * K, 'sine', 50);
  [311, 330, 349, 370, 392, 415].forEach(f => ping(o, t, f, 1.6 * W, .13 * K, 'sawtooth', f * .96));
  vnote(o, t, { f0: 560, f1: 1300 * W, dur: kind === 'hit' ? .5 : 1.1 * W, v: .75 * K, vow: ['a', 'i'], rasp: 1.4, breath: .6, grow: .65, vib: 8, vibD: .018, att: .01, rel: .5 });
  vnote(o, t + .02, { f0: 840, f1: 1900, dur: .8, v: .35 * K, vow: ['e', 'a'], shift: 1.1, rasp: 1.2, grow: .5, att: .01 });
  if (kind === 'death') vnote(o, t + .15, { f0: 70, f1: 32, dur: 2.8, v: .6 * K, vow: ['u', 'o'], rasp: .6, grow: .5, sub: .6, att: .05 });
}
function stepSfx(e, size) { // a footfall: yours, or a creature's (positional; heavier creatures thump lower, hounds click)
  if (!ac) return; const t = ac.currentTime;
  if (!e) { const o = bus(.12); nz(o, t, .09, { type: 'lowpass', f: 380, f2: 160, q: .7, g: .12, att: .004 }); ping(o, t, 85, .09, .09, 'sine', 45); return; }
  if (Math.hypot(player.x - e.x, player.z - e.z) > 22) return;
  const o = spatial(e.x, e.z, .3), w = Math.min(2, size);
  if (TYPES[e.ti].low) { nz(o, t, .05, { f: 1500, q: 1.2, g: .14 }); ping(o, t, 140, .06, .1, 'sine', 80); }
  else { nz(o, t, .12, { type: 'lowpass', f: 300 * (1 + .3 / w), f2: 120, q: .8, g: .35 * w, att: .004 }); ping(o, t, 62 / Math.sqrt(w), .14, .3 * w, 'sine', 32); }
}

/* --- generative score: breathing pad, hollow choir, glass bells, heartbeat that follows the hunt --- */
const SCALE = [0, 1, 3, 5, 7, 8, 10]; // phrygian: the dark one
const CHORDS = [[0, 7, 12, 15], [0, 1, 7, 13], [0, 6, 12, 15], [-1, 6, 11, 18], [0, 3, 6, 12]], BEAT = 60 / 58; // minor-second clusters, tritones, a diminished chord: nothing resolves
function startMusic() {
  const t = ac.currentTime, lp = ac.createBiquadFilter(), pg = ac.createGain(), ps = ac.createGain(), padN = [];
  lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = .8; pg.gain.value = .0001; lp.connect(pg); pg.connect(musicBus); ps.gain.value = .6; pg.connect(ps); ps.connect(send);
  for (let i = 0; i < 4; i++) for (const det of LITE ? [0] : [-7, 7]) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sawtooth'; o.detune.value = det; o.frequency.value = 46.25; g.gain.value = .1; o.connect(g).connect(lp); o.start(t); padN.push([o, i]); }
  const dl = ac.createOscillator(), dg = ac.createGain(); dl.frequency.value = .11; dg.gain.value = 22; dl.connect(dg); padN.forEach(([o]) => dg.connect(o.detune)); dl.start(t); // the whole pad drifts slightly out of tune
  const lf = ac.createOscillator(), lg = ac.createGain(); lf.frequency.value = .07; lg.gain.value = 150; lf.connect(lg).connect(lp.frequency); lf.start(t);
  pg.gain.setTargetAtTime(.5, t, 4);
  const sub = ac.createOscillator(), sg = ac.createGain(); sub.frequency.value = 46.25; sg.gain.value = .0001; sub.connect(sg).connect(musicBus); sub.start(t); sg.gain.setTargetAtTime(.3, t, 5);
  const sw = ac.createWaveShaper(), sb = ac.createBiquadFilter(), sbg = ac.createGain(), sc = new Float32Array(256); for (let i = 0; i < 256; i++) sc[i] = Math.tanh(4 * (i / 128 - 1)); // harmonics of the sub, so small speakers still carry the low drone
  sw.curve = sc; sb.type = 'highpass'; sb.frequency.value = 90; sbg.gain.value = .5; sg.connect(sw); sw.connect(sb); sb.connect(sbg); sbg.connect(musicBus);
  const tl = ac.createBiquadFilter(), tg = ac.createGain(), tens = []; tl.type = 'bandpass'; tl.frequency.value = 900; tl.Q.value = .8; tg.gain.value = .0001; tl.connect(tg); tg.connect(musicBus);
  for (const s of [0, 6]) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sawtooth'; o.frequency.value = 220 * Math.pow(2, s / 12); g.gain.value = .1; o.connect(g).connect(tl); o.start(t); tens.push(o); }
  const choir = ac.createGain(), cw = ac.createGain(); choir.connect(musicBus); cw.gain.value = .9; choir.connect(cw); cw.connect(send);
  mus = { lp, pg, sub, sg, tg, padN, tens, choir, next: t + .3, beat: 0, chord: -1, motif: 3, prev: 0 };
}
const behind = (d, spread) => { camera.getWorldDirection(fw); const a = Math.atan2(fw.x, fw.z) + Math.PI + (Math.random() - .5) * spread; return [player.x + Math.sin(a) * d, player.z + Math.cos(a) * d]; }; // a point d metres behind where you are facing
function whisperBg(t) { // breathy muttering at your back: short syllables, mostly breath
  const [x, z] = behind(2.5 + Math.random() * 4, 2.4), d = spatial(x, z, .85), f = 150 + rnd(70), VW = ['a', 'e', 'i', 'o', 'u'];
  for (let i = 0, n = 2 + rnd(3); i < n; i++) { nz(d, t + i * .22, .05, { type: 'highpass', f: 3500, g: .17 }); vnote(d, t + i * .22, { f0: f * (1 - i * .03), f1: f * .95, dur: .26, v: .36, vow: [VW[rnd(5)], VW[rnd(5)]], voice: .15, breath: 1, vib: 5, vibD: .01, att: .04 }); }
}
function phantomSteps(t) { // five footsteps from behind, getting closer, then nothing
  const [x, z] = behind(6.5, .8), dx = player.x - x, dz = player.z - z, l = Math.hypot(dx, dz) || 1;
  for (let i = 0; i < 5; i++) { const d = spatial(x + dx / l * 3 * i / 5, z + dz / l * 3 * i / 5, .45), tt = t + i * .58; nz(d, tt, .12, { type: 'lowpass', f: 320, f2: 130, q: .8, g: .9, att: .004 }); ping(d, tt, 60, .14, .9, 'sine', 32); }
}
function knocks(t) { const a = Math.random() * 6.28, r = 6 + rnd(6), d = spatial(player.x + Math.sin(a) * r, player.z + Math.cos(a) * r, .6);
  for (let i = 0; i < 3; i++) { const tt = t + i * .85 + Math.random() * .1; ping(d, tt, 95, .2, 1.3, 'sine', 55); nz(d, tt, .07, { type: 'lowpass', f: 900, g: 1, att: .002 }); } }
function scrape(t) { const a = Math.random() * 6.28, r = 9 + rnd(8), d = spatial(player.x + Math.sin(a) * r, player.z + Math.cos(a) * r, .85), tg = ac.createGain(); tg.gain.value = .4; tg.connect(d); creak(tg, t, 1.6 + Math.random()); }
function breathBehind(t) { const [x, z] = behind(1.3, .6), d = spatial(x, z, .3); nz(d, t, 1.1, { f: 650, f2: 1050, q: .9, g: .4, att: .55 }); nz(d, t + 1.5, 1.3, { f: 1000, f2: 600, q: .9, g: .36, att: .35 }); }
function riser(t) { const o = bus(.8, musicBus); nz(o, t, 2.4, { f: 280, f2: 4200, q: 1, g: .3, att: 2 }); ping(o, t, 180, 2.4, .09, 'sine', 1500, 2); ping(o, t + .02, 187, 2.4, .08, 'sine', 1580, 2); }
function musicBox(t) { // a lullaby from somewhere far off; it slows down and sags in pitch as it plays
  const a = Math.random() * 6.28, r = 8 + rnd(5), d = spatial(player.x + Math.sin(a) * r, player.z + Math.cos(a) * r, .95), root = 46.25 * Math.pow(2, ((level - 1) >> 1) * 2 / 12); let tt = t;
  [19, 17, 15, 19, 17, 15, 13, 15].forEach((s, i) => { const f = hz(root, s) * 4 * (1 - i * .007); ping(d, tt, f, 1.8, .9, 'triangle'); ping(d, tt, f * 2.005, 1.1, .2, 'sine'); tt += .44 * (1 + i * .14); });
}
function scheduleBeat(t, n) {
  const root = 46.25 * Math.pow(2, ((level - 1) >> 1) * 2 / 12);
  if (n % 16 === 0) { // every ~15 s: a new chord; the pad glides to it and the choir breathes in
    mus.chord = mus.chord < 0 ? 0 : Math.random() < .45 ? 0 : 1 + rnd(CHORDS.length - 1);
    const ch = CHORDS[mus.chord];
    mus.padN.forEach(([o, i]) => o.frequency.setTargetAtTime(hz(root, ch[i % 4]) * (i < 2 ? 1 : 2), t, 2.2));
    mus.sub.frequency.setTargetAtTime(hz(root, ch[0]), t, 2);
    mus.tens[0].frequency.setTargetAtTime(hz(root, ch[1]) * 4, t, 1); mus.tens[1].frequency.setTargetAtTime(hz(root, ch[1] + 6) * 4, t, 1);
    ch.forEach((s, k) => setTimeout(() => vnote(mus.choir, t + k * .6, { f0: hz(root, s) * (k % 2 ? 4 : 2), dur: 13, v: .09, vow: ['o', 'a'], rasp: 0, breath: .25, vib: 5.1, vibD: .008, att: 4, rel: 6, sr: 11025, bright: .4, scoop: .02 }), k * 80)); // staggered so no frame stalls
  }
  if (n % 2 === 0 && Math.random() < .28 + intensity * .2) { // sparse glass-bell motif: a random walk on the scale
    mus.motif = Math.max(0, Math.min(13, mus.motif + rnd(5) - 2));
    const f = hz(root, SCALE[mus.motif % 7] + 12 * (mus.motif / 7 | 0)) * 2, bt = t + Math.random() * .25, o = bus(.9, musicBus); // low, hollow bells
    const c = ac.createOscillator(), m = ac.createOscillator(), mg = ac.createGain(), g = ac.createGain(); // FM bell
    c.frequency.value = f; m.frequency.value = f * 2.76; mg.gain.setValueAtTime(f * 1.6, bt); mg.gain.exponentialRampToValueAtTime(1, bt + 1.5); m.connect(mg).connect(c.frequency);
    g.gain.setValueAtTime(.0001, bt); g.gain.linearRampToValueAtTime(.09 + intensity * .05, bt + .005); g.gain.exponentialRampToValueAtTime(.0001, bt + 5.5);
    c.connect(g).connect(o); c.start(bt); m.start(bt); c.stop(bt + 5.6); m.stop(bt + 5.6);
  }
  if (intensity > .3) { // heartbeat: lub-dub, faster and louder as the hunt closes in
    const v = (intensity - .2) * .9, o = bus(.15, musicBus), hit = (tt, vv) => { ping(o, tt, 78, .38, vv, 'sine', 36); nz(o, tt, .05, { type: 'lowpass', f: 400, g: vv * .4 }); };
    if (intensity > .7) { hit(t, v); hit(t + BEAT * .5, v * .7); } else if (n % 2 === 0) { hit(t, v); hit(t + .28, v * .6); }
  }
  if (Math.random() < .08) { const d = spatial(player.x + (Math.random() - .5) * 14, player.z + (Math.random() - .5) * 14, .8), f = 1700 + rnd(1200); ping(d, t + Math.random() * .4, f, .18, .12, 'sine', f * .65); } // water drip
  if (Math.random() < .03) { const a = Math.random() * 6.28, r = 16 + rnd(14), d = spatial(player.x + Math.cos(a) * r, player.z + Math.sin(a) * r, .9); // a far-off moan in another passage
    vnote(d, t, { f0: 80 + rnd(40), f1: 60 + rnd(20), dur: 3.2, v: .3, vow: ['o', 'u'], shift: .9, rasp: .1, breath: .5, grow: .2, att: .9, rel: 1.8 }); }
  const lv = .6 + Math.min(level, 10) * .08, R = Math.random; // the haunting grows with depth
  if (intensity < .5) {
    if (R() < .06 * lv) whisperBg(t + R() * .3);                                   // muttering just behind you
    if (level >= 2 && R() < .011 * lv) phantomSteps(t);                           // footsteps approaching from behind that stop
    if (level >= 2 && R() < .011 * lv) knocks(t);                                 // three slow knocks inside a wall
    if (R() < .013 * lv) scrape(t);                                               // something heavy dragged along stone
    if (level >= 3 && R() < .007 * lv) breathBehind(t);                           // breath on the back of your neck
    if (intensity < .25 && clock >= scareUntil && R() < .011) musicBox(t);        // a distant, sagging lullaby
  }
  if (n % 8 === 0) ping(bus(.3, musicBus), t, 46, 1.6, .12, 'sine', 40, .7);    // slow sub throb: pressure in the chest
}
function musicTick(now = ac.currentTime) {
  if (!mus) return;
  const goal = enemies.some(e => e.st === 'chase') ? 1 : clock < scareUntil ? .8 : enemies.some(e => e.st === 'investigate' || e.st === 'search') ? .45 : boss ? .18 : 0;
  if (goal >= .45 && mus.prev < .45) riser(now); mus.prev = goal;              // something just changed: a riser swells
  intensity += (goal - intensity) * .04;
  mus.lp.frequency.setTargetAtTime(300 + intensity * 1000, now, .6); mus.tg.gain.setTargetAtTime(intensity > .55 ? (intensity - .55) * .45 : .0001, now, .5);
  if (mus.next < now - 1) mus.next = now + .1;
  while (mus.next < now + .6) { scheduleBeat(mus.next, mus.beat); mus.next += BEAT; mus.beat++; }
}
function initAudio() {
  if (ac) { audioResume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try { ac = new AC({ latencyHint: LITE ? 'playback' : 'interactive' }); } catch (e) { ac = new AC(); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { } // iPhone: play even with the silent switch on
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 4; comp.attack.value = .004; comp.release.value = .25;
    master = ac.createGain(); master.gain.value = LITE ? 1.05 : .85; master.connect(comp); comp.connect(ac.destination);
    musicBus = ac.createGain(); musicBus.gain.value = musicLevel(); musicBus.connect(master); sfxBus = ac.createGain(); sfxBus.gain.value = vol.s; sfxBus.connect(master);
    const verb = ac.createConvolver(), wet = ac.createGain(); verb.buffer = impulse(LITE ? 2.2 : 3.4, 2.6); send = ac.createGain(); wet.gain.value = .55; send.connect(verb); verb.connect(wet); wet.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate); const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    for (const pan of [-.7, .7]) { // wind in the passages: two slow filtered noise streams, left and right
      const ns = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), lf = ac.createOscillator(), lg = ac.createGain();
      ns.buffer = noiseBuf; ns.loop = true; f.type = 'lowpass'; f.frequency.value = 260; g.gain.value = .06; lf.frequency.value = .09 + Math.abs(pan) * .05; lg.gain.value = 170; lf.connect(lg).connect(f.frequency);
      ns.connect(f); if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; f.connect(p).connect(g); } else f.connect(g); g.connect(master); ns.start(0, Math.random()); lf.start();
    }
    const rb = ac.createBufferSource(), rf = ac.createBiquadFilter(), rg = ac.createGain(), rl = ac.createOscillator(), rlg = ac.createGain(); // room tone: a barely audible low pressure under everything
    rb.buffer = noiseBuf; rb.loop = true; rf.type = 'lowpass'; rf.frequency.value = 85; rg.gain.value = .16; rl.frequency.value = .06; rlg.gain.value = .05; rl.connect(rlg).connect(rg.gain); rb.connect(rf).connect(rg).connect(master); rb.start(0, Math.random()); rl.start();
    const hp = ac.createPanner(), hg = ac.createGain(), hf = ac.createBiquadFilter(), hw = ac.createGain(); // portal hum, positional, swells as you near it
    hp.panningModel = LITE ? 'equalpower' : 'HRTF'; hp.distanceModel = 'inverse'; hp.refDistance = 3; hp.rolloffFactor = .6; hf.type = 'lowpass'; hf.frequency.value = 900; hg.gain.value = 0; hw.gain.value = .4;
    for (const f of [73.4, 74.2, 146.8, 220.5]) { const o = ac.createOscillator(), og = ac.createGain(); o.type = f > 100 ? 'sine' : 'sawtooth'; o.frequency.value = f; og.gain.value = f > 100 ? .5 : .25; o.connect(og).connect(hf); o.start(); }
    hf.connect(hp); hp.connect(hg); hg.connect(master); hg.connect(hw); hw.connect(send); hum = { p: hp, g: hg };
    startMusic(); startTheme();
    ac.onstatechange = () => { if (audioLive && !document.hidden && ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => { }); }; // phones interrupt audio (calls, notifications): take it back
    if (ac.state !== 'running') ac.resume().catch(() => { });
  } catch (e) { console.warn('audio unavailable:', e); ac = null; } // the game carries on in silence rather than breaking
}
const unlockAudio = () => { if (ac && audioLive && ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => { }); };
['pointerdown', 'touchend', 'keydown', 'click'].forEach(ev => addEventListener(ev, unlockAudio, { passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) unlockAudio(); });
function audioFrame(dt) { // per frame: listener follows the camera, portal hum follows distance, the score keeps scheduling
  if (!ac) return;
  const L = ac.listener, t = ac.currentTime; camera.getWorldDirection(fw);
  if (L.positionX) { L.positionX.value = player.x; L.positionY.value = 1.6; L.positionZ.value = player.z; L.forwardX.value = fw.x; L.forwardY.value = fw.y; L.forwardZ.value = fw.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
  else { L.setPosition(player.x, 1.6, player.z); L.setOrientation(fw.x, fw.y, fw.z, 0, 1, 0); }
  if (hum && exit) { const pd = Math.hypot(exit.px - player.x, exit.pz - player.z); hum.g.gain.setTargetAtTime(exit.open ? Math.max(0, 1 - pd / 18) * .22 : Math.max(0, 1 - pd / 9) * .05, t, .25); setPos(hum.p, exit.px, 1.5, exit.pz); }
  musicTick(t);
}
function audioPause(delay = 0) { if (!ac) return; clearTimeout(audioOff); audioLive = false; const go = () => ac.suspend && ac.suspend(); if (delay) audioOff = setTimeout(go, delay); else go(); }
function audioResume() { if (!ac) return; clearTimeout(audioOff); audioLive = true; if (ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => { }); musicBus.gain.cancelScheduledValues(ac.currentTime); musicBus.gain.setTargetAtTime(musicLevel(), ac.currentTime, .3); }


/* --- the Hollow Choir theme: composed rather than generated. E phrygian, 54 bpm, an 8-bar loop: a sung lament over strings, a low bell and a slow drum.
       It plays on the title and ending screens; in the game its melody returns as the distant music box --- */
const THEME = {
  mel: [[0, 12, 2], [2, 13, 1], [3, 12, 1], [4, 10, 2], [6, 8, 1.5], [7.5, 10, .5], [8, 12, 2], [10, 15, 1], [11, 13, 1], [12, 12, 3], [15, 7, 1],
    [16, 12, 2], [18, 13, 1], [19, 15, 1], [20, 17, 2], [22, 15, 1], [23, 13, 1], [24, 13, 2], [26, 12, 1], [27, 10, 1], [28, 12, 4]], // [start beat, semitones above E3, length in beats]
  chords: [[0, 7, 12, 15], [1, 8, 13, 17], [0, 7, 12, 15], [7, 10, 13, 19], [0, 7, 12, 15], [-4, 3, 8, 12], [1, 8, 13, 17], [0, 5, 7, 12]] // one per bar, semitones above E2
}, TH_BEAT = 60 / 54;
let th = null, musicMode = 'menu';
function bellFM(dest, bt, f, v, dec = 5.5) { // inharmonic FM bell
  const c = ac.createOscillator(), m = ac.createOscillator(), mg = ac.createGain(), g = ac.createGain(); c.frequency.value = f; m.frequency.value = f * 2.76; mg.gain.setValueAtTime(f * 1.6, bt); mg.gain.exponentialRampToValueAtTime(1, bt + dec * .3); m.connect(mg).connect(c.frequency);
  g.gain.setValueAtTime(.0001, bt); g.gain.linearRampToValueAtTime(v, bt + .005); g.gain.exponentialRampToValueAtTime(.0001, bt + dec); c.connect(g).connect(dest); c.start(bt); m.start(bt); c.stop(bt + dec + .1); m.stop(bt + dec + .1);
}
function startTheme() {
  const t = ac.currentTime, bus_ = ac.createGain(), lp = ac.createBiquadFilter(), pg = ac.createGain(), pw = ac.createGain(), pad = [];
  bus_.gain.value = .0001; bus_.connect(musicBus); lp.type = 'lowpass'; lp.frequency.value = 650; lp.Q.value = .7; pg.gain.value = .5; lp.connect(pg); pg.connect(bus_); pw.gain.value = .5; pg.connect(pw); pw.connect(send);
  for (let i = 0; i < (LITE ? 3 : 6); i++) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sawtooth'; o.detune.value = i % 2 ? 7 : -7; o.frequency.value = 82.41; g.gain.value = LITE ? .1 : .07; o.connect(g).connect(lp); o.start(t); pad.push([o, LITE ? i : i >> 1]); }
  th = { bus: bus_, pad, next: 0, beat: 0 };
}
function setMusicMode(m) { // 'menu': the theme. 'game': the generative score.
  if (!ac || !th) { musicMode = m; return; }
  const t = ac.currentTime; if (m === 'menu' && musicMode !== 'menu') { th.next = t + .3; th.beat = 0; }
  musicMode = m; th.bus.gain.cancelScheduledValues(t); th.bus.gain.setTargetAtTime(m === 'menu' ? 1 : .0001, t, m === 'menu' ? .8 : 1.2);
  if (mus) { mus.pg.gain.setTargetAtTime(m === 'menu' ? .0001 : .5, t, 1.5); mus.sg.gain.setTargetAtTime(m === 'menu' ? .0001 : .3, t, 1.5); mus.tg.gain.setTargetAtTime(.0001, t, .5); }
}
function themeTick(now) { if (!th || !ac) return; if (th.next < now - 1) th.next = now + .2; while (th.next < now + .7) { themeBeat(th.next, th.beat); th.next += TH_BEAT; th.beat++; } }
function themeBeat(t, n) {
  const b = n % 32, ch = THEME.chords[b >> 2], o = bus(.75, th.bus);
  if (b % 4 === 0) { // a new bar: strings move, the bass speaks, the choir breathes the chord
    th.pad.forEach(([osc, i]) => osc.frequency.setTargetAtTime(hz(82.41, ch[i % 4]), t, .6));
    const bass = hz(82.41, ch[0]); ping(o, t, bass, TH_BEAT * 3.9, .5, 'sine', 0, .06); ping(o, t, bass * 2, TH_BEAT * 3, .14, 'triangle', 0, .06); ping(o, t, bass / 2, TH_BEAT * 3.9, .22, 'sine', 0, .1); // the octave above carries on phone speakers
    ch.slice(1).forEach((s, k) => vnote(o, t + k * .05, { f0: hz(82.41, s) * 2, dur: TH_BEAT * 4.1, v: .12 - k * .015, vow: ['o', 'a'], breath: .15, vib: 5, vibD: .008, att: .5, rel: 1.2, sr: 11025, bright: .4, scoop: .02 }));
  }
  if (b === 0 || b === 16) { bellFM(o, t, 164.81, .14, 7); ping(o, t, 85, .7, .7, 'sine', 38); nz(o, t, .08, { type: 'lowpass', f: 600, g: .3 }); } // the bell and a slow drum open each half
  else if (b % 8 === 4) ping(o, t, 95, .45, .25, 'sine', 45);
  for (const [st, semi, len] of THEME.mel) if (st >= b && st < b + 1) { // the sung melody, doubled a hair out of tune so it sounds like more than one voice
    const tt = t + (st - b) * TH_BEAT, f = hz(164.81, semi), d = len * TH_BEAT * 1.06;
    vnote(o, tt, { f0: f, dur: d, v: .36, vow: ['a', 'o'], breath: .1, vib: 5.4, vibD: .011, att: .22, rel: .6, sr: 11025, bright: .45, scoop: .035 });
    vnote(o, tt + .02, { f0: f * 1.006, dur: d, v: .22, vow: ['o', 'a'], breath: .12, vib: 4.9, vibD: .01, att: .3, rel: .6, sr: 11025, bright: .4, scoop: .03 });
  }
}
function sfxUi(kind) { // menu sounds
  if (!ac || !audioLive) return; const t = ac.currentTime, o = bus(.35);
  if (kind === 'hover') { ping(o, t, 180, .07, .14, 'sine', 100); nz(o, t, .05, { type: 'lowpass', f: 700, g: .08 }); }
  else if (kind === 'click') { ping(o, t, 70, .3, .45, 'sine', 40); nz(o, t, .09, { type: 'lowpass', f: 900, f2: 200, g: .3 }); ping(o, t + .01, 520, .12, .08, 'triangle'); }
  else if (kind === 'save') [392, 523.25, 659.25].forEach((f, i) => ping(bus(.8), t + i * .09, f, 1.4, .13, 'sine'));
  else if (kind === 'whisper') { const VW = ['a', 'e', 'i', 'o', 'u'], w = bus(.9); for (let i = 0; i < 4; i++) vnote(w, t + .05 + i * .24, { f0: 150 - i * 4, f1: 140, dur: .3, v: .3, vow: [VW[rnd(5)], VW[rnd(5)]], voice: .2, breath: 1, att: .05 }); }
}
// every audio entry point is wrapped: if a browser rejects something, the game goes on (quieter) instead of freezing
for (const name of ['initAudio', 'audioFrame', 'audioPause', 'audioResume', 'musicTick', 'themeTick', 'setMusicMode', 'applyVol', 'vox', 'voice', 'growl', 'beep', 'stepSfx', 'sfxUi', 'sfxShot', 'sfxClick', 'sfxHit', 'sfxHurt', 'sfxDeath', 'sfxUnseal', 'sfxPickup', 'sfxNo', 'sfxChest', 'sfxGate', 'sfxPortal', 'sfxWarp', 'sfxScarePre', 'sfxScare']) {
  const fn = window[name]; if (typeof fn === 'function') window[name] = (...a) => { try { return fn(...a); } catch (e) { if (!window.__audioWarned) { window.__audioWarned = 1; console.warn('audio:', name, e); } } };
}
/* ---------- Touch controls: joystick, drag-to-look, buttons (shown only on phones and tablets) ---------- */
const joy = { x: 0, y: 0 }; let touchRun = false, touchFire = false;
(function touchUI() {
  const J = $('joy'), K = $('knob'), L = $('look'); let jid = null, lid = null, lx = 0, ly = 0;
  const jmove = e => {
    const r = J.getBoundingClientRect(), R = r.width / 2; let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R; const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    joy.x = Math.abs(x) < .12 ? 0 : x; joy.y = Math.abs(y) < .12 ? 0 : y; K.style.transform = `translate(${x * R * .6}px, ${y * R * .6}px)`;
  };
  J.addEventListener('pointerdown', e => { jid = e.pointerId; J.setPointerCapture(jid); jmove(e); });
  J.addEventListener('pointermove', e => { if (e.pointerId === jid) jmove(e); });
  for (const ev of ['pointerup', 'pointercancel']) J.addEventListener(ev, e => { if (e.pointerId === jid) { jid = null; joy.x = joy.y = 0; K.style.transform = ''; } });
  L.addEventListener('pointerdown', e => { lid = e.pointerId; L.setPointerCapture(lid); lx = e.clientX; ly = e.clientY; });
  L.addEventListener('pointermove', e => {
    if (e.pointerId !== lid || state !== 'play') return;
    player.yaw -= (e.clientX - lx) * .005; player.pitch = Math.max(-1.4, Math.min(1.4, player.pitch - (e.clientY - ly) * .005)); lx = e.clientX; ly = e.clientY;
  });
  for (const ev of ['pointerup', 'pointercancel']) L.addEventListener(ev, e => { if (e.pointerId === lid) lid = null; });
  const hold = (id, set) => { const b = $(id); b.addEventListener('pointerdown', e => { e.preventDefault(); set(true); }); for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => set(false)); };
  const tap = (id, fn) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); if (state === 'play') fn(); });
  hold('bFire', v => touchFire = v); hold('bRun', v => touchRun = v);
  tap('bUse', interact); tap('bLight', () => torchOn = !torchOn); tap('bMap', () => { mapBig = !mapBig; $('map').classList.toggle('big', mapBig); }); tap('bPause', pause);
})();

/* ---------- Boot ---------- */
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, .05); last = now;
  if (state === 'play') { clock += dt; update(dt); }
  faceStep(dt);                                                                      // jump-scare face (also plays over the game-over screen)
  if (!$('menu').hidden) { menuBg(dt); if (ac && audioLive && musicMode === 'menu') themeTick(ac.currentTime); } // the living title screen and its theme
  if (state === 'menu') return;                                                      // title screen: the menu paints everything, skip the 3D pass
  vmScene.visible = !!levelGroup;
  renderer.clear(); renderer.render(scene, camera);                                  // pass 1: the world
  if (vmScene.visible) { renderer.clearDepth(); renderer.render(vmScene, vmCam); }   // pass 2: hands and weapons, never clipped by walls
}
showMenu('Hollow Depths', 'Ten levels of the restless dead. Gather the shards, break each guardian, and find the way up.');
loop(performance.now());
