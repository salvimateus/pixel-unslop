<script lang="ts">
  interface Props {
    /** Each new value plays the effect once. 0 shows nothing. */
    trigger: number;
    count: number;
    colors: readonly string[];
    /** `burst` flies out from the center; `confetti` rises and falls over a wide area. */
    kind?: 'burst' | 'confetti';
  }

  let { trigger, count, colors, kind = 'burst' }: Props = $props();

  interface Piece {
    dx: number;
    dy: number;
    rot: number;
    size: number;
    delay: number;
    duration: number;
    color: string;
  }

  function makePieces(): Piece[] {
    return Array.from({ length: count }, (_, i) => {
      const color = colors[i % Math.max(1, colors.length)] ?? '#fff';
      if (kind === 'confetti') {
        return {
          dx: (Math.random() - 0.5) * 520,
          dy: 160 + Math.random() * 260,
          rot: (Math.random() - 0.5) * 900,
          size: 6 + Math.random() * 6,
          delay: Math.random() * 180,
          duration: 1100 + Math.random() * 700,
          color,
        };
      }
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const distance = 70 + Math.random() * 90;
      return {
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance,
        rot: (Math.random() - 0.5) * 360,
        size: 6 + Math.random() * 6,
        delay: 0,
        duration: 520 + Math.random() * 260,
        color,
      };
    });
  }
</script>

{#key trigger}
  {#if trigger > 0}
    <span class="burst burst-{kind}" aria-hidden="true">
      {#each makePieces() as piece, i (i)}
        <span
          class="burst-piece"
          style:--dx="{piece.dx}px"
          style:--dy="{piece.dy}px"
          style:--rot="{piece.rot}deg"
          style:--size="{piece.size}px"
          style:--delay="{piece.delay}ms"
          style:--duration="{piece.duration}ms"
          style:background={piece.color}
        ></span>
      {/each}
    </span>
  {/if}
{/key}

<style>
  @layer components {
    .burst {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      pointer-events: none;
    }

    .burst-confetti {
      top: 20%;
    }

    .burst-piece {
      position: absolute;
      left: calc(var(--size) / -2);
      top: calc(var(--size) / -2);
      width: var(--size);
      height: var(--size);
      opacity: 0;
      animation: burst-fly var(--duration) var(--ease-out) var(--delay) forwards;
    }

    .burst-confetti .burst-piece {
      height: calc(var(--size) * 0.6);
      animation-name: confetti-fall;
      animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1);
    }

    @keyframes burst-fly {
      0% {
        opacity: 1;
        transform: translate(0, 0) rotate(0) scale(1);
      }
      100% {
        opacity: 0;
        transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(0.4);
      }
    }

    @keyframes confetti-fall {
      0% {
        opacity: 1;
        transform: translate(0, 0) rotate(0);
      }
      30% {
        opacity: 1;
        transform: translate(calc(var(--dx) * 0.6), calc(var(--dy) * -0.45)) rotate(calc(var(--rot) * 0.3));
      }
      100% {
        opacity: 0;
        transform: translate(var(--dx), var(--dy)) rotate(var(--rot));
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .burst {
        display: none;
      }
    }
  }
</style>
