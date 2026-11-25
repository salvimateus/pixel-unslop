import type { EditSession } from './edit-session.ts';
import type { RemovedColor, RemovedColorList, ReplacedColor, ReplacedColorList } from './color-list.svelte.ts';

const LIMIT = 200;

/** The two lists of one journey. */
export interface ColorLists {
  readonly removed: RemovedColorList;
  readonly replaced: ReplacedColorList;
}

/** A user action on a list: a removal pick, a replacement, a chip delete of each list, or "Clear" of each list. */
export type ListAction = 'remove' | 'replace' | 'restore' | 'unreplace' | 'clearRemoved' | 'clearReplaced';

export interface ListsState {
  removed: readonly RemovedColor[];
  replaced: readonly ReplacedColor[];
}

type Step =
  | { kind: 'pixels'; session: EditSession }
  | { kind: 'lists'; lists: ColorLists; action: ListAction; before: ListsState; after: ListsState }
  | { kind: 'other'; undo: () => void; redo: () => void };

/** What one undo or redo did, for the feedback of the screen. */
export type Replay = { kind: 'pixels'; changed: Int32Array } | { kind: 'lists'; action: ListAction; lists: ColorLists } | { kind: 'other' };

function stateOf(lists: ColorLists): ListsState {
  return { removed: lists.removed.entries, replaced: lists.replaced.entries };
}

function sameState(a: ListsState, b: ListsState): boolean {
  return a.removed === b.removed && a.replaced === b.replaced;
}

/**
 * One ordered undo history for one screen: pixel steps (they stay in their `EditSession`, the history only orders
 * them), list steps (a snapshot of both lists before and after) and other steps of the owner (the container and the
 * offsets of an animation). A new step drops the redo branch of every kind.
 *
 * A list step undoes only while the lists still hold its `after` state: a list change on another screen makes the
 * older steps stale, and the history drops them. With no step left, an undo falls back to the history of the
 * `fallback` session: the pixel steps made before the history started.
 */
export class UndoTimeline {
  /** Changes on each push, undo, redo and reset: the buttons read it. */
  version = $state(0);
  private done: Step[] = [];
  private undone: Step[] = [];
  private fallback: EditSession | null = null;

  get canUndo(): boolean {
    void this.version;
    return this.done.length > 0 || (this.fallback?.canUndo ?? false);
  }

  get canRedo(): boolean {
    void this.version;
    return this.undone.length > 0;
  }

  /** Forgets every step. `fallback` is the session of the open image, whose older pixel steps an undo still reaches. */
  reset(fallback: EditSession | null = null): void {
    this.done = [];
    this.undone = [];
    this.fallback = fallback;
    this.version++;
  }

  /** A pixel step that `session.apply` made. */
  pushPixels(session: EditSession): void {
    this.push({ kind: 'pixels', session });
  }

  /** An undoable step of the owner. */
  pushOther(undo: () => void, redo: () => void): void {
    this.push({ kind: 'other', undo, redo });
  }

  /** Runs a list change and records it as one step; a change that leaves both lists as they were adds no step. */
  record(lists: ColorLists, action: ListAction, run: () => void): void {
    const before = stateOf(lists);
    run();
    const after = stateOf(lists);
    if (!sameState(before, after)) this.push({ kind: 'lists', lists, action, before, after });
  }

  undo(): Replay | null {
    for (;;) {
      const step = this.done.pop();
      if (!step) return this.undoFallback();
      const replay = this.replay(step, 'undo');
      if (!replay) continue;
      this.undone.push(step);
      this.version++;
      return replay;
    }
  }

  redo(): Replay | null {
    for (;;) {
      const step = this.undone.pop();
      if (!step) return null;
      const replay = this.replay(step, 'redo');
      if (!replay) continue;
      this.done.push(step);
      this.version++;
      return replay;
    }
  }

  private undoFallback(): Replay | null {
    const session = this.fallback;
    const changed = session?.undo() ?? null;
    if (!session || !changed) {
      this.version++;
      return null;
    }
    this.undone.push({ kind: 'pixels', session });
    this.version++;
    return { kind: 'pixels', changed };
  }

  /** Undoes or redoes one step; null for a step that no longer applies. */
  private replay(step: Step, way: 'undo' | 'redo'): Replay | null {
    switch (step.kind) {
      case 'pixels': {
        const changed = way === 'undo' ? step.session.undo() : step.session.redo();
        return changed ? { kind: 'pixels', changed } : null;
      }
      case 'lists': {
        const [from, to] = way === 'undo' ? [step.after, step.before] : [step.before, step.after];
        if (!sameState(stateOf(step.lists), from)) return null;
        step.lists.removed.restoreEntries(to.removed);
        step.lists.replaced.restoreEntries(to.replaced);
        step.lists.removed.onchange?.();
        return { kind: 'lists', action: step.action, lists: step.lists };
      }
      case 'other':
        if (way === 'undo') step.undo();
        else step.redo();
        return { kind: 'other' };
    }
  }

  private push(step: Step): void {
    for (const old of this.undone) if (old.kind === 'pixels') old.session.dropRedo();
    this.fallback?.dropRedo();
    this.undone = [];
    this.done.push(step);
    if (this.done.length > LIMIT) this.done.shift();
    this.version++;
  }
}
