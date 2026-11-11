<script lang="ts">
  import { t } from '../app/i18n.ts';
  import SetGridPanel from './SetGridPanel.svelte';
  import SetPieceList from './SetPieceList.svelte';
</script>

<!-- The set side of the Grade step: the grid choice of the set, then every piece with its grid. -->
<aside class="set-rail" aria-label={t('setGrid.railLabel')}>
  <SetGridPanel />
  <div class="rail-list">
    <SetPieceList view="grid" />
  </div>
</aside>

<style>
  @layer components {
    .set-rail {
      display: grid;
      grid-template: auto minmax(0, 1fr) / minmax(0, 1fr);
      gap: var(--space-4);
      min-width: 0;
      min-height: 0;
      padding: var(--space-4) var(--space-3);
      background: var(--surface-1);
      border-right: 2px solid var(--line);
    }

    .rail-list {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      min-height: 0;
    }

    @media (max-height: 760px) {
      .set-rail {
        gap: var(--space-3);
        padding: var(--space-3) var(--space-3);
      }
    }
  }
</style>
