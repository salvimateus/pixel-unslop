<script lang="ts">
  interface Props {
    /** A short help text, such as "Alt + drag". The key names in it show as keycaps; the rest stays text. */
    text: string;
  }

  let { text }: Props = $props();

  /** A split with a capture group: the odd parts are the key names. */
  const parts = $derived(text.split(/\b(Ctrl|Alt|Shift|Delete|Enter|Esc|Tab)\b/));
</script>

{#each parts as part, i (i)}{#if i % 2 === 1}<kbd class="keycap">{part}</kbd>{:else}{part}{/if}{/each}
