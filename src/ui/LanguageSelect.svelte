<script lang="ts">
  import { t } from '../app/i18n.ts';
  import { LOCALES, LOCALE_NAMES, activeLocale, parseLocale, setLocale } from '../app/locale.svelte.ts';
  import * as sfx from '../app/sfx.ts';
  import Icon from './Icon.svelte';

  /** True from a pointer press on the select until its next key press or blur. */
  let byPointer = false;

  function onChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    setLocale(parseLocale(select.value, activeLocale()));
    sfx.play('tick');
    // A choice made with the pointer gives the keyboard back to the shortcuts of the screen.
    if (byPointer) select.blur();
  }
</script>

<!-- A native select: the global key handlers of the screens ignore SELECT targets. -->
<span class="lang">
  <span class="lang-icon lang-globe"><Icon name="globe" size={18} /></span>
  <select
    id="language"
    name="language"
    class="lang-select"
    aria-label={t('header.language')}
    title={t('header.language')}
    value={activeLocale()}
    onchange={onChange}
    onpointerdown={() => (byPointer = true)}
    onkeydown={() => (byPointer = false)}
    onblur={() => (byPointer = false)}
  >
    {#each LOCALES as code (code)}
      <option class="lang-option" value={code} lang={code}>{LOCALE_NAMES[code]}</option>
    {/each}
  </select>
  <span class="lang-icon lang-caret"><Icon name="chevronDown" size={14} /></span>
</span>

<style>
  @layer components {
    .lang {
      position: relative;
      display: inline-grid;
      margin-right: var(--space-1);
      color: var(--text-muted);
      contain: layout style;
      transition: color var(--dur-hover) var(--ease-sym);

      &:hover,
      &:focus-within {
        color: var(--text);
      }
    }

    .lang-select {
      appearance: none;
      min-height: 28px;
      padding: 0 1.5rem 0 1.75rem;
      background: var(--surface-2);
      border: 2px solid var(--line);
      border-radius: 999px;
      font: 700 0.8125rem/1 var(--font-body);
      cursor: pointer;
      transition: border-color var(--dur-hover) var(--ease-sym);

      &:hover {
        border-color: var(--line-strong);
      }
    }

    .lang-option {
      color: var(--text);
      background: var(--surface-2);
    }

    .lang-icon {
      position: absolute;
      top: 50%;
      translate: 0 -50%;
      pointer-events: none;
    }

    .lang-globe {
      left: var(--space-2);
    }

    .lang-caret {
      right: var(--space-2);
    }
  }
</style>
