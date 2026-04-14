<!--
  Login page.

  Redirects to the WorkOS hosted login UI. Shows a brief loading state
  while the redirect URL is fetched from the server.
-->
<script>
  import { onMount } from "svelte";

  let { data } = $props();

  onMount(() => {
    if (data.authUrl) {
      window.location.href = data.authUrl;
    }
  });
</script>

<svelte:head>
  <title>Login - norush chat</title>
</svelte:head>

<section class="login">
  <h1>norush</h1>
  <p>Redirecting to login...</p>
  {#if data.authUrl}
    <p class="fallback">
      Not redirected? <a href={data.authUrl}>Click here to log in</a>.
    </p>
  {:else}
    <p class="error">Authentication is not configured.</p>
  {/if}
</section>

<style>
  .login {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 60vh;
    gap: 1rem;
  }

  h1 {
    font-size: 3rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  p {
    font-size: 1.125rem;
    color: var(--color-text-muted);
  }

  .fallback {
    font-size: 0.875rem;
  }

  .error {
    color: #dc2626;
  }
</style>
