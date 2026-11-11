<script lang="ts" module>
  const PATHS = {
    view: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
    pencil: 'M4 20l1-5L15.5 4.5l4 4L9 19zM13 7l4 4M4 20h5',
    eraser: 'M3 15.5L12.5 6l6 6-7.5 7.5H7zM9 9.5l6 6M12 20h9',
    bucket: 'M4 11l7-7 8 8-7 7zM4 11h15M20 15v3M19 20h2',
    picker: 'M14 4l6 6M12.5 6.5l5 5M15 9L6 18H4v-2l9-9',
    undo: 'M4 9h11a5 5 0 0 1 0 10H9M8 5L4 9l4 4',
    redo: 'M20 9H9a5 5 0 0 0 0 10h6M16 5l4 4-4 4',
    grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
    zoomIn: 'M4 4h12v12H4zM16 16l5 5M7 10h6M10 7v6',
    zoomOut: 'M4 4h12v12H4zM16 16l5 5M7 10h6',
    fit: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z',
    soundOn: 'M4 9h4l5-4v14l-5-4H4zM16 9v6M19 6v12',
    soundOff: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
    info: 'M3 3h18v18H3zM12 11v6M12 7v1',
    alert: 'M12 3l10 18H2zM12 10v5M12 18v1',
    back: 'M15 5l-7 7 7 7',
    check: 'M4 12l5 5L20 6',
    download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
    folder: 'M3 6h6l2 2h10v11H3z',
    wand: 'M4 20L15 9M13 7l4 4M18 3v4M16 5h4M8 3v2M7 4h2M20 12v2M19 13h2',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
    swap: 'M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4',
    sparkle: 'M12 3v6M12 15v6M3 12h6M15 12h6M18 4v2M17 5h2M6 18v2M5 19h2',
    image: 'M3 4h18v16H3zM3 16l5-5 5 5 3-3 5 5M15 8h1v1h-1z',
    close: 'M6 6l12 12M18 6L6 18',
    more: 'M5 12h1M11.5 12h1M18 12h1',
    compare: 'M12 2v20M4 6h5v12H4zM15 6h5v12h-5z',
    star: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5l-5.4 3 1.2-6L3.3 9.3l6.1-.7z',
    arrows: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  } as const;

  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
    filled?: boolean;
  }

  let { name, size = 20, filled = false }: Props = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="square"
  stroke-linejoin="miter"
  aria-hidden="true"
  focusable="false"
>
  <path d={PATHS[name]} />
</svg>

<style>
  @layer components {
    .icon {
      flex: none;
      display: block;
    }
  }
</style>
