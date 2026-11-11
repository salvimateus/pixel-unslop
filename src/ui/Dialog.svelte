<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    labelledby: string;
    /** Escape, a click on the backdrop and the close buttons all end here. */
    onclose: () => void;
    wide?: boolean;
    children: Snippet;
  }

  let { open, labelledby, onclose, wide = false, children }: Props = $props();
  let dialog: HTMLDialogElement;

  $effect(() => {
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="dialog"
  class:dialog-wide={wide}
  aria-labelledby={labelledby}
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
  onclick={(event) => {
    if (event.target === dialog) onclose();
  }}
>
  {#if open}
    {@render children()}
  {/if}
</dialog>

<style>
  @layer components {
    .dialog-wide {
      width: min(560px, calc(100vw - 32px));
    }
  }
</style>
