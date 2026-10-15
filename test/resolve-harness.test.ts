/**
 * The harness resolver.
 *
 * This module decides **which physical copy** of `@deepseek-ai/dsh-llm` the
 * plugin patches. Getting it wrong is the failure mode the whole design worries
 * about: the patch lands on a class the runtime never uses and every request
 * silently keeps failing. So the search is tested directly, against synthetic
 * stores, rather than only against whatever happens to be installed.
 *
 * The filesystem is injected, so these cases are deterministic and need no real
 * directory tree — including the layouts that are awkward to reproduce on
 * purpose, such as an unreadable directory or a store at an unexpected depth.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  dlxRoots,
  findHarnessInStore,
  loadLlmModule,
  resolveHarnessEntry,
  searchForHarness,
  storePrefixFor,
} from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

/**
 * A fake filesystem over an explicit set of paths.
 *
 * `dirs` maps a directory path to its entries; a path absent from `dirs` is a
 * file (so `exists` answers true) unless it is also absent from `files`.
 */
function fakeFs(spec: { dirs: Record<string, string[]>; unreadable?: string[] }): StoreFs {
  const dirs = new Map(Object.entries(spec.dirs));
  const unreadable = new Set(spec.unreadable ?? []);
  const files = new Set<string>();
  for (const [dir, entries] of dirs) {
    for (const entry of entries) {
      const child = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
      if (!dirs.has(child)) files.add(child);
    }
  }
  return {
    readdir: (dir) => {
      if (unreadable.has(dir)) throw new Error(`EACCES: ${dir}`);
      const entries = dirs.get(dir);
      if (entries === undefined) throw new Error(`ENOTDIR: ${dir}`);
      return entries;
    },
    exists: (path) => dirs.has(path) || files.has(path),
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
  };
}

/** Build the path to a harness entry point inside a store. */
const harnessPath = (store: string, pkg: string) =>
  `${store}/${pkg}/node_modules/@deepseek-ai/dsh-llm/lib/index.js`;

describe('findHarnessInStore', () => {
  const store = '/store/.pnpm';

  it('finds the harness entry point', () => {
    const pkg = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
    const fs = fakeFs({
      dirs: {
        [store]: [pkg],
        [`${store}/${pkg}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
      },
    });
    assert.equal(findHarnessInStore(store, fs), harnessPath(store, pkg));
  });

  it('ignores a matching directory whose entry point is missing', () => {
    const pkg = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
    const fs = fakeFs({ dirs: { [store]: [pkg] } });
    assert.equal(findHarnessInStore(store, fs), undefined);
  });

  it('ignores unrelated packages', () => {
    const fs = fakeFs({
      dirs: {
        [store]: ['@deepseek-ai+dsh-brand@1.0.0', 'zod@4.0.0', '@deepseek-ai+dsh-llm-pi-ai@1.0.0'],
      },
    });
    assert.equal(findHarnessInStore(store, fs), undefined);
  });

  it('is the prefix check, not the path check, that excludes a lookalike', () => {
    // This is the case that actually exercises the prefix guard. Every path in
    // it resolves — a package directory holding a valid harness entry point —
    // so only the store-directory name tells the real harness from a package
    // that merely contains one. Without the guard, the plugin could patch a
    // copy nested inside a different package's dependencies.
    const lookalike = '@deepseek-ai+dsh-llm-pi-ai@1.0.0';
    const fs = fakeFs({
      dirs: {
        [store]: [lookalike],
        [`${store}/${lookalike}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
      },
    });
    assert.equal(findHarnessInStore(store, fs), undefined);
  });

  it('prefers the real harness over a lookalike listed first', () => {
    const lookalike = '@deepseek-ai+dsh-llm-pi-ai@1.0.0';
    const real = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
    const fs = fakeFs({
      dirs: {
        [store]: [lookalike, real],
        [`${store}/${lookalike}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
        [`${store}/${real}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
      },
    });
    assert.equal(findHarnessInStore(store, fs), harnessPath(store, real));
  });

  it('returns the first match when several copies exist', () => {
    const first = '@deepseek-ai+dsh-llm@0.2.0-rc.2_aaa';
    const second = '@deepseek-ai+dsh-llm@0.2.0-rc.2_bbb';
    const fs = fakeFs({
      dirs: {
        [store]: [first, second],
        [`${store}/${first}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
        [`${store}/${second}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
      },
    });
    assert.equal(findHarnessInStore(store, fs), harnessPath(store, first));
  });

  it('degrades to undefined for an unreadable store rather than throwing', () => {
    const fs = fakeFs({ dirs: { [store]: [] }, unreadable: [store] });
    assert.equal(findHarnessInStore(store, fs), undefined);
  });
});

describe('searchForHarness', () => {
  const pkg = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
  const leaf = (store: string) => ({
    [`${store}/${pkg}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
  });

  it('finds a store at the root: <root>/node_modules/.pnpm', () => {
    const root = '/dlx';
    const store = `${root}/node_modules/.pnpm`;
    const fs = fakeFs({ dirs: { [root]: ['node_modules'], [store]: [pkg], ...leaf(store) } });
    assert.equal(searchForHarness(root, 3, fs), harnessPath(store, pkg));
  });

  it('finds a store one level down: <root>/<entry>/node_modules/.pnpm', () => {
    const root = '/dlx';
    const store = `${root}/abc123/node_modules/.pnpm`;
    const fs = fakeFs({
      dirs: { [root]: ['abc123'], [store]: [pkg], ...leaf(store) },
    });
    assert.equal(searchForHarness(root, 3, fs), harnessPath(store, pkg));
  });

  it('finds a store two levels down: <root>/<hash>/<version>/node_modules/.pnpm', () => {
    const root = '/dlx';
    const store = `${root}/hash/version/node_modules/.pnpm`;
    const fs = fakeFs({
      dirs: { [root]: ['hash'], [`${root}/hash`]: ['version'], [store]: [pkg], ...leaf(store) },
    });
    assert.equal(searchForHarness(root, 3, fs), harnessPath(store, pkg));
  });

  it('does not descend past the depth limit', () => {
    const root = '/dlx';
    const store = `${root}/a/b/c/d/node_modules/.pnpm`;
    const fs = fakeFs({
      dirs: {
        [root]: ['a'],
        [`${root}/a`]: ['b'],
        [`${root}/a/b`]: ['c'],
        [`${root}/a/b/c`]: ['d'],
        [store]: [pkg],
        ...leaf(store),
      },
    });
    assert.equal(searchForHarness(root, 2, fs), undefined, 'too deep for the limit');
    assert.equal(
      searchForHarness(root, 6, fs),
      harnessPath(store, pkg),
      'a deeper limit reaches it',
    );
  });

  it('skips node_modules, .pnpm and dot-entries while descending', () => {
    const root = '/dlx';
    const store = `${root}/real/node_modules/.pnpm`;
    const fs = fakeFs({
      dirs: {
        [root]: ['node_modules', '.pnpm', '.hidden', 'real'],
        [store]: [pkg],
        ...leaf(store),
      },
    });
    assert.equal(searchForHarness(root, 3, fs), harnessPath(store, pkg));
  });

  it('degrades to undefined when a directory cannot be read', () => {
    const root = '/dlx';
    const fs = fakeFs({ dirs: { [root]: ['a'] }, unreadable: [root] });
    assert.equal(searchForHarness(root, 3, fs), undefined);
  });

  it('degrades to undefined for an empty root', () => {
    const fs = fakeFs({ dirs: { '/dlx': [] } });
    assert.equal(searchForHarness('/dlx', 3, fs), undefined);
  });

  it('degrades to undefined when the root does not exist', () => {
    const fs = fakeFs({ dirs: {} });
    assert.equal(searchForHarness('/nope', 3, fs), undefined);
  });

  it('finds a store nested inside a non-store entry', () => {
    // The real dlx shape: the store lives under a hash directory that also holds
    // a `pkg` directory with no store of its own.
    const root = '/dlx';
    const store = `${root}/hash/version/node_modules/.pnpm`;
    const fs = fakeFs({
      dirs: {
        [root]: ['hash'],
        [`${root}/hash`]: ['version', 'pkg'],
        [`${root}/hash/version`]: ['node_modules'],
        [store]: [pkg],
        ...leaf(store),
      },
    });
    assert.equal(searchForHarness(root, 3, fs), harnessPath(store, pkg));
  });
});

describe('loadLlmModule · concurrent resolution', () => {
  // Two properties, and it matters which is which.
  //
  // The override cases below prove `loadLlmModule` is safe under concurrency in
  // general. They do **not** exercise the store-scan cache: an override returns
  // before the scan runs. The scan is what had the bug — a three-state
  // `null`/`undefined`/`string` cache, where a second caller arriving mid-scan
  // read `undefined` ("not found") and concluded the harness was absent.
  //
  // The last case below therefore runs the real scan path, with no override, and
  // is gated on the harness actually being installed.
  const saved = process.env.DSH_HEAL_LLM_MODULE;

  afterEach(() => {
    if (saved === undefined) delete process.env.DSH_HEAL_LLM_MODULE;
    else process.env.DSH_HEAL_LLM_MODULE = saved;
  });

  it('two concurrent loads both resolve, rather than one seeing "not found"', async () => {
    process.env.DSH_HEAL_LLM_MODULE = 'node:os';
    const [a, b] = await Promise.all([loadLlmModule(), loadLlmModule()]);
    assert.ok(a !== undefined && b !== undefined, 'both callers must get a module');
    assert.equal(a, b, 'and they must be the same module instance');
  });

  it('a burst of loads all resolve to one module', async () => {
    process.env.DSH_HEAL_LLM_MODULE = 'node:path';
    const results = await Promise.all(Array.from({ length: 8 }, () => loadLlmModule()));
    const first = results[0];
    for (const result of results) assert.equal(result, first);
  });

  it('a failing load rejects every concurrent caller', async () => {
    process.env.DSH_HEAL_LLM_MODULE = 'file:///nonexistent/nope.mjs';
    const results = await Promise.allSettled([loadLlmModule(), loadLlmModule()]);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 2);
  });

  it('the real scan path is shared: concurrent scans agree', async () => {
    // No override and no NODE_PATH, so the bare specifier fails in this repo and
    // the store scan runs — the path the promise cache exists for.
    delete process.env.DSH_HEAL_LLM_MODULE;
    const savedNodePath = process.env.NODE_PATH;
    delete process.env.NODE_PATH;
    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => loadLlmModule()));
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      if (fulfilled.length === 0) {
        // No harness installed: every caller must agree on that, not half of them.
        assert.equal(rejected.length, 6, 'all callers must agree the harness is absent');
        return;
      }
      assert.equal(rejected.length, 0, 'no caller may see "not found" while another finds it');
      const first = (fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
      for (const result of fulfilled) {
        assert.equal((result as PromiseFulfilledResult<unknown>).value, first);
      }
    } finally {
      if (savedNodePath !== undefined) process.env.NODE_PATH = savedNodePath;
      else delete process.env.NODE_PATH;
    }
  });
});

describe('storePrefixFor', () => {
  it('encodes a scope slash as a plus, and a bare name as itself', () => {
    assert.equal(storePrefixFor('@deepseek-ai/dsh-llm'), '@deepseek-ai+dsh-llm@');
    assert.equal(storePrefixFor('@types/node'), '@types+node@');
    assert.equal(storePrefixFor('js-yaml'), 'js-yaml@');
  });
});

describe('dlxRoots', () => {
  it('names the three standard roots, in order', () => {
    const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
    assert.deepEqual(dlxRoots('/home/u', join), [
      '/home/u/Library/Caches/pnpm/dlx',
      '/home/u/.cache/pnpm/dlx',
      '/home/u/.local/share/pnpm/dlx',
    ]);
  });
});

describe('resolveHarnessEntry', () => {
  const HOME = '/home/u';
  const ROOT = `${HOME}/Library/Caches/pnpm/dlx`;

  /**
   * A store laid out the way pnpm actually writes one.
   *
   * `storeDirName` is the encoded directory (scope slash becomes `+`), while the
   * path *inside* it uses the real package name — `@deepseek-ai/dsh-llm`. Those are
   * two different strings and conflating them is exactly the mistake the resolver
   * has to avoid, so the helper keeps them separate too.
   */
  function layout(storeDirName: string, packageName: string, inner: string): StoreFs {
    const dirs: Record<string, string[]> = {
      [HOME]: ['Library'],
      [`${HOME}/Library`]: ['Caches'],
      [`${HOME}/Library/Caches`]: ['pnpm'],
      [`${HOME}/Library/Caches/pnpm`]: ['dlx'],
      [ROOT]: ['abc123hash'],
      [`${ROOT}/abc123hash`]: ['0.2.0-rc.2'],
      [`${ROOT}/abc123hash/0.2.0-rc.2`]: ['node_modules'],
      [`${ROOT}/abc123hash/0.2.0-rc.2/node_modules`]: ['.pnpm'],
      [`${ROOT}/abc123hash/0.2.0-rc.2/node_modules/.pnpm`]: [storeDirName],
    };
    let cursor = `${ROOT}/abc123hash/0.2.0-rc.2/node_modules/.pnpm/${storeDirName}/node_modules`;
    dirs[`${ROOT}/abc123hash/0.2.0-rc.2/node_modules/.pnpm/${storeDirName}`] = ['node_modules'];
    const segments = [...packageName.split('/'), ...inner.split('/')];
    for (let index = 0; index < segments.length; index += 1) {
      const next = `${cursor}/${segments[index]}`;
      dirs[cursor] = [...(dirs[cursor] ?? []), segments[index]!];
      if (index < segments.length - 1) dirs[next] = [];
      cursor = next;
    }
    return fakeFs({ dirs });
  }

  const entryOf = (storeDirName: string, packageName: string, inner: string) =>
    `${ROOT}/abc123hash/0.2.0-rc.2/node_modules/.pnpm/${storeDirName}/node_modules/${packageName}/${inner}`;

  it('finds the entry point at the real, deeply nested layout', () => {
    const dirName = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
    const fs = layout(dirName, '@deepseek-ai/dsh-llm', 'lib/index.js');
    assert.equal(
      resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', fs, HOME),
      entryOf(dirName, '@deepseek-ai/dsh-llm', 'lib/index.js'),
    );
  });

  it('finds an unscoped package', () => {
    const fs = layout('js-yaml@4.1.0', 'js-yaml', 'dist/js-yaml.mjs');
    assert.equal(
      resolveHarnessEntry('js-yaml', 'dist/js-yaml.mjs', fs, HOME),
      entryOf('js-yaml@4.1.0', 'js-yaml', 'dist/js-yaml.mjs'),
    );
  });

  it('finds a scoped package that is not the harness', () => {
    const fs = layout('@types+node@24.0.0', '@types/node', 'package.json');
    assert.equal(
      resolveHarnessEntry('@types/node', 'package.json', fs, HOME),
      entryOf('@types+node@24.0.0', '@types/node', 'package.json'),
    );
  });

  it('returns undefined when no root exists', () => {
    assert.equal(
      resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', fakeFs({ dirs: {} }), HOME),
      undefined,
    );
  });

  it('returns undefined when the package is absent from a present store', () => {
    const fs = layout(
      '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer',
      '@deepseek-ai/dsh-llm',
      'lib/index.js',
    );
    assert.equal(
      resolveHarnessEntry('@deepseek-ai/dsh-session', 'lib/index.js', fs, HOME),
      undefined,
    );
  });

  it('does not confuse one scoped package for another with a shared prefix', () => {
    // `@types/node` and `@types/node-fetch` share a prefix. The store prefix ends
    // in `@`, so the wrong one cannot match — this pins that.
    const fs = layout('@types+node-fetch@3.0.0', '@types/node-fetch', 'package.json');
    assert.equal(resolveHarnessEntry('@types/node', 'package.json', fs, HOME), undefined);
  });

  it('finds a package in a store that sits directly under the root', () => {
    // `<root>/node_modules/.pnpm` — the other layout pnpm produces, and the reason
    // the resolver checks the direct path before descending.
    const dirName = '@deepseek-ai+dsh-llm@0.2.0-rc.2_peer';
    const store = `${ROOT}/node_modules/.pnpm`;
    const dirs: Record<string, string[]> = {
      [HOME]: ['Library'],
      [`${HOME}/Library`]: ['Caches'],
      [`${HOME}/Library/Caches`]: ['pnpm'],
      [`${HOME}/Library/Caches/pnpm`]: ['dlx'],
      [ROOT]: ['node_modules'],
      [`${ROOT}/node_modules`]: ['.pnpm'],
      [store]: [dirName],
      [`${store}/${dirName}`]: ['node_modules'],
      [`${store}/${dirName}/node_modules`]: ['@deepseek-ai'],
      [`${store}/${dirName}/node_modules/@deepseek-ai`]: ['dsh-llm'],
      [`${store}/${dirName}/node_modules/@deepseek-ai/dsh-llm`]: ['lib'],
      [`${store}/${dirName}/node_modules/@deepseek-ai/dsh-llm/lib`]: ['index.js'],
    };
    assert.equal(
      resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', fakeFs({ dirs }), HOME),
      `${store}/${dirName}/node_modules/@deepseek-ai/dsh-llm/lib/index.js`,
    );
  });

  it('tolerates an unreadable directory rather than throwing', () => {
    const fs = fakeFs({
      dirs: { [HOME]: ['Library'], [`${HOME}/Library`]: ['Caches'] },
      unreadable: [`${HOME}/Library`],
    });
    assert.equal(resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', fs, HOME), undefined);
  });
});

describe('loadLlmModule failure reporting', () => {
  const saved = process.env.DSH_HEAL_LLM_MODULE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DSH_HEAL_LLM_MODULE;
    else process.env.DSH_HEAL_LLM_MODULE = saved;
  });

  it('names the override when it cannot be imported', async () => {
    // A mistyped override must not silently fall back to a default copy: that
    // would hide the very packaging problem the override exists to investigate.
    process.env.DSH_HEAL_LLM_MODULE = '/nonexistent/definitely-not-a-module.js';
    await assert.rejects(
      () => loadLlmModule(),
      /cannot import the module named by DSH_HEAL_LLM_MODULE/,
    );
  });
});
