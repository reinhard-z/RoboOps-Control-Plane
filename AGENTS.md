# RoboOps Agent Instructions

These instructions apply to the entire repository.

## Project Context

RoboOps Control Plane is a pnpm TypeScript workspace for a cloud-to-edge robot
fleet operations prototype. The codebase is organized around apps, shared
packages, infrastructure, simulations, docs, and tests.

## Coding Standards

- Write robust, readable code that an experienced senior developer would be
  comfortable maintaining.
- Avoid hacks, implicit coupling, and overly clever shortcuts.
- Prefer clear domain names and small functions over dense logic.
- Keep cognitive load low by making control flow and data boundaries explicit.
- Follow the existing module structure and local patterns before introducing new
  abstractions.
- Keep roadmap labels out of durable file names, migrations, package APIs,
  architecture docs, and UI copy. Use domain-oriented names instead.
- Preserve TypeScript strictness and avoid weakening types to get code through
  the compiler.

## Comments

- Add brief comments for all but the most basic functions, types, interfaces,
  classes, and modules.
- Keep comments human and useful: explain intent, invariants, edge cases, or
  why a choice exists.
- Do not narrate obvious implementation details that the code already states.

## Testing And Verification

- Use pnpm for workspace commands.
- Run focused package tests when touching a single app or package.
- Run broader checks when shared contracts, domain logic, persistence, or
  cross-package behavior changes.

Common commands:

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Local Environment Notes

- The workspace requires Node 22+. If `pnpm` fails with modern JavaScript syntax
  or regular-expression flag errors, check `node -v`.
- On this machine, run pnpm with Node 22 when needed:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm <command>
```

- Fleet Platform integration tests bind local HTTP/WebSocket servers on
  `127.0.0.1`; sandboxed runs may fail with `listen EPERM`. Rerun `pnpm test`
  with local bind permission when needed.
- Prefer focused Operator UI tests around extracted view-model or DOM-render
  helpers before adding browser test dependencies.

## Documentation

- Update docs when behavior, architecture, local demo flows, or public package
  contracts change.
- Keep examples executable and aligned with the current workspace scripts.
