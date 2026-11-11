import { PARAMS } from '../core/params.ts';

const presets = PARAMS.palette.presets;

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
  --offset <x,y>           Shift the grid phase by x,y source pixels (float). Turns the elastic fit off.
  --elastic <auto|on|off>  Elastic grid that follows drawn edges when the AI art drifts. Default: auto
                           (used only for a pixel size of ${PARAMS.elastic.minPeriod} or more when it fits clearly better).
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
  --erase-background       Make the background that touches the border transparent (a solid color or a
                           fake checkerboard of up to ${PARAMS.background.maxColors} colors).
  --swap <from=to>         Replace one color everywhere. Repeatable. "to" can be "transparent".
                           Order after the merge: --palette, --erase-background, then each --swap.
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
      },`;

const CLEAN = `pixel-unslop clean <input.png>... [options]

Cleans AI pixel art. Each output PNG has one image pixel per tile (or k x k with --scale k).

Output options:
  -o, --output <path>      Output file, for one input.
  --out-dir <dir>          Output folder (must exist), for one or many inputs.
                           Default name: <input name>-pixel-<cols>x<rows>[-x<k>].png next to the input.
  --scale <k | original>   Integer upscale of the output. Default 1. "original" uses the rounded mean pixel size.
                           The largest output side is ${PARAMS.limits.maxExportSide} px.
  --write-palette <path>   Write the final palette as text, one #rrggbb per line (all outputs together).

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
        "width": 41, "height": 46, "scale": 1,    output size in pixels
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
  pixel-unslop clean hero.png -o hero-clean.png --scale 4 --erase-background
  pixel-unslop clean pieces/*.png --out-dir clean --shared-pixel-size --shared-palette --write-palette clean/palette.txt
  pixel-unslop clean hero.png --pixel-size 9.4 --grid-preview hero-grid.png --json
  pixel-unslop clean hero.png --pixel-size 8 --exact --offset 2,3 --elastic off
  pixel-unslop clean hero.png --palette pico8.txt --cleanup strong --max-colors 16
  pixel-unslop clean hero.png --swap "#ffffff=transparent" --overwrite`;

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
  pixel-unslop inspect hero.png --pixel-size 2.65 --cleanup light`;

const EDIT = `pixel-unslop edit <sprite.png> [options]

Edits a clean sprite: 1 image pixel = 1 tile (or k x k pixels with --from-scale k). Alpha below 128 is
transparent; every other pixel becomes opaque. The operations run in the order given on the command line.

Operations (each one is repeatable):
  --set <x,y=color>        Set one tile.
  --erase <x,y>            Make one tile transparent.
  --fill <x,y=color>       Flood fill: the 4-connected region with exactly the color of tile x,y.
  --swap <from=to>         Replace one color everywhere.
  --erase-color <color>    Make one color transparent everywhere.
  --erase-background       Make the background that touches the border transparent.
  --palette <path>         Map every color to the nearest color of a palette file (text or PNG).
  color is #rrggbb, #rgb or transparent. x,y are tile coordinates, origin 0,0 at the top left.

Other options:
  --from-scale <k>         The input is an upscaled sprite: read each k x k block as one tile.
  --scale <k>              Integer upscale of the output. Default 1.
  -o, --output <path>      Output file. Default: <input name>-edited.png next to the input.
  --overwrite              Permit the replacement of an existing file (also the input itself).
  --json                   Print one JSON report on stdout.

JSON report (--json):
  { "ok": true, "command": "edit", "input": "/abs/in.png", "output": "/abs/out.png",
    "cols": 41, "rows": 46, "scale": 1, "width": 41, "height": 46, "operations": 3,
    "colors": 11, "transparentTiles": 320, "palette": [ { "color": "#1a1520", "count": 402 } ] }

Examples:
  pixel-unslop edit hero-pixel-41x46.png --set 10,4=#ff0000 --erase 0,0 -o hero-fixed.png
  pixel-unslop edit hero-pixel-41x46.png --fill 0,0=transparent --swap "#2b2b2b=#1a1520" --json
  pixel-unslop edit hero-x4.png --from-scale 4 --erase-background --scale 4 -o hero-x4-clear.png
  pixel-unslop edit hero.png --palette palette.txt --erase-color "#ffffff" --overwrite -o hero.png`;

export const HELP_TOPICS: Record<string, string> = { clean: CLEAN, inspect: INSPECT, edit: EDIT };

export function helpText(topic?: string): string | null {
  if (!topic) return `${OVERVIEW}\n\n${CLEAN}\n\n${INSPECT}\n\n${EDIT}`;
  return HELP_TOPICS[topic] ?? null;
}

export const SHORT_USAGE = OVERVIEW;
