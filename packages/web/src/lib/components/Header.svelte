<!--
  Site header with primary navigation.

  Rendered in the root layout so it appears on every page. The primary nav
  and logout link are only shown when a user is logged in (read from
  `page.data.user`, populated by the root +layout.server.ts). Anonymous
  visitors get "Log in" / "Sign up" links that kick off the WorkOS AuthKit
  flow (the /register route passes screenHint=sign-up).

  Logout uses a plain GET anchor to /auth/logout. The CSRF risk is accepted as
  low-severity: the session cookie is SameSite=Lax, so browsers will not attach
  it to cross-origin subresource requests (e.g. <img>). A cross-site link that
  tricks a user into clicking could trigger a "drive-by logout", but that merely
  ends the session — it does not allow an attacker to act on the user's behalf.
-->
<script>
  import { page } from "$app/state";
  import ThemeToggle from "./ThemeToggle.svelte";

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
    {#if page.data.user}
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
      <div class="auth">
        <span class="user-name">
          {page.data.user.firstName ?? page.data.user.email}
        </span>
        <ThemeToggle />
        <a href="/auth/logout" class="link" data-sveltekit-reload>Log out</a>
      </div>
    {:else}
      <div class="auth">
        <ThemeToggle />
        <a
          href="/login"
          class="link"
          class:active={isActive("/login", page.url.pathname)}
          aria-current={isActive("/login", page.url.pathname)
            ? "page"
            : undefined}
        >
          Log in
        </a>
        <a
          href="/register"
          class="link link-primary"
          class:active={isActive("/register", page.url.pathname)}
          aria-current={isActive("/register", page.url.pathname)
            ? "page"
            : undefined}
        >
          Sign up
        </a>
      </div>
    {/if}
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

  .auth {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .user-name {
    font-size: 0.875rem;
    color: var(--color-text-muted);
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
    background: var(--color-surface-muted);
    color: var(--color-text);
    text-decoration: none;
  }

  .link.active {
    color: var(--color-primary);
    background: var(--color-primary-subtle-bg);
  }

  .link.active:hover {
    background: var(--color-primary-subtle-bg-hover);
  }

  .link-primary {
    background: var(--color-primary);
    color: var(--color-on-primary);
  }

  .link-primary:hover {
    background: var(--color-primary-hover);
    color: var(--color-on-primary);
  }
</style>
