# Publish @norush/core to npm

## Why this task exists

`@norush/core` is designed to be a standalone developer library.
Publishing it to npm makes the batch engine available to anyone who wants to use deferred LLM processing in their own apps.

## Scope

**Included:**
- Package preparation: correct `package.json` fields (`main`, `module`, `types`, `exports`, `files`)
- ESM + types build output verification
- `README.md` for the package: installation, quick start, API overview
- `CHANGELOG.md` initialization
- npm publish configuration (public package, scoped to `@norush`)
- GitHub Actions workflow for npm publish on release/tag

**Out of scope:**
- Documentation site (task 4-05)
- `@norush/web` publish (it's an application, not a library)

## Context and references

- PLAN.md Section 8, Phase 4 — "npm publish `@norush/core`"
- PLAN.md Section 5.3 (Developer Library) — usage pattern: `npm install @norush/core`

## Target files or areas

```
packages/core/
├── package.json              # Verify/update exports, files, publishConfig
├── README.md                 # Package-level documentation
├── CHANGELOG.md
.github/workflows/
└── publish.yml               # npm publish on release tag
```

## Implementation notes

- **Package.json exports map:**
  ```json
  {
    "exports": {
      ".": {
        "import": "./dist/index.js",
        "types": "./dist/index.d.ts"
      }
    },
    "files": ["dist", "README.md", "CHANGELOG.md"]
  }
  ```
- **README.md** should include: install command, `createNorush()` quick start, links to full docs, supported providers.
- **Publish workflow:** Trigger on GitHub release creation or version tag (`v*`). Steps: checkout → install → build → test → `npm publish`. Use `NODE_AUTH_TOKEN` secret.
- **Scoped package:** Set `"publishConfig": { "access": "public" }` for the `@norush` scope.
- Verify that no source files, tests, or configs are included in the published package (only `dist/`).

### Dependencies

- Requires task 1-09 (core library is complete and tested).
- Requires npm account with `@norush` scope claimed.

## Acceptance criteria

- `npm pack` produces a tarball with only `dist/`, `README.md`, and `CHANGELOG.md`.
- Package exports resolve correctly: `import { createNorush } from '@norush/core'`.
- TypeScript types are included and resolve correctly.
- README has installation instructions and a working quick-start example.
- GitHub Actions publish workflow is configured and valid.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Run `npm pack --dry-run` → verify only expected files are included.
- In a separate project: `npm install ./norush-core-X.Y.Z.tgz` → verify imports work.
- Review README for accuracy and completeness.

## Review plan

- Verify no test files, source maps, or config files leak into the package.
- Verify exports map is correct for ESM consumers.
- Check that the publish workflow requires tests to pass before publishing.
- Confirm `@norush` scope is configured for public access.
