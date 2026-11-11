<script lang="ts">
  import packageJson from '../../package.json?raw';
  import logoUrl from '../../app-icon.svg';
  import { app } from '../app/state.svelte.ts';
  import { t } from '../app/i18n.ts';
  import { isDesktop, openExternal } from '../app/platform.ts';
  import Dialog from './Dialog.svelte';

  const version = (JSON.parse(packageJson) as { version: string }).version;
  const AUTHOR_URL = 'https://github.com/salvimateus';

  function onAuthorClick(event: MouseEvent): void {
    if (!isDesktop) return;
    event.preventDefault();
    openExternal(AUTHOR_URL).catch(() => app.toast(t('error.internal'), 'error'));
  }
</script>

<Dialog open={app.aboutOpen} labelledby="about-title" onclose={() => (app.aboutOpen = false)}>
  <div class="dialog-body about">
    <img class="about-logo" src={logoUrl} alt="" width="72" height="72" />
    <h2 id="about-title" class="about-title">{t('about.title')}</h2>
    <p class="about-version">{t('about.version', { version })}</p>
    <p>{t('about.body')}</p>
    <p class="about-author">
      <span>{t('about.author')}</span>
      <a class="about-link" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" onclick={onAuthorClick}>{t('about.authorLink')}</a>
    </p>
    <p class="about-license">{t('about.license')}</p>
    <p class="hint">{t('about.credits')}</p>
    <div class="dialog-actions">
      <!-- svelte-ignore a11y_autofocus -->
      <button type="button" class="btn btn-primary" autofocus onclick={() => (app.aboutOpen = false)}>{t('about.close')}</button>
    </div>
  </div>
</Dialog>

<style>
  @layer components {
    .about {
      justify-items: center;
      text-align: center;
    }

    .about-logo {
      image-rendering: pixelated;
    }

    .about-title {
      font-size: 1.5rem;
    }

    .about-version {
      font-variant-numeric: tabular-nums;
      color: var(--primary);
      font-weight: 700;
    }

    .about-author {
      display: grid;
      gap: 2px;
    }

    .about-link {
      color: var(--teal);
      font-weight: 700;
      text-underline-offset: 3px;

      &:hover {
        color: var(--primary);
      }
    }

    .about-license {
      color: var(--text-muted);
    }

    .about .dialog-actions {
      justify-content: center;
    }
  }
</style>
