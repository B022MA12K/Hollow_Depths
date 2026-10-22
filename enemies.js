'use strict';
/* enemies.js: bestiary for Hollow Depths. Load AFTER game.js.
   Rebuilds the ten guardians from the concept art (and dresses every ordinary creature in the same models), plus the AI:
   smooth steering, patrol / see / chase / lose-sight / return, floating ? and ! icons, positional voices.
   Dev URL flags: ?level=N jumps to a level (New game), add &god=1 for immunity. */
(() => {
const T = THREE, ART_DIR = ''; // set ART_DIR = 'art/' if you move the concept images into a folder
const up = n => n >= 6 ? Math.min(48, Math.max(14, n * 2)) : n, upS = w => Math.min(40, Math.max(14, w * 2)), upH = h => Math.min(28, Math.max(10, h * 2)); // finer tessellation: round limbs and heads, spikes stay sharp
const Cyl2 = (a, b, l, n = 8, hs, open, ts, tl) => new T.CylinderGeometry(a, b, l, up(n), hs, open, ts, tl), Sph2 = (r, w = 12, h = 8, ...x) => new T.SphereGeometry(r, upS(w), upH(h), ...x);
const Cone2 = (r, h, n = 8, hs, open, ts, tl) => new T.ConeGeometry(r, h, up(n), hs, open, ts, tl), Tor2 = (r, tube, rs = 8, ts = 24, arc) => new T.TorusGeometry(r, tube, Math.max(8, rs), Math.min(64, ts * 2), arc);
const CylG = (a, b, l, n = 10) => Cyl2(a, b, l, n), SphG = (r, w = 12, h = 8) => Sph2(r, w, h), BoxG = (w, h, d) => new T.BoxGeometry(w, h, d);
let cur = [];
const reg = m => (m.userData.c = m.color.getHex(), cur.push(m), m); // registered materials flash red when shot
const skinPbr = pbr('#ffffff', g => { g.fillStyle = '#000'; for (let i = 0; i < 900; i++) g.fillRect(rnd(256), rnd(256), 1.2, 1.2); g.lineWidth = .8; for (let i = 0; i < 26; i++) { const x = rnd(256), y = rnd(256); g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + rnd(30) - 15, y + rnd(30) - 15, x + rnd(40) - 20, y + rnd(40) - 20); g.stroke(); } }, .64, SM, 0, { bevel: .6, str: 1.3, grain: .02 });
const sk = (c, o = {}) => reg(new T.MeshStandardMaterial({ color: c, roughness: o.roughness ?? 1, map: skinPbr.map, normalMap: skinPbr.normalMap, normalScale: new T.Vector2(.45, .45), ...(o.roughness === undefined ? { roughnessMap: skinPbr.roughnessMap } : {}), ...o })); // fine pores and creases on everything alive
const fab = c => { const m = robeMat.clone(); m.color.setHex(c); m.side = T.DoubleSide; return reg(m); };
const lit = (c, i = 2) => new T.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i });
const mk = (p, geo, mat, x = 0, y = 0, z = 0) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; p.add(m); return m; };
const grp = (p, x, y, z) => { const g = new T.Group(); g.position.set(x, y, z); p.add(g); return g; };
const glow = (p, c, s, x = 0, y = 0, z = 0, o = .7) => { const m = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: c, blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity: o })); m.scale.set(s, s, 1); m.position.set(x, y, z); p.add(m); return m; };
const eyes = (p, c, y, z, gap = .08, r = .03, gs = .6) => { const em = new T.MeshBasicMaterial({ color: c }); for (const s of [-1, 1]) mk(p, SphG(r, 6, 6), em, s * gap, y, z).castShadow = false; glow(p, c, gs, 0, y, z - .03, .6); };
const lantern = (p, x, y, z, s = 1) => { mk(p, BoxG(.14 * s, .2 * s, .14 * s), lit(0xffb050, 2.2), x, y, z); glow(p, 0xffa040, 1.3 * s, x, y, z, .8); };
const robe = (g, c, rt, rb, h, y = .85) => mk(g, Cyl2(rt, rb, h, 16, 1, true), c, 0, y, 0);
const hood = (P, c) => mk(P.head, Cone2(.3, .62, 12, 1, true), c, 0, .2, .03);
const veilOn = (P, m, o = .9) => { m.transparent = true; m.opacity = o; mk(P.head, Cone2(.36, .85, 14, 1, true), m, 0, -.08, 0); };
const beard = (P, c) => mk(P.head, Cone2(.12, .3, 8), c, 0, -.25, -.1).rotation.x = Math.PI;
const pick = (arm, head, tip) => { const h = grp(arm, 0, -.78, 0); mk(h, CylG(.035, .035, 1.5, 6), wood, 0, .35, 0); mk(h, BoxG(.95, .09, .12), head, 0, 1.1, 0); for (const s of [-1, 1]) mk(h, Cone2(.06, .4, 6), tip, s * .6, 1.1, 0).rotation.z = -s * Math.PI / 2; };

function human(g, o) { // biped rig: body > head, arms; legs on the root. Same joint names the game's animate() drives.
  const k = o.bulk || 1, body = grp(g, 0, .85, 0), head = grp(body, 0, 1, 0);
  mk(body, CylG(.3 * k, .38 * k, .75, 12).translate(0, .37, 0), o.torso); mk(head, SphG(.2 * (o.hs || 1), 14, 10), o.skin);
  const arm = s => { const a = grp(body, s * .4 * k, .68, 0); mk(a, CylG(.08 * k, .06 * k, .75, 8).translate(0, -.37, 0), o.arms || o.torso); mk(a, SphG(.085 * k, 8, 6), o.skin, 0, -.78, 0); return a; };
  const leg = s => { const l = grp(g, s * .17 * k, .85, 0); mk(l, CylG(.11 * k, .08 * k, .85, 8).translate(0, -.42, 0), o.legs || o.torso); mk(l, BoxG(.2 * k, .09, .34), o.legs || o.torso, 0, -.8, -.07); return l; };
  return { body, head, armL: arm(-1), armR: arm(1), legL: leg(-1), legR: leg(1) };
}
function quad(g, leg) { // four-legged rig for the hounds
  const body = grp(g, 0, .78, 0), head = grp(body, 0, .22, -.85), tail = grp(body, 0, .05, .7);
  const paw = (x, z) => { const l = grp(g, x, .72, z); mk(l, CylG(.07, .045, .72, 6).translate(0, -.36, 0), leg); for (const c of [-1, 0, 1]) mk(l, Cone2(.02, .12, 4), leg, c * .035, -.72, -.07).rotation.x = -1.9; return l; };
  return { body, head, tail, legL: paw(-.2, -.5), legR: paw(.2, -.5), armL: paw(-.2, .5), armR: paw(.2, .5) };
}

const DESIGN = [
function warden(g) { // Acolyte: hooded jailer, leather armour, key ring, lantern staff
  const lea = fab(0x4a3220), dk = fab(0x24231d), P = human(g, { torso: lea, legs: dk, skin: sk(0x7a6050), bulk: 1.1 });
  hood(P, dk); eyes(P.head, 0xff7a30, .02, -.18);
  for (const s of [-1, 1]) mk(P.body, SphG(.17, 10, 6), metal, s * .44, .74, 0);
  mk(P.body, Cyl2(.46, .66, 1.3, 14, 1, true, -1.4, 2.8), dk, 0, .15, .05);
  const ring = grp(P.body, -.4, .1, -.12); mk(ring, Tor2(.07, .012, 6, 12), gold);
  for (let k = 0; k < 4; k++) mk(ring, BoxG(.02, .15, .012), metal, (k - 1.5) * .03, -.11, 0);
  const st = grp(P.armR, 0, -.78, 0); mk(st, CylG(.03, .03, 1.7, 6), wood, 0, .5, -.1); mk(st, BoxG(.12, .05, .12), metal, 0, 1.35, -.1); lantern(st, 0, 1.5, -.1, 1.2);
  return { P, S: 1.35, fx: (e, dt, spd) => { ring.rotation.z = spd ? Math.sin(clock * 14) * .35 : 0; } };
},
function gravedigger(g) { // Digger: old sexton, apron, cap, grey beard, shovel, belt lantern
  const coat = fab(0x2f3a33), P = human(g, { torso: coat, legs: fab(0x2a2a22), skin: sk(0x9a7c68), bulk: 1.15 });
  mk(P.body, BoxG(.62, .85, .06), fab(0x6b6a45), 0, .22, -.4); mk(P.head, CylG(.23, .25, .07, 12), fab(0x2a2a26), 0, .2, -.02); beard(P, sk(0xb0aea2));
  mk(P.body, BoxG(.28, .3, .12), sk(0x6a5a3a), .42, 0, .1); mk(P.body, Tor2(.12, .035, 6, 12), sk(0x9a8a5a), -.4, .05, .1);
  lantern(grp(P.body, .42, -.12, -.2), 0, 0, 0, 1); eyes(P.head, 0xd0c8a0, .02, -.19, .07, .02, .4);
  const sh = grp(P.armR, 0, -.78, 0); mk(sh, CylG(.03, .03, 1.7, 6), wood, 0, .45, 0); mk(sh, Tor2(.08, .02, 6, 10), wood, 0, 1.3, 0); mk(sh, BoxG(.3, .42, .03), metal, 0, -.4, 0);
  return { P, S: 1.4 };
},
function boneChoir(g) { // Hound: charcoal skeleton hung with bone bells, green-lit skull, flute tail
  const bn = sk(0x3b3733, { roughness: .45 }), P = quad(g, bn), pale = sk(0x8c8b78, { roughness: .4, emissive: 0x0a2a14 });
  mk(P.body, SphG(.26).scale(.8, .7, 1.9), sk(0x3a1020), 0, -.02, 0);
  for (let i = 0; i < 6; i++) mk(P.body, Tor2(.3 * Math.sin(.4 + i * .42), .02, 5, 12), bn, 0, 0, -.5 + i * .2);
  for (let i = 0; i < 9; i++) mk(P.body, BoxG(.07, .07, .1), bn, 0, .27, -.75 + i * .19);
  mk(P.head, SphG(.2).scale(.9, .8, 1.5), pale, 0, 0, -.1); mk(P.head, BoxG(.16, .05, .3), pale, 0, -.13, -.25);
  for (let k = -2; k <= 2; k++) mk(P.head, Cone2(.015, .07, 4), pale, k * .035, -.09, -.34).rotation.x = Math.PI;
  eyes(P.head, 0x40ff80, .05, -.34, .07, .035, .9); const br = glow(P.head, 0x40ff80, 1.1, 0, -.05, -.5, .5);
  const rack = grp(P.body, 0, .42, 0), bells = []; mk(rack, CylG(.012, .012, .9, 5).rotateZ(Math.PI / 2), pale);
  for (let k = 0; k < 4; k++) { const b = grp(rack, (k - 1.5) * .26, 0, 0); mk(b, Cone2(.05, .11, 8, 1, true), gold, 0, -.08, 0); bells.push(b); }
  mk(P.tail, Cone2(.035, .8, 5).rotateX(Math.PI / 2), bn, 0, 0, .4); mk(P.tail, CylG(.025, .025, .35, 6).rotateX(Math.PI / 2), pale, 0, .02, .95);
  return { P, S: 1.7, fx: (e, dt, spd) => { bells.forEach((b, i) => b.rotation.z = Math.sin(clock * (4 + spd * 2) + i) * (.25 + spd * .12)); br.material.opacity = .35 + Math.sin(clock * 6) * .2; } };
},
function hollowMother(g) { // Veiled: crowned widow in a drowned-green shroud, caged lantern staff, swaddled bundle
  const rb = fab(0x3a3f38), P = human(g, { torso: rb, skin: fab(0x15171a), hs: 1.05 });
  robe(g, rb, .38, .85, 1.75); veilOn(P, fab(0x15171a));
  for (let i = 0; i < 7; i++) { const a = i * .8976; mk(P.head, Cone2(.022, .34, 4), wood, Math.cos(a) * .17, .27, Math.sin(a) * .17).rotation.set(Math.sin(a) * .5, 0, -Math.cos(a) * .5); }
  mk(P.head, Tor2(.19, .02, 6, 14).rotateX(Math.PI / 2), gold, 0, .2, 0);
  mk(P.body, SphG(.17).scale(.9, .8, 1.7), fab(0x4d4c46), 0, .28, -.42); mk(P.body, new T.OctahedronGeometry(.07), metal, 0, .55, -.36);
  const st = grp(P.armL, 0, -.78, 0); mk(st, CylG(.03, .03, 1.7, 6), wood, 0, .5, 0); mk(st, new T.OctahedronGeometry(.14), lit(0x40ff80, 2), 0, 1.5, 0);
  const gl = glow(st, 0x40ff80, 2, 0, 1.5, 0, .8), rags = [];
  for (let i = 0; i < 10; i++) { const a = i * .628, r = grp(g, Math.cos(a) * .8, .75, Math.sin(a) * .8); r.rotation.y = -a; mk(r, BoxG(.1, .6, .01), rb, 0, -.3, 0); rags.push(r); }
  return { P, S: 1.4, fx: () => { gl.material.opacity = .6 + Math.sin(clock * 5) * .2; rags.forEach((r, i) => r.rotation.x = Math.sin(clock * 2 + i) * .12); } };
},
function cinderKing(g) { // Digger: furnace-scarred hooded miner, cracked ember skin, glowing pick, drifting embers
  const ch = fab(0x1d1a18), fl = sk(0x2a1a14, { emissive: 0xff4a00, emissiveIntensity: .6 }), P = human(g, { torso: ch, skin: fl, bulk: 1.3, hs: 1.05 });
  hood(P, ch); eyes(P.head, 0xffa030, .02, -.2, .08, .035, .9); mk(P.body, BoxG(.62, .8, .05), fab(0x3a2a20), 0, .05, -.5);
  for (let i = 0; i < 7; i++) mk(P.body, BoxG(.025, .14 + rnd(10) / 60, .02), lit(0xff6a10, 2.5), (rnd(100) - 50) / 180, .1 + rnd(60) / 100, -.42);
  pick(P.armR, metal, lit(0xff5a10, 1.6)); glow(P.body, 0xff5a10, 2.4, 0, .45, -.3, .35);
  const em = new T.Points(new T.BufferGeometry().setAttribute('position', new T.BufferAttribute(new Float32Array(90).map(() => (Math.random() - .5) * 1.6), 3)), new T.PointsMaterial({ size: .08, map: glowTex, transparent: true, color: 0xff7a20, blending: T.AdditiveBlending, depthWrite: false }));
  em.frustumCulled = false; g.add(em);
  return { P, S: 1.55, fx: (e, dt) => { const a = em.geometry.attributes.position; for (let i = 1; i < 90; i += 3) { a.array[i] += dt * .9; if (a.array[i] > 2.4) a.array[i] = .2; } a.needsUpdate = true; fl.emissiveIntensity = .5 + Math.sin(clock * 3) * .25; } };
},
function weeper(g) { // Veiled: gaunt mourner in layered black lace, tear-dripping veil, locket
  const lace = fab(0x17181b), mid = fab(0x25272c), P = human(g, { torso: lace, skin: fab(0x0b0b0d), bulk: .9, hs: .95 });
  for (let i = 0; i < 4; i++) robe(g, i % 2 ? lace : mid, .33 + i * .03, .5 + i * .13, 1.55 - i * .22, .8 - i * .06);
  veilOn(P, fab(0x0b0b0d), .88); mk(P.body, SphG(.05, 8, 6).scale(1, 1.5, .4), metal, 0, .5, -.31); eyes(P.head, 0xbfe4ff, .02, -.2, .07, .02, .5);
  const tears = []; for (let i = 0; i < 8; i++) tears.push(glow(g, 0xaadcff, .18, (Math.random() - .5) * .5, 1.5, -.3 + (Math.random() - .5) * .3, .8));
  return { P, S: 1.4, fx: (e, dt) => tears.forEach((t, i) => { t.position.y -= dt * (.6 + i * .05); if (t.position.y < .1) t.position.y = 1.55; }) };
},
function archivist(g) { // Acolyte: bearded scholar in a rune-hemmed robe, floating glowing tome, lantern
  const rb = fab(0x2c2a28), P = human(g, { torso: rb, skin: sk(0xb08a70), bulk: 1.05 });
  robe(g, rb, .4, .62, 1.2, .6); for (const s of [-1, 1]) mk(g, BoxG(.06, 1.1, .02), gold, s * .13, .6, -.6);
  mk(P.body, Tor2(.33, .09, 8, 14).rotateX(Math.PI / 2), gold, 0, .74, 0);
  mk(P.head, SphG(.21, 12, 8).scale(1, .7, 1), sk(0x77776f), 0, .08, .04); beard(P, sk(0x9a9a92)); eyes(P.head, 0x70ffa0, .02, -.19, .07, .02, .5);
  lantern(grp(P.armR, 0, -.95, -.05), 0, 0, 0, 1.3);
  const tome = grp(g, 0, 1.35, -.8); mk(tome, BoxG(.5, .05, .38), wood, 0, -.03, 0); mk(tome, BoxG(.46, .03, .34), lit(0xb8f0c0, 1.2), 0, .01, 0); glow(tome, 0x50ff90, 1.8, 0, .2, 0, .7); tome.rotation.x = -.5;
  return { P, S: 1.3, fx: (e, dt) => { tome.position.y = 1.35 + Math.sin(clock * 2) * .06; tome.rotation.y += dt * .7; } };
},
function understair(g) { // Hound: horned skeletal ambusher; fades out in the dark, only its eyes give it away
  const bn = sk(0x2b1c1a, { roughness: .4 }), rib = sk(0x5a4a40, { roughness: .4 }), P = quad(g, bn);
  mk(P.body, SphG(.3).scale(.85, .7, 1.8), sk(0x240f12), 0, -.02, 0);
  for (let i = 0; i < 6; i++) mk(P.body, Tor2(.3 * Math.sin(.4 + i * .42), .022, 5, 12), rib, 0, 0, -.5 + i * .2);
  for (let i = 0; i < 8; i++) mk(P.body, Cone2(.045, .26 - Math.abs(i - 3) * .02, 5), rib, 0, .34, -.7 + i * .2);
  mk(P.head, SphG(.2).scale(.9, .8, 1.5), rib, 0, 0, -.1); mk(P.head, BoxG(.16, .05, .3), rib, 0, -.13, -.25);
  for (const s of [-1, 1]) mk(P.head, Cone2(.05, .42, 6), bn, s * .13, .24, 0).rotation.z = -s * .6;
  mk(P.tail, Cone2(.04, .9, 5).rotateX(Math.PI / 2), bn, 0, 0, .45); eyes(P.head, 0xff1010, .06, -.34, .08, .045, 1);
  return { P, S: 1.8, fx: (e, dt, spd, chase) => { const pd = Math.hypot(player.x - e.x, player.z - e.z); e.vis = (e.vis ?? 1) + ((chase || pd < 6 ? 1 : 0) - (e.vis ?? 1)) * Math.min(1, dt * 3); for (const m of e.mats) { m.transparent = true; m.opacity = .04 + .96 * e.vis; } } };
},
function heartEater(g) { // Digger: scarred bare-chested miner, blood-tipped pick; heals on hit, speeds up as it bleeds
  const fl = sk(0x7a5a48), blood = sk(0x5a0a0c), dk = sk(0x1c1612), P = human(g, { torso: fl, legs: fab(0x4a4430), skin: fl, bulk: 1.35 });
  for (const [x, y] of [[-.15, .5], [.12, .3], [.2, .6], [-.2, .2]]) mk(P.body, SphG(.1, 8, 6).scale(1, 1, .3), blood, x, y, -.38);
  mk(P.body, BoxG(.56, .7, .05), fab(0x3a3028), 0, .05, -.46); beard(P, dk); mk(P.head, SphG(.21, 10, 6).scale(1, .6, 1), dk, 0, .1, .05);
  eyes(P.head, 0xff3a20, .03, -.19, .07, .025, .5); pick(P.armR, metal, blood); lantern(grp(P.body, .5, -.1, -.2), 0, 0, 0, 1);
  const hg = glow(P.body, 0xff1020, 1.3, 0, .45, -.45, .6);
  return { P, S: 1.5, fx: () => hg.scale.setScalar(1.1 + Math.abs(Math.sin(clock * 4)) * .5) };
},
function lastDoor(g) { // Veiled: the final guardian drags the carved door behind it
  const sh = fab(0x1a1a1d), P = human(g, { torso: sh, skin: fab(0x050505), bulk: 1.1, hs: 1.05 });
  robe(g, sh, .4, .9, 1.75); veilOn(P, fab(0x2a2b30)); eyes(P.head, 0xffd8a0, .02, -.2, .07, .02, .5);
  const door = grp(g, 0, 0, 1.2), dw = sk(0x2a1d14, { roughness: .9 });
  mk(door, BoxG(1.6, 1.4, .16), dw, 0, .7, 0); mk(door, CylG(.8, .8, .16, 18).rotateX(Math.PI / 2), dw, 0, 1.4, 0);
  for (const y of [.35, 1]) mk(door, BoxG(1.64, .07, .19), metal, 0, y, 0);
  const seam = mk(door, BoxG(.04, 2.1, .18), lit(0xffc890, 2), 0, 1.05, 0), halo = glow(door, 0xffd0a0, 4, 0, 1.1, .2, .4);
  return { P, S: 1.3, fx: () => { seam.material.emissiveIntensity = 1.5 + Math.sin(clock * 3); halo.material.opacity = .3 + Math.sin(clock * 3) * .12; } };
}];

/* ---------- Voice lines (intro when it first sees you, last words) and concept-art cards ---------- */
const LORE = [['No one leaves my cells.', 'Take the keys. Take them all.'], ['Room enough for one more.', 'At last. A bed of my own.'],
  ['Sing with us.', 'The song goes quiet.'], ['Hush. The little one sleeps.', 'Wake him. Please. Wake him.'],
  ['Kneel before the furnace.', 'The fire remembers me.'], ['Why did you leave me?', 'Now I can rest.'],
  ['You are not written here.', 'Your page is blank.'], ['Hungry.', 'Down. Go down.'],
  ['Still warm. Still beating.', 'My own heart is cold.'], ['Every door ends here.', 'Open. At last.']];
const ART = ['The_Warden__Acolyte', 'Gravedigger__Digger', 'Bone_Choir__Hound', 'The_Hollow_Mother__Veiled', 'Cinder_King__Digger', 'The_Weeper__Veiled',
  'The_Archivist__Acolyte', 'Understair_Thing__Hound', 'Heart-Eater__Digger', 'The_Last_Door__Veiled'].map(n => ART_DIR + n + '_base_type_.jpg');
const card = document.createElement('div'); card.id = 'bcard'; card.innerHTML = '<img alt=""><b></b>'; document.body.appendChild(card);
let cardT;
function introCard(bi) {
  const im = card.firstChild; im.hidden = false; im.onerror = () => im.hidden = true; im.src = ART[bi];
  card.lastChild.textContent = BOSSES[bi][0]; card.style.opacity = 1; clearTimeout(cardT); cardT = setTimeout(() => card.style.opacity = 0, 3600);
}

/* ---------- Projectiles, pull, blink, summons ---------- */
const shots = [];
function fire(e, off, col, spd, dmg, o = {}) {
  const m = new T.Mesh(SphG(.16, 8, 6), new T.MeshBasicMaterial({ color: col })); glow(m, col, 1.2, 0, 0, 0, .8);
  m.position.set(e.x, 1.5, e.z); levelGroup.add(m);
  shots.push({ m, a: Math.atan2(player.x - e.x, player.z - e.z) + off, spd, dmg: e.boss ? Math.round(dmg * 2.4) : dmg, t: 6, ...o });
}
function tickShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i], p = s.m.position;
    if (s.home) { let d = Math.atan2(player.x - p.x, player.z - p.z) - s.a; d = Math.atan2(Math.sin(d), Math.cos(d)); s.a += Math.max(-s.home * dt, Math.min(s.home * dt, d)); }
    p.x += Math.sin(s.a) * s.spd * dt; p.z += Math.cos(s.a) * s.spd * dt; s.t -= dt;
    if (Math.hypot(player.x - p.x, player.z - p.z) < .7) { s.t = 0; damage(s.dmg); if (s.blind) blackout = Math.max(blackout, s.blind); }
    else if (hit(p.x, p.z, .12)) s.t = 0;
    if (s.t <= 0 || s.m.parent !== levelGroup) { s.m.parent && s.m.parent.remove(s.m); shots.splice(i, 1); }
  }
}
function pull(e, d) {
  const pd = Math.hypot(e.x - player.x, e.z - player.z) || 1, nx = player.x + (e.x - player.x) / pd * d, nz = player.z + (e.z - player.z) / pd * d;
  if (pd > 1.6 && !hit(nx, player.z, .35)) player.x = nx; if (pd > 1.6 && !hit(player.x, nz, .35)) player.z = nz;
}
function spawnNear(e, ti, n) {
  const ci = Math.round(e.x / CELL), cj = Math.round(e.z / CELL), cells = DIRS.map(([a, b]) => [ci + a, cj + b]).filter(([i, j]) => grid[j] && grid[j][i] === 0);
  for (let k = 0; k < n; k++) addEnemy(ti, cells[k % cells.length] || [ci, cj], -1);
}
function blink(e) { // reappear a few cells from the player, out of sight
  const ci = Math.round(player.x / CELL), cj = Math.round(player.z / CELL), opts = [];
  for (let j = cj - 3; j <= cj + 3; j++) for (let i = ci - 3; i <= ci + 3; i++) if (grid[j] && grid[j][i] === 0 && Math.hypot(i - ci, j - cj) >= 2) opts.push([i, j]);
  const c = opts[rnd(opts.length)]; if (!c) return;
  e.x = e.tx = c[0] * CELL; e.z = e.tz = c[1] * CELL; e.pi = c[0]; e.pj = c[1]; growl(60, .6, .3);
}

/* ---------- Signature abilities, one per guardian ---------- */
const BRAIN = [
  (e, dt, pd) => { // Warden: chain lash hauls you into reach, keys jingle with each stride
    if (e.pull > 0) { e.pull -= dt; pull(e, 6.5 * dt); shake = Math.max(shake, .3); }
    else if (e.saw && pd > 5 && pd < 13 && e.ab <= 0) { e.ab = 7; e.pull = .7; e.atk = .5; say('The Warden hauls you in by the chain!', 1600); beep(900, .3, 'sawtooth', .15); }
    if (e.fs * (e.kf || 1) < 0 && pd < 14) beep(2600 + rnd(500), .05, 'triangle', .05 * (1 - pd / 14)); e.kf = e.fs || e.kf;
  },
  (e, dt, pd) => { if (e.saw && pd > 4 && pd < 13 && e.ab <= 0) { e.ab = 5.5; e.atk = .45; fire(e, 0, 0x6a5030, 7, 10, { blind: .9 }); say('Grave dirt in your eyes!', 1200); } }, // Gravedigger
  (e, dt, pd) => { // Bone Choir: bell toll blacks out the lights and alerts everything; the pack answers at half health
    if (e.saw && e.ab <= 0) { e.ab = 11; blackout = Math.max(blackout, .8); shake = Math.max(shake, .5); alertAll(e, 99); for (let k = 0; k < 4; k++) beep(1500 + k * 180, .5, 'triangle', .1); say('The bells toll. Everything hears.', 1800); }
    if (!e.sum && e.hp < e.max / 2) { e.sum = 1; spawnNear(e, 1, 2); say('The choir answers.', 2000); }
  },
  (e, dt, pd) => { if (e.saw && pd < 11) { player.slow = .55; if (e.ab <= 0) { e.ab = 9; voice('Hush. Hush now.', .2); } } }, // Hollow Mother: lullaby drags at your legs
  (e, dt, pd) => { if (e.saw && pd > 3 && pd < 14 && e.ab <= 0) { const n = e.rage ? 3 : 1; e.ab = e.rage ? 3 : 4.5; e.atk = .45; for (let k = 0; k < n; k++) fire(e, (k - (n - 1) / 2) * .25, 0xff6a10, 6, 12); growl(120, .3, .25); } }, // Cinder King: molten slag
  (e, dt, pd) => { if (e.saw && pd < 14 && e.ab <= 0) { e.ab = 9; voice('Why did you leave me?', .15); blackout = Math.max(blackout, 1.1); shake = 1; growl(200, 1.2, .3); if (pd < 8) damage(26); } }, // Weeper: wail
  (e, dt, pd) => { if (e.saw && pd > 3 && pd < 15 && e.ab <= 0) { const n = e.rage ? 5 : 3; e.ab = e.rage ? 3.5 : 5; e.atk = .45; for (let k = 0; k < n; k++) fire(e, (k - (n - 1) / 2) * .3, 0x50ff90, 5.2, 8, { home: 1.2 }); } }, // Archivist: homing glyphs
  (e, dt, pd) => { if (e.saw && pd > 2 && pd < 8 && e.pc <= 0) { e.pc = 2.5; e.lunge = .6; growl(160, .4, .35); } }, // Understair Thing: long ambush lunge
  (e, dt, pd) => { // Heart-Eater: heals when it lands a hit, faster the more it bleeds, audible heartbeat
    e.sp0 = e.sp0 || e.speed; e.speed = e.sp0 * (e.rage ? 1.35 : 1) * (1 + (1 - e.hp / e.max) * .6);
    if (e._w > 0 && e.wind <= 0 && pd < 2.4) { e.hp = Math.min(e.max, e.hp + e.max * .06); say('It feeds.', 900); }
    e._w = e.wind;
    if (pd < 10 && (e.hb = (e.hb || 0) - dt) < 0) { e.hb = .9 - (1 - e.hp / e.max) * .4; beep(48, .18, 'sine', .3 * (1 - pd / 10)); }
  },
  (e, dt, pd) => { // Last Door: blinks while unwatched, opens at half health, wails when enraged
    const look = ((e.x - player.x) * fw.x + (e.z - player.z) * fw.z) / (pd || 1) > .55;
    if (!look && pd > 7 && e.ab <= 0) { blink(e); e.ab = 8; say('The door opens behind you.', 1600); }
    if (!e.sum && e.hp < e.max / 2) { e.sum = 1; spawnNear(e, 3, 2); blackout = 1.5; voice('Come through.', .05); say('Something steps out of the door.', 2500); }
    if (e.rage && pd < 9 && (e.wl = (e.wl || 6) - dt) <= 0) { e.wl = 10; blackout = Math.max(blackout, 1); shake = .8; damage(22); }
  }];

/* ---------- Enemy AI ----------
   PATROL (roam between destinations) -> hears you: INVESTIGATE the noise / sees you for a moment: CHASE
   -> loses sight: SEARCH (last seen spot, then looks around) -> RETURN home -> PATROL.
   Only eyes start a chase; ears only send them to look. They track you by sight, never through walls. */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), cellOf = v => Math.round(v / CELL);
const SPEED = { patrol: .38, investigate: .62, search: .7, return: .7, chase: 1 }; // share of top speed in each state
const ICONS = new URLSearchParams(location.search).get('icons') !== '0'; // add ?icons=0 to hide the "?" and "!" over their heads
const MARK = {};
for (const [ch, col] of [['!', '#e03a2a'], ['?', '#e0b040']]) { // what a creature is doing, readable at a glance: ? = looking for you, ! = hunting you
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.font = 'bold 54px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(ch, 32, 34); g.fillStyle = col; g.fillText(ch, 32, 34);
  MARK[ch] = new T.CanvasTexture(c);
}
let px = 0, pz = 0;
function setState(e, st, ti, tj) { e.st = st; e.stT = 0; e.rest = 0; e.idle = 0; if (ti !== undefined) { e.nav = bfs(ti, tj).d; e.tx = e.x; e.tz = e.z; } }
function alertAll(from, r) { for (const o of enemies) if (o !== from && o.st !== 'chase' && Math.hypot(o.x - from.x, o.z - from.z) < r) setState(o, 'investigate', cellOf(player.x), cellOf(player.z)); }
function roam(e) { // next destination: 4-14 steps away (2-5 for bosses, which guard their chamber), inside the roaming range
  const { d, q } = bfs(cellOf(e.x), cellOf(e.z)), lo = e.boss ? 2 : 4, hi = e.boss ? 5 : 14, lim = e.boss ? 5 : 12;
  const c = q.filter(([i, j]) => d[j][i] >= lo && d[j][i] <= hi && Math.abs(i - e.home[0]) + Math.abs(j - e.home[1]) <= lim), g = c.length ? c[rnd(c.length)] : e.home;
  e.nav = bfs(g[0], g[1]).d;
}
function nextWP(e) { // at a cell centre: step to the neighbour closest to the goal; false when there (or cut off)
  const ci = cellOf(e.x), cj = cellOf(e.z), n = e.nav; if (!n || !n[cj] || !(n[cj][ci] > 0)) return false;
  let best = null; for (const [a, b] of DIRS) { const i = ci + a, j = cj + b; if (n[j] && grid[j][i] === 0 && n[j][i] >= 0 && n[j][i] < n[cj][ci] && (!best || n[j][i] < n[best[1]][best[0]])) best = [i, j]; }
  if (!best) return false;
  e.tx = best[0] * CELL - (best[1] - cj) * e.lane; e.tz = best[1] * CELL + (best[0] - ci) * e.lane; return true;
}
function arrive(e) { // reached the goal of the current state
  if (e.st === 'patrol') { if (e.rest) { e.rest = 0; roam(e); } else { e.rest = 1; e.idle = 1 + Math.random() * 3; } } // pause, look about, then pick a new destination
  else if (e.st === 'investigate' || e.st === 'chase') setState(e, 'search', cellOf(e.x), cellOf(e.z));
  else if (e.st === 'search') { if (!e.rest) { e.rest = 1; e.idle = 3 + Math.random() * 3; } else if (Math.abs(cellOf(e.x) - e.home[0]) + Math.abs(cellOf(e.z) - e.home[1]) <= (e.boss ? 5 : 12)) { setState(e, 'patrol'); roam(e); } else setState(e, 'return', e.home[0], e.home[1]); } // scan, give up, resume roaming (walk home first if it strayed far)
  else if (e.st === 'return') { setState(e, 'patrol'); roam(e); }
}
const bossHit = (e, t) => Math.min(95, Math.round((38 + level * 5) * (e.rage ? 1.2 : 1) * (.8 + t.dmg / 60))); // 43 at level 1 up to 95
function knock(e, d) { const dx = player.x - e.x, dz = player.z - e.z, l = Math.hypot(dx, dz) || 1; for (let s = d; s > 0; s -= .3) { const nx = player.x + dx / l * s, nz = player.z + dz / l * s; if (!hit(nx, nz, .4)) { player.x = nx; player.z = nz; break; } } } // thrown back, never into a wall
function think(e, dt) {
  const t = TYPES[e.ti], pd = Math.hypot(player.x - e.x, player.z - e.z), range = torchOn ? 16 : 8, rot = e.g.rotation.y, fx = -Math.sin(rot), fz = -Math.cos(rot);
  const sees = pd < range && (pd < 2.5 || t.smell || ((player.x - e.x) * fx + (player.z - e.z) * fz) / (pd || 1) > .3) && los(e.x, e.z, player.x, player.z);
  const near = dist[cellOf(e.z)] && dist[cellOf(e.z)][cellOf(e.x)], heard = near >= 0 && near < noise;
  e.stT += dt; e.pc -= dt; e.lunge -= dt; e.stun -= dt; if (e.idle > 0) e.idle -= dt;
  e.aw = sees ? Math.min(1, e.aw + dt * (2.4 - pd / range * 1.4)) : Math.max(0, e.aw - dt * .35); // awareness: fills faster the closer you are
  if (e.boss && !e.rage && e.hp < e.max / 2) { e.rage = 1; e.speed *= 1.35; voice('You cannot kill me.', .05); vox('roar', e); say(BOSSES[level - 1][0] + ' is enraged!', 2000); }
  // ---- perception and state changes: PATROL -> (sees you) CHASE -> (loses you) SEARCH -> RETURN -> PATROL ----
  if (e.st !== 'chase') {
    if (sees && e.aw >= 1) { if (pd < 28) vox('alert', e); if (pd < 8) { shake = Math.max(shake, .6); hurt = Math.max(hurt, .12); } alertAll(e, 14); setState(e, 'chase'); e.lost = 0; e.last = [player.x, player.z]; }
    else if (heard && !sees && (e.st === 'patrol' || e.st === 'return' || e.stT > 1)) setState(e, 'investigate', cellOf(player.x), cellOf(player.z));
  } else if (sees) { e.lost = 0; e.last = [player.x, player.z]; }
  else if ((e.lost += dt) > .8) setState(e, 'search', cellOf(e.last[0]), cellOf(e.last[1])); // broke line of sight: go to where it last saw you
  const chase = e.st === 'chase', direct = chase && sees, run = Math.min(e.speed * 1.4, 6), reach = (t.low ? 1.2 : 1.1) * (e.boss ? 1.5 : 1);
  const looked = t.stalk && ((e.x - player.x) * fw.x + (e.z - player.z) * fw.z) / (pd || 1) > .55, noticing = !chase && sees && e.aw > 0;
  // ---- where to go ----
  let want = run * SPEED[e.st] * (e.lunge > 0 ? 2.2 : 1), gx = e.tx, gz = e.tz;
  const frozen = e.stun > 0 || e.wind > 0 || (looked && e.st !== 'patrol');
  if (direct) { gx = player.x; gz = player.z; e.tx = e.x; e.tz = e.z; if (pd < reach * .7) want = 0; }
  else {
    if (chase) e.nav = dist;
    if (!(e.idle > 0) && Math.hypot(e.tx - e.x, e.tz - e.z) < (chase ? 1.2 : .9)) { if (!nextWP(e)) arrive(e); gx = e.tx; gz = e.tz; } // switch waypoint early so corners are cut in a curve
  }
  if (e.idle > 0 || frozen || noticing) want = 0; // stands and stares while it works out what it saw
  // ---- steering: the heading turns at a limited rate and speed eases in and out, so routes curve instead of snapping ----
  let ax = gx - e.x, az = gz - e.z; if (noticing || direct) { ax = player.x - e.x; az = player.z - e.z; }
  let da = 0;
  if (!looked && (Math.abs(ax) > .01 || Math.abs(az) > .01)) {
    const goal = Math.atan2(-ax, -az); da = Math.atan2(Math.sin(goal - rot), Math.cos(goal - rot));
    const rate = (direct ? 7.5 : chase ? 6 : noticing ? 4 : 3.6) * (t.low ? 1.4 : 1) * (e.boss ? .8 : 1);
    e.g.rotation.y += clamp(da, -rate * dt, rate * dt);
  }
  if (want > 0) want *= .2 + .8 * Math.max(0, Math.cos(Math.min(Math.abs(da), 1.5))); // slow through sharp turns instead of skating sideways
  if (looked) e.v = 0; // the Veiled stop dead the instant you look at them, on purpose
  else e.v += (want - e.v) * (1 - Math.exp(-(want > e.v ? 4.5 : frozen ? 16 : 9) * dt));
  const ox = e.x, oz = e.z, h = e.g.rotation.y, step = e.v * dt;
  if (step > 0) { const nx = e.x - Math.sin(h) * step, nz = e.z - Math.cos(h) * step; if (!hit(nx, e.z, .4)) e.x = nx; if (!hit(e.x, nz, .4)) e.z = nz; }
  e.stuck = want > .4 && e.v > .2 && Math.hypot(e.x - ox, e.z - oz) < e.v * dt * .2 ? e.stuck + dt : 0; // wedged on a corner: snap back to the cell centre
  if (e.stuck > 1) { e.stuck = 0; e.lane = 0; e.v = 0; e.tx = cellOf(e.x) * CELL; e.tz = cellOf(e.z) * CELL; }
  // ---- attack ----
  if (e.wind > 0) { if ((e.wind -= dt) <= 0 && pd < reach + .5) { damage(e.boss ? bossHit(e, t) : t.dmg); if (e.boss) { shake = 1; hurt = Math.max(hurt, .7); knock(e, 1.7); } } } // a guardian's blow takes half your health or more
  else if (chase && (e.cd -= dt) < 0 && pd < reach && e.stun <= 0) { e.cd = 1.2; e.wind = t.low ? .2 : .4; e.atk = .45; vox('attack', e); }
  if (chase && t.pounce && sees && pd < 4.5 && pd > 1.5 && e.pc <= 0 && e.wind <= 0) { e.pc = 3; e.lunge = .45; vox('attack', e, .8); }
  for (const o of enemies) if (o !== e) { const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz); if (d > 0 && d < 1.5) { const k = (1.5 - d) * dt * 3 / d, nx = e.x + dx * k, nz = e.z + dz * k; if (!hit(nx, e.z, .45)) e.x = nx; if (!hit(e.x, nz, .45)) e.z = nz; } } // personal space: no stacking
  e.g.position.x = e.x; e.g.position.z = e.z; e.saw = sees && chase; // (y belongs to the gait animation)
  e.g.visible = pd < 34; // beyond ~34 m the fog hides them anyway: skip their draw calls
  const fl = (e.flash -= dt) > 0; e.skin.color.setHex(fl ? 0xff5050 : 0xffffff); if (e.mats) for (const m of e.mats) m.color.setHex(fl ? 0xff5050 : m.userData.c);
  // ---- readable state: floating ? / ! and the odd mutter ----
  if (e.mark) {
    const ch = chase ? '!' : (e.st === 'investigate' || e.st === 'search' || noticing) ? '?' : '', m = e.mark.material;
    if (ch && e.mk !== ch) { e.mk = ch; m.map = MARK[ch]; m.needsUpdate = true; }
    m.opacity += ((ICONS && ch && pd < 22 ? .95 : 0) - m.opacity) * Math.min(1, dt * 8); e.mark.visible = m.opacity > .02; e.mark.position.y = (t.low ? 1.75 : 2.75) + Math.sin(clock * 5) * .04;
  }
  if ((e.vt -= dt) <= 0) { e.vt = 6 + Math.random() * 10; if (!chase && !noticing && pd < 24) vox('idle', e); }
  animate(e, dt, e.v, chase, looked);
  return pd;
}
function abilities(e, dt, pd) {
  e.ab -= dt;
  if (e.st === 'chase' && !e.intro) { e.intro = 1; introCard(e.bi); voice(LORE[e.bi][0], .05); vox('roar', e); }
  BRAIN[e.bi](e, dt, pd);
  for (const m of e.mats) m.color.setHex(e.flash > 0 ? 0xff5050 : m.userData.c);
}
window.makeApparition = di => { cur = []; const g = new T.Group(), d = DESIGN[di](g); cur = []; return { g, P: d.P, S: d.S }; }; // a creature model for the jump-scare rush
const MINION = [[0, 6], [2, 7], [1, 4, 8], [3, 5, 9]], MINION_SCALE = .72; // concept-art designs that fit each base type; ordinary creatures wear them smaller
const pickMinion = ti => { const o = MINION[ti].filter(i => i !== level - 1); return (o.length ? o : MINION[ti])[rnd((o.length ? o : MINION[ti]).length)]; };
function dress(e) { // swap the generic body for a concept-art model (every creature, not only bosses); hitbox follows the new scale
  cur = e.mats = []; while (e.g.children.length) { const c = e.g.children[0]; e.g.remove(c); c.geometry && c.geometry.dispose(); }
  const d = DESIGN[e.bi >= 0 ? e.bi : pickMinion(e.ti)](e.g), low = TYPES[e.ti].low, S = d.S * (e.boss ? 1 : MINION_SCALE);
  e.P = d.P; e.fx = d.fx; e.g.scale.setScalar(S); e.sy = S * (low ? .6 : 1); e.r = Math.max(e.boss ? .65 : .7, .55 * S * (low ? .8 : 1) + .1); e.ab = 3 + Math.random() * 2;
  const mark = new T.Sprite(new T.SpriteMaterial({ map: MARK['!'], transparent: true, opacity: 0, depthWrite: false })); mark.scale.set(.5, .5, 1); mark.position.set(0, low ? 1.75 : 2.75, 0); mark.renderOrder = 5; mark.visible = false; e.g.add(mark); e.mark = mark;
}
const _add = addEnemy, _anim = animate, _kill = killEnemy, _dmg = damage;
window.addEnemy = (ti, c, bi, hpNow) => {
  const n = enemies.length; _add(ti, c, bi, hpNow); if (enemies.length === n) return;
  const e = enemies[enemies.length - 1]; dress(e);
  Object.assign(e, { st: 'patrol', stT: 0, aw: 0, lost: 0, rest: 0, stuck: 0, v: 0, vt: 3 + Math.random() * 8, idle: Math.random() * 3, last: [e.x, e.z] }); roam(e);
};
window.animate = (e, dt, spd, chase, seen) => { _anim(e, dt, spd, chase, seen); e.fx && e.fx(e, dt, spd, chase, seen); };
window.damage = n => { if (state === 'play') _dmg(n); };
window.updateEnemies = dt => {
  if ((pathTimer -= dt) < 0) { pathTimer = .4; dist = bfs(cellOf(player.x), cellOf(player.z)).d; }
  const mv = Math.hypot(player.x - px, player.z - pz) > .002; px = player.x; pz = player.z;
  noise = clock - lastShot < 1.5 ? 10 : player.sprint ? 6 : mv ? 3 : 1.2; // hearing range in maze steps
  camera.getWorldDirection(fw); player.slow = 1; let minD = 99;
  for (const e of [...enemies]) { const pd = think(e, dt); minD = Math.min(minD, pd); if (e.boss && e.mats) abilities(e, dt, pd); }
  tension = minD < 12 ? 1 : 0;
  $('boss').hidden = !boss; if (boss) { $('bn').textContent = BOSSES[level - 1][0]; $('bh').style.width = Math.max(0, boss.hp / boss.max * 100) + '%'; }
  tickShots(dt);
};
window.killEnemy = e => { _kill(e); if (e.boss && e.mats) voice(LORE[e.bi][1], .05); };

/* ---------- Dev tools ---------- */
const Q = new URLSearchParams(location.search), lvl = +Q.get('level') || 0, god = Q.has('god');
if (lvl) $('new').onclick = () => { level = Math.min(MAX_LEVEL, lvl); hp = 100; ammo = 40; score = 0; begin(); };
if (god) window.damage = n => hud();
window.BESTIARY = { design: DESIGN, brain: BRAIN, lore: LORE, art: ART };
})();
