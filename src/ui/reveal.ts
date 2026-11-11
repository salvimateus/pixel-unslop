import { prefersReducedMotion } from '../app/state.svelte.ts';

/**
 * Scrolls the nearest panel scroll area, and only it, so that `element` shows in full. scrollIntoView would also
 * move the clipped layout boxes around the panel.
 */
export function revealInPanel(element: Element | null, area = '.grid-panel-scroll'): void {
  const scroller = element?.closest<HTMLElement>(area);
  if (!element || !scroller) return;
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  let delta = 0;
  if (rect.bottom > box.bottom) delta = rect.bottom - box.bottom;
  // A block taller than the area shows from its top.
  if (rect.top - delta < box.top) delta = rect.top - box.top;
  if (Math.abs(delta) < 1) return;
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
