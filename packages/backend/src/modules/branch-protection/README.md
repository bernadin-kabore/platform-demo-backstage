# branch-protection scaffolder module

A custom Backstage scaffolder action, `platform:github:branch-protection`,
registered into the new backend system. See
[`branchProtectionAction.ts`](branchProtectionAction.ts) for what it does
and why it exists at all (short version: `bernadin-kabore/*` are personal
repos, not a GitHub Organization, so there's no org-wide ruleset that would
cover this automatically — see
`platform-demo-terraform-modules/envs/github-repos/README.md` for what the
equivalent looks like on an Organization).

## Wiring this into a generated app

This repo only holds the customization layer (see the top-level README).
After `npx @backstage/create-app`, in addition to copying over
`app-config.yaml`, add this module to the generated
`packages/backend/src/index.ts`:

```ts
backend.add(import('./modules/branch-protection/module'));
```

and copy this `modules/branch-protection/` directory into the generated
`packages/backend/src/`. `@backstage/plugin-scaffolder-node`,
`@backstage/backend-plugin-api`, `@backstage/integration`, and
`@backstage/config` all ship as dependencies of a stock generated backend
already; `octokit` does not — add it to `packages/backend/package.json`.

## Called from

Every language template's `template.yaml`
(`platform-demo-hello-world-template/templates/*/template.yaml`), as the
step right after `publish:github` creates the repo and before
`catalog:register`.
