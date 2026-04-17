<!--
  ThemeToggle: small header button that cycles between system / light / dark.

  Three-state model:
    - "system" — no override, CSS `prefers-color-scheme` decides. This is
      the default on first load.
    - "light"  — forces the light palette regardless of OS preference.
    - "dark"   — forces the dark palette regardless of OS preference.

  The user's choice is stored in localStorage under `norush:theme`. An
  inline script in app.html applies the saved value before first paint to
  avoid a theme flash; this component only runs after hydration and mirrors
  that logic when the user changes the choice at runtime.

  When mode is "system", we clear any explicit `data-theme` override so CSS
  `prefers-color-scheme` follows OS preference changes while the page is open.
  A matchMedia listener tracks the OS preference to keep the aria-label accurate.
-->
<script>
  import { onMount } from "svelte";

  /** @typedef {"system" | "light" | "dark"} ThemeMode */

  const STORAGE_KEY = "norush:theme";

  /** @type {ThemeMode} */
  let mode = $state("system");

  /** Tracks whether hydration is complete; SSR render stays neutral. */
  let mounted = $state(false);

  /** Tracks OS dark-mode preference to keep aria-label accurate in system mode. */
  let systemPrefersDark = $state(false);

  /**
   * Apply `data-theme` on <html> for light/dark; clear it for system so
   * the `prefers-color-scheme` media query takes over.
   * @param {ThemeMode} next
   */
  function applyMode(next) {
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", next);
    }
  }

  /**
   * Persist and apply a new mode choice.
   * @param {ThemeMode} next
   */
  function setMode(next) {
    mode = next;
    try {
      if (next === "system") {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // localStorage may be unavailable — the choice still holds for this session.
    }
    applyMode(next);
  }

  /** Cycle: system → light → dark → system. */
  function cycle() {
    const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
    setMode(next);
  }

  onMount(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        mode = stored;
      }
    } catch {
      // Ignore; keep default "system".
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    systemPrefersDark = mq.matches;
    const onOsChange = (/** @type {MediaQueryListEvent} */ e) => {
      systemPrefersDark = e.matches;
    };
    mq.addEventListener("change", onOsChange);

    mounted = true;

    return () => mq.removeEventListener("change", onOsChange);
  });

  /** Human labels for the current mode, shown as tooltip/aria-label. */
  let label = $derived(
    mode === "system"
      ? `Theme: system — OS is using ${systemPrefersDark ? "dark" : "light"} (click to switch to light)`
      : mode === "light"
        ? "Theme: light (click to switch to dark)"
        : "Theme: dark (click to switch to system)",
  );
</script>

<button
  type="button"
  class="theme-toggle"
  onclick={cycle}
  aria-label={label}
  title={label}
>
  {#if !mounted || mode === "system"}
    <!-- Auto / half-moon+sun glyph -->
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  {:else if mode === "light"}
    <!-- Sun -->
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  {:else}
    <!-- Moon -->
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  {/if}
  <span class="sr-only">{label}</span>
</button>

<style>
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .theme-toggle:hover {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }

  .theme-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
