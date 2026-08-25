import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { ScmIntegrations } from '@backstage/integration';
import { Config } from '@backstage/config';
import { Octokit } from 'octokit';

// This whole action exists to compensate for one fact: bernadin-kabore/* are
// personal-account repos, not an Organization, so there's no equivalent of a
// GitHub Organization Ruleset that auto-applies to every repo an org creates
// — including ones that don't exist yet. On an Organization, the entire
// contents of this file is replaced by ONE Terraform resource
// (github_organization_ruleset, target = "branch", conditions.repository_name
// = ["~ALL"]) applied once, and nothing needs to run at scaffold time ever
// again. See platform-demo-terraform-modules/envs/github-repos/README.md.
//
// On a personal account, the closest available equivalent is: call the same
// GitHub Rulesets API a moment after the repo is created, once, from here.
// It's automated (the developer never touches it), but it's per-repo and it
// runs at scaffold time rather than being inherited for free.
export const createBranchProtectionAction = (options: { config: Config }) => {
  const { config } = options;

  return createTemplateAction({
    id: 'platform:github:branch-protection',
    description:
      'Creates a repository ruleset on main/develop/release/* requiring PR review, passing status checks (including the coverage gate), and signed commits, with the platform deploy bot exempted so CI can still push automated chart bumps to main.',
    schema: {
      input: {
        owner: z => z.string({ description: 'Repository owner (org or user)' }),
        repo: z => z.string({ description: 'Repository name' }),
        requiredStatusChecks: z =>
          z
            .array(z.string())
            .describe('Status check contexts that must pass before merging')
            .optional(),
      },
    },
    async handler(ctx) {
      const { owner, repo } = ctx.input;
      const requiredStatusChecks =
        ctx.input.requiredStatusChecks ?? ['test', 'sast', 'sca', 'coverage / check'];

      const githubIntegration = ScmIntegrations.fromConfig(config).github.byHost('github.com');
      const token = githubIntegration?.config.token;
      if (!token) {
        throw new Error(
          'No GitHub token configured under integrations.github in app-config.yaml — branch-protection needs the same token publish:github uses, with admin rights on the new repo.',
        );
      }

      // The platform deploy bot (see .github/actions/create-github-app-token
      // usage in every scaffolded ci.yml's update-manifests job) needs to
      // bypass this ruleset entirely to push image-tag bumps straight to
      // main. Its numeric App ID is a deployment-wide constant, not
      // per-service, so it's read from config rather than passed in by the
      // template — see app-config.yaml's platform.deployBotAppId.
      const deployBotAppId = config.getOptionalNumber('platform.deployBotAppId');

      const octokit = new Octokit({ auth: token });

      ctx.logger.info(
        `Creating branch-protection ruleset on ${owner}/${repo} (main, develop, release/*)`,
      );

      await octokit.request('POST /repos/{owner}/{repo}/rulesets', {
        owner,
        repo,
        name: 'platform-default',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main', 'refs/heads/develop', 'refs/heads/release/*'],
            exclude: [],
          },
        },
        bypass_actors: deployBotAppId
          ? [{ actor_id: deployBotAppId, actor_type: 'Integration' as const, bypass_mode: 'always' as const }]
          : [],
        rules: [
          { type: 'deletion' as const },
          { type: 'non_fast_forward' as const },
          { type: 'required_signatures' as const },
          {
            type: 'pull_request' as const,
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
            },
          },
          {
            type: 'required_status_checks' as const,
            parameters: {
              strict_required_status_checks_policy: true,
              do_not_enforce_on_create: true, // lets publish:github's initial commit through before any workflow has ever run
              required_status_checks: requiredStatusChecks.map(context => ({ context })),
            },
          },
        ],
      });

      ctx.logger.info('Branch-protection ruleset created.');
    },
  });
};
