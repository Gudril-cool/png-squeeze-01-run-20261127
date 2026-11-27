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
  const zopt = zopt2Zlib(data);
  if (zopt.length < best.length) best = zopt;
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

// ---------------------------------------------------------------------------
// zopt: a zopfli-style optimal-parse deflate compressor (pure JS).
//
// The screen's winner dataset is also compressed with this optimal parser and
// the smallest stream wins, so it can only ever help. Method: a global
// hash-chain match finder records, per position, the longest match and the
// nearest match; a shortest-path parse under a package-merge length-limited
// Huffman cost model is iterated (parse -> frequencies -> costs -> parse),
// and each 128 KiB block is emitted with dynamic Huffman codes (fixed or
// stored when either is smaller). Every choice is a function of the data
// only -- no clocks, no randomness -- so output is byte-for-byte
// reproducible.
// ---------------------------------------------------------------------------
const MAX_MATCH = 258, MIN_MATCH = 3, WINDOW = 32768;
const HASH_BITS = 16, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1;
const BLOCK = 131072;
const ITERATIONS = 4;
const CHAIN_LIMIT = 256;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_CODE_OF = new Uint8Array(259);
for (let l = 3; l <= 258; l++) {
  let c = 0;
  while (c < 28 && LEN_BASE[c + 1] <= l) c++;
  LEN_CODE_OF[l] = c;
}
const DIST_CODE_OF = new Uint8Array(32769);
for (let d = 1; d <= 32768; d++) {
  let c = 0;
  while (c < 29 && DIST_BASE[c + 1] <= d) c++;
  DIST_CODE_OF[d] = c;
}
// Candidate match lengths to relax in the DP for a longest match of `bl`:
// all lengths when short; segment boundaries + the longest when long.
const CAND_LENS = (() => {
  const table = new Array(259);
  for (let bl = 0; bl <= 258; bl++) {
    if (bl < MIN_MATCH) { table[bl] = []; continue; }
    if (bl <= 40) {
      const a = [];
      for (let l = MIN_MATCH; l <= bl; l++) a.push(l);
      table[bl] = a;
    } else {
      const s = new Set();
      for (let l = MIN_MATCH; l <= 12; l++) s.add(l);
      for (const b of LEN_BASE) if (b >= MIN_MATCH && b <= bl) s.add(b);
      s.add(bl);
      table[bl] = [...s].sort((a, b) => a - b);
    }
  }
  return table;
})();

// ------------------------------------------------------------ bit writer
class BW {
  constructor() { this.bytes = []; this.buf = 0; this.cnt = 0; }
  put(bits, n) {
    this.buf |= bits << this.cnt;
    this.cnt += n;
    while (this.cnt >= 8) {
      this.bytes.push(this.buf & 0xff);
      this.buf >>>= 8;
      this.cnt -= 8;
    }
  }
  finish() {
    if (this.cnt > 0) this.bytes.push(this.buf & 0xff);
    return new Uint8Array(this.bytes);
  }
}
function revBits(code, n) {
  let r = 0;
  for (let i = 0; i < n; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

// ------------------------------------------- length-limited Huffman lengths
// Package-merge (Katajainen): returns code lengths <= maxBits for freq[].
function limitedLengths(freq, maxBits) {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) { len[syms[0]] = 1; return len; }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  // Packages are arrays of symbol indices (with multiplicity across levels).
  // Node weight = sum of freq of its symbols (counted with multiplicity).
  let level = syms.map((s) => ({ w: freq[s], items: [s] }));
  for (let d = 1; d < maxBits; d++) {
    const packaged = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      packaged.push({ w: level[i].w + level[i + 1].w, items: level[i].items.concat(level[i + 1].items) });
    }
    // merge packaged with the leaf list (both sorted by weight)
    const merged = [];
    let a = 0, b = 0;
    const leaves = syms.map((s) => ({ w: freq[s], items: [s] }));
    while (a < leaves.length || b < packaged.length) {
      if (b >= packaged.length || (a < leaves.length && leaves[a].w <= packaged[b].w)) merged.push(leaves[a++]);
      else merged.push(packaged[b++]);
    }
    level = merged;
  }
  const take = 2 * syms.length - 2;
  for (let i = 0; i < take && i < level.length; i++) {
    for (const s of level[i].items) len[s]++;
  }
  return len;
}
function canonicalCodes(lenArr) {
  const n = lenArr.length;
  const codes = new Uint16Array(n);
  const bl = new Int32Array(16);
  for (let i = 0; i < n; i++) bl[lenArr[i]]++;
  bl[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let b = 1; b < 16; b++) { code = (code + bl[b - 1]) << 1; next[b] = code; }
  for (let i = 0; i < n; i++) if (lenArr[i]) codes[i] = next[lenArr[i]]++;
  return codes;
}

// ------------------------------------------------------------ match finder
function findMatches(data) {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const bestLen = new Uint16Array(n);
  const bestDist = new Uint16Array(n);
  const nearLen = new Uint16Array(n);
  const nearDist = new Uint16Array(n);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + MIN_MATCH <= n; i++) {
    const h = (Math.imul((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2], 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
    let cand = head[h];
    head[h] = i;
    prev[i] = cand;
    if (cand < 0) continue;
    const maxl = Math.min(MAX_MATCH, n - i);
    let bl = 0, bd = 0, tries = 0;
    // Good-length scaling (zlib's idea): once a long match is in hand, only a
    // few more candidates get a chance to beat it.
    let budget = CHAIN_LIMIT;
    while (cand >= 0 && tries < budget) {
      const d = i - cand;
      if (d > WINDOW) break;
      tries++;
      // Only a candidate that matches at offset bl can beat the current best.
      if (bl === 0 || data[cand + bl] === data[i + bl]) {
        let l = 0;
        while (l + 4 <= maxl && dv.getUint32(cand + l) === dv.getUint32(i + l)) l += 4;
        while (l < maxl && data[cand + l] === data[i + l]) l++;
        if (l >= MIN_MATCH) {
          // The chain is walked nearest-first: the first match found is the
          // smallest-distance one.
          if (nearLen[i] === 0) { nearLen[i] = l; nearDist[i] = d; }
          if (l > bl) {
            bl = l; bd = d;
            if (bl >= maxl) break;
            budget = bl >= 128 ? Math.min(budget, tries + 4)
              : bl >= 32 ? Math.min(budget, tries + 16)
              : bl >= 8 ? Math.min(budget, tries + 64)
              : budget;
          }
        }
      }
      cand = prev[cand];
    }
    if (bl >= MIN_MATCH) { bestLen[i] = bl; bestDist[i] = bd; }
  }
  return { bestLen, bestDist, nearLen, nearDist };
}

// ------------------------------------------------------------ optimal parse
// DP over data[from..to). Costs: litCost[286] (symbol 256 = end-of-block is
// NOT charged here; emission adds it), lenSymCost[l] = cost of the length
// symbol + its extra bits for length l, distSymCost[d] likewise per distance.
function optimalParse(data, from, to, bestLen, bestDist, nearLen, nearDist, litCost, lenSymCost, distSymCost) {
  const m = to - from;
  const cost = new Float64Array(m + 1);
  const choice = new Uint16Array(m + 1); // at END offset (rel): 0 literal else match length
  const cdist = new Uint16Array(m + 1);
  for (let i = 1; i <= m; i++) cost[i] = Infinity;
  cost[0] = 0;
  for (let i = 0; i < m; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const pos = from + i;
    const lc = ci + litCost[data[pos]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; choice[i + 1] = 0; }
    const bl = bestLen[pos];
    if (bl >= MIN_MATCH) {
      const d = bestDist[pos];
      const dc = distSymCost[d];
      const cands = CAND_LENS[bl];
      for (let k = 0; k < cands.length; k++) {
        const l = cands[k];
        if (i + l > m) break;
        const c = ci + lenSymCost[l] + dc;
        if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l; cdist[i + l] = d; }
      }
      // The nearest match: shorter, but its distance code may be far cheaper.
      const nl = nearLen[pos];
      const nd = nearDist[pos];
      if (nl >= MIN_MATCH && nd !== d) {
        const ndc = distSymCost[nd];
        const ncands = CAND_LENS[nl];
        for (let k = 0; k < ncands.length; k++) {
          const l = ncands[k];
          if (i + l > m) break;
          const c = ci + lenSymCost[l] + ndc;
          if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l; cdist[i + l] = nd; }
        }
      }
    }
  }
  // Walk back collecting ops (reversed). Each op is one packed integer:
  // 0 = literal; otherwise length * 32769 + distance.
  const ops = [];
  let e = m;
  while (e > 0) {
    const l = choice[e];
    if (l === 0) { ops.push(0); e--; }
    else { ops.push(l * 32769 + cdist[e]); e -= l; }
  }
  ops.reverse();
  return { ops, cost: cost[m] };
}

// ------------------------------------------------------------ block emission
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const FIXED_LIT_LEN = (() => {
  const a = new Uint8Array(288);
  for (let i = 0; i < 288; i++) a[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return a;
})();
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

function rleLengths(allLens) {
  const seq = [];
  for (let k = 0; k < allLens.length;) {
    const v = allLens[k];
    let run = 1;
    while (k + run < allLens.length && allLens[k + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const t = Math.min(r, 138); seq.push(18, t); r -= t; }
      if (r >= 3) { seq.push(17, r); r = 0; }
      while (r-- > 0) seq.push(0, 0);
    } else {
      seq.push(v, 0);
      let r = run - 1;
      while (r >= 3) { const t = Math.min(r, 6); seq.push(16, t); r -= t; }
      while (r-- > 0) seq.push(v, 0);
    }
    k += run;
  }
  return seq; // flat [sym, rep, sym, rep, ...]
}

// Emit ops from optimalParse: each op is 0 (literal, consumes the next data
// byte in order) or a packed match length * 32769 + distance.
function emitOps(bw, data, from, ops, litLen, litCode, distLen, distCode) {
  let p = from;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op === 0) {
      const s = data[p++];
      bw.put(revBits(litCode[s], litLen[s]), litLen[s]);
    } else {
      const l = Math.floor(op / 32769);
      const d = op % 32769;
      const lc = LEN_CODE_OF[l];
      bw.put(revBits(litCode[257 + lc], litLen[257 + lc]), litLen[257 + lc]);
      if (LEN_EXTRA[lc]) bw.put(l - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = DIST_CODE_OF[d];
      bw.put(revBits(distCode[dc], distLen[dc]), distLen[dc]);
      if (DIST_EXTRA[dc]) bw.put(d - DIST_BASE[dc], DIST_EXTRA[dc]);
      p += l;
    }
  }
  bw.put(revBits(litCode[256], litLen[256]), litLen[256]);
}

function emitBlockDynamic(bw, data, from, ops, litFreq, distFreq, last) {
  let hlit = 286;
  while (hlit > 257 && litFreq[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distFreq[hdist - 1] === 0) hdist--;
  const litLen = limitedLengths(litFreq.subarray(0, hlit), 15);
  const distLen = limitedLengths(distFreq.subarray(0, hdist), 15);
  const allLens = [];
  for (let i = 0; i < hlit; i++) allLens.push(litLen[i]);
  for (let i = 0; i < hdist; i++) allLens.push(distLen[i]);
  const seq = rleLengths(allLens);
  const clFreq = new Uint32Array(19);
  for (let k = 0; k < seq.length; k += 2) clFreq[seq[k]]++;
  const clLen = limitedLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  bw.put(last ? 1 : 0, 1);
  bw.put(2, 2);
  bw.put(hlit - 257, 5);
  bw.put(hdist - 1, 5);
  bw.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.put(clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < seq.length; k += 2) {
    const sym = seq[k], rep = seq[k + 1];
    bw.put(revBits(clCode[sym], clLen[sym]), clLen[sym]);
    if (sym === 16) bw.put(rep - 3, 2);
    else if (sym === 17) bw.put(rep - 3, 3);
    else if (sym === 18) bw.put(rep - 11, 7);
  }
  emitOps(bw, data, from, ops, litLen, litCode, distLen, distCode);
}

function emitBlockFixed(bw, data, from, ops, last) {
  const litCode = canonicalCodes(FIXED_LIT_LEN);
  const distCode = canonicalCodes(FIXED_DIST_LEN);
  bw.put(last ? 1 : 0, 1);
  bw.put(1, 2);
  emitOps(bw, data, from, ops, FIXED_LIT_LEN, litCode, FIXED_DIST_LEN, distCode);
}

// Splice a scratch writer's exact bitstream (whole bytes + pending bits)
// into the main writer at its current bit position.
function splice(bw, scratch) {
  for (let i = 0; i < scratch.bytes.length; i++) bw.put(scratch.bytes[i], 8);
  if (scratch.cnt > 0) bw.put(scratch.buf, scratch.cnt);
}
function bitLength(scratch) {
  return scratch.bytes.length * 8 + scratch.cnt;
}

function alignAndStore(bw, data, from, to, last) {
  // Emit a stored block header at the current bit position, then align.
  bw.put(last ? 1 : 0, 1);
  bw.put(0, 2);
  if (bw.cnt > 0) { bw.bytes.push(bw.buf & 0xff); bw.buf = 0; bw.cnt = 0; }
  const len = to - from;
  bw.bytes.push(len & 0xff, (len >>> 8) & 0xff, (~len) & 0xff, ((~len) >>> 8) & 0xff);
  for (let i = from; i < to; i++) bw.bytes.push(data[i]);
}

// ------------------------------------------------------------ main entry
function zopt2Deflate(data) {
  const n = data.length;
  if (n === 0) {
    const scratch = new BW();
    emitBlockFixed(scratch, data, 0, [], true);
    return scratch.finish();
  }
  const { bestLen, bestDist, nearLen, nearDist } = findMatches(data);
  // Initial costs: fixed-Huffman lengths.
  const litCost0 = new Float64Array(286);
  for (let i = 0; i < 286; i++) litCost0[i] = FIXED_LIT_LEN[i];
  const distCost0 = new Float64Array(30).fill(5);
  const bw = new BW();
  for (let from = 0; from < n; from += BLOCK) {
    const to = Math.min(n, from + BLOCK);
    const last = to >= n;
    let bestScratch = null;
    let bestBits = Infinity;
    let curLit = litCost0, curDist = distCost0;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const lenSymCost = new Float64Array(259);
      for (let l = 3; l <= 258; l++) {
        const c = LEN_CODE_OF[l];
        lenSymCost[l] = curLit[257 + c] + LEN_EXTRA[c];
      }
      const distSymCost = new Float64Array(32769);
      for (let d = 1; d <= 32768; d++) {
        const c = DIST_CODE_OF[d];
        distSymCost[d] = curDist[c] + DIST_EXTRA[c];
      }
      const { ops } = optimalParse(data, from, to, bestLen, bestDist, nearLen, nearDist, curLit, lenSymCost, distSymCost);
      // Symbol frequencies of this parse.
      const litFreq = new Uint32Array(286);
      const distFreq = new Uint32Array(30);
      let p = from;
      for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op === 0) { litFreq[data[p++]]++; }
        else {
          const l = Math.floor(op / 32769);
          const d = op % 32769;
          litFreq[257 + LEN_CODE_OF[l]]++;
          distFreq[DIST_CODE_OF[d]]++;
          p += l;
        }
      }
      litFreq[256] = 1;
      if (distFreq.every((f) => f === 0)) distFreq[0] = 1; // a dist tree must exist
      // Emit dynamic and fixed variants into scratch writers; keep smaller.
      for (const variant of ['dyn', 'fix']) {
        const scratch = new BW();
        if (variant === 'dyn') emitBlockDynamic(scratch, data, from, ops, litFreq, distFreq, last);
        else emitBlockFixed(scratch, data, from, ops, last);
        const bits = bitLength(scratch);
        if (bits < bestBits) { bestBits = bits; bestScratch = scratch; }
      }
      // Update the cost model from this parse's Huffman lengths.
      let hlit = 286;
      while (hlit > 257 && litFreq[hlit - 1] === 0) hlit--;
      let hdist = 30;
      while (hdist > 1 && distFreq[hdist - 1] === 0) hdist--;
      const ll = limitedLengths(litFreq.subarray(0, hlit), 15);
      curLit = new Float64Array(286).fill(15);
      for (let i = 0; i < hlit; i++) if (ll[i] !== 0) curLit[i] = ll[i];
      const dl = limitedLengths(distFreq.subarray(0, hdist), 15);
      curDist = new Float64Array(30);
      for (let i = 0; i < 30; i++) curDist[i] = i < hdist && dl[i] !== 0 ? dl[i] : 15;
    }
    // Stored-block fallback if it beats the best compressed variant.
    const storedBits = 3 + ((8 - bw.cnt) % 8) + 32 + (to - from) * 8;
    if (storedBits < bestBits) alignAndStore(bw, data, from, to, last);
    else splice(bw, bestScratch);
  }
  return bw.finish();
}

export function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    b += a;
    if ((i & 0xfff) === 0xfff) { a %= 65521; b %= 65521; }
  }
  a %= 65521; b %= 65521;
  return ((b << 16) | a) >>> 0;
}

function zopt2Zlib(data) {
  const raw = zopt2Deflate(data);
  const ad = adler32(data);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  out[raw.length + 2] = (ad >>> 24) & 0xff;
  out[raw.length + 3] = (ad >>> 16) & 0xff;
  out[raw.length + 4] = (ad >>> 8) & 0xff;
  out[raw.length + 5] = ad & 0xff;
  return out;
}

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
