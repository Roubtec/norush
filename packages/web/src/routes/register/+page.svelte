<!--
  Register page.

  Redirects to WorkOS AuthKit with the sign-up screen hint so new users land
  on the account-creation form rather than the sign-in form.
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
  <title>Sign up - norush chat</title>
</svelte:head>

<section class="register">
  <h1>norush</h1>
  <p>Redirecting to sign up...</p>
  {#if data.authUrl}
    <p class="fallback">
      Not redirected? <a href={data.authUrl}>Click here to sign up</a>.
    </p>
  {:else}
    <p class="error">Authentication is not configured.</p>
  {/if}
</section>

<style>
  .register {
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
    color: var(--color-error-text);
  }
</style>
