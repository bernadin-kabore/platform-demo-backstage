import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createAiPlatformRequestAction } from './aiPlatformRequestAction';

export const scaffolderModuleAiPlatformRequest = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'ai-platform-request',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createAiPlatformRequestAction({ config }));
      },
    });
  },
});
