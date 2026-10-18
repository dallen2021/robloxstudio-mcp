import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getPluginsFolder,
  installPluginAsset,
} from './install-plugin-helpers.js';
import type { PluginVariant } from './install-plugin-helpers.js';


export interface PluginInstallOptions {
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Resolve artifacts and versions relative to the calling edition, including bundled CLIs. */
export function createPluginInstaller(moduleUrl: string, variant: PluginVariant) {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const ASSET_NAME = variant === 'main' ? 'MCPPlugin.rbxmx' : 'MCPInspectorPlugin.rbxmx';
  const OTHER_VARIANT = variant === 'main' ? 'MCPInspectorPlugin.rbxmx' : 'MCPPlugin.rbxmx';
  const buildCommand = variant === 'main' ? 'build:plugin' : 'build:plugin:inspector';

  function bundledAssetPath(): string | null {
    const candidates = [
      join(currentDir, '..', 'studio-plugin', ASSET_NAME),
      join(currentDir, '..', '..', '..', 'studio-plugin', ASSET_NAME),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  function resolvePluginAssetPath(sourcePath: string | undefined): string | null {
    if (sourcePath === undefined) return bundledAssetPath();
    return existsSync(sourcePath) ? sourcePath : null;
  }

  function packageVersion(): string {
    const pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
    if (!pkg.version) {
      throw new Error('Package version not found');
    }
    return pkg.version;
  }

  function installSource(source: Buffer, options: PluginInstallOptions) {
    return installPluginAsset({
      pluginsFolder: getPluginsFolder(),
      assetName: ASSET_NAME,
      otherAssetName: OTHER_VARIANT,
      source,
      expectedVersion: packageVersion(),
      expectedVariant: variant,
      replaceVariant: options.replaceVariant ?? true,
      log: options.log ?? console.log,
      warn: options.warn ?? console.warn,
    });
  }

  async function installBundledPlugin(options: PluginInstallOptions = {}): Promise<void> {
    const log = options.log ?? console.log;
    const sourcePath = resolvePluginAssetPath(options.sourcePath);
    if (!sourcePath) {
      throw new Error(
        `Bundled ${ASSET_NAME} not found. Run npm run ${buildCommand} in this worktree first.`,
      );
    }

    const result = installSource(readFileSync(sourcePath), options);
    if (result.installed) {
      log(`Installed ${ASSET_NAME} to ${result.destination}`);
    }
  }

  async function installPlugin(options: PluginInstallOptions = {}, dev = false): Promise<void> {
    const log = options.log ?? console.log;
    const bundled = resolvePluginAssetPath(options.sourcePath);
    if (options.sourcePath !== undefined && !bundled) {
      throw new Error(`Plugin asset not found at explicit path ${options.sourcePath}.`);
    }

    if (bundled) {
      const result = installSource(readFileSync(bundled), options);
      if (result.installed) {
        log(`Installed bundled ${ASSET_NAME} to ${result.destination}`);
      } else {
        log(`${ASSET_NAME} already installed.`);
      }
      return;
    }

    // dallen fork: never download a plugin. Upstream's fallback fetched the
    // release asset from chrrxs/robloxstudio-mcp, which is a different build
    // than this fork's server and would fail the plugin/server version match.
    void dev;
    throw new Error(
      `${ASSET_NAME} ${packageVersion()} is not built. This fork installs only a locally built plugin: ` +
      `run ${variant === 'main' ? 'npm run build:plugin:artifact' : 'npm run compile:plugin && node scripts/build-plugin.mjs --variant inspector --build-only'} ` +
      'in the fork checkout, then rerun with --install-plugin (or pass --plugin-path <file>).',
    );
  }

  return { installBundledPlugin, installPlugin };
}
