# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Gudril-cool/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Gudril-cool/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer built for the [make.fun png-squeeze bounty](https://make.fun/bounty/png-squeeze-01-run-20261127).

`main.ts` (Node 22, built-in modules only) answers a set of eight 1280×720
RGBA screenshots: for each one it screens every lossless form the image can
be written in — palette by count or by luminance when it holds at most 256
colours, grey or grey+alpha when every pixel is grey, RGB or RGBA otherwise,
with a tRNS key where one exact transparent value allows dropping the alpha
channel — together with the row filters each form can carry (fixed filters,
a minimum-sum choice, a fewest-distinct-pairs choice, and, for grey images,
a brute-force per-row choice weighed by deflating each trial). The winning
form's filtered data is then written with the strongest of a fixed list of
deflate settings: zlib level 9 and level 6 one-shot, level 9 cut into
192/256/384 KiB sync-flush blocks, and level 9 FILTERED in 256 KiB blocks.

The candidate list is fixed and nothing reads the clock, so the program is
deterministic: two runs over the same set write byte-identical files.
Every pixel, including the colours of fully transparent pixels, decodes
exactly as the input.

Run it the way the grader does:

```
MAKEFUN_INPUT_DIR=<set>/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

It reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`), creating each
instance's output directory itself.

## Improvement pass (2026-11-27): optimal-parse stream candidate

The form screen and the zlib candidate suite are unchanged. `strongestStream`
now also compresses the screen winner's filtered dataset with **zopt**, a
zopfli-style optimal-parse deflate compressor written for this entry (pure
JS, no dependencies): a global hash-chain match finder records the longest
and the nearest match per position, a shortest-path parse under a
package-merge length-limited Huffman cost model is iterated four times per
128 KiB block, and the block is emitted with dynamic Huffman codes (fixed or
stored when smaller). The smallest stream wins, exactly as with the existing
candidates, so the addition can only ever shrink the output. All choices are
functions of the data only — no clocks, no randomness — so output stays
byte-for-byte reproducible.

Measured with the kit's practice scorer (this machine):

| | standing | this candidate |
|---|---|---|
| practice score | 712,355 | **726,308** |
| lossless (scorer) | 8/8 | 8/8 |
| total output bytes | 552,250 | 531,823 |
| wall (whole set) | ~12 s | ~27 s (limit 60 s) |
| peak RSS | ~286 MB | ~348 MB (limit 512 MB) |

On a second, independently generated 8-image set from the same generator
(different seed), the same change scored 714,558 → 731,848 with all outputs
pixel-exact, winning on every instance.
