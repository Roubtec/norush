<script>
  import "../app.css";

  let { children } = $props();
</script>

<div class="app">
  <header>
    <nav>
      <a href="/" class="logo">norush</a>
    </nav>
  </header>

  <main>
    {@render children()}
  </main>

  <footer>
    <p>norush.chat &mdash; Deferred LLM batch processing</p>
  </footer>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  header {
    height: var(--header-height);
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    padding: 0 1.5rem;
  }

  nav {
    width: 100%;
    max-width: var(--max-width);
    margin: 0 auto;
    display: flex;
    align-items: center;
  }

  .logo {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-text);
    text-decoration: none;
  }

  .logo:hover {
    text-decoration: none;
    color: var(--color-primary);
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
