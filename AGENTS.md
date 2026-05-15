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
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Documentation

- Update docs when behavior, architecture, local demo flows, or public package
  contracts change.
- Keep examples executable and aligned with the current workspace scripts.
