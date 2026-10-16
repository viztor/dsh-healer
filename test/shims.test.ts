/**
 * The hand-written `node:` type shims must match the real declarations.
 *
 * `types/node-shims.d.ts` exists because this package has no `node_modules` and
 * therefore no `@types/node`. That is a deliberate trade — the suite typechecks
 * without a dependency — but it creates a specific hazard: a shim that declares
 * a member the real module does not have, or with the wrong name, would let a
 * test typecheck while the runtime call fails. A shim is a claim about someone
 * else's API, and claims should be checked.
 *
 * This parses the shim file, extracts every member it declares, and confirms each
 * one appears in the installed `@types/node`. It skips when those types are not
 * present, so the suite stays runnable without them.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vite-plus/test';
import { resolveInstalledEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIMS = readFileSync(join(ROOT, 'types', 'node-shims.d.ts'), 'utf8');

/** Locate the installed `@types/node` package directory. */
/** The installed @types/node directory, via the shared resolver. */
function findTypesNode(): string | undefined {
  const entry = resolveInstalledEntry('@types/node', 'package.json', storeFs, homedir());
  return entry === undefined ? undefined : dirname(entry);
}
const storeFs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

const typesNode = findTypesNode();

/** Every `declare module 'x' { ... }` block in the shim file, with its body. */
function declaredModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const pattern = /declare module '([^']+)' \{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(SHIMS)) !== null) {
    modules.set(match[1]!, match[2]!);
  }
  return modules;
}

/** Exported member names inside a module body. */
function declaredMembers(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/export function (\w+)/g)) names.add(match[1]!);
  for (const match of body.matchAll(/export const (\w+)/g)) names.add(match[1]!);
  for (const match of body.matchAll(/^\s{4}(\w+)\(/gm)) names.add(match[1]!);
  return [...names];
}

const modules = declaredModules();

describe('node-shims match the real @types/node', { skip: typesNode === undefined }, () => {
  it('parses at least the modules the tests rely on', () => {
    for (const name of [
      'node:assert/strict',
      'node:fs',
      'node:os',
      'node:path',
      'node:url',
      'node:crypto',
      'node:module',
    ]) {
      assert.ok(modules.has(name), `the shim file must declare ${name}`);
    }
  });

  it('every shimmed module corresponds to a real declaration file', () => {
    for (const name of modules.keys()) {
      const bare = name.replace(/^node:/, '').split('/')[0]!;
      const file = join(typesNode!, `${bare}.d.ts`);
      assert.ok(existsSync(file), `${name} is shimmed but @types/node has no ${bare}.d.ts`);
    }
  });

  it('every shimmed member exists in the real types', () => {
    for (const [name, body] of modules) {
      const bare = name.replace(/^node:/, '').split('/')[0]!;
      // `node:assert/strict` re-exports from `assert`, so check that file.
      const file = join(typesNode!, `${bare}.d.ts`);
      if (!existsSync(file)) continue;
      const real = readFileSync(file, 'utf8');
      for (const member of declaredMembers(body)) {
        assert.ok(
          new RegExp(`\\b${member}\\b`).test(real),
          `${name} shims "${member}", which @types/node does not declare`,
        );
      }
    }
  });

  it('shims no more than the code actually uses', () => {
    // A shim that grows beyond the surface in use is a place for drift to hide.
    // This is a coarse guard: it fails if the file grows a lot, so a widening is
    // a deliberate act with a reason rather than an accident. Every member is
    // still verified real by the `@types/node` check above.
    //
    // Widened 40 -> 43, each reviewed:
    //   - `path.delimiter` — `config.ts` splits `NODE_PATH` with it. The
    //     separator is `;` on Windows, and splitting on `:` there would also cut
    //     through a drive letter.
    //   - `fs.mkdirSync`, `fs.symlinkSync` — the upstream verifier builds its
    //     sandbox with them.
    const total = [...modules.values()].reduce(
      (sum, body) => sum + declaredMembers(body).length,
      0,
    );
    assert.ok(total > 0, 'the shims must declare something');
    assert.ok(
      total <= 43,
      `the shim surface has grown to ${total} members; review before widening`,
    );
  });
});
