import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Config } from '@backstage/config';

// The developer's entry point into the AI layer. A template collects a
// sentence or two of intent and this action hands it to the AI Platform Agent
// (platform-demo-ai-agent), which routes it to its four specialists, evaluates
// what they produced, and — if it passes — opens pull requests across the
// platform repositories.
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
// The scaffolder's own permission model still applies: who may run this
// template is an RBAC decision in app-config.production.yaml, the same as for
// the "hello-world-*" templates.
export const createAiPlatformRequestAction = (options: { config: Config }) => {
  const { config } = options;

  return createTemplateAction({
    id: 'platform:ai:request',
    description:
      'Sends a natural-language platform request to the AI Platform Agent, which produces pull requests across the platform repositories once they pass its eval gate. Returns the request id and, if the run finishes within the wait window, the pull request URLs.',
    schema: {
      input: {
        intent: z =>
          z
            .string()
            .min(10)
            .describe("What the developer wants, in their own words"),
        requester: z =>
          z.string().describe('Owning team or user the request is attributed to'),
        service: z =>
          z
            .string()
            .describe('Existing service the request concerns, if any')
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
      },
    },
    async handler(ctx) {
      const { intent, requester, service } = ctx.input;
      const waitSeconds = ctx.input.waitSeconds ?? 600;

      const baseUrl = config.getString('platform.aiAgent.baseUrl');

      ctx.logger.info(`Sending platform request to the AI Platform Agent at ${baseUrl}`);

      const accepted = await fetch(`${baseUrl}/v1/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, requester, service }),
      });

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

      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/v1/requests/${id}`);
        if (response.ok) {
          record = (await response.json()) as AgentRequestRecord;
          ctx.logger.info(`Request ${id}: ${record.status}`);
          if (terminal.has(record.status)) break;
        }
        await new Promise(resolve => setTimeout(resolve, 10_000));
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
        const reasoning = record.evaluation?.markdown ?? 'No evaluation report was returned.';
        throw new Error(
          [
            `The AI Platform Agent produced a change set that did not pass its own evaluation, so no pull request was opened.`,
            '',
            reasoning,
            '',
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

// Mirrors what platform-demo-ai-agent's GET /v1/requests/:id returns. Kept
// narrow on purpose: the portal shows status and links, and has no business
// rendering proposed file contents.
interface AgentRequestRecord {
  status: string;
  error?: string;
  pullRequests: { repo: string; url: string }[];
  evaluation?: {
    passed: boolean;
    score: number;
    threshold: number;
    markdown: string;
  };
}
