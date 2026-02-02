import defu from 'defu';
import { Plugin, UserConfig } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import { PluginDevProxyModuleTopLevelAwait } from './plugins/pluginDevProxyModuleTopLevelAwait';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import pluginDts from './plugins/pluginDts';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
  NormalizedModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import { createNormalizeOptimizeDepsPlugin } from './utils/normalizeOptimizeDeps';
import VirtualModule, { initVirtualModuleInfrastructure } from './utils/VirtualModule';
import {
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  initVirtualModules,
  REMOTE_ENTRY_ID,
  writeLocalSharedImportMap,
} from './virtualModules';
import { VIRTUAL_EXPOSES } from './virtualModules/virtualExposes';
import {
  writeLoadShareModule,
  writePreBuildLibPath,
  getLoadShareModulePath,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
} from './virtualModules/virtualShared_preBuild';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import {
  virtualRuntimeInitStatus,
  writeRuntimeInitStatus,
} from './virtualModules/virtualRuntimeInitStatus';

/**
 * Plugin that runs FIRST to create virtual module files in the config hook.
 * This is critical to prevent 504 errors - files must exist before optimization starts.
 *
 * The 504 error occurs because:
 * 1. Vite starts optimization in the config hook
 * 2. Virtual modules are normally created in configResolved (too late)
 * 3. When browser loads, Vite discovers new dependencies and re-optimizes
 * 4. Pending requests with old version hash get 504 errors
 *
 * By creating files in the config hook AND adding them to optimizeDeps.include,
 * Vite knows about them during the initial optimization.
 */
function createEarlyVirtualModulesPlugin(options: NormalizedModuleFederationOptions): Plugin {
  const { name, shared, virtualModuleDir } = options;

  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      if (_command !== 'serve') return;

      // Initialize virtual module infrastructure EARLY (in config hook, not configResolved)
      const root = config.root || process.cwd();
      console.log(
        `[Module Federation] Early init: Creating virtual modules for ${name} in config hook`
      );

      // Create the virtual module directory structure
      initVirtualModuleInfrastructure(root, virtualModuleDir);

      // Set root for VirtualModule class
      VirtualModule.setRoot(root);
      VirtualModule.ensureVirtualPackageExists();

      // Create core virtual modules immediately
      // This writes the files to node_modules/__mf__virtual/
      initVirtualModules();

      // Collect the import IDs of virtual modules we create
      const virtualModuleImportIds: string[] = [];

      // Create shared module virtual modules immediately
      // This is the key fix - these files must exist BEFORE optimization
      if (shared && Object.keys(shared).length > 0) {
        console.log(
          `[Module Federation] Creating ${Object.keys(shared).length} shared module virtual files`
        );
        for (const key of Object.keys(shared)) {
          const shareItem = shared[key] as any;
          writeLoadShareModule(key, shareItem, _command);
          writePreBuildLibPath(key);
          addUsedShares(key);

          // Only add loadShare paths to optimizeDeps.include
          // NOTE: Do NOT add prebuild paths - they are empty placeholders that get
          // resolved via alias to the actual package. Adding them to optimizeDeps.include
          // causes Vite to bundle the empty file, breaking module loading.
          virtualModuleImportIds.push(getLoadShareModulePath(key));
        }
        // Update the localSharedImportMap with all shared modules
        writeLocalSharedImportMap();
      }

      // Add the runtimeInitStatus import ID
      virtualModuleImportIds.push(virtualRuntimeInitStatus.getImportId());

      // Now add the virtual modules to optimizeDeps.include with CORRECT paths
      // This is critical - Vite needs to know about these during initial optimization
      if (!config.optimizeDeps) config.optimizeDeps = {};
      if (!config.optimizeDeps.include) config.optimizeDeps.include = [];
      if (!config.optimizeDeps.needsInterop) config.optimizeDeps.needsInterop = [];

      console.log(
        `[Module Federation] Adding ${virtualModuleImportIds.length} virtual modules to optimizeDeps.include`
      );

      for (const importId of virtualModuleImportIds) {
        if (!config.optimizeDeps.include.includes(importId)) {
          config.optimizeDeps.include.push(importId);
        }
        if (!config.optimizeDeps.needsInterop.includes(importId)) {
          config.optimizeDeps.needsInterop.push(importId);
        }
      }
    },
  };
}

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { name, remotes, shared, filename, hostInitInjectLocation } = options;
  if (!name) throw new Error('name is required');

  return [
    // This plugin runs FIRST to create virtual module files before optimization
    createEarlyVirtualModulesPlugin(options),
    {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      configResolved(config) {
        // Set root path (may already be set by early init, but ensure it's correct)
        VirtualModule.setRoot(config.root);
        // Ensure virtual package directory exists
        VirtualModule.ensureVirtualPackageExists();
        initVirtualModules();
      },
    },
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    createNormalizeOptimizeDepsPlugin({
      shared,
      remotes,
      name,
      exposes: options.exposes,
      virtualModuleDir: options.virtualModuleDir,
    }),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: REMOTE_ENTRY_ID,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: getHostAutoInitPath(),
      inject: hostInitInjectLocation,
    }),
    ...addEntry({
      entryName: 'virtualExposes',
      entryPath: VIRTUAL_EXPOSES,
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
    ...pluginModuleParseEnd(
      (id: string) => {
        return (
          id.includes(getHostAutoInitImportId()) ||
          id.includes(REMOTE_ENTRY_ID) ||
          id.includes(VIRTUAL_EXPOSES) ||
          id.includes(getLocalSharedImportMapPath())
        );
      },
      {
        moduleParseTimeout: options.moduleParseTimeout,
      }
    ),
    ...proxySharedModule({
      shared,
    }),
    PluginDevProxyModuleTopLevelAwait(),
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // @ts-expect-error
      // used to expose plugin options: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config, { command: _command }: { command: string }) {
        // TODO: singleton
        (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: options.implementation,
        });
        config.build = defu(config.build || {}, {
          commonjsOptions: {
            strictRequires: 'auto',
          },
        });
        const virtualDir = options.virtualModuleDir || '__mf__virtual';
        config.optimizeDeps?.include?.push('@module-federation/runtime');
        config.optimizeDeps?.include?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(getLocalSharedImportMapPath());

        // Explicitly include shared dependencies in optimizeDeps to avoid
        // 504 Outdated Optimize Dep errors. This replaces the previous
        // optimizeDeps.force = true approach which caused race conditions.
        if (shared && Object.keys(shared).length > 0) {
          const sharedDeps = Object.keys(shared);
          for (const dep of sharedDeps) {
            if (!config.optimizeDeps?.include?.includes(dep)) {
              config.optimizeDeps?.include?.push(dep);
            }
          }
        }
      },
    },
    ...pluginManifest(),
  ];
}

export { federation };
