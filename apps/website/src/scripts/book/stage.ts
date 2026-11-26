// The red khata on a fixed WebGL stage behind the page. Scrolling opens it, turns four pages
// (handwriting on the left, Omnivo on the right) and closes it onto Omnivo's back cover.
//
// This module is loaded with a dynamic import (see index.astro), so three.js is its own chunk:
// the text of the page paints first, and a phone with Save-Data or no WebGL never downloads it.
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  FrontSide,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import {
  CANVAS_FONT_SAMPLE,
  CANVAS_FONTS,
  LAST_PAGE,
  makeSheet,
  paintAll,
  PH,
  SHEET_NAMES,
  type Sheet,
  type SheetName,
  TURNING_PAGES,
} from './pages';

export interface StageOptions {
  canvas: HTMLCanvasElement;
  // The sections that are the book's steps, in order: cover, the story's pages, the close
  steps: readonly HTMLElement[];
  // The folio and progress bar at the bottom right
  folio: HTMLElement | null;
  bar: HTMLElement | null;
}

// The story's pages: one per turning page, plus the last page on the block
const STORY = TURNING_PAGES.length + 1;
// Step 0 is the cover, steps 1…STORY the pages, the last step the closed book
const LAST_STEP = STORY + 1;
const FOLIO = ['মলাট', 'পাতা ১', 'পাতা ২', 'পাতা ৩', 'পাতা ৪', 'পাতা ৫', 'Omnivo'] as const;

// Book size in scene units: cover width and depth, page width and depth. The page's aspect
// (2.98 × 4.16) is the canvas page's (1024 × 1426)
const CW = 3.15;
const CD = 4.4;
const PGW = 2.98;
const PGD = 4.16;

// The camera: 30° vertical field of view, 14 units away
const FOV = 30;
const CAM_Z = 14;
const HALF_H = CAM_Z * Math.tan(MathUtils.degToRad(FOV / 2));

// Poses: rx tilts the book toward the camera (π/2 faces it fully), ry turns it, rz rolls it.
// `off` slides the book inside its group so the closed book stays centered (it hinges at the
// spine). The prototype read the pages at rx 1.16 (66°), which squashed them to 92% of their
// height and smeared the text along the far edge. Reading now happens at 1.38 (79°): still a
// book on a desk, but the page is almost square to the eye.
interface Pose {
  rx: number;
  ry: number;
  rz: number;
  off: number;
}
const POSE = {
  hero: { rx: 1.02, ry: -0.52, rz: 0.16, off: -CW / 2 },
  read: { rx: 1.38, ry: 0, rz: 0, off: 0 },
  final: { rx: 1.02, ry: 0.5, rz: -0.12, off: CW / 2 },
} satisfies Record<string, Pose>;

// Where the book sits on screen for each pose, set by resize()
interface Place {
  x: number;
  y: number;
  s: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export async function startStage({ canvas, steps, folio, bar }: StageOptions): Promise<void> {
  // Throws when WebGL is off or the GPU is blocklisted; the caller then shows the page without
  // the book
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const maxTexture = renderer.capabilities.maxTextureSize;

  // ---------- textures ----------
  const sheets = Object.fromEntries(SHEET_NAMES.map((n) => [n, makeSheet()])) as Record<
    SheetName,
    Sheet
  >;
  // Back faces of a plane see the texture mirrored, so their textures are flipped back
  const mirrored: ReadonlySet<SheetName> = new Set(['coverIn', 'p1b', 'p2b', 'p3b', 'back']);
  const texture = (name: SheetName): CanvasTexture => {
    const t = new CanvasTexture(sheets[name].canvas);
    t.colorSpace = SRGBColorSpace;
    // The most the GPU allows: pages are seen at a slant, and without it the mipmaps blur the
    // text along the far edge
    t.anisotropy = maxAniso;
    if (mirrored.has(name)) {
      t.wrapS = RepeatWrapping;
      t.repeat.x = -1;
      t.offset.x = 1;
    }
    return t;
  };
  const texs = Object.fromEntries(SHEET_NAMES.map((n) => [n, texture(n)])) as Record<
    SheetName,
    CanvasTexture
  >;

  // ---------- the scene ----------
  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(0, 0, CAM_Z);
  // three.js counts light in physical units since r155. These are the prototype's (r128)
  // intensities times π, which gives the same brightness: white paper stays white
  scene.add(new HemisphereLight(0xffffff, 0xd9d2c2, 0.78 * Math.PI));
  const sun = new DirectionalLight(0xffffff, 0.55 * Math.PI);
  sun.position.set(3, 5, 9);
  scene.add(sun);

  const outer = new Group();
  outer.rotation.order = 'ZYX';
  scene.add(outer);
  const tilt = new Group();
  outer.add(tilt);
  const book = new Group();
  tilt.add(book);

  const std = (o: MeshStandardMaterialParameters): MeshStandardMaterial =>
    new MeshStandardMaterial({ roughness: 0.92, metalness: 0, ...o });
  // A plane lying flat (normal +Y), like a page on a desk
  const plane = (w: number, d: number): PlaneGeometry => {
    const p = new PlaneGeometry(w, d);
    p.rotateX(-Math.PI / 2);
    return p;
  };

  // A soft shadow under the book
  {
    const sc = document.createElement('canvas');
    sc.width = sc.height = 256;
    const g = sc.getContext('2d');
    if (g) {
      const r = g.createRadialGradient(128, 128, 10, 128, 128, 128);
      r.addColorStop(0, 'rgba(10,15,30,.38)');
      r.addColorStop(1, 'rgba(10,15,30,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 256, 256);
    }
    const shadow = new Mesh(
      plane(10, 7.5),
      new MeshBasicMaterial({ map: new CanvasTexture(sc), transparent: true, depthWrite: false }),
    );
    shadow.position.set(0, -0.14, 0);
    book.add(shadow);
  }

  // Right half: the back cover (Omnivo underneath), the page block and the last page
  const C2 = 0.071;
  const right = new Group();
  right.position.y = C2;
  book.add(right);
  const backBoard = new Mesh(new BoxGeometry(CW, 0.08, CD), std({ color: 0x1f47b5 }));
  backBoard.position.set(CW / 2, -0.04 - C2, 0);
  right.add(backBoard);
  const backFace = new Mesh(plane(CW - 0.02, CD - 0.02), std({ map: texs.back, side: BackSide }));
  backFace.position.set(CW / 2, -0.0815 - C2, 0);
  right.add(backFace);
  const block = new Mesh(new BoxGeometry(PGW, 0.12, PGD), std({ color: 0xefe8d8 }));
  block.position.set(PGW / 2 + 0.02, 0.06 - C2, 0);
  right.add(block);
  const lastPage = new Mesh(plane(PGW, PGD), std({ map: texs[LAST_PAGE] }));
  lastPage.position.set(PGW / 2 + 0.02, 0.1215 - C2, 0);
  right.add(lastPage);

  // The front cover, hinged at the spine
  const C1 = 0.07;
  const front = new Group();
  front.position.y = C1;
  book.add(front);
  const frontBoard = new Mesh(new BoxGeometry(CW, 0.08, CD), std({ color: 0x8e1a16 }));
  frontBoard.position.set(CW / 2, 0.11, 0);
  front.add(frontBoard);
  const frontOut = new Mesh(plane(CW - 0.02, CD - 0.02), std({ map: texs.coverOut }));
  frontOut.position.set(CW / 2, 0.1505, 0);
  front.add(frontOut);
  const frontIn = new Mesh(plane(PGW, PGD), std({ map: texs.coverIn, side: BackSide }));
  frontIn.position.set(CW / 2, 0.0695, 0);
  front.add(frontIn);

  // The turning pages, bent as they turn. Each is a strip of SEG columns; bend() lays the
  // columns along a curve whose bend is largest halfway through the turn
  const SEG = 30;
  interface TurningPage {
    geo: PlaneGeometry;
    colOf: Int16Array;
    yR: number; // height when lying on the right
    yL: number; // height when lying on the left
    last: number; // the angle last drawn, to skip work when nothing moved
  }
  const pages: TurningPage[] = TURNING_PAGES.map(([f, b], k) => {
    const geo = new PlaneGeometry(PGW, PGD, SEG, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(PGW / 2, 0, 0);
    const pos = geo.attributes.position;
    const colOf = new Int16Array(pos?.count ?? 0);
    for (let i = 0; i < colOf.length; i++) colOf[i] = Math.round(((pos?.getX(i) ?? 0) / PGW) * SEG);
    const g = new Group();
    g.position.x = 0.02;
    g.add(new Mesh(geo, std({ map: texs[f], side: FrontSide })));
    g.add(new Mesh(geo, std({ map: texs[b], side: BackSide })));
    book.add(g);
    // stacked so the pages never cut through each other on either side
    return {
      geo,
      colOf,
      yR: 0.12 + (TURNING_PAGES.length - k) * 0.0035,
      yL: 0.004 + (k + 1) * 0.003,
      last: -1,
    };
  });
  const BX = new Float32Array(SEG + 1);
  const BY = new Float32Array(SEG + 1);
  function bend(p: TurningPage, th: number): void {
    if (Math.abs(th - p.last) < 1e-4) return;
    p.last = th;
    const dx = PGW / SEG;
    const s = Math.sin(th);
    const base = mix(p.yR, p.yL, th / Math.PI);
    BX[0] = 0;
    BY[0] = 0;
    for (let c = 1; c <= SEG; c++) {
      const a = th - 0.95 * s * ((c - 0.5) / SEG);
      BX[c] = (BX[c - 1] ?? 0) + Math.cos(a) * dx;
      BY[c] = (BY[c - 1] ?? 0) + Math.sin(a) * dx;
    }
    const pos = p.geo.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      const c = p.colOf[i] ?? 0;
      pos.setX(i, BX[c] ?? 0);
      pos.setY(i, base + (BY[c] ?? 0));
    }
    pos.needsUpdate = true;
    p.geo.computeVertexNormals();
    p.geo.computeBoundingSphere();
  }

  // ---------- layout and texture quality ----------
  const lay: Record<keyof typeof POSE, Place> = {
    hero: { x: 0, y: 0, s: 1 },
    read: { x: 0, y: 0, s: 1 },
    final: { x: 0, y: 0, s: 1 },
  };
  let quality = 0;
  let fontsReady = false;

  // Canvas pixels per layout unit that make one texel at least one device pixel when the page
  // is read, with 25% to spare for the slant. Rounded to quarter steps so a small resize does
  // not repaint. At most 1.5 (1536 × 2139 per page): twelve sheets at that size are about 210 MB on
  // the GPU with mipmaps, and more would not be visibly sharper at reading size.
  function neededQuality(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxPerUnit = window.innerHeight / (2 * HALF_H);
    const pageDevicePx = PGD * lay.read.s * Math.sin(POSE.read.rx) * pxPerUnit * dpr;
    const q = Math.ceil(((pageDevicePx * 1.25) / PH) * 4) / 4;
    return Math.min(1.5, maxTexture / PH, Math.max(0.75, q));
  }

  function repaint(q: number): void {
    quality = q;
    paintAll(sheets, q);
    for (const t of Object.values(texs)) {
      // The canvas may have a new size; a GL texture's size is fixed once made, so it is
      // dropped and made again from the canvas at the next render
      t.dispose();
      t.needsUpdate = true;
    }
  }

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const halfW = HALF_H * camera.aspect;
    if (w >= 900) {
      // The captions take the left 40%; the book is centered in the rest
      const xl = -halfW + 2 * halfW * 0.4;
      const xr = halfW - 0.4;
      const cx = (xl + xr) / 2;
      const span = xr - xl;
      lay.hero = { x: cx + 0.2, y: -0.1, s: Math.min(1.25, span / 3.9, (HALF_H * 1.6) / CD) };
      lay.read = { x: cx, y: -0.15, s: Math.min(1.3, span / 6.3, (HALF_H * 1.8) / CD) };
      lay.final = { x: cx, y: -0.1, s: lay.hero.s };
    } else {
      // On a phone the book sits in the top half and the captions scroll over the bottom
      const top = HALF_H * 0.48;
      lay.hero = { x: 0, y: top, s: Math.min(0.9, (halfW * 1.25) / 3.4, (HALF_H * 0.8) / CD) };
      // the open book is two covers wide (2 × 3.15), plus a margin so its corners never touch
      // the screen's edges in perspective
      lay.read = { x: 0, y: top, s: Math.min(0.95, (halfW * 1.84) / (2 * CW)) };
      lay.final = { x: 0, y: top, s: lay.hero.s };
    }
    // Only ever sharper: going back down would repaint for nothing on every window drag
    if (fontsReady) {
      const q = neededQuality();
      if (q > quality) repaint(q);
    }
    measure();
  }

  // ---------- scroll → step ----------
  // Each step's anchor is the scroll position where its section is centered on screen
  let anchors: number[] = [];
  function measure(): void {
    const vh = window.innerHeight;
    anchors = steps.map((s) => {
      const r = s.getBoundingClientRect();
      return Math.max(0, r.top + window.scrollY + Math.min(r.height, vh) / 2 - vh / 2);
    });
    anchors[0] = 0;
  }
  // A number from 0 to 5: the whole part is the step, the fraction how far into the next one.
  // The first and last 15% of the way between two anchors hold still, so a caption can be read
  // while the book rests
  function stepAt(y: number): number {
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i] ?? 0;
      const b = anchors[i + 1] ?? a;
      if (y < b) return i + clamp01(((y - a) / Math.max(1, b - a) - 0.15) / 0.7);
    }
    return anchors.length - 1;
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let target = 0;
  let cur = 0;
  let mx = 0;
  let my = 0;
  let smx = 0;
  let smy = 0;
  let running = true;
  let lastFolio = -1;

  window.addEventListener(
    'scroll',
    () => {
      target = stepAt(window.scrollY);
    },
    { passive: true },
  );
  window.addEventListener('resize', resize);
  window.addEventListener(
    'pointermove',
    (e) => {
      mx = e.clientX / window.innerWidth - 0.5;
      my = e.clientY / window.innerHeight - 0.5;
    },
    { passive: true },
  );
  // A hidden tab draws nothing
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });
  // Web fonts change the height of the captions, which moves the anchors
  void document.fonts.ready.then(measure);

  function frame(now: number): void {
    if (!running) return;
    const still = reduce.matches;
    const t = now * 0.001;
    // With reduced motion the book jumps to where the scroll is, with no easing and no idle
    // sway. It still opens and turns, because that is the content, not decoration
    cur = still ? target : cur + (target - cur) * 0.07;
    if (Math.abs(target - cur) < 1e-4) cur = target;
    const i = Math.min(LAST_STEP, Math.floor(cur));
    const f = cur - i;

    let A: Pose;
    let B: Pose;
    let la: Place;
    let lb: Place;
    let k = 0;
    if (i === 0) {
      [A, B, la, lb] = [POSE.hero, POSE.read, lay.hero, lay.read];
      k = ease(clamp01(f / 0.7));
    } else if (i < STORY) {
      [A, B, la, lb] = [POSE.read, POSE.read, lay.read, lay.read];
    } else if (i === STORY) {
      [A, B, la, lb] = [POSE.read, POSE.final, lay.read, lay.final];
      k = ease(clamp01((f - 0.35) / 0.65));
    } else {
      [A, B, la, lb] = [POSE.final, POSE.final, lay.final, lay.final];
    }
    const idle = still ? 0 : 1;
    if (!still) {
      smx += (mx - smx) * 0.05;
      smy += (my - smy) * 0.05;
    }
    // The pointer tilts the book a little; while reading it barely sways, so the text holds still
    const sway = i === 0 || i === LAST_STEP ? 1 : 0.3;
    tilt.rotation.x = mix(A.rx, B.rx, k) + smy * 0.08 * idle * sway;
    outer.rotation.set(
      0,
      mix(A.ry, B.ry, k) + smx * 0.14 * idle * sway + Math.sin(t * 0.4) * 0.03 * idle * sway,
      mix(A.rz, B.rz, k),
    );
    outer.position.set(
      mix(la.x, lb.x, k),
      mix(la.y, lb.y, k) + Math.sin(t * 0.8) * 0.05 * idle * sway,
      0,
    );
    outer.scale.setScalar(mix(la.s, lb.s, k));
    book.position.x = mix(A.off, B.off, k);

    // The cover opens during step 0, page n turns during step n, and the book closes during
    // the last page's step
    front.rotation.z = (i === 0 ? ease(clamp01((f - 0.25) / 0.75)) : 1) * Math.PI;
    pages.forEach((p, n) => {
      const s = n + 1;
      bend(p, cur >= s + 1 ? Math.PI : i === s ? ease(f) * Math.PI : 0);
    });
    right.rotation.z = (i > STORY ? 1 : i === STORY ? ease(clamp01(f / 0.75)) : 0) * Math.PI;

    renderer.render(scene, camera);
    const fi = Math.round(cur);
    if (fi !== lastFolio && folio) {
      lastFolio = fi;
      folio.textContent = FOLIO[fi] ?? '';
    }
    if (bar) bar.style.width = `${String((cur / LAST_STEP) * 100)}%`;
    requestAnimationFrame(frame);
  }

  // ---------- start ----------
  resize();
  // Wait for the canvas fonts (at most 3 seconds), then paint once at the right quality. Drawing
  // before the fonts arrive would bake the fallback font into the texture
  const loads = CANVAS_FONTS.map((font) =>
    document.fonts.load(font, CANVAS_FONT_SAMPLE).catch(() => []),
  );
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 3000))]);
  fontsReady = true;
  repaint(neededQuality());
  measure();
  target = stepAt(window.scrollY);
  cur = target;
  canvas.dataset.ready = '';
  requestAnimationFrame(frame);
}
