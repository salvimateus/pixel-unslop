<p align="center">
  <img src="app-icon.svg" width="96" height="96" alt="Pixel Unslop logo: a lime pixel art frame with small colored pixels in it">
</p>

<h1 align="center">Pixel Unslop</h1>

<p align="center"><strong>Fix AI-generated pixel art. Pixel Unslop snaps it to a true pixel grid, makes each tile one flat color and merges the palette into a pixel-perfect sprite.</strong></p>

<p align="center">
  <img src="docs/images/ai-pixel-art-before-after.png" width="900" alt="AI pixel art before and after the cleanup: on the left, a blurred and noisy AI sprite; on the right, the same sprite as 40 by 32 flat pixels">
</p>

Pixel Unslop cleans AI pixel art and converts it to real pixel art. It removes the blur, the noise and the anti-aliased edges. It reduces hundreds of near-equal colors to a clean color palette. It also downscales the image to its true resolution: one image pixel for each art pixel.

Use it for sprites and game assets from AI image generators such as ChatGPT, DALL-E, Midjourney, Stable Diffusion, Gemini and others. The tool does not depend on the generator.

**What makes it different:** it is deterministic and uses no generative AI. Your image never leaves your computer. It is free and open source (MIT). You get a Windows desktop app and a command line tool for AI agents.

## Contents

- [Why AI pixel art is not real pixel art](#why-ai-pixel-art-is-not-real-pixel-art)
- [Who it is for](#who-it-is-for)
- [How to fix AI pixel art in 4 steps](#how-to-fix-ai-pixel-art-in-4-steps)
- [What Pixel Unslop can do](#what-pixel-unslop-can-do)
- [Clean AI pixel art from the command line (for AI agents)](#clean-ai-pixel-art-from-the-command-line-for-ai-agents)
- [How Pixel Unslop finds the pixel grid](#how-pixel-unslop-finds-the-pixel-grid)
- [How to build Pixel Unslop from source](#how-to-build-pixel-unslop-from-source)
- [Known limits](#known-limits)
- [Frequently asked questions](#frequently-asked-questions)
- [Credits](#credits)
- [License](#license)

## Why AI pixel art is not real pixel art

AI image generators make images that look like pixel art, but the pixels are not on a real pixel grid. You see these defects:

- Off-grid pixels: the art pixels have different sizes and positions.
- Lines that are not straight.
- Blur and anti-aliased edges between the colors.
- Noise in areas that must have one flat color.
- Hundreds of colors that are almost equal, where the art needs a small palette.

A game engine or a pixel art editor needs one flat color for each art pixel. Pixel Unslop finds the grid of the art and makes each tile one flat color. Then it merges the near-equal colors into a clean palette.

## Who it is for

- Game developers who use AI images as game assets.
- Pixel artists who want a clean base from an AI sketch.
- People who make sprites and game assets with AI image generators.
- AI agents, for example Claude Code, that process images with the command line tool.

## How to fix AI pixel art in 4 steps

### 1. Drop the image

Open Pixel Unslop. Drag a PNG, JPG or WebP image into the window.

- To select a file, click the drop zone.
- To paste an image, push Ctrl+V.

<img src="docs/images/pixel-unslop-drop-screen.png" width="900" alt="Pixel Unslop drop screen: the logo, a large drop zone with the text Drag an image here, and the line Your image never leaves your computer">

### 2. Examine the pixel grid

The program finds the pixel grid and shows it on your image. Each square must cover one pixel of the art. Three stars show a good fit.

- If the grid is not correct, drag a box over ONE pixel of the art. A magnifier shows the area. The program fits the grid to your box.
- For fine adjustment, use the "Pixel size" slider, or type the size.
- To change the size by 0.01, push an arrow key. To change it by 0.1, push Shift and an arrow key.
- Select the "Color cleanup" level (Off, Light, Normal or Strong). You can change it later.
- Click "Clean!".

<img src="docs/images/pixel-unslop-grid-screen.png" width="900" alt="Pixel grid detection on an AI sprite: grid lines on the source image, a box over one art pixel with a magnifier, and a panel with 40 by 32 pixels, three stars and the color cleanup levels">

### 3. Clean and correct the sprite

The program shows the clean sprite. To compare it with the source, move the divider or the "Before / After" slider.

- To correct small defects, use the Pencil (B), the Eraser (E), the Bucket (G) and the Dropper (I).
- To pick the color below the cursor, click the right mouse button. This works in all tools.
- To replace a color in all the sprite, right-click it in the color list. You can also click the "..." button. You can also erase the color there.
- To make the background transparent, click "Remove background". This changes the background that touches the border.
- You can change the "Color cleanup" level at any time. Your manual corrections stay.
- To undo, push Ctrl+Z. To redo, push Ctrl+Y.

<img src="docs/images/pixel-unslop-clean-and-edit-screen.png" width="900" alt="Clean pixel art editor: the tools on the left, the sprite in the middle with a divider between the blurred AI source and the flat result, and the color palette on the right">

### 4. Export the PNG

Click "Export PNG", or push Ctrl+S. Then select one size:

- The true resolution (1x): one image pixel for each art pixel.
- An integer scale: 2x, 4x, 8x or 16x.
- The size of the original image.

The scale keeps the pixel edges hard.

<img src="docs/images/pixel-unslop-export-png-dialog.png" width="900" alt="Export pixel art as PNG: a dialog with six size choices from 40 by 32 pixels to 16x, the 8x choice selected, the file name and a Save PNG button">

## What Pixel Unslop can do

- Automatic pixel grid detection, with a rating of the fit from 1 to 3 stars.
- Manual correction: a box over one art pixel, or a pixel size with steps of 0.01 px.
- Advanced grid controls: a flexible grid for art that moves away from the grid, a phase shift with the arrow keys, and a different width and height.
- One flat color for each tile, with no blur.
- Pixel art cleanup of the colors in four levels, in the OKLab color space. The merge agrees with what the eye sees.
- Pencil, eraser, bucket fill and dropper, with undo and redo.
- Replace a color in all the sprite, erase a color, or remove the background with one click.
- A comparison of the source and the result, on a checker, dark or light background.
- PNG export at the true resolution or at an integer scale.
- An interface in English and in Brazilian Portuguese.
- It works offline. There is no account, no upload and no telemetry.

## Clean AI pixel art from the command line (for AI agents)

The same engine is also a command line tool. It is for AI agents, such as Claude Code, and for scripts. Use it to clean many sprites in one run, to read a JSON report, and to correct single tiles with exact commands.

| File | Platform | Requirement |
|---|---|---|
| `pixel-unslop` (with `pixel-unslop.cjs`) | WSL or Linux | Node.js 20 or newer |
| `pixel-unslop-cli.exe` | Windows | None (Node.js is in the file) |

The examples use the name `pixel-unslop`. On Windows, use `pixel-unslop-cli.exe` with the same options. The tool reads only PNG files.

Clean one image and make its background transparent:

```sh
pixel-unslop clean hero.png --erase-background
```

Clean the parts of one sprite sheet with one pixel size and one palette for all the parts:

```sh
pixel-unslop clean pieces/*.png --out-dir clean --shared-pixel-size --shared-palette --write-palette clean/palette.txt
```

Read the grid and the palette as JSON. This command writes no image:

```sh
pixel-unslop inspect hero.png --json
```

Write a preview of the source with the grid lines. Use it to examine the grid:

```sh
pixel-unslop inspect hero.png --grid-preview hero-grid.png
```

Edit a clean sprite. This example sets one tile, then fills the background area with transparency:

```sh
pixel-unslop edit hero-pixel-40x32.png --set 10,4=#ff0000 --fill 0,0=transparent -o hero-fixed.png
```

With `--json`, the tool writes one JSON report to stdout. The report gives the output file, the grid, the number of colors and the palette. The grid data includes the pixel size, the offset, a quality from 1 to 3 and notes.

The exit codes are:

- 0: all files are correct.
- 1: one file or more failed.
- 2: a usage error.

For all the options and more examples, run `pixel-unslop help`, `help clean`, `help inspect` or `help edit`.

## How Pixel Unslop finds the pixel grid

1. **Edge evidence.** The tool measures the color change between adjacent pixels, along each column and each row.
2. **Grid period and phase.** In real pixel art, the edges have a regular step. The tool finds the step (the size of one art pixel) and the offset where the edges agree best. A box that you draw over one pixel gives a strong hint. If the AI art moves away from a regular grid, an elastic fit moves the grid lines to the edges.
3. **One color for each tile.** The tool examines the center of each tile. It uses the color with the largest area there. The blurred border of the tile has no effect.
4. **Palette merge.** The tool merges the colors that are almost equal in the OKLab color space. The cleanup level sets the maximum difference.

## How to build Pixel Unslop from source

There is no release yet. Build the program from source. The build operates on Linux or WSL. It makes the Windows programs with a cross-compiler.

### Requirements

- Node.js 24.10.0, exactly. The Windows CLI build stops with a different version. The build puts the CLI into the official Node.js 24.10.0 Windows binary.
- Rust (with `rustup`) and the Windows target: `rustup target add x86_64-pc-windows-msvc`.
- cargo-xwin: `cargo install cargo-xwin --locked`.
- The LLVM tools. On Ubuntu or WSL: `sudo apt install clang lld llvm`.

The first Windows build downloads the Windows SDK and CRT files with cargo-xwin. The Windows CLI build downloads `node.exe` 24.10.0 from nodejs.org. Then it examines the SHA-256 hash of the file.

### Commands

Install the dependencies:

```sh
npm ci
```

Open the interface in your browser at http://localhost:5173:

```sh
npm run dev
```

Build all the programs:

```sh
npm run release
```

The build writes these files into the `release/` folder:

| Path | Content |
|---|---|
| `release/windows/PixelUnslop.exe` | The Windows desktop app (portable, with no installer) |
| `release/windows/pixel-unslop-cli.exe` | The command line tool for Windows |
| `release/wsl/pixel-unslop` | The command line tool for WSL or Linux (a small launcher) |
| `release/wsl/pixel-unslop.cjs` | The CLI file that the launcher runs with Node.js |

To build only the CLI for Linux or WSL, run `npm run build:cli`. This command writes `dist-cli/pixel-unslop.cjs`.

## Known limits

- A small, blurred image gives little edge evidence. Thus the automatic grid can be incorrect.
  - In the app, drag a box over one pixel of the art, or set the pixel size.
  - In the CLI, give `--pixel-size`. Or clean the parts of one sheet together with `--shared-pixel-size`.
- The Windows exe has no signature. Windows SmartScreen shows a warning when you open it for the first time.
- The desktop app needs the Microsoft Edge WebView2 runtime. Windows 11 has it.

## Frequently asked questions

### How do I fix AI-generated pixel art?

Open the image in Pixel Unslop. Examine the grid, click "Clean!", correct small defects and export the PNG. The [4 steps](#how-to-fix-ai-pixel-art-in-4-steps) above show the full procedure.

### Does Pixel Unslop use AI?

No. It uses no generative AI and no machine learning. It uses only math, and the same image and settings always give the same result.

### Does it work with images from Midjourney, DALL-E, Stable Diffusion or ChatGPT?

Yes. The tool does not depend on the generator. It needs an image that shows pixel art on an approximate grid. The desktop app opens PNG, JPG and WebP files. The command line tool reads PNG files.

### How do I find the pixel size of my image?

The program finds it automatically. If the result is not correct, drag a box over one art pixel, or set the "Pixel size" control. In the command line tool, run `pixel-unslop inspect image.png` to read the pixel size, or give it with `--pixel-size`.

### Why does my result have too many or too few colors?

The "Color cleanup" level controls the merge of near-equal colors. For fewer colors, select a stronger level. To keep more colors, select a lighter level or Off. The command line tool also has `--cleanup`, `--max-colors` and `--palette`.

### Can I clean many sprites with one palette?

Yes, with the command line tool. Use `--shared-palette` to give all the outputs one palette. Add `--shared-pixel-size` for the parts of one sprite sheet. The desktop app cleans one image at a time.

### Is it free?

Yes. Pixel Unslop is free and open source, with the MIT license.

### Does it run offline?

Yes. The desktop app and the command line tool need no internet connection. Your image stays on your computer.

## Credits

The algorithm uses ideas from these MIT projects:

- [unfake.js](https://github.com/jenissimo/unfake.js)
- [proper-pixel-art](https://github.com/KennethJAllen/proper-pixel-art)
- [Sprite Fusion Pixel Snapper](https://github.com/Hugo-Dz/spritefusion-pixel-snapper)

## License

MIT. Made by Mateus Salvi ([@salvimateus](https://github.com/salvimateus)). See [LICENSE](LICENSE).
