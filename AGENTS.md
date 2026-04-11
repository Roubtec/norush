# Agent Instructions

## Verification Checklist

Before committing any changes, run the following commands in order and fix any issues before proceeding:

```bash
pnpm lint          # ESLint — catches style/rule violations
pnpm typecheck     # tsc --noEmit — catches type errors
pnpm test          # Vitest — catches failing tests
pnpm build         # Final build smoke-test
```

This is the same order CI uses.
Do not commit until all four pass.

## Documentation Practices

Update [README.md](README.md) if there are any changes to the project overview, tech stack, or development practices.

Use one line per paragraph in Markdown if possible.

## Working Tips

Suggest alternative strategies or push back on the user's ideas if there are better practices recommended or the user appears to be inconsistent.

Teach or question the user if that is in the best interest of the final product.
