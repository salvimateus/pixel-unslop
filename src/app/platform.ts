import { invoke, isTauri } from '@tauri-apps/api/core';
import { zipStored } from './zip.ts';

export type SaveResult =
  | { status: 'saved'; path: string }
  | { status: 'downloaded'; url: string }
  | { status: 'cancelled' };

export type SaveSetResult =
  | { status: 'saved'; folder: string; paths: string[] }
  /** `zip` names the one archive that holds the files when there are two or more, else null. */
  | { status: 'downloaded'; count: number; zip: string | null }
  | { status: 'cancelled' };

export type FileKind = 'png' | 'gif' | 'json' | 'zip';

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

export type PngFile = OutputFile;

/** A file given to the desktop exe: its name is known at once, its bytes are read only on demand. */
export interface LaunchedFile {
  name: string;
  read(): Promise<File>;
}

/** True inside the Tauri window, false in a plain browser. */
export const isDesktop: boolean = isTauri();

export interface LogicalArea {
  width: number;
  height: number;
}

/** Desktop only: the work area of the monitor of the window, in logical pixels; null when it is not known. */
export async function monitorWorkArea(): Promise<LogicalArea | null> {
  if (!isDesktop) return null;
  try {
    const { currentMonitor } = await import('@tauri-apps/api/window');
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const size = monitor.workArea.size.toLogical(monitor.scaleFactor);
    return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
  } catch {
    return null;
  }
}

/** The zoom and the smallest layout viewport that the window must keep, for a minimum that waits for the normal state. */
let windowZoom: { factor: number; minViewport: LogicalArea } | null = null;
/** The window was maximized or fullscreen at the last zoom change: its minimum waits for the normal state. */
let minimumPending = false;
let resizeWatch: Promise<void> | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Desktop only: the native zoom of the webview, and a window whose inner size keeps the layout viewport at
 * `minViewport` CSS pixels. A maximized or fullscreen window gets only the zoom: the native minimum call would clear
 * its maximized state. Its minimum comes when it is a normal window again. Returns false when a call failed; the
 * app stays usable at the zoom it has.
 */
export async function setInterfaceZoom(factor: number, minViewport: LogicalArea): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([import('@tauri-apps/api/webview'), import('@tauri-apps/api/window')]);
    await getCurrentWebview().setZoom(factor);
    windowZoom = { factor, minViewport };
    const win = getCurrentWindow();
    const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
    if (maximized || fullscreen) {
      minimumPending = true;
      watchWindowState();
      return true;
    }
    minimumPending = false;
    await applyWindowMinimum();
    return true;
  } catch {
    return false;
  }
}

/**
 * The minimum for the current zoom: 960 x 640 CSS pixels times the zoom, never larger than the work area less the
 * window frame. A smaller window grows to it, as far as the work area goes from the window position; it never moves
 * and never shrinks.
 */
async function applyWindowMinimum(): Promise<void> {
  const zoom = windowZoom;
  if (!zoom) return;
  const { getCurrentWindow, currentMonitor, LogicalSize } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const [monitor, scale, inner, outer, position] = await Promise.all([currentMonitor(), win.scaleFactor(), win.innerSize(), win.outerSize(), win.outerPosition()]);
  const innerSize = inner.toLogical(scale);
  const outerSize = outer.toLogical(scale);
  const frameW = Math.max(0, outerSize.width - innerSize.width);
  const frameH = Math.max(0, outerSize.height - innerSize.height);
  let minW = Math.ceil(zoom.minViewport.width * zoom.factor);
  let minH = Math.ceil(zoom.minViewport.height * zoom.factor);
  // The room from the window position to the right and lower edges of the work area.
  let roomW = Infinity;
  let roomH = Infinity;
  if (monitor) {
    const area = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const areaAt = monitor.workArea.position.toLogical(monitor.scaleFactor);
    const at = position.toLogical(scale);
    minW = Math.min(minW, Math.floor(area.width - frameW));
    minH = Math.min(minH, Math.floor(area.height - frameH));
    roomW = Math.floor(areaAt.x + area.width - at.x - frameW);
    roomH = Math.floor(areaAt.y + area.height - at.y - frameH);
  }
  await win.setMinSize(new LogicalSize(minW, minH));
  if (innerSize.width >= minW && innerSize.height >= minH) return;
  const width = Math.max(innerSize.width, Math.min(minW, roomW));
  const height = Math.max(innerSize.height, Math.min(minH, roomH));
  if (width > innerSize.width || height > innerSize.height) await win.setSize(new LogicalSize(width, height));
}

/**
 * Once: a resize listener that applies a waiting minimum when the window is normal again. The calls run once, a
 * short time after the last resize event, so a drag does not repeat them.
 */
function watchWindowState(): void {
  if (resizeWatch) return;
  resizeWatch = (async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onResized(() => {
      if (!minimumPending) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        try {
          const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
          if (maximized || fullscreen || !minimumPending) return;
          minimumPending = false;
          await applyWindowMinimum();
        } catch {
          // The window keeps its size; the next zoom change tries again.
          minimumPending = true;
        }
      }, WINDOW_STATE_DELAY_MS);
    });
  })().catch(() => {
    resizeWatch = null;
  });
}

/** A waiting minimum runs this long after the last resize event of the window. */
const WINDOW_STATE_DELAY_MS = 250;

let lastDownloadUrl: string | null = null;
let setDownloadUrl: string | null = null;

/** The name of the archive of a set download. */
export const SET_ZIP_NAME = 'pixel-unslop-set.zip';

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The save dialog filter and the download MIME type of each kind of output file. */
const FILE_KINDS: Record<FileKind, { label: string; extension: string; mime: string }> = {
  png: { label: 'PNG', extension: 'png', mime: 'image/png' },
  gif: { label: 'GIF', extension: 'gif', mime: 'image/gif' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json' },
  zip: { label: 'ZIP', extension: 'zip', mime: 'application/zip' },
};

/** The MIME type of a file name by its extension, or `fallback` for an extension with no kind. */
function mimeOfName(name: string, fallback = 'application/octet-stream'): string {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase();
  const kind = Object.values(FILE_KINDS).find((entry) => entry.extension === extension);
  return kind?.mime ?? fallback;
}

function blobOf(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
}

/** Saves one file. Desktop: a save dialog filtered to the kind. Browser: a download with the MIME type of the kind. */
export async function saveFile(bytes: Uint8Array, name: string, kind: FileKind): Promise<SaveResult> {
  const { label, extension, mime } = FILE_KINDS[kind];
  if (isDesktop) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ defaultPath: name, filters: [{ name: label, extensions: [extension] }] });
    if (!path) return { status: 'cancelled' };
    // The dialog grants write access to this exact path only: another extension would be a forbidden path.
    await writeFile(path, bytes);
    return { status: 'saved', path };
  }

  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = URL.createObjectURL(blobOf(bytes, mime));
  lastDownloadUrl = url;
  download(url, name);
  return { status: 'downloaded', url };
}

export function savePng(bytes: Uint8Array, name: string): Promise<SaveResult> {
  return saveFile(bytes, name, 'png');
}

function download(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/** The one file that a browser download of a set gives: the file itself for one file, else one ZIP of all of them. */
export function setDownloadFile(files: readonly OutputFile[], zipName: string = SET_ZIP_NAME): OutputFile | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  return { name: zipName, bytes: zipStored(files) };
}

/**
 * Saves several files, each with its name exactly as given. Desktop: one folder dialog, one confirmation when
 * files with the same names exist, and each file directly in that folder. Browser: one download, because browsers
 * block a row of automatic downloads: the file itself for one file, else one ZIP named `zipName` that holds them all.
 */
export function saveFileSet(files: readonly OutputFile[], confirmOverwrite: (names: string[]) => Promise<boolean>, zipName: string): Promise<SaveSetResult> {
  return saveSet(files, confirmOverwrite, zipName);
}

/** `singleMime` is the download type of one file whose extension has no kind. */
async function saveSet(files: readonly OutputFile[], confirmOverwrite: (names: string[]) => Promise<boolean>, zipName: string, singleMime?: string): Promise<SaveSetResult> {
  if (isDesktop) {
    const [{ open }, { exists, writeFile }, { join }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path'),
    ]);
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== 'string') return { status: 'cancelled' };
    const names = files.map((file) => file.name);
    const paths = await Promise.all(names.map((name) => join(folder, name)));
    const found = await Promise.all(paths.map((path) => exists(path)));
    const taken = names.filter((_, i) => found[i]);
    if (taken.length > 0 && !(await confirmOverwrite(taken))) return { status: 'cancelled' };
    for (let i = 0; i < files.length; i++) await writeFile(paths[i], files[i].bytes);
    return { status: 'saved', folder, paths };
  }

  const file = setDownloadFile(files, zipName);
  if (!file) return { status: 'cancelled' };
  const single = files.length === 1;
  // The URL stays alive until the next set export, so a slow browser still finds the file.
  if (setDownloadUrl) URL.revokeObjectURL(setDownloadUrl);
  setDownloadUrl = URL.createObjectURL(blobOf(file.bytes, single ? mimeOfName(file.name, singleMime) : FILE_KINDS.zip.mime));
  download(setDownloadUrl, file.name);
  return { status: 'downloaded', count: files.length, zip: single ? null : file.name };
}

/** Saves several PNG files: `saveFileSet` with the set ZIP name, where every file written to a desktop folder is a PNG. */
export function savePngSet(files: readonly PngFile[], confirmOverwrite: (names: string[]) => Promise<boolean>): Promise<SaveSetResult> {
  const named = isDesktop ? files.map((file) => (/\.png$/i.test(file.name) ? file : { name: `${file.name}.png`, bytes: file.bytes })) : files;
  return saveSet(named, confirmOverwrite, SET_ZIP_NAME, FILE_KINDS.png.mime);
}

export async function revealFile(path: string): Promise<void> {
  if (!isDesktop) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

/** Opens a web page outside the app: a plain link would navigate the desktop window away from the app. */
export async function openExternal(url: string): Promise<void> {
  if (isDesktop) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** The event that the exe emits when a later launch gives the running window a file. */
const LAUNCH_EVENT = 'launch-file';

/** The file that waits in the exe, taken once: a second take gets null until another launch gives a file. */
async function takeLaunchFile(): Promise<LaunchedFile | null> {
  const path = await invoke<string | null>('launch_file');
  if (!path) return null;
  const name = baseName(path);
  return {
    name,
    async read() {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const bytes = await readFile(path);
      return new File([bytes as Uint8Array<ArrayBuffer>], name);
    },
  };
}

/**
 * Desktop only: gives `onFile` each file that the exe receives ("Open with", a drop on the icon), the one of this
 * launch and those of later launches, which the single running window takes. Resolves to the function that stops
 * the watch; a browser gets a function that does nothing.
 */
export async function watchLaunchFiles(onFile: (file: LaunchedFile) => void, onError: () => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const take = (): Promise<void> =>
    takeLaunchFile().then((file) => {
      if (file) onFile(file);
    }, onError);
  const { listen } = await import('@tauri-apps/api/event');
  // The listener comes first: a file that arrives before it waits in the exe for the first take.
  const stop = await listen(LAUNCH_EVENT, () => void take());
  void take();
  return stop;
}
