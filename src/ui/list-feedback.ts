import type { ListVariant, RemoveScope } from '../app/color-list.svelte.ts';
import { t } from '../app/i18n.ts';
import type { ListAction } from '../app/undo-timeline.svelte.ts';

/** The toast of a removal pick: `count` is tiles on one image, frames in an animation, pieces in a set. */
export function removedToast(variant: ListVariant, count: number, scope: RemoveScope): string {
  const inside = scope === 'all';
  switch (variant) {
    case 'image':
      return inside ? t('toast.colorDeletedInside', { count }) : t('toast.colorDeleted', { count });
    case 'frames':
      if (inside) return count === 1 ? t('toast.colorRemovedInsideFrame') : t('toast.colorRemovedInsideFrames', { count });
      return count === 1 ? t('toast.colorRemovedFrame') : t('toast.colorRemovedFrames', { count });
    case 'set':
      if (inside) return count === 1 ? t('toast.colorRemovedInsidePiece') : t('toast.colorRemovedInsidePieces', { count });
      return count === 1 ? t('toast.colorRemovedPiece') : t('toast.colorRemovedPieces', { count });
  }
}

/**
 * The toast of a replacement: `count` is tiles on one image, frames in an animation, pieces in a set. `erased`: every
 * target of the step is TRANSPARENT, so the toast says that the colors were erased.
 */
export function replacedToast(variant: ListVariant, count: number, erased = false): string {
  if (erased) {
    if (variant === 'image') return t('toast.colorDeleted', { count });
    if (variant === 'frames') return count === 1 ? t('toast.colorErasedFrame') : t('toast.colorErasedFrames', { count });
    return count === 1 ? t('toast.colorErasedPiece') : t('toast.colorErasedPieces', { count });
  }
  switch (variant) {
    case 'image':
      return t('toast.colorSwapped', { count });
    case 'frames':
      return count === 1 ? t('toast.colorReplacedFrame') : t('toast.colorReplacedFrames', { count });
    case 'set':
      return count === 1 ? t('toast.colorReplacedPiece') : t('toast.colorReplacedPieces', { count });
  }
}

const ACTIONS = {
  remove: 'history.remove',
  replace: 'history.replace',
  restore: 'history.restore',
  unreplace: 'history.unreplace',
  clearRemoved: 'history.clearRemoved',
  clearReplaced: 'history.clearReplaced',
} as const satisfies Record<ListAction, string>;

/** The toast of an undo or a redo of a list step. */
export function historyToast(action: ListAction, way: 'undo' | 'redo'): string {
  return t(way === 'undo' ? 'history.undone' : 'history.redone', { action: t(ACTIONS[action]) });
}

/** The tiles where two sprites of one size differ. */
export function changedTiles(before: Uint32Array, after: Uint32Array): Int32Array {
  if (before.length !== after.length) return new Int32Array(0);
  const out: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push(i);
  return Int32Array.from(out);
}
