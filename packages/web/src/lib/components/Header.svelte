<!--
  Site header with primary navigation.

  Rendered in the root layout so it appears on every page. Highlights the
  link matching the current pathname. Navigation is plain anchor links so
  SvelteKit performs client-side routing automatically.
-->
<script>
  import { page } from "$app/state";

  /** @type {Array<{ href: string; label: string }>} */
  const links = [
    { href: "/chat", label: "Chat" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/settings", label: "Settings" },
  ];

  /**
   * True when the current path matches or is nested under the link target.
   * @param {string} href
   * @param {string} pathname
   */
  function isActive(href, pathname) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  }
</script>

<header>
  <nav aria-label="Primary">
    <a href="/" class="logo">norush</a>
    <ul class="links">
      {#each links as link}
        <li>
          <a
            href={link.href}
            class="link"
            class:active={isActive(link.href, page.url.pathname)}
            aria-current={isActive(link.href, page.url.pathname)
              ? "page"
              : undefined}
          >
            {link.label}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
</header>

<style>
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
    gap: 1.5rem;
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

  .links {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .link {
    display: inline-block;
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-decoration: none;
    transition:
      background 0.15s,
      color 0.15s;
  }

  .link:hover {
    background: #f3f4f6;
    color: var(--color-text);
    text-decoration: none;
  }

  .link.active {
    color: var(--color-primary);
    background: #eff6ff;
  }

  .link.active:hover {
    background: #dbeafe;
  }
</style>
