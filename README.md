# platform-demo-backstage

The Internal Developer Portal. This repo holds the **customization layer**
on top of a stock Backstage app — config, catalog entities, and plugin
wiring — not a hand-rolled Backstage core (that's generated tooling; see
below).

## Bootstrapping the actual app

```bash
npx @backstage/create-app@latest --path .
```

then copy this repo's `app-config.yaml`, `app-config.production.yaml`, and
`catalog/` over the generated defaults, and install the plugins referenced
below.

## Plugins this portal runs

| Plugin | Why |
|---|---|
| `@backstage/plugin-scaffolder` | Powers the "hello-world-*" templates — the whole point of the demo |
| `@backstage/plugin-catalog` | Software catalog: every service, its owner, its links |
| `@backstage/plugin-kubernetes` | Pod status, events, and logs for a service, right on its catalog page |
| `@backstage/plugin-techdocs` | Docs-as-code, rendered from each repo's `docs/` |
| `@roadiehq/backstage-plugin-argo-cd` | Shows each service's ArgoCD sync/health status inline |
| `@backstage-community/plugin-grafana` | Embeds the service's Grafana dashboards |
| `@backstage-community/plugin-tech-insights` | Surfaces Kyverno PolicyReports as scorecards per service |
| `backstage-plugin-github-actions` | Shows the last CI run and its SAST/SCA/scan results |

## Catalog structure

```
catalog/
├── org.yaml              Team/Group/User entities
└── platform-system.yaml  System entity grouping all platform components
```

Both are registered as `file` locations in `app-config.yaml`, alongside a
single `url` location pointing at `platform-demo-hello-world-template`'s
root `catalog-info.yaml` — a `Location` entity that in turn lists all four
language templates (`templates/{nodejs,python,go,java}/template.yaml`).
That's what makes **Node.js Service**, **Python Service**, **Go Service**,
and **Java Service** all show up under **Create** in the portal; adding a
5th language later is one new line in that `catalog-info.yaml`, no change
here. Every app a template scaffolds registers itself the same way, via the
`catalog-info.yaml` its skeleton includes.

## Custom scaffolder actions

| Action | Purpose |
|---|---|
| [`platform:github:branch-protection`](packages/backend/src/modules/branch-protection) | Called by every "hello-world-*" template right after the repo is created: locks down `main`/`develop`/`release/*` (PR required, signed commits, the coverage check required) via GitHub's Rulesets API |

This exists because `bernadin-kabore/*` are personal repos, not a GitHub
Organization — see that module's README for the full explanation, and
`platform-demo-terraform-modules/envs/github-repos/README.md` for what
replaces it entirely on an Organization (one Terraform resource, zero
scaffolder involvement).

## Auth

`app-config.yaml` wires GitHub OAuth as the sign-in provider (`auth.github`)
— team membership from GitHub org membership drives catalog ownership and
scaffolder permissions (`permission.enabled: true`, RBAC policy in
`app-config.production.yaml`).

## The "spin up a hello world app" flow

1. Developer opens Backstage → **Create** → picks a language (**hello-world-nodejs**, **-python**, **-go**, or **-java**).
2. Fills in: service name, owning team, language runtime, whether to
   provision an S3 bucket (Crossplane claim), and target namespace.
3. The scaffolder (defined in
   [`platform-demo-hello-world-template`](../platform-demo-hello-world-template)) templates the
   skeleton, creates a new GitHub repo, locks down its `main`/`develop`/`release/*`
   branches (`platform:github:branch-protection`, above), pushes the app + its
   CI workflow + its Helm chart, opens a PR against `platform-demo-gitops`
   adding the new `services/<service-name>/config.json`, and registers the
   new service in the Backstage catalog — all from one form.
4. Once the GitOps PR merges, ArgoCD deploys it with Istio sidecar
   injection, an Argo Rollout, ServiceMonitor, and OTel instrumentation
   already wired in — the developer never touches Kubernetes YAML.
