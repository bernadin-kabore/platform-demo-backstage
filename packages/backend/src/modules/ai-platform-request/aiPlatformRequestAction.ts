import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Config } from '@backstage/config';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';

// The developer's entry point into the AI layer. A template collects a
// sentence or two of intent and this action hands it to the AI Platform Agent
// (platform-demo-ai-agent), which classifies it, routes it to the specialists
// it needs, evaluates what they produced, and — if it passes — opens pull
// requests.
//
// Two things this action deliberately does not do:
//
//   1. It does not talk to a model. Backstage holds no model credential and no
//      GitHub App key; the agent does, in the cluster, via IRSA. Putting the
//      Claude call here would mean every portal instance needed those secrets
//      and every prompt change needed a portal deploy.
//
//   2. It does not merge, approve, or deploy anything. What comes back is a
//      list of pull request URLs. Everything downstream of that — CI, policy
//      scanning, terraform plan, an approving human review, ArgoCD — is the
//      platform that already existed, unchanged.
//
// What it *does* do, and did not before, is resolve the selected service into a
// repository. That resolution is the authorization input for the entire run, so
// it is worth being precise about where the trust actually sits:
//
//   - The developer picks a Component from an EntityPicker with
//     allowArbitraryValues: false, so the entity reference is a catalog entity
//     rather than something typed.
//   - The repository comes from that entity's github.com/project-slug
//     annotation, which the shared catalog-info.yaml sets at scaffold time.
//   - Ownership comes from the entity's spec.owner.
//
// None of it comes from the request text, and the agent independently
// re-validates every field including the ownership comparison. This action
// failing open would therefore not grant access on its own — but it fails
// closed anyway, because a boundary that relies on the next layer catching it
// is not one you can reason about.
export const createAiPlatformRequestAction = (options: {
  config: Config;
  catalog: CatalogService;
}) => {
  const { config, catalog } = options;

  return createTemplateAction({
    id: 'platform:ai:request',
    description:
      'Sends a natural-language platform request to the AI Platform Agent. Resolves the selected service to its repository through the software catalog, so the agent is authorized for exactly that service and the platform repositories. Returns the request id, the execution plan, and any pull requests that resulted.',
    schema: {
      input: {
        intent: z =>
          z.string().min(10).describe("What the developer wants, in their own words"),
        requester: z =>
          z.string().describe('Owning team the request is attributed to and authorized as'),
        service: z =>
          z
            .string()
            .describe(
              'Entity reference of the service this request concerns, from the catalog. Omit for a platform-wide request.',
            )
            .optional(),
        waitSeconds: z =>
          z
            .number()
            .describe(
              'How long to wait for the run before handing back just the request id. A run takes minutes; the portal can poll afterwards either way.',
            )
            .optional(),
      },
      output: {
        requestId: z => z.string(),
        status: z => z.string(),
        pullRequests: z => z.array(z.string()),
        evaluationScore: z => z.number().optional(),
        interpretedRequest: z => z.string().optional(),
        ownershipScope: z => z.string().optional(),
        specialists: z => z.array(z.string()).optional(),
      },
    },
    async handler(ctx) {
      const { intent, requester, service } = ctx.input;
      const waitSeconds = ctx.input.waitSeconds ?? 600;

      const baseUrl = config.getString('platform.aiAgent.baseUrl');
      const expectedGithubOwner = config.getOptionalString('platform.aiAgent.githubOwner');

      const serviceContext = service
        ? await resolveService({ ctx, catalog, service, requester, expectedGithubOwner })
        : undefined;

      if (serviceContext) {
        ctx.logger.info(
          `Request scoped to ${serviceContext.entityRef}, which resolves to the ${serviceContext.repo} repository and is owned by ${serviceContext.owner}.`,
        );
      } else {
        ctx.logger.info(
          'No service selected; this is a platform-wide request and no application repository is in scope.',
        );
      }

      const accepted = await fetch(`${baseUrl}/v1/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, requester, serviceContext }),
      });

      if (accepted.status === 403) {
        // The agent refused at its own authorization boundary. That is a
        // correct outcome rather than an outage, and the developer needs to see
        // why in words rather than as a failed step.
        throw new Error(
          [
            'The AI Platform Agent refused this request:',
            '',
            await accepted.text(),
            '',
            'A team may only ask for help with services it owns. If this is your service, check its owner in the catalog.',
          ].join('\n'),
        );
      }

      if (!accepted.ok) {
        throw new Error(
          `The AI Platform Agent rejected the request (${accepted.status}): ${await accepted.text()}`,
        );
      }

      const { id } = (await accepted.json()) as { id: string };
      ctx.logger.info(`Accepted as request ${id}. Waiting up to ${waitSeconds}s for it to finish.`);

      // Poll rather than hold a connection open for ten minutes: an
      // orchestrator run is minutes of model calls and repository reads, and a
      // long-lived HTTP request through an Istio sidecar is the kind of thing
      // that times out somewhere unhelpful.
      const deadline = Date.now() + waitSeconds * 1000;
      const terminal = new Set(['pull-requests-open', 'rejected', 'failed']);
      let record: AgentRequestRecord | undefined;
      let planLogged = false;

      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/v1/requests/${id}`);
        if (response.ok) {
          record = (await response.json()) as AgentRequestRecord;
          ctx.logger.info(`Request ${id}: ${record.status}`);

          // The plan is the most useful thing the developer sees, and it exists
          // long before the run finishes — so surface it the moment it appears
          // rather than holding it until the end.
          if (record.plan && !planLogged) {
            planLogged = true;
            ctx.logger.info(describePlan(record.plan));
          }

          if (terminal.has(record.status)) break;
        }
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }

      if (record?.plan) {
        ctx.output('interpretedRequest', record.plan.interpretedRequest);
        ctx.output('ownershipScope', record.plan.ownershipScope);
        ctx.output(
          'specialists',
          record.plan.specialists.map(specialist => specialist.agent),
        );
      }

      if (!record || !terminal.has(record.status)) {
        // Not a failure. The run continues in the cluster whether or not the
        // portal is still watching, so hand back the id and let the developer
        // follow it there.
        ctx.logger.info(
          `Request ${id} is still running. It will finish without the portal; the pull requests will appear on the repositories when it does.`,
        );
        ctx.output('requestId', id);
        ctx.output('status', record?.status ?? 'running');
        ctx.output('pullRequests', []);
        return;
      }

      if (record.status === 'failed') {
        throw new Error(`The AI Platform Agent failed on request ${id}: ${record.error ?? 'no reason given'}`);
      }

      if (record.status === 'rejected') {
        // A rejected run is a working gate, not a broken one — the change set
        // did not meet the eval bar and so no pull request was opened. Surface
        // the reasoning rather than a bare failure, because the useful next
        // step is usually to rephrase the request.
        throw new Error(
          [
            'The AI Platform Agent produced a change set that did not pass its own evaluation, so no pull request was opened.',
            '',
            record.evaluation?.markdown ?? 'No evaluation report was returned.',
            '',
            ...describeDenials(record),
            'This is the gate working. Try a more specific request, or open the change by hand.',
          ].join('\n'),
        );
      }

      for (const pr of record.pullRequests) {
        ctx.logger.info(`Opened ${pr.url} on ${pr.repo}`);
      }

      ctx.output('requestId', id);
      ctx.output('status', record.status);
      ctx.output(
        'pullRequests',
        record.pullRequests.map(pr => pr.url),
      );
      if (record.evaluation) {
        ctx.output('evaluationScore', record.evaluation.score);
      }
    },
  });
};

/**
 * Resolve the selected Component into the repository the agent may write, and
 * refuse if any step of that is not certain.
 *
 * Every throw here is a fail-closed path. There is deliberately no fallback
 * that guesses a repository name from the component name: a Component whose
 * project-slug annotation is missing is a Component whose repository this
 * platform does not actually know, and inventing one would mean authorizing a
 * repository nobody verified.
 */
async function resolveService(args: {
  ctx: { getInitiatorCredentials: () => Promise<any>; logger: { warn: (message: string) => void } };
  catalog: CatalogService;
  service: string;
  requester: string;
  expectedGithubOwner?: string;
}): Promise<ServiceContext> {
  const { ctx, catalog, service, requester, expectedGithubOwner } = args;

  // Parsed rather than passed through, so a malformed reference fails here
  // instead of somewhere less obvious.
  const ref = parseEntityRef(service, { defaultKind: 'component', defaultNamespace: 'default' });
  if (ref.kind.toLowerCase() !== 'component') {
    throw new Error(
      `${service} is a ${ref.kind}, not a Component. Only a service can be the subject of a request.`,
    );
  }

  const entity = await catalog.getEntityByRef(stringifyEntityRef(ref), {
    credentials: await ctx.getInitiatorCredentials(),
  });

  if (!entity) {
    throw new Error(
      `${service} is not in the software catalog, or you cannot see it. The agent will not act on a service the catalog cannot confirm.`,
    );
  }

  const slug = entity.metadata.annotations?.['github.com/project-slug'];
  if (!slug) {
    throw new Error(
      `${service} has no github.com/project-slug annotation, so the platform cannot tell which repository it lives in. Add the annotation to its catalog-info.yaml and try again.`,
    );
  }

  const [slugOwner, repo] = slug.split('/');
  if (!slugOwner || !repo) {
    throw new Error(`The github.com/project-slug annotation on ${service} is not in owner/repo form: "${slug}".`);
  }
  if (expectedGithubOwner && slugOwner !== expectedGithubOwner) {
    // The agent resolves repositories inside a single configured GitHub owner.
    // A slug pointing somewhere else would otherwise silently authorize a
    // same-named repository in the agent's own organisation.
    throw new Error(
      `${service} lives under the ${slugOwner} GitHub owner, and the AI Platform Agent is installed on ${expectedGithubOwner}. It cannot open a pull request there.`,
    );
  }

  const owner = entity.spec?.owner;
  if (typeof owner !== 'string' || !owner.trim()) {
    throw new Error(`${service} has no owner in the catalog, so there is nobody to authorize this request as.`);
  }

  if (normalizeGroup(owner) !== normalizeGroup(requester)) {
    throw new Error(
      `${requester} does not own ${service}, which belongs to ${owner}. A team may only ask the platform for help with services it owns.`,
    );
  }

  return {
    entityRef: stringifyEntityRef(ref),
    name: entity.metadata.name,
    repo,
    owner,
  };
}

/**
 * "group:default/checkout-team" and "checkout-team" name the same team; an
 * entity's spec.owner produces the first and an OwnerPicker can produce either.
 * The agent normalises identically — see src/scope.ts there — and the two
 * implementations have to agree or every request is denied.
 */
function normalizeGroup(value: string): string {
  return value.trim().toLowerCase().replace(/^group:/, '').replace(/^default\//, '');
}

function describePlan(plan: ExecutionPlan): string {
  return [
    'The platform understood the request as:',
    `  ${plan.interpretedRequest}`,
    `  Scope: ${plan.ownershipScope}${plan.targetService ? ` (${plan.targetService})` : ''}`,
    `  Risk: ${plan.risk} — ${plan.riskReason}`,
    '  Working on it:',
    ...plan.specialists.map(
      specialist =>
        `    ${specialist.agent} — ${specialist.reason}${
          specialist.intendedWrites.length
            ? ` (proposing changes to ${specialist.intendedWrites.map(w => w.repo).join(', ')})`
            : ''
        }`,
    ),
    ...(plan.outOfScope.length
      ? ['  Deliberately not covered:', ...plan.outOfScope.map(item => `    ${item}`)]
      : []),
  ].join('\n');
}

/** Refusals are the most useful part of a rejected run, so they are shown, not swallowed. */
function describeDenials(record: AgentRequestRecord): string[] {
  const denials = (record.changeSets ?? []).flatMap(set =>
    (set.denials ?? []).map(denial => `  ${set.agent}: ${denial}`),
  );
  return denials.length ? ['The agent was refused the following, which may explain the result:', ...denials, ''] : [];
}

interface ServiceContext {
  entityRef: string;
  name: string;
  repo: string;
  owner: string;
}

interface ExecutionPlan {
  interpretedRequest: string;
  targetService?: string;
  ownershipScope: string;
  risk: string;
  riskReason: string;
  specialists: { agent: string; reason: string; intendedWrites: { repo: string }[] }[];
  outOfScope: string[];
}

// Mirrors what platform-demo-ai-agent's GET /v1/requests/:id returns. Kept
// narrow on purpose: the portal shows the plan, the status and links, and has
// no business rendering proposed file contents.
interface AgentRequestRecord {
  status: string;
  error?: string;
  plan?: ExecutionPlan;
  changeSets?: { agent: string; denials?: string[] }[];
  pullRequests: { repo: string; url: string }[];
  evaluation?: {
    passed: boolean;
    score: number;
    threshold: number;
    markdown: string;
  };
}
