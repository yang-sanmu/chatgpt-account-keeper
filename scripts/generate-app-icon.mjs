/**
 * Generates the application icon from vector definitions.
 *
 * Outputs (all committed, so a normal build never needs this script):
 *   desktop/src/GptAccountKeeper.Desktop/app-icon.ico  -> <ApplicationIcon> + `vpk pack --icon`
 *   desktop/src/GptAccountKeeper.Desktop/app-icon.png  -> 256px master, embedded by AppIcon.cs
 *   Application/AppIcon.cs                             -> base64 payload rewritten in place
 *
 * Run with `node scripts/generate-app-icon.mjs` after editing the artwork below.
 * No third-party dependencies: shapes are rasterised from signed distance fields
 * and the PNG/ICO containers are written by hand.
 *
 * Two things the artwork must preserve, because both were user-visible bugs:
 *   - a transparent margin on every side. A badge that bleeds into the canvas
 *     edge shows up as a dark box around the icon.
 *   - a mid-tone badge fill. Near-black artwork is indistinguishable from a
 *     dark shell background.
 *
 * Currently Windows-only, because that is the only platform the project ships.
 * The artwork itself is platform neutral: `render(size)` takes any size, so the
 * M6 macOS/Linux assets are new container encoders over the same shapes, not new
 * artwork -- add an .icns writer (16/32/128/256/512 plus @2x) and an XDG hicolor
 * PNG set beside `encodeIco`. Keep `simplify` in mind for Linux trays, whose
 * sizes vary by desktop environment.
 */
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.join(
  repositoryRoot,
  "desktop/src/GptAccountKeeper.Desktop",
);

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

// Coordinates are a 0..1 unit square, y pointing down, so the artwork is
// resolution independent and every size below renders from the same source.
//
// The margin shrinks at small sizes: 5.5% of 16px is under a pixel, so keeping
// the large-size margin there would spend the icon's whole pixel budget on
// empty space. It never reaches 0 -- the transparent border is what stops the
// taskbar from drawing a box around the icon.
const marginFor = (size) => (size <= 24 ? 0.035 : 0.055);

const BADGE_TOP = [0x22, 0xc8, 0x9e];
const BADGE_BOTTOM = [0x0b, 0x7d, 0x63];
const GLYPH = [0xff, 0xff, 0xff];
const KEYHOLE = [0x0a, 0x6b, 0x55];

const length = (x, y) => Math.hypot(x, y);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle. Negative inside. */
function sdRoundRect(px, py, cx, cy, halfX, halfY, radius) {
  const r = Math.min(radius, Math.min(halfX, halfY));
  const qx = Math.abs(px - cx) - (halfX - r);
  const qy = Math.abs(py - cy) - (halfY - r);
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, radius) {
  return length(px - cx, py - cy) - radius;
}

/** Signed distance to a triangle (Inigo Quilez's formulation). */
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;

  const proj = (vx, vy, ex, ey) => {
    const t = clamp01((vx * ex + vy * ey) / (ex * ex + ey * ey));
    return [vx - ex * t, vy - ey * t];
  };
  const [p0x, p0y] = proj(v0x, v0y, e0x, e0y);
  const [p1x, p1y] = proj(v1x, v1y, e1x, e1y);
  const [p2x, p2y] = proj(v2x, v2y, e2x, e2y);

  // The squared distance and the winding sign are minimised independently
  // (componentwise), which is what makes the result signed.
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const distance = Math.min(
    p0x * p0x + p0y * p0y,
    p1x * p1x + p1y * p1y,
    p2x * p2x + p2y * p2y,
  );
  const winding = Math.min(
    s * (v0x * e0y - v0y * e0x),
    s * (v1x * e1y - v1y * e1x),
    s * (v2x * e2y - v2y * e2x),
  );
  return -Math.sqrt(distance) * Math.sign(winding);
}

/**
 * Distance to the speech bubble (accounts/conversations) that holds the
 * keyhole in its counter. Large sizes only -- see `render`.
 */
function sdBubble(px, py) {
  const body = sdRoundRect(px, py, 0.5, 0.452, 0.295, 0.235, 0.105);
  // Kept deliberately stubby and wide-based. A long thin tail is the first
  // thing to break up at 32px, where it renders as a detached speck.
  const tail = sdTriangle(px, py, 0.33, 0.62, 0.515, 0.62, 0.37, 0.805);
  return Math.min(body, tail);
}

/**
 * Distance to the keyhole (kept credentials).
 *
 * `bold` is the small-size cut: the keyhole becomes the whole glyph, drawn
 * white directly on the badge, so it gets the full pixel budget instead of
 * sharing it with a bubble outline.
 */
function sdKeyhole(px, py, bold) {
  if (bold) {
    const head = sdCircle(px, py, 0.5, 0.405, 0.15);
    const stem = sdTriangle(px, py, 0.415, 0.68, 0.585, 0.68, 0.5, 0.42);
    return Math.min(head, stem);
  }
  const head = sdCircle(px, py, 0.5, 0.408, 0.079);
  const stem = sdTriangle(px, py, 0.462, 0.575, 0.538, 0.575, 0.5, 0.42);
  return Math.min(head, stem);
}

/**
 * Renders one square RGBA frame. Returns a Buffer of size*size*4.
 *
 * `forceSimplify` renders the small-size artwork at a larger raster. The tray
 * needs it: Avalonia hands Win32 a single bitmap and Windows downsamples it to
 * 16-24px, so the tray raster must carry artwork that survives that scale even
 * though the raster itself is bigger.
 */
function render(size, forceSimplify = false) {
  // At and below 24px the bubble outline and its counter cannot both survive:
  // the bubble collapses into a white rectangle and the keyhole inside it into
  // a smudge. These sizes drop the bubble and draw a bold white keyhole on the
  // badge instead. Size-specific artwork is normal practice for icons.
  const simplify = forceSimplify || size <= 24;
  const margin = marginFor(simplify ? 24 : size);
  const out = Buffer.alloc(size * size * 4);
  // Analytic coverage from the distance field: crisper at 16px than
  // supersampling, and stable because every edge is a true SDF.
  const px = 1 / size;
  const coverage = (d) => clamp01(0.5 - d / px);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) * px;
      const uy = (y + 0.5) * px;

      const badgeHalf = 0.5 - margin;
      const aBadge = coverage(
        sdRoundRect(ux, uy, 0.5, 0.5, badgeHalf, badgeHalf, simplify ? 0.16 : 0.205),
      );
      // Vertical gradient across the badge only, so the ramp does not shift
      // with the transparent margin.
      const t = clamp01((uy - margin) / (1 - 2 * margin));
      let r = mix(BADGE_TOP[0], BADGE_BOTTOM[0], t);
      let g = mix(BADGE_TOP[1], BADGE_BOTTOM[1], t);
      let b = mix(BADGE_TOP[2], BADGE_BOTTOM[2], t);

      // Both glyph layers sit fully inside the badge, so they can be
      // composited as opaque paint before the badge alpha is applied.
      if (simplify) {
        const aKey = coverage(sdKeyhole(ux, uy, true));
        r = mix(r, GLYPH[0], aKey);
        g = mix(g, GLYPH[1], aKey);
        b = mix(b, GLYPH[2], aKey);
      } else {
        const aBubble = coverage(sdBubble(ux, uy));
        r = mix(r, GLYPH[0], aBubble);
        g = mix(g, GLYPH[1], aBubble);
        b = mix(b, GLYPH[2], aBubble);

        // Clipped to the bubble so the keyhole cannot spill onto the badge.
        const aKey = coverage(sdKeyhole(ux, uy, false)) * aBubble;
        r = mix(r, KEYHOLE[0], aKey);
        g = mix(g, KEYHOLE[1], aKey);
        b = mix(b, KEYHOLE[2], aKey);
      }

      const o = (y * size + x) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(aBadge * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(rgba, size) {
  const stride = size * 4;
  // Filter type 1 (Sub) on every row: flat fills and the vertical gradient
  // both collapse to long runs of zero, which deflate compresses far better
  // than unfiltered rows.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1;
    for (let x = 0; x < stride; x++) {
      const prior = x >= 4 ? rgba[y * stride + x - 4] : 0;
      raw[rowStart + 1 + x] = (rgba[y * stride + x] - prior) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container
// ---------------------------------------------------------------------------

/**
 * Encodes a frame as a 32-bit BMP (BITMAPINFOHEADER, bottom-up BGRA).
 *
 * PNG-compressed ICO entries only became legal in Vista, and some shell and
 * tooling paths still read the small sizes as DIBs. The small sizes are where
 * a fallback would be most visible, so they ship as BMP and only 128/256 use
 * PNG (where the size saving is worth it).
 */
function encodeBmp(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour data + AND mask
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // BMP rows run bottom-up
    const dst = y * size * 4;
    for (let x = 0; x < size; x++) {
      pixels[dst + x * 4] = rgba[src + x * 4 + 2]; // B
      pixels[dst + x * 4 + 1] = rgba[src + x * 4 + 1]; // G
      pixels[dst + x * 4 + 2] = rgba[src + x * 4]; // R
      pixels[dst + x * 4 + 3] = rgba[src + x * 4 + 3]; // A
    }
  }

  // The AND mask is ignored for 32-bit entries but must still be allocated,
  // and its rows are padded to 4 bytes.
  const maskStride = (((size + 31) >> 5) << 2);
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = [];
  const payloads = [];
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// The window icon is downscaled by the compositor from a single raster, so it
// ships large. The tray raster is smaller and uses the simplified artwork,
// because Windows renders it at 16-24px.
const WINDOW_SIZE = 256;
const TRAY_SIZE = 64;

const frames = ICO_SIZES.map((size) => {
  const rgba = render(size);
  return { size, data: size >= 128 ? encodePng(rgba, size) : encodeBmp(rgba, size) };
});

const icoPath = path.join(projectRoot, "app-icon.ico");
const pngPath = path.join(projectRoot, "app-icon.png");
const windowPng = encodePng(render(WINDOW_SIZE), WINDOW_SIZE);
const trayPng = encodePng(render(TRAY_SIZE, true), TRAY_SIZE);

fs.writeFileSync(icoPath, encodeIco(frames));
fs.writeFileSync(pngPath, windowPng);

// Rewrite both base64 payloads in AppIcon.cs so the embedded copies can never
// drift from the generated artwork.
const appIconSource = path.join(projectRoot, "Application/AppIcon.cs");
let source = fs.readFileSync(appIconSource, "utf8");

const wrap = (buffer) =>
  (buffer.toString("base64").match(/.{1,116}/g) ?? [])
    .map((line, index) => (index === 0 ? `        "${line}"` : `        + "${line}"`))
    .join("\n");

for (const [name, buffer] of [
  ["WindowPngBase64", windowPng],
  ["TrayPngBase64", trayPng],
]) {
  // Tested separately from the replacement result: an unchanged file is a
  // legitimate outcome (re-running with no artwork change), so it must not be
  // reported as a failed match.
  const literal = new RegExp(`(private const string ${name} =\\r?\\n)[\\s\\S]*?;\\r?\\n`);
  if (!literal.test(source)) {
    throw new Error(`Could not locate the ${name} literal in AppIcon.cs`);
  }
  source = source.replace(literal, `$1${wrap(buffer)};\n`);
}
fs.writeFileSync(appIconSource, source);

if (process.argv.includes("--preview")) {
  const previewRoot = path.join(repositoryRoot, "tmp/icon-preview");
  fs.mkdirSync(previewRoot, { recursive: true });
  for (const size of [16, 24, 32, 48, 256]) {
    fs.writeFileSync(
      path.join(previewRoot, `icon-${size}.png`),
      encodePng(render(size), size),
    );
    // Nearest-neighbour blow-up so small-size rendering can be eyeballed.
    const scale = Math.max(1, Math.round(256 / size));
    const small = render(size);
    const big = size * scale;
    const zoomed = Buffer.alloc(big * big * 4);
    for (let y = 0; y < big; y++) {
      for (let x = 0; x < big; x++) {
        const s = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
        small.copy(zoomed, (y * big + x) * 4, s, s + 4);
      }
    }
    fs.writeFileSync(path.join(previewRoot, `zoom-${size}.png`), encodePng(zoomed, big));
  }
  fs.writeFileSync(path.join(previewRoot, "tray-raster.png"), trayPng);
  console.log(`previews -> ${previewRoot}`);
}

console.log(
  `${path.relative(repositoryRoot, icoPath)}  ` +
    `${ICO_SIZES.length} sizes, ${fs.statSync(icoPath).size} bytes`,
);
console.log(`${path.relative(repositoryRoot, pngPath)}  ${windowPng.length} bytes`);
console.log(`AppIcon.cs  window ${windowPng.length}B / tray ${trayPng.length}B embedded`);
