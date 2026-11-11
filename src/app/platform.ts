import { invoke, isTauri } from '@tauri-apps/api/core';

export type SaveResult =
  | { status: 'saved'; path: string }
  | { status: 'downloaded'; url: string }
  | { status: 'cancelled' };

export interface LaunchedFile {
  name: string;
  bytes: Uint8Array;
}

/** True inside the Tauri window, false in a plain browser. */
export const isDesktop: boolean = isTauri();

let lastDownloadUrl: string | null = null;

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
    const finalPath = /\.png$/i.test(path) ? path : `${path}.png`;
    await writeFile(finalPath, bytes);
    return { status: 'saved', path: finalPath };
  }

  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  lastDownloadUrl = url;
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  return { status: 'downloaded', url };
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
