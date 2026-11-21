import { deflateSync, inflateSync } from "node:zlib";

/**
 * Cropping an image (ADR 9006). Bun.Image resizes and re-encodes but has no crop, so the image
 * is read as PNG pixels, a region is copied out into a PNG of its own, and Bun.Image draws that
 * at the size asked.
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGB, three bytes a pixel, rows top to bottom. */
  rgb: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The pixels of a PNG: 8-bit RGB or RGBA, not interlaced (what Bun.Image writes). Anything else throws. */
export function decodePng(png: Uint8Array): Pixels {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("crop: not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const size = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + size);
    if (type === "IHDR") {
      width = v.getUint32(at + 8);
      height = v.getUint32(at + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
        throw new Error(`crop: unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
      }
      channels = color === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(body);
    at += 12 + size;
  }
  if (!width || !height || idat.length === 0) throw new Error("crop: broken PNG");

  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    if (filter === 0) {
      // Unfiltered rows (what an uncompressed PNG holds) are copied as they are.
      px.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
      continue;
    }
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (px[y * stride + i - channels] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (px[(y - 1) * stride + i - channels] ?? 0) : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const est = a + b - c;
        const [pa, pb, pc] = [Math.abs(est - a), Math.abs(est - b), Math.abs(est - c)];
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`crop: PNG filter ${filter}`);
      px[y * stride + i] = (x + p) & 255;
    }
  }
  if (channels === 3) return { width, height, rgb: px };
  const rgb = new Uint8Array(width * height * 3);
  for (let n = 0; n < width * height; n++) rgb.set(px.subarray(n * 4, n * 4 + 3), n * 3);
  return { width, height, rgb };
}

/** A PNG of the `w`×`h` pixels of `p` from (`x`, `y`) (Bun.Image reads no BMP on Linux, so the copy goes out as PNG). */
export function pngOf(p: Pixels, x: number, y: number, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h); // each row: filter byte 0, then RGB
  for (let r = 0; r < h; r++)
    raw.set(p.rgb.subarray(((y + r) * p.width + x) * 3, ((y + r) * p.width + x + w) * 3), r * (w * 3 + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    out.set(Buffer.from(type), 4);
    out.set(body, 8);
    v.setUint32(8 + body.length, Bun.hash.crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 1 })), // only ever read back here or by Bun.Image
    chunk("IEND", new Uint8Array()),
  ]);
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An image read once, so many regions can be cut from it. */
export async function openImage(base64: string) {
  const png = await new Bun.Image(Buffer.from(base64, "base64")).png().bytes();
  const pixels = decodePng(png);
  return {
    width: pixels.width,
    height: pixels.height,
    /**
     * `region` (the image's own pixels, clamped inside it) drawn `out` big, as a base64 JPEG. A `cross` is a red
     * crosshair outlined in white, its four arms around that point of the image and its middle left empty, 52
     * pixels wide (more on a close-up drawn bigger, as the image's pixels grow); a `box` is a red rectangle
     * outlined in white just outside that region of it. A picture with a mark gets a grey margin around it, wide
     * enough for the mark past its edge.
     */
    async crop(
      region: Region,
      out: { width: number; height: number },
      mark?: { cross?: { x: number; y: number }; box?: Region },
    ): Promise<string> {
      const x = Math.min(Math.max(0, Math.floor(region.x)), pixels.width - 1);
      const y = Math.min(Math.max(0, Math.floor(region.y)), pixels.height - 1);
      const w = Math.min(Math.max(1, Math.ceil(region.width)), pixels.width - x);
      const h = Math.min(Math.max(1, Math.ceil(region.height)), pixels.height - y);
      const sized = new Bun.Image(pngOf(pixels, x, y, w, h)).resize(out.width, out.height);
      if (!mark?.box && !mark?.cross) return sized.jpeg({ quality: 70 }).toBase64();
      // Marks go on the picture as sent, in a grey margin around it: drawn on the image first, a box's sides were
      // 20 pixels wide on a close-up three times bigger, and a box's side or a cross's arm on the screen's edge lay
      // over the window's close button there or wasn't there at all (measured).
      // At its own size (the whole screen) the region's pixels are taken as they are, not resized and read back.
      const drawn: Pixels =
        out.width === w && out.height === h
          ? { width: w, height: h, rgb: decodePng(pngOf(pixels, x, y, w, h)).rgb }
          : decodePng(await sized.png({ compressionLevel: 0 }).bytes());
      const [sx, sy] = [drawn.width / w, drawn.height / h];
      // As big as on the screen's own pixels, up to the twice a check's close-up is enlarged (`targets.ts`): an image
      // smaller than it says it is would otherwise get a mark, and a margin, hundreds of times too big.
      const k = Math.min(2, Math.max(1, sx));
      const margin = mark.cross ? Math.ceil(CROSS_ARM * k) : MARGIN;
      const framed: Pixels = {
        width: drawn.width + 2 * margin,
        height: drawn.height + 2 * margin,
        rgb: new Uint8Array((drawn.width + 2 * margin) * (drawn.height + 2 * margin) * 3).fill(128),
      };
      for (let r = 0; r < drawn.height; r++)
        framed.rgb.set(
          drawn.rgb.subarray(r * drawn.width * 3, (r + 1) * drawn.width * 3),
          ((r + margin) * framed.width + margin) * 3,
        );
      const { box, cross } = mark;
      if (box)
        drawBox(framed, {
          x: (box.x - x) * sx + margin,
          y: (box.y - y) * sy + margin,
          width: box.width * sx,
          height: box.height * sy,
        });
      if (cross) drawCross(framed, Math.round((cross.x - x) * sx + margin), Math.round((cross.y - y) * sy + margin), k);
      return new Bun.Image(pngOf(framed, 0, 0, framed.width, framed.height)).jpeg({ quality: 70 }).toBase64();
    },
  };
}

const CROSS_ARM = 26;

/** A crosshair centered on (cx, cy), its middle left empty, `k` times its own size: white, then red inside it. */
function drawCross(p: Pixels, cx: number, cy: number, k: number) {
  const arm = Math.round(CROSS_ARM * k);
  // The middle stays empty, wider than a small control: a cross drawn over one hid it (measured on an 18-px close
  // button, also with a 14-px middle).
  const gap = Math.round(12 * k);
  const paint = (half: number, rgb: [number, number, number]) => {
    const t = Math.max(1, Math.round(half * k));
    for (let d = -arm; d <= arm; d++)
      if (Math.abs(d) >= gap)
        for (let o = -t; o <= t; o++)
          for (const [px, py] of [
            [cx + d, cy + o],
            [cx + o, cy + d],
          ] as const)
            if (px >= 0 && py >= 0 && px < p.width && py < p.height) p.rgb.set(rgb, (py * p.width + px) * 3);
  };
  paint(2.5, [255, 255, 255]);
  paint(1, [230, 0, 0]);
}

/** The grey margin a picture with a box gets on each side, wide enough for a side drawn past the picture's edge. */
const MARGIN = 8;

/** A rectangle's outline just outside `r`, white, then red inside it, kept inside the picture. */
function drawBox(p: Pixels, r: Region) {
  const edge = 3;
  const inside = (v: number, most: number) => Math.min(Math.max(edge, Math.round(v)), most - 1 - edge);
  const [x0, y0, x1, y1] = [
    inside(r.x - edge, p.width),
    inside(r.y - edge, p.height),
    inside(r.x + r.width + edge, p.width),
    inside(r.y + r.height + edge, p.height),
  ];
  const paint = (t: number, rgb: [number, number, number]) => {
    const dot = (px: number, py: number) => {
      if (px >= 0 && py >= 0 && px < p.width && py < p.height) p.rgb.set(rgb, (py * p.width + px) * 3);
    };
    for (let o = -t; o <= t; o++) {
      for (let px = x0 - t; px <= x1 + t; px++) {
        dot(px, y0 + o);
        dot(px, y1 + o);
      }
      for (let py = y0 - t; py <= y1 + t; py++) {
        dot(x0 + o, py);
        dot(x1 + o, py);
      }
    }
  };
  paint(3, [255, 255, 255]);
  paint(1, [230, 0, 0]);
}

/** One region of an image (base64) as a base64 JPEG of the size asked. */
export async function cropImage(base64: string, region: Region, out: { width: number; height: number }) {
  return (await openImage(base64)).crop(region, out);
}
