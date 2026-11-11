<script lang="ts">
  import logoUrl from '../../app-icon.svg';
  import { app, prefersReducedMotion } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { TUNING } from '../app/tuning.ts';
  import Burst from './Burst.svelte';
  import Icon from './Icon.svelte';
  import { sparkColors } from './stage-renderer.ts';

  let input: HTMLInputElement;
  let zone: HTMLButtonElement;
  let burst = $state(0);
  let lastSignal = 0;

  const SHAKE: Keyframe[] = [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-12px)' },
    { transform: 'translateX(10px)' },
    { transform: 'translateX(-7px)' },
    { transform: 'translateX(4px)' },
    { transform: 'translateX(0)' },
  ];
  const POP: Keyframe[] = [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(0.98)' }, { transform: 'scale(1)' }];

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

  async function onPick(): Promise<void> {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    await app.openFiles(files);
  }
</script>

<section class="drop-screen">
  <div class="drop-hero">
    <img class="drop-logo" src={logoUrl} alt={t('app.logoAlt')} width="88" height="88" />
    <h1 class="drop-title">{t('drop.title')}</h1>
    <p class="drop-tagline">{t('drop.tagline')}</p>
  </div>

  <button
    type="button"
    class="drop-zone"
    class:is-over={app.dragActive}
    bind:this={zone}
    disabled={app.loading}
    aria-describedby="drop-privacy"
    onclick={() => input.click()}
  >
    <span class="drop-icon"><Icon name="image" size={44} /></span>
    <span class="drop-zone-title">
      {app.loading ? t('drop.loading') : app.dragActive ? t('drop.zoneRelease') : t('drop.zone')}
    </span>
    <span class="drop-zone-sub">{t('drop.zoneSub')}</span>
    <span class="drop-formats">{t('drop.formats')}</span>
    <Burst trigger={burst} count={TUNING.ui.dropBurstCount} colors={sparkColors()} />
  </button>
  <input
    bind:this={input}
    id="image-file"
    name="image-file"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    aria-label={t('drop.inputLabel')}
    tabindex="-1"
    onchange={onPick}
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
      padding: var(--space-6) var(--space-4);
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
      gap: var(--space-2);
      width: min(620px, 100%);
      padding: var(--space-6) var(--space-5);
      color: var(--text);
      background:
        repeating-linear-gradient(45deg, transparent 0 14px, var(--stripe) 14px 28px),
        var(--surface-1);
      border: 3px dashed var(--line-strong);
      border-radius: var(--radius-l);
      box-shadow: 0 6px 0 var(--depth);
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
      }

      &:focus-visible {
        outline-offset: 4px;
      }

      &.is-over {
        border-style: solid;
        border-color: var(--primary);
        transform: scale(1.04);
      }

      &::after {
        content: '';
        position: absolute;
        inset: -3px;
        border-radius: inherit;
        box-shadow: 0 0 0 6px var(--primary-fill), 0 0 48px 8px var(--primary-glow);
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
      width: 84px;
      height: 84px;
      margin-bottom: var(--space-2);
      color: var(--primary);
      background: var(--surface-sunken);
      border: 2px solid var(--line);
      border-radius: var(--radius-l);
      transition: transform var(--dur-pop) var(--ease-spring);

      .drop-zone:hover &,
      .is-over & {
        transform: translateY(-4px) rotate(-4deg);
      }
    }

    .drop-zone-title {
      font: 600 1.625rem/1.2 var(--font-display);
    }

    .drop-zone-sub {
      color: var(--text-muted);
    }

    .drop-formats {
      margin-top: var(--space-2);
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

    @media (max-height: 720px) {
      .drop-screen {
        gap: var(--space-4);
        padding-block: var(--space-4);
      }

      .drop-logo {
        width: 64px;
        height: 64px;
      }

      .drop-zone {
        padding: var(--space-5) var(--space-5);
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
