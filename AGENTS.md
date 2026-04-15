# Agent Instructions

## Verification Checklist

Before committing any changes, run the following commands in order (or choose ones that apply based on the extent of the changes). Fix any issues before proceeding:

```bash
pnpm format        # Prettier — unifies code style
pnpm lint          # ESLint — catches style/rule violations
pnpm typecheck     # tsc --noEmit — catches type errors
pnpm test          # Vitest — catches failing tests
pnpm build         # Final build smoke-test
```

This is the same order CI uses. We want to avoid having to revisit code due to failed CI runs. Iterate if there are issues.

## Documentation Practices

Update [README.md](README.md) if there are any changes to the project overview, tech stack, or development practices.

Use one line per paragraph in Markdown if possible.

## Working Tips

Suggest alternative strategies or push back on the user's ideas if there are better practices recommended or the user appears to be inconsistent.

Teach or question the user if that is in the best interest of the final product.
