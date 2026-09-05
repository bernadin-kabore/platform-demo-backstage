# ai-platform-request scaffolder module

A custom Backstage scaffolder action, `platform:ai:request`, registered into
the new backend system. It is the developer's entry point into the AI layer:
the template collects a sentence or two of intent, this action hands it to the
AI Platform Agent running in the cluster, and the agent returns pull requests
once they clear its eval gate.

See [`aiPlatformRequestAction.ts`](aiPlatformRequestAction.ts) for the details
and [`platform-demo-ai-agent`](https://github.com/bernadin-kabore/platform-demo-ai-agent)
for what happens on the other end.

## What this action is not

It does not talk to a model, and it holds no credential that could.

Backstage has no model credential and no GitHub App key. The agent has both,
in the cluster — the model one via IRSA rather than a secret at all. Putting
the Claude call in the portal instead would mean every portal instance needed
those secrets and every prompt change needed a portal deploy; keeping it here
means the portal knows one URL.

It also does not merge, approve, or deploy anything. What comes back is a list
of pull request URLs. Everything downstream of that — CI, policy scanning,
`terraform plan`, an approving human review, ArgoCD — is the platform that
already existed, unchanged.

## A rejected run is a success

If the agent's change set does not clear the eval threshold, no pull request is
opened and this action fails the scaffolder task with the evaluation report as
its message. That is the gate working, and the report is the useful part: it
says which rubric dimensions scored low and which deterministic checks blocked,
which usually points at a more specific way to phrase the request.

## Configuration

`app-config.yaml`:

```yaml
platform:
  aiAgent:
    baseUrl: ${AI_PLATFORM_AGENT_URL}
```

In-cluster that resolves to
`http://ai-platform-agent.ai-platform.svc.cluster.local`. The agent's
NetworkPolicy accepts ingress only from the `backstage` namespace, so this is
not reachable from anywhere else in the cluster and is not exposed outside it
at all.

## Wiring this into a generated app

Same as the sibling `branch-protection` module (see the top-level README for
why this repo holds only the customization layer). After
`npx @backstage/create-app`, add to the generated
`packages/backend/src/index.ts`:

```ts
backend.add(import('./modules/ai-platform-request/module'));
```

and copy this directory into the generated `packages/backend/src/modules/`.
It needs no dependency a stock generated backend does not already have — it
uses `fetch`, not an SDK.

## Called from

`platform-demo-hello-world-template/templates/ai-platform-request/template.yaml`,
which is the "Ask the Platform" entry under **Create** in the portal.
