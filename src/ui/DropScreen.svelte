<script lang="ts">
  import logoUrl from '../../app-icon.svg';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import Burst from './Burst.svelte';
  import Icon from './Icon.svelte';
  import { sparkColors } from './stage-renderer.ts';

  type Entry = 'single' | 'set';

  let singleInput: HTMLInputElement;
  let setInput: HTMLInputElement;
  let zone: HTMLDivElement;
  let burst = $state(0);
  let over = $state<Entry | null>(null);
  let lastSignal = 0;

  const SHAKE: Keyframe[] = [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-12px)' },
    { transform: 'translateX(10px)' },
    { transform: 'translateX(-7px)' },
    { transform: 'translateX(4px)' },
    { transform: 'translateX(0)' },
  ];
  const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(0.99)' }, { transform: 'scale(1)' }];

  $effect(() => {
    const signal = app.dropSignal;
    if (!signal || signal.at === lastSignal || !zone) return;
    lastSignal = signal.at;
    if (prefersReducedMotion()) return;
    if (signal.kind === 'bad') {
      zone.animate(SHAKE, { duration: 420, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
    } else {
      zone.animate(POP, { duration: TUNING.ui.loadPopMs, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      burst++;
    }
  });

  $effect(() => {
    if (!app.dragActive) over = null;
  });

  function leave(event: DragEvent): void {
    const card = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) over = null;
  }

  async function onPick(input: HTMLInputElement, asSet: boolean): Promise<void> {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    await app.openFiles(files, asSet);
  }
</script>

<section class="drop-screen">
  <div class="drop-hero">
    <img class="drop-logo" src={logoUrl} alt={t('app.logoAlt')} width="88" height="88" />
    <h1 class="drop-title">{t('drop.title')}</h1>
    <p class="drop-tagline">{t('drop.tagline')}</p>
  </div>

  <div class="drop-zone" class:is-dragging={app.dragActive} bind:this={zone}>
    <div class="drop-head">
      <h2 class="drop-zone-title">{app.loading ? t('drop.loading') : app.dragActive ? t('drop.zoneRelease') : t('drop.zone')}</h2>
      <p class="drop-zone-sub">{t('drop.zoneSub')}</p>
    </div>

    <div class="drop-choices">
      <button
        type="button"
        class="drop-card"
        class:is-over={over === 'single'}
        disabled={app.loading}
        aria-describedby="drop-privacy"
        onclick={() => singleInput.click()}
        ondragenter={() => (over = 'single')}
        ondragover={() => (over = 'single')}
        ondragleave={leave}
      >
        <span class="drop-icon"><Icon name="image" size={36} /></span>
        <span class="drop-card-title">{t('drop.single')}</span>
        <span class="drop-card-sub">{t('drop.singleSub')}</span>
        <span class="drop-card-pick">{t('drop.pick')}</span>
      </button>
      <button
        type="button"
        class="drop-card is-set"
        class:is-over={over === 'set'}
        data-drop-set
        disabled={app.loading}
        aria-describedby="drop-privacy"
        onclick={() => setInput.click()}
        ondragenter={() => (over = 'set')}
        ondragover={() => (over = 'set')}
        ondragleave={leave}
      >
        <span class="drop-icon"><Icon name="pieces" size={36} /></span>
        <span class="drop-card-title">{t('drop.set')}</span>
        <span class="drop-card-sub">{t('drop.setSub')}</span>
        <span class="drop-card-pick">{t('drop.pick')}</span>
      </button>
    </div>

    <span class="drop-formats">{t('drop.formats')}</span>
    <Burst trigger={burst} count={TUNING.ui.dropBurstCount} colors={sparkColors()} />
  </div>

  <input
    bind:this={singleInput}
    id="image-file"
    name="image-file"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    aria-label={t('drop.inputLabel')}
    tabindex="-1"
    onchange={() => onPick(singleInput, false)}
  />
  <input
    bind:this={setInput}
    id="set-files"
    name="set-files"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    multiple
    aria-label={t('drop.setInputLabel')}
    tabindex="-1"
    onchange={() => onPick(setInput, true)}
  />

  <p class="drop-privacy" id="drop-privacy">
    <Icon name="check" size={16} />
    {t('drop.privacy')}
  </p>
</section>

<style>
  @layer components {
    .drop-screen {
      display: grid;
      place-content: center;
      justify-items: center;
      gap: var(--space-5);
      height: 100%;
      padding: var(--space-5) var(--space-4);
      overflow: auto;
      background-image: radial-gradient(var(--hairline) 1px, transparent 1.5px);
      background-size: 24px 24px;
      background-position: center;
    }

    .drop-hero {
      display: grid;
      justify-items: center;
      gap: var(--space-2);
      text-align: center;
    }

    .drop-logo {
      image-rendering: pixelated;
      filter: drop-shadow(0 6px 0 var(--depth));
      animation: logo-bob 3.2s var(--ease-sym) infinite alternate;
    }

    .drop-title {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: clamp(2.25rem, 4vw + 1rem, 3.5rem);
      color: var(--text);
      text-shadow: 0 4px 0 var(--depth);
    }

    .drop-tagline {
      color: var(--text-muted);
      font-size: 1.0625rem;
    }

    .drop-zone {
      position: relative;
      display: grid;
      justify-items: center;
      gap: var(--space-4);
      width: min(720px, 100%);
      padding: var(--space-5);
      color: var(--text);
      background:
        repeating-linear-gradient(45deg, transparent 0 14px, var(--stripe) 14px 28px),
        var(--surface-1);
      border: 3px dashed var(--line-strong);
      border-radius: var(--radius-l);
      box-shadow: 0 6px 0 var(--depth);
      transition: border-color var(--dur-hover) var(--ease-sym);

      &.is-dragging {
        border-style: solid;
        border-color: var(--primary);
      }
    }

    .drop-head {
      display: grid;
      justify-items: center;
      gap: var(--space-1);
      text-align: center;
    }

    .drop-zone-title {
      font: 600 1.625rem/1.2 var(--font-display);
    }

    .drop-zone-sub {
      max-width: 52ch;
      color: var(--text-muted);
      text-wrap: balance;
    }

    .drop-choices {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
      width: 100%;
    }

    .drop-card {
      position: relative;
      display: grid;
      justify-items: center;
      align-content: start;
      gap: var(--space-1);
      min-width: 0;
      padding: var(--space-4) var(--space-3);
      color: var(--text);
      text-align: center;
      background: var(--surface-2);
      border: 2px solid var(--line-strong);
      border-radius: var(--radius-l);
      box-shadow: 0 4px 0 var(--depth);
      transition:
        transform var(--dur-pop) var(--ease-sym),
        border-color var(--dur-hover) var(--ease-sym),
        background-color var(--dur-hover) var(--ease-sym);

      &:hover:not(:disabled) {
        border-color: var(--primary-edge);
        transform: translateY(-2px);
      }

      &:active:not(:disabled) {
        transform: translateY(2px);
        transition-duration: 60ms;
      }

      &:disabled {
        cursor: progress;
        opacity: 0.6;
      }

      &:focus-visible {
        outline-offset: 4px;
      }

      &.is-over {
        border-color: var(--primary);
        background: color-mix(in oklch, var(--primary), var(--surface-2) 86%);
        transform: scale(1.03);
      }

      &::after {
        content: '';
        position: absolute;
        inset: -2px;
        border-radius: inherit;
        box-shadow: 0 0 0 5px var(--primary-fill), 0 0 40px 6px var(--primary-glow);
        opacity: 0;
        transition: opacity var(--dur-pop) var(--ease-sym);
        pointer-events: none;
      }

      &.is-over::after {
        opacity: 1;
      }
    }

    .drop-icon {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      margin-bottom: var(--space-1);
      color: var(--primary);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-l);
      transition: transform var(--dur-pop) var(--ease-spring);

      .drop-card:hover &,
      .is-over & {
        transform: translateY(-3px) rotate(-4deg);
      }

      .is-set & {
        color: var(--teal);
      }
    }

    .drop-card-title {
      font: 600 1.375rem/1.2 var(--font-display);
    }

    .drop-card-sub {
      color: var(--text-muted);
      font-size: 0.9375rem;
      text-wrap: balance;
    }

    .drop-card-pick {
      margin-top: var(--space-2);
      padding: var(--space-1) var(--space-3);
      color: var(--on-primary);
      background: var(--primary);
      border-radius: 999px;
      font: 600 0.875rem/1.2 var(--font-display);

      .is-set & {
        background: var(--teal);
      }
    }

    .drop-formats {
      padding: var(--space-1) var(--space-3);
      font: 600 0.8125rem/1.2 var(--font-display);
      letter-spacing: 0.06em;
      color: var(--text-muted);
      background: var(--surface-sunken);
      border-radius: 999px;
    }

    .drop-privacy {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--text-muted);

      & :global(.icon) {
        color: var(--primary);
      }
    }

    @media (max-height: 760px) {
      .drop-screen {
        gap: var(--space-3);
        padding-block: var(--space-3);
      }

      .drop-logo {
        width: 56px;
        height: 56px;
      }

      .drop-title {
        font-size: 2.25rem;
      }

      .drop-zone {
        gap: var(--space-3);
        padding: var(--space-4);
      }

      .drop-zone-title {
        font-size: 1.375rem;
      }

      .drop-card {
        padding: var(--space-3);
      }

      .drop-icon {
        width: 52px;
        height: 52px;
      }
    }

    @keyframes logo-bob {
      from {
        transform: translateY(0);
      }
      to {
        transform: translateY(-6px);
      }
    }
  }
</style>
