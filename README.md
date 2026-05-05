# visual-compare

A TypeScript monorepo for visually comparing web pages.

## Layout

This repository uses a bare-repo layout to make it easy to work in multiple
git worktrees side by side:

```
visual-compare/
├── .bare/         # bare git repo (the source of truth)
├── main/          # worktree for the main branch
└── <feature>/     # additional worktrees as siblings
```

To work on a new branch, add a sibling worktree:

```sh
git -C main worktree add ../my-feature -b my-feature
```

## Packages

- `packages/api` — backend API
- `packages/web` — web frontend
- `packages/shared` — code shared between api and web
