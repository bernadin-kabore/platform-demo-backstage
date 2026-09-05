import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createAiPlatformRequestAction } from './aiPlatformRequestAction';

// Unlike its sibling module, this one takes a catalog dependency. That is the
// whole of what changed to make "Ask the Platform" service-scoped: the selected
// Component has to be resolved to a repository and an owner, and the catalog is
// the only trustworthy place either of those exists.
//
// The action reads the catalog as the requesting user rather than as the
// backend, using the credentials the scaffolder task carries. A developer who
// cannot see a service in the portal therefore cannot scope a request to it,
// which keeps this consistent with the portal's own permission model instead of
// inventing a second one beside it.
export const scaffolderModuleAiPlatformRequest = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'ai-platform-request',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
      },
      async init({ scaffolder, config, catalog }) {
        scaffolder.addActions(createAiPlatformRequestAction({ config, catalog }));
      },
    });
  },
});
