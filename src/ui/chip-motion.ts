import { cubicOut } from 'svelte/easing';
import { scale, type TransitionConfig } from 'svelte/transition';
import { prefersReducedMotion } from '../app/state.svelte.ts';

/** A chip of a color list grows in and shrinks out, as a pick, a chip click, an undo or a redo changes the list. Instant under reduced motion. */
export function chip(node: Element, { leaving = false }: { leaving?: boolean } = {}): TransitionConfig {
  return scale(node, { duration: prefersReducedMotion() ? 0 : leaving ? 120 : 200, start: 0.5, opacity: 0, easing: cubicOut });
}
