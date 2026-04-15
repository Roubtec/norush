<script>
  import "../app.css";
  import Header from "$lib/components/Header.svelte";

  let { children } = $props();
</script>

<div class="app">
  <Header />

  <main>
    {@render children()}
  </main>

  <footer>
    <p>norush chat &mdash; Deferred LLM batch processing</p>
  </footer>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  main {
    flex: 1;
    width: 100%;
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }

  footer {
    border-top: 1px solid var(--color-border);
    padding: 1rem 1.5rem;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }
</style>
