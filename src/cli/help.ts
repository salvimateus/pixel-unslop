import { PARAMS } from '../core/params.ts';

const presets = PARAMS.palette.presets;
const sizing = PARAMS.sizing;

const OVERVIEW = `Pixel Unslop: turns AI-generated pixel art into clean, flat pixel art. Deterministic: the same input and options always give the same bytes.

Usage:
  pixel-unslop clean <input.png>... [options]     clean AI pixel art and write flat pixel art PNG files
  pixel-unslop inspect <input.png>... [options]   print the detected grid and the palette, write no image
  pixel-unslop edit <sprite.png> [options]        edit a clean sprite (1 image pixel = 1 tile)
  pixel-unslop help [command]                     full usage with examples
  pixel-unslop --version

How it works: the tool finds the grid of art pixels (the size of one art pixel comes from the image), then
each tile takes the color with the largest area in its center and becomes one flat color. A palette merge
then makes near-equal colors identical. Input is PNG only.
The output is always 1 image pixel for each art pixel, so all assets of a game stay on the same grid.
Each output is also cropped to the box of its opaque pixels, so it has the smallest size and loses no
opaque pixel (--no-trim keeps the full frame).

Exit codes: 0 success, 1 runtime error (a file failed), 2 usage error (bad command or option).
Errors go to stderr as one line: "error <code>: <message>". With --json, stdout also gets
{ "ok": false, "error": { "code", "message" } } for a usage or fatal error.
Error codes: usage, file-not-found, read-failed, not-an-image, decode-failed, too-small, too-large,
empty-image, too-many-cells, output-exists, write-failed, bad-palette, internal.

Run "pixel-unslop help clean", "help inspect" or "help edit" for the options, the JSON report and examples.`;

const PIPELINE = `Grid options (clean and inspect):
  --pixel-size <n | WxH>   Size of one art pixel in source pixels (float, e.g. 2.65 or 9x10). Used as a hint:
                           the tool refines it within ${Math.round(PARAMS.pitch.hintWindow * 100)}%. One number gives square art pixels;
                           WxH with two different values asks for non-square art pixels.
                           Default: detect the size. Art pixels are square unless you ask otherwise.
  --exact                  Use --pixel-size exactly, with no refinement. The phase is still detected.
  --offset <x,y>           Move the whole fitted grid by x,y source pixels (float), as one rigid body: no cell
                           changes its size, and the choice of an elastic or a regular grid does not change.
  --elastic <auto|on|off>  Elastic grid that follows drawn edges when the AI art drifts. Default: auto
                           (used only for a pixel size of ${PARAMS.elastic.minPeriod} or more, with a grid quality of
                           ${PARAMS.elastic.minQuality} or more, when it fits clearly better).
  --shared-pixel-size      With several inputs (pieces of one sheet): detect one pixel size for the full set
                           and use it for each input (each input refines it within ${Math.round(PARAMS.pitch.squareSlack * 100)}%).
                           Recommended for small, blurred pieces: one small piece alone often has too
                           little evidence, and then its report says quality 1 and "weak-grid".
Color options:
  --cleanup <off|light|normal|strong|number>
                           Palette merge strength (OKLab distance). off ${presets.off}, light ${presets.light},
                           normal ${presets.normal}, strong ${presets.strong}. Default: normal.
  --max-colors <n>         Merge the closest colors until at most n remain.
  --shared-palette         With several inputs: merge the colors of the full set, so all outputs share one palette.
  --palette <path>         Map every color to the nearest color of a fixed palette (OKLab). The file is a
                           text file with one #rrggbb per line, or a PNG whose opaque colors are the palette.
  --reference <path>       Give each color the nearest color (OKLab) of a reference PNG. The lightness
                           difference between the image and the reference is corrected first. A
                           reference with at most ${PARAMS.pitch.nativeMaxColors} colors is a clean sprite: its pixels are its colors.
                           Other references are AI pixel art: automatic grid, then --cleanup. With
                           --shared-palette, all inputs use one color map. Not with --palette.
  --erase-background       Make the background that touches the border transparent (a solid color or a
                           fake checkerboard of up to ${PARAMS.background.maxColors} colors).
  --swap <from=to>         Replace one color everywhere. Repeatable. "to" can be "transparent".
                           Order after the merge: --reference or --palette, --erase-background, then each --swap.
Size options (by default each output is cropped to the box of its opaque tiles, after --erase-background
and the other color operations; no opaque tile is cut, and a result with no opaque tile fails with "empty-image"):
  --no-trim                Keep the full frame, e.g. for the frames of an animation that must keep one size.
                           A fully transparent result is then written.
  --trim                   Accepted for older commands; it has no effect, because the crop is the default.
  --height <h | input=h>   Resize the output to h tiles high; the width keeps the proportion and no new color
                           is made. Repeatable. h alone is for every input; input=h is for one input, by its
                           path as given or by its file name (input=h wins over h). Not with --no-trim.
                           Each output tile takes the color with the largest area under it (equal areas: the
                           darker color); a tile is transparent only when more than half of it is transparent.
                           A height of a whole reduction (1/2 to 1/${sizing.maxReduction}, see "object.reductions") or a
                           whole enlargement (2x to ${sizing.maxEnlargement}x) gives the cleanest result. Largest height:
                           ${sizing.maxEnlargement} times the cropped height. Order: merge, color operations, crop, resize.
Other options:
  --grid-preview <path>    Write a PNG of the source, upscaled so one art pixel is at least ${PARAMS.preview.minCellSide} px, with the
                           fitted grid lines (alternate magenta and green). With several inputs, <path> is a
                           folder and each preview is <name>-grid.png. Use it to check the grid by eye.
  --overwrite              Permit the replacement of existing output files. Without it, the tool refuses.
  --json                   Print one JSON report on stdout (no other text on stdout).`;

const GRID_JSON = `      "grid": {
        "cols": 41, "rows": 46,                 tiles per row and per column
        "pixelSize": { "x": 2.6461, "y": 2.7437 }, art pixel size in source pixels
        "offset": { "x": 1.54, "y": 2.09 },     grid phase in source pixels
        "coherence": { "x": 0.21, "y": 0.33 },  share of the edges on the grid, 0 to 1
        "elastic": { "x": false, "y": false },  true when the elastic fit is used on that axis
        "quality": 2,                           1 weak (check the grid, or give --pixel-size),
                                                2 fair, 3 good
        "notes": []                             any of: harmonic-down, harmonic-up, weak-grid,
                                                native-resolution, elastic
      },
      "object": {                               the box of the opaque tiles before the resize (the output
                                                size unless --no-trim); null when no tile is opaque
        "cols": 41, "rows": 46,
        "reductions": { "1/2": 23, "1/3": 16 }  --height value of each whole reduction (no repeated height)
      },
      "resize": { "fromRows": 46, "height": 23, "step": 2 } or null,
                                                step: source tiles per output tile (0.5 is a 2x enlargement)`;

const CLEAN = `pixel-unslop clean <input.png>... [options]

Cleans AI pixel art. Each output PNG has one image pixel per tile (one art pixel), always.

Output options:
  -o, --output <path>      Output file, for one input.
  --out-dir <dir>          Output folder (must exist), for one or many inputs.
                           Default name: <input name>-pixel-<cols>x<rows>.png next to the input.
                           The largest output side is ${PARAMS.limits.maxExportSide} px.
  --write-palette <path>   Write the final palette as text, one #rrggbb per line (all outputs together).
  --optimize               Write the smallest lossless PNG (indexed colors when 256 or fewer, strongest
                           compression). The pixels stay exactly the same. Default: plain RGBA PNG.

${PIPELINE}

JSON report (--json):
  {
    "ok": true,                                false when any input failed (exit code 1)
    "command": "clean",
    "sharedPixelSize": { "x": 2.6461, "y": 2.7437 } or null,
    "results": [
      {
        "input": "/abs/in.png", "ok": true,
        "output": "/abs/in-pixel-41x46.png",
        "width": 41, "height": 46,               output size in pixels (one pixel per tile)
        "optimized": false, "fileSize": 2318,    true with --optimize; fileSize: output file in bytes
${GRID_JSON}
        "colors": 12, "transparentTiles": 310,
        "palette": [ { "color": "#1a1520", "count": 402 } ],  sorted by count
        "gridPreview": "/abs/grid.png" or null
      },
      { "input": "/abs/bad.png", "ok": false, "error": { "code": "not-an-image", "message": "..." } }
    ],
    "paletteFile": { "path": "/abs/palette.txt", "colors": ["#1a1520"] } or null
  }

Examples:
  pixel-unslop clean hero.png
  pixel-unslop clean hero.png -o hero-clean.png --erase-background
  pixel-unslop clean pieces/*.png --out-dir clean --shared-pixel-size --shared-palette --write-palette clean/palette.txt
  pixel-unslop clean hero.png --pixel-size 9.4 --grid-preview hero-grid.png --json
  pixel-unslop clean hero.png --pixel-size 8 --exact --offset 2,3 --elastic off
  pixel-unslop clean hero.png --palette pico8.txt --cleanup strong --max-colors 16
  pixel-unslop clean hero-run.png --reference hero-idle-pixel-41x46.png
  pixel-unslop clean hero.png --swap "#ffffff=transparent" --overwrite
  pixel-unslop clean pieces/*.png --out-dir clean --shared-palette --optimize

Set example (the monkey must be half as tall as the tree, with one palette for both):
  pixel-unslop inspect tree.png monkey.png --shared-palette --erase-background --json
  pixel-unslop clean tree.png monkey.png --out-dir set --shared-palette --erase-background --height tree.png=120 --height monkey.png=60`;

const INSPECT = `pixel-unslop inspect <input.png>... [options]

Prints the detected grid and the palette that "clean" would give with the same options. Writes no image,
except --grid-preview.

${PIPELINE}

JSON report (--json):
  {
    "ok": true, "command": "inspect",
    "sharedPixelSize": { "x": 2.6461, "y": 2.7437 } or null,
    "results": [
      {
        "input": "/abs/in.png", "ok": true,
        "width": 110, "height": 125,             source size in pixels
${GRID_JSON}
        "colors": 12, "transparentTiles": 310,
        "palette": [ { "color": "#1a1520", "count": 402 } ],
        "gridPreview": "/abs/grid.png" or null
      }
    ]
  }

Examples:
  pixel-unslop inspect hero.png
  pixel-unslop inspect hero.png --json
  pixel-unslop inspect hero.png --grid-preview hero-grid.png
  pixel-unslop inspect pieces/*.png --shared-pixel-size --json
  pixel-unslop inspect hero.png --pixel-size 2.65 --cleanup light
  pixel-unslop inspect tree.png monkey.png --shared-palette --erase-background --json
  pixel-unslop clean walk-*.png --out-dir walk --shared-palette --erase-background --no-trim`;

const EDIT = `pixel-unslop edit <sprite.png> [options]

Edits a clean sprite: 1 image pixel = 1 tile (or k x k pixels with --from-scale k). The output is always
1 image pixel per tile, so --from-scale also brings an upscaled asset back to 1x. Alpha below 128 is
transparent; every other pixel becomes opaque. The operations run in the order given on the command line,
with the tile coordinates of the input. Then the output is cropped to the box of its opaque tiles.

Operations (each one is repeatable):
  --set <x,y=color>        Set one tile.
  --erase <x,y>            Make one tile transparent.
  --fill <x,y=color>       Flood fill: the 4-connected region with exactly the color of tile x,y.
  --swap <from=to>         Replace one color everywhere.
  --erase-color <color>    Make one color transparent everywhere.
  --erase-background       Make the background that touches the border transparent.
  --palette <path>         Map every color to the nearest color of a palette file (text or PNG).
  --reference <path>       Give each color the nearest color of a reference PNG, as "clean --reference" does.
                           The reference must be a clean sprite (at most ${PARAMS.pitch.nativeMaxColors} colors).
  --height <n>             Resize to n tiles high, as "clean --height" does (area vote, the width keeps the
                           proportion, at most ${sizing.maxEnlargement} times the height).
  color is #rrggbb, #rgb or transparent. x,y are tile coordinates, origin 0,0 at the top left.

Other options:
  --from-scale <k>         The input is an upscaled sprite: read each k x k block as one tile.
  --optimize               Write the smallest lossless PNG, as "clean --optimize" does.
  --no-trim                Keep the full frame of the input; no crop. A fully transparent result is then written.
  --trim                   Accepted for older commands; it has no effect, because the crop is the default.
  -o, --output <path>      Output file. Default: <input name>-edited.png next to the input.
  --overwrite              Permit the replacement of an existing file (also the input itself).
  --json                   Print one JSON report on stdout.

JSON report (--json):
  { "ok": true, "command": "edit", "input": "/abs/in.png", "output": "/abs/out.png",
    "cols": 41, "rows": 46, "width": 41, "height": 46, "optimized": false, "fileSize": 2318,
    "operations": 3, "colors": 11, "transparentTiles": 320, "palette": [ { "color": "#1a1520", "count": 402 } ] }

Examples:
  pixel-unslop edit hero-pixel-41x46.png --set 10,4=#ff0000 --erase 0,0 -o hero-fixed.png
  pixel-unslop edit hero-pixel-41x46.png --fill 0,0=transparent --swap "#2b2b2b=#1a1520" --json
  pixel-unslop edit hero-x4.png --from-scale 4 --erase-background -o hero-clear.png
  pixel-unslop edit hero.png --palette palette.txt --erase-color "#ffffff" --overwrite -o hero.png
  pixel-unslop edit hero-run-pixel-40x46.png --reference hero-idle-pixel-41x46.png -o hero-run-fixed.png
  pixel-unslop edit monkey-pixel-80x120.png --height 60 -o monkey-60.png`;

export const HELP_TOPICS: Record<string, string> = { clean: CLEAN, inspect: INSPECT, edit: EDIT };

export function helpText(topic?: string): string | null {
  if (!topic) return `${OVERVIEW}\n\n${CLEAN}\n\n${INSPECT}\n\n${EDIT}`;
  return HELP_TOPICS[topic] ?? null;
}

export const SHORT_USAGE = OVERVIEW;
