// png-squeeze: rewrite each screenshot of a set as the smallest lossless PNG.
//
// For every instance under /input/<id>/ the program decodes the stored RGBA
// screenshot, screens the lossless forms the image can be written in
// (palette, grey, grey+alpha, RGB, RGBA, with a tRNS key where one exact
// transparent value allows it) and the row filters each form can carry,
// weighs every candidate by a level-6 zlib stream, then writes the winner's
// filtered data with the strongest of a fixed list of deflate settings:
// level 9 one-shot, level 6 one-shot, level 9 cut into 192/256/384 KiB
// sync-flush blocks, and level 9 FILTERED in 256 KiB blocks. The candidate
// list is fixed and nothing reads the clock, so two runs write the same
// bytes. Only Node's built-in modules are used.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, createDeflate, inflateSync, constants } from 'node:zlib';

// ---------------------------------------------------------------- PNG codec

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Assemble a PNG file from [type, data] chunk pairs, CRCs computed. */
function buildPng(chunks) {
  let total = 8;
  for (const [, data] of chunks) total += 12 + data.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrBytes(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG of any colour type the contest reads (bit depth 8, not
 * interlaced) into RGBA bytes, four per pixel, rows top to bottom.
 * Transparent-key and palette alpha are expanded exactly.
 */
function decodeToRgba(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let head = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let sawEnd = false;
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      head = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        colourType: data[9],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') sawEnd = true;
    at += 12 + len;
  }
  if (!head || !sawEnd || idatParts.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = head;
  const ch = CHANNELS[colourType];
  const stride = width * ch;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), {
    maxOutputLength: height * (stride + 1) + 1,
  });
  // Reverse the row filters in place into a samples buffer.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= ch ? samples[o + i - ch] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= ch ? samples[o + i - ch] : 0;
        const up = y > 0 ? samples[p + i] : 0;
        samples[o + i] = raw[src + i] + ((left + up) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? samples[o + i - ch] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= ch ? samples[p + i - ch] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    } else throw new Error('filter type ' + ft);
  }
  // Expand the samples to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[i];
      rgba[d + 3] = samples[i] === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    // Colour type 3: palette indices, alpha from tRNS where present.
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { rgba, width, height };
}

// ------------------------------------------------------------- image forms

/** The RGBA bytes as 32-bit words (a copy when the offset is unaligned). */
function wordsOf(rgba) {
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >>> 2);
}

/**
 * One pass over the pixels: is every pixel opaque, is every pixel grey, and
 * the colour histogram while it holds at most 256 distinct colours.
 */
function analyseImage(rgba) {
  const n = rgba.length >>> 2;
  const words = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  let overflow = false;
  const counts = new Map();
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!overflow) {
      const w = words[i];
      const seen = counts.get(w);
      if (seen === undefined) {
        if (counts.size === 256) overflow = true;
        else counts.set(w, 1);
      } else counts.set(w, seen + 1);
    }
  }
  let colours = null;
  if (!overflow) {
    colours = [...counts.entries()].map(([word, count]) => {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      return { word, count, r: b[0], g: b[1], bl: b[2], a: b[3] };
    });
  }
  return { opaque, grey, colours };
}

/**
 * The single fully transparent value an image may carry as a tRNS key
 * instead of an alpha channel: every non-opaque pixel has alpha 0 and that
 * exact value, and no opaque pixel shares it. Null when there is none.
 */
function transparentKeyOf(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (v !== key) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The samples of the image in a channel colour type (0, 2, 4 or 6). */
function samplesFor(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    out[s] = rgba[d];
    if (colourType === 4) out[s + 1] = rgba[d + 3];
    else if (colourType === 2) {
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/**
 * A palette form for a colour list: entries ordered with the transparent
 * ones first (so the tRNS chunk stays short), the rest by count or by
 * luminance, plus the per-pixel index bytes.
 */
function paletteFormOf(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.bl;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const indexOf = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let lastTransparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.bl;
    if (c.a !== 255) lastTransparent = i + 1;
  });
  const trns = lastTransparent === 0
    ? null
    : Uint8Array.from(entries.slice(0, lastTransparent), (c) => c.a);
  const words = wordsOf(rgba);
  const indices = new Uint8Array(words.length);
  for (let i = 0; i < words.length; i++) indices[i] = indexOf.get(words[i]);
  return { plte, trns, indices };
}

/**
 * The forms an image can be screened in. A palette of a non-grey image
 * holds it in a third of the RGB bytes or less, so its channel form is not
 * screened; a grey image screens both its palette and its grey form.
 */
function formsToScreen(rgba) {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms = [];
  if (colours !== null) {
    const byCount = paletteFormOf(rgba, colours, 'count');
    forms.push({ colourType: 3, bpp: 1, samples: byCount.indices, plte: byCount.plte, trns: byCount.trns, filters: [0] });
    const byLum = paletteFormOf(rgba, colours, 'luminance');
    forms.push({ colourType: 3, bpp: 1, samples: byLum.indices, plte: byLum.plte, trns: byLum.trns, filters: [0, 'minsum', 'brute'] });
    if (!grey) return { forms, grey };
  }
  const key = opaque ? null : transparentKeyOf(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({
    colourType,
    bpp,
    samples: samplesFor(rgba, colourType),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return { forms, grey };
}

// ------------------------------------------------------------------ filters

/** Filter one row of samples by `type` into out (PNG filters 0 to 4). */
function applyFilter(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + up) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

/** The minimum-sum heuristic's cost: a filtered row's bytes as signed values. */
function signedAbsSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** The pairs heuristic's cost: distinct neighbouring byte pairs in a row. */
function distinctPairs(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768; // bytes of history a brute-force trial deflates after
const BRUTE_LEVEL = 4; // the zlib level brute force weighs trials at

/**
 * The filtered raw data of an image: every row behind its filter byte.
 * `choice` is a fixed filter type for all rows, or 'minsum', 'pairs' or
 * 'brute' to pick per row (brute deflates each trial after the history
 * written so far and keeps the smallest). The lower type wins a tie.
 */
function filteredData(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const out = raw ?? new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      applyFilter(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const history = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      applyFilter(t, cur, prev, bpp, trials[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedAbsSum(trials[t].subarray(1));
      else if (choice === 'pairs') cost = distinctPairs(trials[t].subarray(1), seen, ++stamp);
      else if (history.length === 0) cost = deflateSync(trials[t], { level: BRUTE_LEVEL, memLevel: 9 }).length;
      else cost = deflateSync(trials[t], { level: BRUTE_LEVEL, memLevel: 9, dictionary: history }).length;
      if (cost < bestCost) {
        bestCost = cost;
        type = t;
      }
    }
    out.set(trials[type], at);
  }
  return out;
}

// -------------------------------------------------------- screen and encode

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

/** The bytes a form's PLTE and tRNS chunks take in the file. */
function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

/**
 * The screen: every form and filter choice weighed by its level-6 zlib
 * stream plus its palette/tRNS chunk bytes; the smallest wins, the first on
 * a tie. Brute-force row choice is screened only when `brute` is set (the
 * caller sets it for grey images, where it measurably pays).
 */
function screenForms(forms, width, height, brute) {
  let best = null;
  let spare = null;
  for (const form of forms) {
    const size = height * (width * form.bpp + 1);
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      if (!brute && choice === 'brute') continue;
      const data = filteredData(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : undefined);
      spare = null;
      const stream = deflateSync(data, SCREEN_OPTS);
      const bytes = stream.length + overhead;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, data, bytes };
      } else {
        spare = data;
      }
    }
  }
  return best;
}

/** Deflate `data` in sync-flush blocks of `chunk` bytes: fresh Huffman trees per block. */
function deflateInChunks(data, chunk, level, strategy) {
  return new Promise((resolve, reject) => {
    const engine = createDeflate({ level, memLevel: 9, strategy });
    const parts = [];
    engine.on('data', (c) => parts.push(c));
    engine.on('error', reject);
    engine.on('end', () => resolve(Buffer.concat(parts)));
    let at = 0;
    const step = () => {
      if (at >= data.length) {
        engine.end();
        return;
      }
      const end = Math.min(at + chunk, data.length);
      const last = end >= data.length;
      engine.write(data.subarray(at, end), () => {
        if (last) {
          engine.end();
          return;
        }
        engine.flush(constants.Z_SYNC_FLUSH, () => {
          at = end;
          step();
        });
      });
    };
    step();
  });
}

/** The strongest stream of a fixed candidate list over the winner's data. */
async function strongestStream(data) {
  let best = deflateSync(data, { level: 9, memLevel: 9 });
  const level6 = deflateSync(data, { level: 6, memLevel: 8 });
  if (level6.length < best.length) best = level6;
  for (const chunk of [192 * 1024, 256 * 1024, 384 * 1024]) {
    const z = await deflateInChunks(data, chunk, 9, constants.Z_DEFAULT_STRATEGY);
    if (z.length < best.length) best = z;
  }
  const filtered = await deflateInChunks(data, 256 * 1024, 9, constants.Z_FILTERED);
  if (filtered.length < best.length) best = filtered;
  return best;
}

/** The PNG file of an image written in `form` with IDAT stream `idat`. */
function pngForForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrBytes(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return buildPng(chunks);
}

/** Squeeze one screenshot: decode, screen, deflate, assemble. */
async function squeeze(bytes) {
  const { rgba, width, height } = decodeToRgba(bytes);
  const { forms, grey } = formsToScreen(rgba);
  const winner = screenForms(forms, width, height, grey);
  const stream = await strongestStream(winner.data);
  return pngForForm(width, height, winner.form, stream);
}

// --------------------------------------------------------------------- main

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

async function main() {
  for (const id of readdirSync(INPUT_DIR).sort()) {
    const bytes = readFileSync(join(INPUT_DIR, id, 'image.png'));
    const png = await squeeze(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
  }
}

await main();
