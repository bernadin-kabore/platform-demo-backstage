import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createBranchProtectionAction } from './branchProtectionAction';

export const scaffolderModuleBranchProtection = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'branch-protection',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createBranchProtectionAction({ config }));
      },
    });
  },
});
