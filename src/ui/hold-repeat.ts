import { TUNING } from '../app/tuning.ts';

export interface HoldRepeatOptions {
  /** One step; `shift` is true while Shift is held. */
  step: (shift: boolean) => void;
  /** After the pointer lets the button go, or after a keyboard click. */
  release?: () => void;
}

/**
 * Svelte action for a step button: a press makes one step at once and repeats it while the button stays
 * pressed. A keyboard click (Enter or Space) makes one step.
 */
export function holdRepeat(node: HTMLButtonElement, options: HoldRepeatOptions) {
  let current = options;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;
  let shift = false;

  const stop = (): void => {
    const held = delay !== undefined || repeat !== undefined;
    clearTimeout(delay);
    clearInterval(repeat);
    delay = undefined;
    repeat = undefined;
    if (held) current.release?.();
  };

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || node.disabled) return;
    event.preventDefault();
    node.focus({ preventScroll: true });
    stop();
    shift = event.shiftKey;
    current.step(shift);
    delay = setTimeout(() => {
      repeat = setInterval(() => {
        if (node.disabled) stop();
        else current.step(shift);
      }, TUNING.grid.holdRepeatMs);
    }, TUNING.grid.holdDelayMs);
  };

  const onClick = (event: MouseEvent): void => {
    // A pointer press already stepped; only a keyboard click (detail 0) steps here.
    if (event.detail !== 0) return;
    current.step(event.shiftKey);
    current.release?.();
  };

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointerleave', stop);
  node.addEventListener('pointercancel', stop);
  node.addEventListener('click', onClick);
  return {
    update(next: HoldRepeatOptions) {
      current = next;
    },
    destroy() {
      stop();
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointerup', stop);
      node.removeEventListener('pointerleave', stop);
      node.removeEventListener('pointercancel', stop);
      node.removeEventListener('click', onClick);
    },
  };
}
