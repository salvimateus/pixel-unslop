/** The box of a canvas on screen: its CSS size and its exact size in physical pixels. */
export interface CanvasBox {
  cssW: number;
  cssH: number;
  pxW: number;
  pxH: number;
}

/**
 * Keeps a canvas on whole physical pixels and reports its box, so its backing store can equal the box: then the
 * browser shows the canvas with no resampling, and a line of one physical pixel stays sharp at any device pixel
 * ratio (1.25 included).
 *
 * The canvas fills its parent (`position: absolute; inset: 0`). Its edges go to the nearest whole physical pixel:
 * a small `translate` and an explicit CSS size absorb a layout that gives a fraction. The physical size comes from
 * `devicePixelContentBoxSize` when it agrees with the ratio, else from the snapped edges. Above `maxRatio` the
 * backing store stays at that ratio, to limit its memory. Returns the stop function.
 */
export function watchCanvasBox(canvas: HTMLCanvasElement, onbox: (box: CanvasBox) => void, maxRatio = Infinity): () => void {
  const parent = canvas.parentElement;
  if (!parent) return () => undefined;
  let device: { w: number; h: number } | null = null;
  let last = '';

  const report = (): void => {
    const rect = parent.getBoundingClientRect();
    const left = rect.left + parent.clientLeft;
    const top = rect.top + parent.clientTop;
    const width = rect.width - parent.clientLeft - (parent.offsetWidth - parent.clientWidth - parent.clientLeft);
    const height = rect.height - parent.clientTop - (parent.offsetHeight - parent.clientHeight - parent.clientTop);
    if (width <= 0 || height <= 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
    const x0 = Math.round(left * ratio);
    const y0 = Math.round(top * ratio);
    let pxW = Math.max(1, Math.round((left + width) * ratio) - x0);
    let pxH = Math.max(1, Math.round((top + height) * ratio) - y0);
    // The browser measure of the same box wins when it agrees (an emulated ratio reports the CSS size instead).
    if (device && ratio === window.devicePixelRatio && Math.abs(device.w - pxW) <= 1 && Math.abs(device.h - pxH) <= 1) {
      pxW = device.w;
      pxH = device.h;
    }
    const cssW = pxW / ratio;
    const cssH = pxH / ratio;
    const key = `${x0},${y0}:${pxW}x${pxH}@${ratio}`;
    if (key === last) return;
    last = key;
    canvas.style.translate = `${x0 / ratio - left}px ${y0 / ratio - top}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    onbox({ cssW, cssH, pxW, pxH });
  };

  const parentObserver = new ResizeObserver(report);
  parentObserver.observe(parent);
  const deviceObserver = new ResizeObserver((entries) => {
    const size = entries[0]?.devicePixelContentBoxSize?.[0];
    device = size ? { w: size.inlineSize, h: size.blockSize } : null;
    report();
  });
  try {
    deviceObserver.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    device = null;
  }
  // A zoom change or a move between displays changes the ratio, maybe with no resize.
  let query: MediaQueryList | null = null;
  const onRatio = (): void => {
    report();
    watchRatio();
  };
  const watchRatio = (): void => {
    query?.removeEventListener('change', onRatio);
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', onRatio);
  };
  watchRatio();
  // An entry animation moves the canvas with a transform, which no observer sees: measure again when it ends, and
  // after a window resize, which can change the ratio with no change of the boxes.
  const onMotionEnd = (): void => report();
  document.addEventListener('animationend', onMotionEnd, true);
  document.addEventListener('transitionend', onMotionEnd, true);
  window.addEventListener('resize', onMotionEnd);
  return () => {
    window.removeEventListener('resize', onMotionEnd);
    document.removeEventListener('animationend', onMotionEnd, true);
    document.removeEventListener('transitionend', onMotionEnd, true);
    parentObserver.disconnect();
    deviceObserver.disconnect();
    query?.removeEventListener('change', onRatio);
  };
}
