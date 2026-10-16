/**
 * Locating the installed harness.
 *
 * Two callers need this: the plugin resolving `LlmRuntime` to patch, and the
 * marker bridge resolving `isAgentLoopRequest`. Both must reach the **same
 * physical module** the runtime uses — a second copy would make the prototype
 * patch target an unused class, which fails silently.
 *
 * Resolution order:
 *
 *   1. `DSH_HEAL_LLM_MODULE` — an explicit override (tests, and unusual hosts).
 *   2. A bare `@deepseek-ai/dsh-llm` import — the correct path when this package
 *      is installed into a profile, because the peer dependency resolves to the
 *      runtime's own copy.
 *   3. A scan of the pnpm dlx store — development ergonomics for a source
 *      checkout with no `node_modules`. No machine-specific path is written
 *      down; the store is found from the home directory.
 *
 * @module dsh-healer/resolve-harness
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LLM_PACKAGE = '@deepseek-ai/dsh-llm';

/**
 * This package's own root directory.
 *
 * Correct from both `src/resolve-harness.ts` and the bundled `lib/index.js`: each
 * sits two levels below the package root.
 */
export function localRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The module specifier to load, honouring the override. */
export function llmSpecifier(): string {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  return override !== undefined && override.length > 0 ? override : DEFAULT_LLM_PACKAGE;
}

/**
 * Filesystem access, injected so the search can be tested against a synthetic
 * store rather than only against whatever happens to be installed.
 */
export interface StoreFs {
  readdir(dir: string): readonly string[];
  exists(path: string): boolean;
  join(...parts: string[]): string;
}

/**
 * The pnpm store directory prefix for a `@deepseek-ai` package.
 *
 * Generalised from the llm-only original so the session package can be resolved
 * the same portable way. Two resolvers with different reach is how one test ends
 * up failing on a clean checkout while its neighbours pass.
 */
export function storePrefixFor(packageName: string): string {
  // pnpm encodes a scope's slash as a plus: `@types/node` -> `@types+node@`.
  const encoded = packageName.startsWith('@') ? packageName.replace('/', '+') : packageName;
  return `${encoded}@`;
}

/** A package name's path segments under `node_modules`. */
function packageSegments(packageName: string): string[] {
  return packageName.split('/');
}

/**
 * Path of a `@deepseek-ai` package entry point inside one `.pnpm` store.
 *
 * Defaults to the llm package, which is what the plugin patches. Package names are
 * always **fully qualified** (`@deepseek-ai/dsh-llm`): a bare `dsh-llm` would
 * encode to the wrong store prefix and silently find nothing.
 */
export function findHarnessInStore(
  store: string,
  fs: StoreFs,
  packageName: string = DEFAULT_LLM_PACKAGE,
): string | undefined {
  let packages: readonly string[];
  try {
    packages = fs.readdir(store);
  } catch {
    return undefined;
  }
  const prefix = storePrefixFor(packageName);
  for (const pkg of packages) {
    if (!pkg.startsWith(prefix)) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      'lib',
      'index.js',
    );
    if (fs.exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The standard pnpm dlx roots, in the order they are tried.
 *
 * Exported so every caller tries the same places. Two callers with different
 * root lists is the same defect as two callers with different depths, and this
 * project has already paid for that once: a test file scanned one level deep,
 * found nothing, skipped eleven tests, and left the suite green.
 */
export function dlxRoots(homedirPath: string, join: (...parts: string[]) => string): string[] {
  return [
    join(homedirPath, 'Library', 'Caches', 'pnpm', 'dlx'),
    join(homedirPath, '.cache', 'pnpm', 'dlx'),
    join(homedirPath, '.local', 'share', 'pnpm', 'dlx'),
  ];
}

/**
 * Resolve one file inside an installed `@deepseek-ai` package, across the
 * standard dlx roots.
 *
 * The single entry point for "where is the harness" — production and tests alike.
 * Anything that needs a path inside the installed harness should call this rather
 * than re-deriving the layout, because a re-derivation is how the layouts drift
 * apart.
 */
export function resolveHarnessEntry(
  packageName: string,
  innerPath: string,
  fs: StoreFs,
  homedirPath: string,
  depth = 3,
): string | undefined {
  for (const root of dlxRoots(homedirPath, fs.join)) {
    if (!fs.exists(root)) continue;
    const store = fs.join(root, 'node_modules', '.pnpm');
    if (fs.exists(store)) {
      const direct = entryIn(store, packageName, innerPath, fs);
      if (direct !== undefined) return direct;
    }
    const found = searchForHarnessEntry(root, depth, fs, packageName, innerPath);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Resolve a package entry from any store this installation can see.
 *
 * The **local** store first, then the dlx roots. That order is the difference
 * between working and not in CI: `pnpm install` there puts the peers into the
 * project's own `node_modules`, and there is no dlx cache under `$HOME` at all,
 * so a dlx-only search finds nothing and every harness-dependent file silently
 * contributes zero tests.
 *
 * `resolveHarnessEntry` stays dlx-only and pure. Its tests drive it with
 * synthetic stores, and adding a real root to it would make those tests find
 * this machine's actual packages instead of the fixture they describe.
 */
export function resolveInstalledEntry(
  packageName: string,
  innerPath: string,
  fs: StoreFs,
  homedirPath: string,
  depth = 3,
): string | undefined {
  const roots = [localRoot(), ...dlxRoots(homedirPath, fs.join)];
  for (const root of roots) {
    if (!fs.exists(root)) continue;
    const store = fs.join(root, 'node_modules', '.pnpm');
    if (fs.exists(store)) {
      const direct = entryIn(store, packageName, innerPath, fs);
      if (direct !== undefined) return direct;
    }
    const found = searchForHarnessEntry(root, depth, fs, packageName, innerPath);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** One package entry point inside a single `.pnpm` store, or `undefined`. */
function entryIn(
  store: string,
  packageName: string,
  innerPath: string,
  fs: StoreFs,
): string | undefined {
  let packages: readonly string[];
  try {
    packages = fs.readdir(store);
  } catch {
    return undefined;
  }
  const prefix = storePrefixFor(packageName);
  for (const pkg of packages) {
    if (!pkg.startsWith(prefix)) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      ...innerPath.split('/'),
    );
    if (fs.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Depth-bounded search for one package entry point below `dir`. */
function searchForHarnessEntry(
  dir: string,
  depth: number,
  fs: StoreFs,
  packageName: string,
  innerPath: string,
): string | undefined {
  if (depth <= 0) return undefined;
  let entries: readonly string[];
  try {
    entries = fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.pnpm' || entry.startsWith('.')) continue;
    const nested = fs.join(dir, entry);
    const store = fs.join(nested, 'node_modules', '.pnpm');
    if (fs.exists(store)) {
      const found = entryIn(store, packageName, innerPath, fs);
      if (found !== undefined) return found;
    }
    const deeper = searchForHarnessEntry(nested, depth - 1, fs, packageName, innerPath);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/**
 * Search one directory for a `.pnpm` store, descending at most `depth` levels.
 *
 * The dlx layout is not fixed — the store has appeared at
 * `<root>/node_modules/.pnpm`, `<root>/<entry>/node_modules/.pnpm`, and
 * `<root>/<hash>/<version>/node_modules/.pnpm` — so rather than encode one
 * shape, the search walks a bounded depth. Returns the first harness found.
 *
 * Defensive by contract: a missing directory, an unreadable one, or a partially
 * written entry must all degrade to "not found" rather than throwing.
 */
export function searchForHarness(
  dir: string,
  depth: number,
  fs: StoreFs,
  packageName: string = DEFAULT_LLM_PACKAGE,
): string | undefined {
  const direct = fs.join(dir, 'node_modules', '.pnpm');
  if (fs.exists(direct)) {
    const found = findHarnessInStore(direct, fs, packageName);
    if (found !== undefined) return found;
  }
  if (depth <= 0) return undefined;
  let entries: readonly string[];
  try {
    entries = fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    // Skip the heavy leaves: a store is never inside one of these.
    if (entry === 'node_modules' || entry === '.pnpm' || entry.startsWith('.')) continue;
    const found = searchForHarness(fs.join(dir, entry), depth - 1, fs, packageName);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The in-flight or completed scan, cached so it runs at most once.
 *
 * Caching the *promise* rather than a three-state value (`null` unscanned,
 * `undefined` not found, `string` found) fixes two things at once: the result is
 * plainly `string | undefined`, which a typecheck can verify, and two concurrent
 * callers share one scan instead of the second returning "not found" while the
 * first is still running.
 */
let scanPromise: Promise<string | undefined> | undefined;

/** Find the harness inside a pnpm store, or `undefined`. */
function scanStore(): Promise<string | undefined> {
  scanPromise ??= (async (): Promise<string | undefined> => {
    try {
      const { readdirSync, existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');

      const fs: StoreFs = {
        readdir: (dir) => readdirSync(dir),
        exists: (path) => existsSync(path),
        join: (...parts) => join(...parts),
      };

      const roots = [
        join(homedir(), 'Library', 'Caches', 'pnpm', 'dlx'),
        join(homedir(), '.cache', 'pnpm', 'dlx'),
        join(homedir(), '.local', 'share', 'pnpm', 'dlx'),
      ];
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const found = searchForHarness(root, 3, fs);
        if (found !== undefined) return pathToFileURL(found).href;
      }
    } catch {
      // Fall through: not found.
    }
    return undefined;
  })();
  return scanPromise;
}

/**
 * Load the harness module, or throw a diagnostic naming the real cause.
 *
 * An explicit override must fail loudly rather than silently falling back: a
 * mistyped override that quietly resolved to the default copy would hide the
 * very packaging problem the override exists to investigate.
 *
 * The bare-specifier failure message is deliberately explicit about the peer
 * dependency, because the failure it describes (a second copy, or none) is the
 * one that would otherwise manifest as a patch that quietly does nothing.
 */
export async function loadLlmModule(): Promise<Record<string, unknown>> {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  if (override !== undefined && override.length > 0) {
    try {
      return (await import(override)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `dsh-healer: cannot import the module named by DSH_HEAL_LLM_MODULE (${override}). ` +
          `Underlying error: ${(error as Error).message}`,
      );
    }
  }

  // When running inside the DSH host, NODE_PATH points to the active runtime's
  // node_modules. Resolving from NODE_PATH first ensures we bind to the exact
  // physical module running the host rather than a local peer copy or an
  // arbitrary dlx cache directory.
  const nodePaths = (process.env.NODE_PATH ?? '').split(':').filter(Boolean);
  if (nodePaths.length > 0) {
    try {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      for (const p of nodePaths) {
        try {
          const req = createRequire(p + '/dummy.js');
          const resolved = req.resolve(DEFAULT_LLM_PACKAGE);
          return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
        } catch {
          // continue checking next NODE_PATH entry
        }
      }
    } catch {
      // fall through to bare import
    }
  }

  try {
    return (await import(DEFAULT_LLM_PACKAGE)) as Record<string, unknown>;
  } catch (bareError) {
    const scannedUrl = await scanStore();
    if (scannedUrl !== undefined) {
      return (await import(scannedUrl)) as Record<string, unknown>;
    }
    throw new Error(
      `dsh-healer: cannot import ${DEFAULT_LLM_PACKAGE}. Declare it as a peerDependency so the ` +
        'plugin resolves the same copy the runtime uses. ' +
        `Underlying error: ${(bareError as Error).message}`,
    );
  }
}
