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

export interface PngFile {
  name: string;
  bytes: Uint8Array;
}

export interface LaunchedFile {
  name: string;
  bytes: Uint8Array;
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

export async function savePng(bytes: Uint8Array, name: string): Promise<SaveResult> {
  if (isDesktop) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!path) return { status: 'cancelled' };
    // The dialog grants write access to this exact path only: another extension would be a forbidden path.
    await writeFile(path, bytes);
    return { status: 'saved', path };
  }

  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  lastDownloadUrl = url;
  download(url, name);
  return { status: 'downloaded', url };
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

/** The one file that a browser download of a set gives: the PNG itself for one file, else one ZIP of all of them. */
export function setDownloadFile(files: readonly PngFile[]): PngFile | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  return { name: SET_ZIP_NAME, bytes: zipStored(files) };
}

/**
 * Saves several PNG files. Desktop: one folder dialog, one confirmation when files with the same names exist,
 * and each file directly in that folder. Browser: one download, because browsers block a row of automatic
 * downloads: the PNG itself for one file, else one ZIP that holds all the files.
 */
export async function savePngSet(files: readonly PngFile[], confirmOverwrite: (names: string[]) => Promise<boolean>): Promise<SaveSetResult> {
  if (isDesktop) {
    const [{ open }, { exists, writeFile }, { join }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path'),
    ]);
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== 'string') return { status: 'cancelled' };
    // Every file written to the folder is a PNG, whatever name reached this point.
    const names = files.map((file) => (/\.png$/i.test(file.name) ? file.name : `${file.name}.png`));
    const paths = await Promise.all(names.map((name) => join(folder, name)));
    const found = await Promise.all(paths.map((path) => exists(path)));
    const taken = names.filter((_, i) => found[i]);
    if (taken.length > 0 && !(await confirmOverwrite(taken))) return { status: 'cancelled' };
    for (let i = 0; i < files.length; i++) await writeFile(paths[i], files[i].bytes);
    return { status: 'saved', folder, paths };
  }

  const file = setDownloadFile(files);
  if (!file) return { status: 'cancelled' };
  const single = files.length === 1;
  // The URL stays alive until the next set export, so a slow browser still finds the file.
  if (setDownloadUrl) URL.revokeObjectURL(setDownloadUrl);
  setDownloadUrl = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: single ? 'image/png' : 'application/zip' }));
  download(setDownloadUrl, file.name);
  return { status: 'downloaded', count: files.length, zip: single ? null : file.name };
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

/** The image file given to the exe as its first argument (a file dropped on the icon), if any. */
export async function launchFile(): Promise<LaunchedFile | null> {
  if (!isDesktop) return null;
  const path = await invoke<string | null>('launch_file');
  if (!path) return null;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  return { name: baseName(path), bytes };
}
