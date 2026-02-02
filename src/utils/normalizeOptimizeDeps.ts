import { UserConfig } from 'vite';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';

export interface Command {
  command: string;
}

export interface NormalizeOptimizeDepsOptions {
  shared?: Record<string, unknown>;
  remotes?: Record<string, unknown>;
  exposes?: Record<string, unknown>;
  name?: string;
  virtualModuleDir?: string;
}

// Cache directory for storing federation config hash
const CACHE_DIR = 'node_modules/.cache/@module-federation';
const HASH_FILE = 'federation-config-hash.txt';

function sortObjectKeys(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  return Object.keys(obj)
    .sort()
    .reduce((result: any, key) => {
      result[key] = sortObjectKeys(obj[key]);
      return result;
    }, {});
}

function getFederationConfigHash(options: NormalizeOptimizeDepsOptions): string {
  const sortedConfig = sortObjectKeys({
    name: options.name,
    remotes: options.remotes,
    exposes: options.exposes,
    shared: options.shared,
  });
  const configString = JSON.stringify(sortedConfig);
  return createHash('md5').update(configString).digest('hex');
}

function getHashFilePath(name?: string): string {
  const filename = name ? `federation-config-hash-${name}.txt` : HASH_FILE;
  return join(process.cwd(), CACHE_DIR, filename);
}

function readStoredHash(name?: string): string | null {
  const hashFilePath = getHashFilePath(name);
  if (existsSync(hashFilePath)) {
    try {
      return readFileSync(hashFilePath, 'utf-8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function writeHash(hash: string, name?: string): void {
  const hashFilePath = getHashFilePath(name);
  const dir = dirname(hashFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(hashFilePath, hash);
}

export function createNormalizeOptimizeDepsPlugin(
  federationOptions: NormalizeOptimizeDepsOptions = {}
) {
  return {
    name: 'normalizeOptimizeDeps',
    config: (config: UserConfig, { command }: Command) => {
      let { optimizeDeps } = config;
      if (!optimizeDeps) {
        config.optimizeDeps = {};
        optimizeDeps = config.optimizeDeps;
      }

      // Only force re-optimization when the federation config has changed
      // This prevents 504 Outdated Optimize Dep errors while still ensuring
      // dependencies are re-optimized when needed
      if (!optimizeDeps.include) optimizeDeps.include = [];
      if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];

      // Only force re-optimization when the federation config has changed
      // This prevents 504 Outdated Optimize Dep errors while still ensuring
      // dependencies are re-optimized when needed
      if (command === 'serve') {
        const currentHash = getFederationConfigHash(federationOptions);
        const storedHash = readStoredHash(federationOptions.name);

        if (storedHash !== currentHash) {
          // Config has changed. Instead of using optimizeDeps.force = true (which causes race conditions),
          // we manually clear the cache directory to force a clean optimization.
          console.log(
            `[Module Federation] Config changed for ${federationOptions.name}, clearing cache to force optimization`
          );

          const cacheDir = config.cacheDir
            ? resolve(config.root || process.cwd(), config.cacheDir)
            : join(process.cwd(), 'node_modules/.vite');

          if (existsSync(cacheDir)) {
            try {
              console.log(`[Module Federation] Clearing cache directory: ${cacheDir}`);
              rmSync(cacheDir, { recursive: true, force: true });
            } catch (e) {
              console.error(`[Module Federation] Failed to clear cache:`, e);
            }
          }

          // We DO NOT set optimizeDeps.force = true here.
          // By clearing the cache, Vite will naturally optimize on start,
          // but it should respect the request hold mechanism better than force=true.
          writeHash(currentHash, federationOptions.name);
        } else {
          console.log(
            `[Module Federation] Config unchanged for ${federationOptions.name}, using cached optimization`
          );
        }

        // Pre-include shared dependencies to ensure they're optimized upfront
        // This helps prevent 504 errors by ensuring deps are ready before federation loads them
        if (federationOptions.shared) {
          const sharedKeys = Object.keys(federationOptions.shared);
          for (const key of sharedKeys) {
            if (!optimizeDeps.include!.includes(key)) {
              optimizeDeps.include!.push(key);
            }
            // Also add to needsInterop to ensure proper CJS/ESM interop
            if (!optimizeDeps.needsInterop!.includes(key)) {
              optimizeDeps.needsInterop!.push(key);
            }
          }
        }

        // NOTE: We CANNOT pre-include virtual modules in optimizeDeps.include because
        // they don't exist yet at this point (they're created in configResolved hook).
        // Vite will fail to resolve them during optimization with:
        // "Failed to resolve dependency: __mf__virtual/..., present in client 'optimizeDeps.include'"
        //
        // The 504 errors happen when Vite discovers new dependencies AFTER the initial crawl
        // and re-optimizes, changing the version hash. Pending requests with old hashes get 504.
        //
        // Current mitigation strategy:
        // 1. holdUntilCrawlEnd = true - holds requests until initial optimization is complete
        // 2. Pre-including shared dependencies - reduces the number of new discoveries
        // 3. The eager population of usedShares in configResolved - creates virtual modules early
        //
        // This doesn't fully prevent 504 errors because virtual modules are still discovered
        // after the initial crawl. A complete fix would require architectural changes to
        // create virtual modules BEFORE the config hook runs.

        // Ensure Vite holds requests until optimization is complete
        // This helps reduce 504 errors but doesn't fully prevent them
        optimizeDeps.holdUntilCrawlEnd = true;

        console.log(`[Module Federation] Final optimizeDeps for ${federationOptions.name}:`, {
          force: optimizeDeps.force,
          holdUntilCrawlEnd: optimizeDeps.holdUntilCrawlEnd,
          includeCount: optimizeDeps.include?.length,
          needsInteropCount: optimizeDeps.needsInterop?.length,
        });
      } else {
        // For build, always force to ensure fresh optimization
        optimizeDeps.force = true;
      }
    },
  };
}

// Default export for backward compatibility (without hash-based invalidation)
export default {
  name: 'normalizeOptimizeDeps',
  config: (config: UserConfig, { command }: Command) => {
    let { optimizeDeps } = config;
    if (!optimizeDeps) {
      config.optimizeDeps = {};
      optimizeDeps = config.optimizeDeps;
    }
    // todo: fix this workaround
    optimizeDeps.force = true;
    if (!optimizeDeps.include) optimizeDeps.include = [];
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];
  },
};
