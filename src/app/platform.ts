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
