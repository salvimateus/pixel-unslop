<script lang="ts">
  import { tick } from 'svelte';
  import { cleanBaseName, fileNameProblem, MAX_BASE_NAME, type FileNameProblem } from '../app/file-name.ts';
  import { t, type TextKey } from '../app/i18n.ts';
  import * as sfx from '../app/sfx.ts';
  import Icon from './Icon.svelte';

  interface Props {
    /** The base name in use, with no extension. */
    base: string;
    /** Unique per dialog: the field gets `{id}-name` as its id and name. */
    id: string;
    /** A problem that the parent sees, such as two files with one name. */
    conflict?: string | null;
    disabled?: boolean;
    onrename: (base: string) => void;
    /** True while the field is open with a name that cannot be saved. */
    oninvalid?: (invalid: boolean) => void;
    /** `end` puts the name and the pencil at the right edge, as the values of the rows above it. */
    align?: 'start' | 'end';
  }

  let { base, id, conflict = null, disabled = false, onrename, oninvalid, align = 'start' }: Props = $props();

  /** Letters at the end of a name with no size part that always show. */
  const TAIL_CHARS = 12;

  const PROBLEMS: Record<FileNameProblem, TextKey> = {
    empty: 'fileName.empty',
    chars: 'fileName.chars',
    end: 'fileName.end',
    long: 'fileName.long',
    reserved: 'fileName.reserved',
  };

  let editing = $state(false);
  let draft = $state('');
  let input: HTMLInputElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  /**
   * The name in two parts: the end (the size and ".png") always shows, and the start loses its last letters to an
   * ellipsis when the row is short.
   */
  const nameParts = $derived.by(() => {
    const full = `${base}.png`;
    const marker = full.lastIndexOf('-pixel-');
    const cut = marker > 0 ? marker : Math.max(0, full.length - TAIL_CHARS);
    return { head: full.slice(0, cut), tail: full.slice(cut) };
  });
  const problem = $derived(editing ? fileNameProblem(cleanBaseName(draft)) : null);

  $effect(() => {
    oninvalid?.(editing && problem !== null);
  });

  async function open(): Promise<void> {
    draft = base;
    editing = true;
    sfx.play('tick');
    await tick();
    input?.focus({ preventScroll: true });
    input?.select();
  }

  async function close(): Promise<void> {
    editing = false;
    await tick();
    button?.focus({ preventScroll: true });
  }

  function confirm(): boolean {
    if (problem) return false;
    const next = cleanBaseName(draft);
    if (next !== base) onrename(next);
    void close();
    return true;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    } else if (event.key === 'Escape') {
      // Escape ends the edit only: the dialog stays open.
      event.preventDefault();
      event.stopPropagation();
      void close();
    }
  }

  function onBlur(): void {
    if (!editing) return;
    // A valid name is kept when the focus leaves; an invalid one stays open with its message.
    if (!problem) confirm();
  }
</script>

<span class="file-field" class:is-editing={editing} class:is-end={align === 'end'}>
  {#if editing}
    <span class="name-edit">
      <input
        bind:this={input}
        id="{id}-name"
        name="{id}-name"
        class="number-input name-input"
        type="text"
        maxlength={MAX_BASE_NAME + 8}
        spellcheck="false"
        autocomplete="off"
        aria-label={t('fileName.label')}
        aria-invalid={problem !== null || conflict !== null}
        aria-describedby={problem || conflict ? `${id}-problem` : undefined}
        bind:value={draft}
        onkeydown={onKey}
        onblur={onBlur}
      />
      <code class="ext">.png</code>
    </span>
  {:else}
    <span class="name-row">
      <code class="file-name" class:is-conflict={conflict !== null} title="{base}.png" aria-label="{base}.png">
        <span class="name-head" aria-hidden="true">{nameParts.head}</span><span class="name-tail" aria-hidden="true">{nameParts.tail}</span>
      </code>
      <button type="button" class="rename" bind:this={button} {disabled} aria-label="{t('fileName.rename')}: {base}.png" title={t('fileName.rename')} onclick={open}>
        <Icon name="pencil" size={14} />
      </button>
    </span>
  {/if}
  {#if (editing && problem) || conflict}
    <span class="problem" id="{id}-problem" role="alert"><Icon name="alert" size={14} />{editing && problem ? t(PROBLEMS[problem], { max: MAX_BASE_NAME }) : conflict}</span>
  {/if}
</span>

<style>
  @layer components {
    .file-field {
      display: inline-flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px var(--space-2);
      min-width: 0;
    }

    /* The name and the pencil never wrap: a long name loses the middle of its text, and its end stays visible. */
    .name-row {
      display: flex;
      flex: 1 1 100%;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;

      .is-end & {
        justify-content: flex-end;
      }
    }

    .file-name {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
      font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
      font-size: 0.8125rem;
      line-height: 1.4;
      white-space: pre;
      color: var(--text);

      &.is-conflict {
        color: var(--danger-text);
      }
    }

    .name-head {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .name-tail {
      flex: none;
    }

    .rename {
      display: inline-grid;
      place-items: center;
      flex: none;
      width: 28px;
      height: 28px;
      color: var(--text-muted);
      border: 2px solid var(--line);
      border-radius: var(--radius-s);
      transition:
        color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym),
        transform var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-3);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
        transition-duration: 60ms;
      }

      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }

    .name-edit {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      flex: 1 1 100%;
    }

    .name-input {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 30px;
      font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
      font-size: 0.8125rem;

      &[aria-invalid='true'] {
        border-color: var(--danger);
      }
    }

    .ext {
      color: var(--text-muted);
      font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
      font-size: 0.8125rem;
    }

    .problem {
      display: flex;
      flex-basis: 100%;
      align-items: center;
      gap: 4px;
      color: var(--danger-text);
      font-size: 0.75rem;
    }
  }
</style>
