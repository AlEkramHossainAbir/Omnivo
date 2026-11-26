// The pictures on the book's pages, drawn on 2D canvases that become WebGL textures.
//
// Why the prototype's pages looked blurry, and what changed here:
// 1. Each page was a fixed 1024 × 1426 canvas, whatever the screen. Here every page is drawn in
//    the same 1024 × 1426 layout units, but onto a canvas `quality` times larger (see `Sheet`).
//    The stage picks the quality from how many device pixels the page really covers, so a
//    4K or retina screen gets more texels and a phone does not waste memory.
// 2. The Omnivo pages used 20–26px text on that 1024px page. On a laptop the page is about 500
//    CSS pixels tall, so that text ended up 7–9px on screen: unreadable at any resolution. The
//    smallest text is now 25px of the layout (about 9–11 screen px), most body text 28–30px.
// 3. The fonts are self-hosted and loaded before the first paint (stage.ts), so the canvas
//    never draws in a fallback font and then has to swap.
import {
  Alert02Icon,
  CashierIcon,
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  HourglassIcon,
  Invoice02Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageMovingIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';

import type { IconData } from '../icons';

// One page in layout units. The page geometry in the scene has the same aspect (2.98 × 4.16)
export const PW = 1024;
export const PH = 1426;

// A canvas plus its 2D context, scaled so the painters can always use layout units
export interface Sheet {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
}

export function makeSheet(): Sheet {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  // A 2D context only fails when the browser is out of memory; nothing on the page works then
  if (!g) throw new Error('2d canvas unavailable');
  return { canvas, g };
}

// Resizes the sheet for this quality and resets its drawing state. Setting width clears the
// canvas and its transform, so the scale is set again after it
function prepare(sheet: Sheet, quality: number): CanvasRenderingContext2D {
  sheet.canvas.width = Math.round(PW * quality);
  sheet.canvas.height = Math.round(PH * quality);
  sheet.g.setTransform(quality, 0, 0, quality, 0, 0);
  return sheet.g;
}

// ---------- small drawing helpers ----------

const INK = '#1C2A6B'; // ballpoint blue of the khata
const RED = '#C2281F'; // the red pen of the margin notes

// The same seed every paint, so a repaint at a new quality draws the very same "random" paper
let seed = 11;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

function rr(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Draws a HugeIcons icon (the same data the HTML uses) with Path2D, so the canvas icons match
// the page's icons. Only the element kinds these icons use are handled
function icon(
  g: CanvasRenderingContext2D,
  data: IconData,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  g.save();
  g.translate(x, y);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const num = (v: string | number | undefined): number => Number(v ?? 0);
  for (const [tag, a] of data) {
    const p = new Path2D();
    if (tag === 'path' && typeof a.d === 'string') p.addPath(new Path2D(a.d));
    else if (tag === 'circle') p.arc(num(a.cx), num(a.cy), num(a.r), 0, Math.PI * 2);
    else if (tag === 'ellipse')
      p.ellipse(num(a.cx), num(a.cy), num(a.rx), num(a.ry), 0, 0, Math.PI * 2);
    else continue;
    g.stroke(p);
  }
  g.restore();
}

// Paper: warm white, a little grain, darker at the edges. Ruled pages get the khata's blue lines
// and red margins
function paper(g: CanvasRenderingContext2D, ruled: boolean): void {
  g.fillStyle = '#FBF8F1';
  g.fillRect(0, 0, PW, PH);
  for (let i = 0; i < 3200; i++) {
    g.fillStyle = `rgba(120,96,60,${String(rnd() * 0.04)})`;
    g.fillRect(rnd() * PW, rnd() * PH, 2, 2);
  }
  const edge = g.createLinearGradient(0, 0, PW, 0);
  edge.addColorStop(0, 'rgba(120,96,60,.10)');
  edge.addColorStop(0.06, 'rgba(120,96,60,0)');
  edge.addColorStop(0.94, 'rgba(120,96,60,0)');
  edge.addColorStop(1, 'rgba(120,96,60,.08)');
  g.fillStyle = edge;
  g.fillRect(0, 0, PW, PH);
  if (!ruled) return;
  g.strokeStyle = 'rgba(60,100,170,.17)';
  g.lineWidth = 2;
  for (let y = 232; y < PH - 50; y += 62) line(g, 50, y, PW - 50, y);
  g.strokeStyle = 'rgba(194,40,31,.45)';
  g.lineWidth = 2.5;
  for (const x of [150, 158, PW - 262, PW - 254]) line(g, x, 40, x, PH - 40);
}

// ---------- the khata (left pages): handwriting ----------

const HAND = '"Atma", "Noto Sans Bengali", sans-serif';

function hw(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  rot: number,
  align: CanvasTextAlign,
  weight = 500,
): number {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.font = `${String(weight)} ${String(size)}px ${HAND}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillText(text, 0, 0);
  const w = g.measureText(text).width;
  g.restore();
  return w;
}

interface KhataRow {
  d?: string; // date, in the margin
  t?: string; // what it is
  a?: string; // amount, on the right
  small?: boolean; // a note under the row above
  strike?: boolean; // the amount is crossed out...
  fix?: string; // ...and this is written above it
  total?: boolean; // double rule above the amount
}

interface KhataNote {
  text: string;
  x: number;
  y: number;
  rot: number;
  size?: number;
}

function khataPage(
  g: CanvasRenderingContext2D,
  title: string,
  rows: readonly KhataRow[],
  notes: readonly KhataNote[],
): void {
  paper(g, true);
  hw(g, title, PW / 2, 160, 72, INK, -0.01, 'center', 600);
  g.strokeStyle = INK;
  g.lineWidth = 3;
  line(g, PW / 2 - 150, 182, PW / 2 + 150, 186);
  rows.forEach((r, i) => {
    const y = 282 + i * 62;
    // a slight slant per row, like a hand that is not ruling lines
    const j = (rnd() - 0.5) * 0.012;
    if (r.d) hw(g, r.d, 100, y, 32, INK, j, 'center');
    if (r.t) hw(g, r.t, 180, y, r.small ? 38 : 44, INK, j, 'left');
    if (r.a) {
      const w = hw(g, r.a, PW - 70, y, 44, INK, j, 'right');
      if (r.strike) {
        g.strokeStyle = INK;
        g.lineWidth = 3.5;
        line(g, PW - 80 - w, y - 14, PW - 62, y - 18);
        if (r.fix) hw(g, r.fix, PW - 70, y - 38, 32, INK, -0.03, 'right');
      }
    }
    if (r.total) {
      g.strokeStyle = INK;
      g.lineWidth = 3;
      line(g, PW - 250, y - 48, PW - 60, y - 48);
      line(g, PW - 250, y - 41, PW - 60, y - 41);
    }
  });
  for (const n of notes) {
    g.save();
    g.translate(n.x, n.y);
    g.rotate(n.rot);
    g.font = `600 ${String(n.size ?? 48)}px ${HAND}`;
    const w = g.measureText(n.text).width;
    g.strokeStyle = RED;
    g.lineWidth = 3.5;
    g.beginPath();
    // an ellipse drawn by hand: it starts a little late and overshoots its start
    g.ellipse(w / 2, -14, w / 2 + 34, 46, 0, 0.2, Math.PI * 2.05);
    g.stroke();
    g.fillStyle = RED;
    g.fillText(n.text, 0, 0);
    g.restore();
  }
}

// ---------- Omnivo (right pages): the product, printed ----------

// The App UI design system's light palette (CLAUDE.md). These pages show the real product, so
// they use its colors exactly. A canvas cannot read CSS variables cheaply, hence the copy.
const C = {
  ink: '#0F1728',
  ink2: '#475467',
  ink3: '#8A94A6',
  line: '#E4E7EC',
  subtle: '#F1F3F6',
  brand: '#1F47B5',
  soft: '#EDF1FB',
  good: '#0A7A4B',
  goodBg: '#ECF8F1',
  warn: '#B25E09',
  warnBg: '#FEF6E7',
  crit: '#B42318',
  critBg: '#FEF1F0',
} as const;

// The variable fontsource packages register "Geist Variable", not "Geist" (CLAUDE.md, Typography)
const SANS = '"Geist Variable", "Noto Sans Bengali", sans-serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';
const F = (weight: number, size: number, mono = false): string =>
  `${String(weight)} ${String(size)}px ${mono ? MONO : SANS}`;

function txt(
  g: CanvasRenderingContext2D,
  t: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = 'left',
): number {
  g.font = font;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillText(t, x, y);
  return g.measureText(t).width;
}

type PillKind = 'good' | 'warn' | 'crit' | 'brand';
const PILL: Record<PillKind, readonly [string, string]> = {
  good: [C.goodBg, C.good],
  warn: [C.warnBg, C.warn],
  crit: [C.critBg, C.crit],
  brand: [C.soft, C.brand],
};

// A status pill: soft background, icon and words in the same color. `y` is the text baseline;
// the pill is 46 units tall around it. `alignRight` puts the pill's right edge at `x`
function pill(
  g: CanvasRenderingContext2D,
  t: string,
  x: number,
  y: number,
  kind: PillKind,
  ic: IconData,
  alignRight = false,
): void {
  const [bg, fg] = PILL[kind];
  g.font = F(500, 27);
  const w = g.measureText(t).width + 70;
  const x0 = alignRight ? x - w : x;
  rr(g, x0, y - 32, w, 46, 23);
  g.fillStyle = bg;
  g.fill();
  icon(g, ic, x0 + 14, y - 22, 26, fg);
  txt(g, t, x0 + 50, y, F(500, 27), fg);
}

function card(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.save();
  g.shadowColor = 'rgba(16,24,40,.10)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 10;
  rr(g, x, y, w, h, 22);
  g.fillStyle = '#FFFFFF';
  g.fill();
  g.restore();
  rr(g, x, y, w, h, 22);
  g.strokeStyle = C.line;
  g.lineWidth = 2;
  g.stroke();
}

function rule(
  g: CanvasRenderingContext2D,
  x1: number,
  y: number,
  x2: number,
  color: string = C.line,
): void {
  g.strokeStyle = color;
  g.lineWidth = 2;
  line(g, x1, y, x2, y);
}

// The logo mark, the screen's name and the page's headline
function omniHead(g: CanvasRenderingContext2D, label: string, title: string): void {
  rr(g, 72, 92, 24, 24, 6);
  g.fillStyle = C.brand;
  g.fill();
  rr(g, 85, 79, 24, 24, 6);
  g.strokeStyle = C.brand;
  g.lineWidth = 3;
  g.stroke();
  txt(g, `Omnivo  ·  ${label}`, 128, 112, F(500, 30), C.brand);
  txt(g, title, 72, 202, F(600, 64), C.ink);
}

// Card geometry shared by the four Omnivo pages
const X = 56;
const W = PW - 112;
const R = X + W; // the card's right edge

function pageAccounts(g: CanvasRenderingContext2D): void {
  paper(g, false);
  omniHead(g, 'Trial balance', 'Balanced, by itself.');
  card(g, X, 250, W, 700);
  txt(g, 'Trial balance', X + 36, 318, F(600, 38), C.ink);
  txt(g, '1 Jul 2026 – 26 Nov 2026', X + 36, 362, F(400, 28), C.ink3);
  pill(g, 'Balanced', R - 34, 330, 'good', CheckmarkCircle02Icon, true);
  g.fillStyle = C.subtle;
  g.fillRect(X + 2, 396, W - 4, 60);
  txt(g, 'Account', X + 36, 436, F(500, 26), C.ink3);
  txt(g, 'Debit', R - 290, 436, F(500, 26), C.ink3, 'right');
  txt(g, 'Credit', R - 36, 436, F(500, 26), C.ink3, 'right');
  const rows = [
    ['1110', 'Cash in hand', '4,82,300.00', '—'],
    ['1200', 'Accounts receivable', '18,42,600.00', '—'],
    ['2100', 'Accounts payable', '—', '9,15,400.00'],
    ['4100', 'Sales', '—', '14,09,500.00'],
  ] as const;
  rows.forEach(([code, name, dr, cr], i) => {
    const y = 516 + i * 80;
    txt(g, code, X + 36, y, F(400, 25, true), C.ink3);
    txt(g, name, X + 116, y, F(400, 28), C.ink2);
    txt(g, dr, R - 290, y, F(400, 27, true), C.ink2, 'right');
    txt(g, cr, R - 36, y, F(400, 27, true), C.ink2, 'right');
    rule(g, X + 2, y + 32, R - 2);
  });
  // the total row on `subtle`, with the card's round bottom corners
  g.fillStyle = C.subtle;
  rr(g, X + 2, 836, W - 4, 112, 20);
  g.fill();
  g.fillRect(X + 2, 836, W - 4, 40);
  txt(g, 'Total', X + 36, 904, F(500, 30), C.ink);
  txt(g, '23,24,900.00', R - 290, 904, F(500, 27, true), C.ink, 'right');
  txt(g, '23,24,900.00', R - 36, 904, F(500, 27, true), C.ink, 'right');
  card(g, X, 990, W, 200);
  txt(g, 'VAT report · October 2026', X + 36, 1056, F(600, 34), C.ink);
  txt(g, 'Output VAT ৳1,24,560.00', X + 36, 1102, F(400, 28), C.ink3);
  txt(g, 'Mushak 6.3 numbers on every bill', X + 36, 1144, F(400, 28), C.ink3);
  pill(g, 'To pay', R - 34, 1064, 'brand', Invoice02Icon, true);
  txt(g, 'Every invoice, receipt and bill posts its journal.', 72, 1262, F(400, 30), C.ink2);
  txt(g, 'Debit on one side, credit on the other.', 72, 1306, F(400, 30), C.ink2);
}

function pageStock(g: CanvasRenderingContext2D): void {
  paper(g, false);
  omniHead(g, 'Stock', 'Every batch, every depot.');
  card(g, X, 250, W, 600);
  txt(g, 'Paracetamol 500 mg', X + 36, 318, F(600, 38), C.ink);
  txt(g, 'Main warehouse · 320 strips', X + 36, 362, F(400, 28), C.ink3);
  const rows = [
    {
      batch: 'AT-2408',
      note: 'expires 30 Nov 2026',
      qty: '80 strips',
      tag: ['4 days left', 'warn', HourglassIcon] as const,
    },
    { batch: 'AT-2411', note: 'expires 28 Feb 2027', qty: '200 strips', tag: null },
    {
      batch: 'AT-2402',
      note: 'expired 31 Oct 2026',
      qty: '40 strips',
      tag: ['Expired', 'crit', Alert02Icon] as const,
    },
  ];
  rows.forEach((r, i) => {
    const y = 450 + i * 108;
    rule(g, X + 2, y - 50, R - 2);
    txt(g, r.batch, X + 36, y, F(500, 30, true), C.ink);
    txt(g, r.note, X + 36, y + 38, F(400, 26), C.ink3);
    txt(g, r.qty, R - 300, y + 18, F(400, 29), C.ink2, 'right');
    // A batch far from its expiry has no pill: the date under it says enough
    if (r.tag) pill(g, r.tag[0], R - 34, y + 22, r.tag[1], r.tag[2], true);
  });
  g.fillStyle = C.goodBg;
  rr(g, X + 2, 770, W - 4, 78, 20);
  g.fill();
  g.fillRect(X + 2, 770, W - 4, 30);
  icon(g, CheckmarkCircle02Icon, X + 34, 792, 32, C.good);
  txt(g, 'Packing picks AT-2408 first: it expires first.', X + 80, 820, F(500, 27), C.good);
  card(g, X, 890, W, 330);
  txt(g, 'Low stock', X + 36, 960, F(600, 36), C.ink);
  pill(g, '2 products', R - 34, 966, 'warn', Alert02Icon, true);
  const low = [
    ['Saline 500 ml', '40 of 200 bags'],
    ['Cotton thread 40s', '12 of 60 cones'],
  ] as const;
  low.forEach(([name, left], i) => {
    const y = 1050 + i * 86;
    txt(g, name, X + 36, y, F(500, 30), C.ink);
    txt(g, left, R - 36, y, F(400, 28), C.ink2, 'right');
    g.fillStyle = C.subtle;
    rr(g, X + 36, y + 20, W - 72, 12, 6);
    g.fill();
    g.fillStyle = C.warn;
    rr(g, X + 36, y + 20, (W - 72) * 0.2, 12, 6);
    g.fill();
  });
}

function pageAging(g: CanvasRenderingContext2D): void {
  paper(g, false);
  omniHead(g, 'Customers owe', 'Who owes, and since when.');
  card(g, X, 250, W, 190);
  const cw = W / 3;
  const kpis = [
    ['Total due', '৳3,95,000', null],
    ['Overdue', '৳2,15,000', '৳80,000 over 90 days'],
    ['Advances', '৳20,000', null],
  ] as const;
  kpis.forEach(([label, value, sub], i) => {
    const cx = X + cw * i + 30;
    if (i > 0) {
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      line(g, X + cw * i, 272, X + cw * i, 418);
    }
    txt(g, label, cx, 308, F(500, 26), C.ink3);
    txt(g, value, cx, 368, F(600, 44), i === 1 ? C.crit : C.ink);
    if (sub) txt(g, sub, cx, 410, F(400, 23), C.ink3);
  });
  card(g, X, 480, W, 590);
  g.fillStyle = C.subtle;
  rr(g, X + 2, 482, W - 4, 66, 20);
  g.fill();
  g.fillRect(X + 2, 514, W - 4, 34);
  // Four columns, not the report's six, so the words stay large enough to read on the page
  const cols = [X + 36, R - 440, R - 240, R - 36];
  ['Customer', '1–30', '31–60', 'Over 90'].forEach((h, i) =>
    txt(g, h, cols[i] ?? 0, 526, F(500, 25), C.ink3, i > 0 ? 'right' : 'left'),
  );
  const rows = [
    ['SP', 'Sylhet Pharmacy', '20,000', '—', '—'],
    ['KB', 'Karim Brothers', '65,000', '50,000', '—'],
    ['RT', 'Rupali Traders', '—', '—', '80,000'],
  ] as const;
  rows.forEach(([initials, name, a, b, c], i) => {
    const y = 630 + i * 110;
    rr(g, X + 36, y - 44, 56, 56, 12);
    g.fillStyle = C.soft;
    g.fill();
    txt(g, initials, X + 64, y - 7, F(600, 22), C.brand, 'center');
    txt(g, name, X + 112, y - 6, F(500, 30), C.ink);
    txt(g, a, cols[1] ?? 0, y - 6, F(400, 27, true), C.ink2, 'right');
    txt(g, b, cols[2] ?? 0, y - 6, F(400, 27, true), C.ink2, 'right');
    txt(
      g,
      c,
      cols[3] ?? 0,
      y - 6,
      F(c === '—' ? 400 : 500, 27, true),
      c === '—' ? C.ink2 : C.crit,
      'right',
    );
    rule(g, X + 2, y + 44, R - 2);
  });
  rr(g, X + 36, 916, 56, 56, 12);
  g.fillStyle = C.soft;
  g.fill();
  txt(g, 'NM', X + 64, 953, F(600, 22), C.brand, 'center');
  txt(g, 'New Model Fashion', X + 112, 954, F(500, 30), C.ink);
  txt(g, '৳20,000 in advance', R - 36, 954, F(400, 27), C.ink2, 'right');
  pill(g, 'Credit limit stops the next order', 72, 1130, 'warn', Alert02Icon);
  txt(g, 'Money in is applied to the oldest invoice first.', 72, 1232, F(400, 30), C.ink2);
}

// The POS counter: a sale made offline (its receipt number, the cart, the payment) and the
// shift's blind count, like the POS receipt layer of the Layers prototype. The lines add up:
// 160 + 170 + 400 = 730, paid 500 cash + 230 bKash
function pagePos(g: CanvasRenderingContext2D): void {
  paper(g, false);
  omniHead(g, 'POS', 'The counter never stops.');
  card(g, X, 250, W, 600);
  txt(g, 'POS1-000124', X + 36, 318, F(500, 38, true), C.ink);
  txt(g, 'Counter POS1 · Sumi Akter · Walk-in', X + 36, 362, F(400, 28), C.ink3);
  pill(g, 'Saved offline', R - 34, 330, 'brand', CloudUploadIcon, true);
  g.fillStyle = C.subtle;
  g.fillRect(X + 2, 396, W - 4, 60);
  txt(g, 'Item', X + 36, 436, F(500, 26), C.ink3);
  txt(g, 'Qty', R - 260, 436, F(500, 26), C.ink3, 'right');
  txt(g, 'Amount', R - 36, 436, F(500, 26), C.ink3, 'right');
  const lines = [
    ['Paracetamol 500 mg', '× ৳40 · strip', '4 strips', '160.00'],
    ['Saline 500 ml', '× ৳85 · bag', '2 bags', '170.00'],
    ['Cotton thread 40s', '× ৳400 · cone', '1 cone', '400.00'],
  ] as const;
  lines.forEach(([name, each, qty, amount], i) => {
    const y = 512 + i * 92;
    txt(g, name, X + 36, y, F(500, 29), C.ink);
    txt(g, each, X + 36, y + 34, F(400, 25), C.ink3);
    txt(g, qty, R - 260, y + 16, F(400, 28), C.ink2, 'right');
    txt(g, amount, R - 36, y + 16, F(400, 28, true), C.ink, 'right');
    if (i < lines.length - 1) rule(g, X + 2, y + 56, R - 2);
  });
  // the total row on `subtle`, with the card's round bottom corners
  g.fillStyle = C.subtle;
  rr(g, X + 2, 770, W - 4, 78, 20);
  g.fill();
  g.fillRect(X + 2, 770, W - 4, 30);
  txt(g, 'Total', X + 36, 820, F(500, 30), C.ink);
  txt(g, '৳730.00', R - 36, 820, F(500, 30, true), C.ink, 'right');
  card(g, X, 890, W, 330);
  txt(g, 'Take payment', X + 36, 956, F(600, 34), C.ink);
  pill(g, 'Paid', R - 34, 964, 'good', CheckmarkCircle02Icon, true);
  const pays = [
    ['Cash', '৳500.00'],
    ['bKash · TrxID BK7XQ2M4', '৳230.00'],
    ['Still to pay', '৳0.00'],
  ] as const;
  pays.forEach(([label, amount], i) => {
    const y = 1040 + i * 62;
    const last = i === pays.length - 1;
    if (last) rule(g, X + 36, y - 40, R - 36, C.ink);
    txt(g, label, X + 36, y, F(last ? 500 : 400, 30), last ? C.ink : C.ink2);
    txt(g, amount, R - 36, y, F(last ? 500 : 400, 29, true), last ? C.ink : C.ink2, 'right');
  });
  icon(g, CashierIcon, 72, 1262, 30, C.ink2);
  txt(g, 'Shift POS1-S0042 closes with a blind count.', 116, 1288, F(400, 30), C.ink2);
  txt(g, 'It syncs when the line is back.', 116, 1332, F(400, 30), C.ink2);
}

function pageShop(g: CanvasRenderingContext2D): void {
  paper(g, false);
  omniHead(g, 'Shop orders', 'Parcels that pay you back.');
  card(g, X, 250, W, 560);
  txt(g, 'W-000123', X + 36, 318, F(500, 38, true), C.ink);
  txt(g, 'Steadfast · SFR2611120042', X + 36, 362, F(400, 28), C.ink3);
  pill(g, 'Delivered', R - 34, 330, 'good', PackageDeliveredIcon, true);
  const steps = [
    ['Confirmed with the phone code', '24 Nov, 19:05', Tick02Icon],
    ['Packed · challan DC-2026-27-0318', '25 Nov, 11:20', PackageIcon],
    ['Picked up by the rider', '25 Nov, 16:48', PackageMovingIcon],
    ['Delivered · invoice posted', '26 Nov, 13:02', PackageDeliveredIcon],
  ] as const;
  steps.forEach(([what, when, ic], i) => {
    const y = 460 + i * 90;
    const last = i === steps.length - 1;
    if (!last) {
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      line(g, X + 62, y + 14, X + 62, y + 52);
    }
    g.beginPath();
    g.arc(X + 62, y - 14, 26, 0, Math.PI * 2);
    g.fillStyle = last ? C.goodBg : C.subtle;
    g.fill();
    icon(g, ic, X + 47, y - 29, 30, last ? C.good : C.ink2);
    txt(g, what, X + 112, y - 16, F(500, 29), C.ink);
    txt(g, when, X + 112, y + 20, F(400, 25), C.ink3);
  });
  card(g, X, 850, W, 380);
  txt(g, 'CPO-2026-27-0001', X + 36, 916, F(500, 34, true), C.ink);
  txt(g, 'Courier payout · Steadfast · 3 parcels', X + 36, 958, F(400, 27), C.ink3);
  pill(g, 'Agrees', R - 34, 924, 'good', CheckmarkCircle02Icon, true);
  const sums = [
    ['Collected', '৳2,100.00'],
    ['Courier charges', '− ৳60.00'],
    ['To the bank', '৳2,040.00'],
  ] as const;
  sums.forEach(([label, amount], i) => {
    const y = 1040 + i * 62;
    const total = i === sums.length - 1;
    if (total) rule(g, X + 36, y - 40, R - 36, C.ink);
    txt(g, label, X + 36, y, F(total ? 500 : 400, 30), total ? C.ink : C.ink2);
    txt(g, amount, R - 36, y, F(total ? 500 : 400, 29, true), total ? C.ink : C.ink2, 'right');
  });
  txt(g, 'The file says ৳2,040 reached the bank.', X + 36, 1204, F(400, 26), C.ink3);
}

// ---------- covers ----------

const SERIF = '"Tiro Bangla", "Noto Sans Bengali", serif';

// Book cloth: a base color, fine horizontal and vertical threads, darker toward the edges
function cloth(g: CanvasRenderingContext2D, base: string, dark: string): void {
  g.fillStyle = base;
  g.fillRect(0, 0, PW, PH);
  for (let y = 0; y < PH; y += 3) {
    g.fillStyle = `rgba(0,0,0,${String(0.03 + rnd() * 0.05)})`;
    g.fillRect(0, y, PW, 1);
  }
  for (let x = 0; x < PW; x += 3) {
    g.fillStyle = `rgba(255,255,255,${String(rnd() * 0.035)})`;
    g.fillRect(x, 0, 1, PH);
  }
  const v = g.createRadialGradient(PW / 2, PH / 2, PW * 0.2, PW / 2, PH / 2, PW * 0.9);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, dark);
  g.fillStyle = v;
  g.fillRect(0, 0, PW, PH);
}

function coverRed(g: CanvasRenderingContext2D): void {
  cloth(g, '#9E1D19', 'rgba(40,0,0,.45)');
  g.strokeStyle = 'rgba(255,220,200,.25)';
  g.lineWidth = 3;
  rr(g, 50, 50, PW - 100, PH - 100, 18);
  g.stroke();
  g.save();
  g.shadowColor = 'rgba(0,0,0,.35)';
  g.shadowBlur = 18;
  g.shadowOffsetY = 6;
  rr(g, 212, 420, 600, 420, 22);
  g.fillStyle = '#F7F1E4';
  g.fill();
  g.restore();
  g.strokeStyle = '#9E1D19';
  g.lineWidth = 3;
  rr(g, 230, 438, 564, 384, 14);
  g.stroke();
  g.textAlign = 'center';
  g.fillStyle = '#8E1A16';
  g.font = `110px ${SERIF}`;
  g.fillText('হালখাতা', 512, 610);
  g.font = `64px ${SERIF}`;
  g.fillText('১৪৩৩', 512, 700);
  g.font = `32px ${SERIF}`;
  g.fillStyle = '#6E1511';
  g.fillText('রহমান ট্রেডার্স · খাতা নং ১', 512, 780);
}

function coverOmnivo(g: CanvasRenderingContext2D): void {
  cloth(g, '#1F47B5', 'rgba(5,12,40,.5)');
  g.strokeStyle = 'rgba(255,255,255,.22)';
  g.lineWidth = 3;
  rr(g, 50, 50, PW - 100, PH - 100, 18);
  g.stroke();
  rr(g, 362, 470, 190, 190, 34);
  g.fillStyle = '#FFFFFF';
  g.fill();
  rr(g, 472, 360, 190, 190, 34);
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = 16;
  g.stroke();
  g.textAlign = 'center';
  g.font = F(600, 120);
  g.fillStyle = '#FFFFFF';
  g.fillText('Omnivo', 512, 850);
  g.font = F(400, 36, true);
  g.fillStyle = 'rgba(255,255,255,.78)';
  g.fillText('rahman-traders.omnivo.app', 512, 922);
  g.font = `38px ${SERIF}`;
  g.fillStyle = 'rgba(255,255,255,.88)';
  g.fillText('হালখাতা, এবার ক্লাউডে', 512, 1012);
}

// ---------- every sheet of the book ----------

// coverOut: the red front. coverIn: inside the front cover (the first khata page).
// pNf / pNb: the front (Omnivo) and back (khata) of turning page N. p5f: the last Omnivo page,
// on the page block. back: the Omnivo back cover the book lands on.
// The story: 1 accounts, 2 stock, 3 dues, 4 the POS counter, 5 the online shop
export const SHEET_NAMES = [
  'coverOut',
  'coverIn',
  'p1f',
  'p1b',
  'p2f',
  'p2b',
  'p3f',
  'p3b',
  'p4f',
  'p4b',
  'p5f',
  'back',
] as const;

// The turning pages, front and back, in the order they turn. The stage builds one turning page
// per pair, so a new story page is a new pair here plus a section in index.astro
export const TURNING_PAGES = [
  ['p1f', 'p1b'],
  ['p2f', 'p2b'],
  ['p3f', 'p3b'],
  ['p4f', 'p4b'],
] as const satisfies readonly (readonly [SheetName, SheetName])[];

// The Omnivo page that lies on the page block, under every turning page
export const LAST_PAGE: SheetName = 'p5f';
export type SheetName = (typeof SHEET_NAMES)[number];

const PAINTERS: Record<SheetName, (g: CanvasRenderingContext2D) => void> = {
  coverOut: coverRed,
  coverIn: (g) => {
    khataPage(
      g,
      'জমা — খরচ',
      [
        { d: '১/১', t: 'নগদ বিক্রি', a: '৪,৮২,৩০০' },
        { d: '২/১', t: 'রহিম স্টোর (বাকি)', a: '১৮,৪২,৬০০' },
        { d: '৩/১', t: 'মাল কেনা — বাকি', a: '৯,১৫,৪০০' },
        { d: '৪/১', t: 'দোকান ভাড়া', a: '৩৫,০০০' },
        { d: '৫/১', t: 'বিক্রি', a: '১৪,০৯,৫০০' },
        { d: '৬/১', t: 'কর্মচারী বেতন', a: '১,২০,০০০', strike: true, fix: '১,১৫,০০০' },
        {},
        { t: 'মোট', a: '২৩,০৯,৯০০', total: true },
        { t: '', a: '২৩,২৪,৯০০ ?' },
      ],
      [{ text: 'যোগ মেলে না!', x: 300, y: 1060, rot: -0.07 }],
    );
  },
  p1f: pageAccounts,
  p1b: (g) => {
    khataPage(
      g,
      'মালের হিসাব',
      [
        { d: '২/১', t: 'প্যারাসিটামল ৫০০', a: '২০০ পাতা' },
        { t: '— মেয়াদ কবে? খাতায় নাই', small: true },
        { d: '৪/১', t: 'স্যালাইন ৫০০ মি.লি.', a: '১৮০', strike: true, fix: '১৬০' },
        { d: '৭/১', t: 'কটন সুতা ৪০', a: '১২ কোন' },
        { d: '৯/১', t: 'চট্টগ্রাম ডিপোতে পাঠানো', a: '৪০ ব্যাগ' },
        { t: '— ফেরত এসেছে কি?', small: true },
      ],
      [{ text: 'গুদামে গিয়ে গুনতে হবে', x: 230, y: 860, rot: -0.05, size: 44 }],
    );
  },
  p2f: pageStock,
  p2b: (g) => {
    khataPage(
      g,
      'বাকির খাতা',
      [
        { d: '৩/১', t: 'সিলেট ফার্মেসি', a: '৭০,০০০' },
        { d: '৮/১', t: 'করিম ব্রাদার্স', a: '১,১৫,০০০' },
        { t: '— গত ঈদ থেকে', small: true },
        { d: '১২/১', t: 'রূপালী ট্রেডার্স', a: '২,১০,০০০' },
        { d: '১৫/১', t: 'নিউ মডেল ফ্যাশন', a: '২০,০০০', strike: true, fix: 'অগ্রিম?' },
      ],
      [{ text: 'কে কত দিন বাকি??', x: 290, y: 880, rot: 0.04 }],
    );
  },
  p3f: pageAging,
  // The counter's cash box: what should be in the drawer and what was counted, ৳520 apart.
  // 5,000 + 12,430 − 450 = 16,980 expected; 16,460 counted. bKash money is not in the drawer
  p3b: (g) => {
    khataPage(
      g,
      'ক্যাশ বাক্স',
      [
        { d: '২৬/১', t: 'সকালের ক্যাশ', a: '৫,০০০' },
        { d: '২৬/১', t: 'খুচরা বিক্রি', a: '১২,৪৩০' },
        { t: '— কারেন্ট গেল, স্লিপ নাই', small: true },
        { d: '২৬/১', t: 'বিকাশে এল', a: '৩,২০০' },
        { d: '২৬/১', t: 'খরচ — চা, বাজার', a: '৩৫০', strike: true, fix: '৪৫০' },
        {},
        { t: 'থাকার কথা', a: '১৬,৯৮০', total: true },
        { t: 'গুনে পেলাম', a: '১৬,৪৬০' },
      ],
      [{ text: 'ক্যাশে ৫২০ টাকা কম!', x: 250, y: 1020, rot: -0.05 }],
    );
  },
  p4f: pagePos,
  p4b: (g) => {
    khataPage(
      g,
      'কুরিয়ার',
      [
        { d: '২৪/১', t: 'W-১২৩ স্টেডফাস্ট', a: '৫৭৮' },
        { d: '২৪/১', t: 'W-১২৪ স্টেডফাস্ট', a: '৭৩০' },
        { d: '২৫/১', t: 'W-১২৬ স্টেডফাস্ট', a: '৭৯২' },
        { d: '২৫/১', t: 'W-১২৭ পাঠাও — ফেরত?', a: '—' },
        {},
        { t: 'রাইডারের টাকা', a: '২,১০০', total: true },
        { t: 'ব্যাংকে এল', a: '২,০৪০' },
      ],
      [{ text: '৬০ টাকা কম কেন?', x: 270, y: 1000, rot: -0.06 }],
    );
  },
  p5f: pageShop,
  back: coverOmnivo,
};

// Paints every sheet at this quality (canvas pixels per layout unit). The seed is reset so the
// grain and the slants are the same on every repaint
export function paintAll(sheets: Record<SheetName, Sheet>, quality: number): void {
  seed = 11;
  for (const name of SHEET_NAMES) PAINTERS[name](prepare(sheets[name], quality));
}

// The fonts the canvases draw with. stage.ts waits for them before the first paint, because a
// canvas does not repaint itself when a web font arrives the way HTML text does
export const CANVAS_FONTS = [
  `500 40px Atma`,
  `600 40px Atma`,
  `40px "Tiro Bangla"`,
  `400 30px "Geist Variable"`,
  `500 30px "Geist Variable"`,
  `600 30px "Geist Variable"`,
  `400 30px "Geist Mono Variable"`,
  `500 30px "Geist Mono Variable"`,
  `400 30px "Noto Sans Bengali"`,
] as const;
export const CANVAS_FONT_SAMPLE = 'হালখাতা জমা খরচ ১২৩ Omnivo ৳';
