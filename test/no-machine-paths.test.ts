/**
 * The repository must not carry a machine path.
 *
 * An absolute path leaks a username, an operating system and a directory layout,
 * and it is worthless to a reader who is not on that machine. Once committed it
 * is in the history permanently, so the check belongs before the commit rather
 * than in review.
 *
 * Two forms are checked, and the second is the one that is easy to miss:
 *
 *   1. A literal path: `/Users/<name>/…`, `/home/<name>/…`, `C:\Users\…`.
 *   2. The **DSH session directory encoding**, which replaces a path's separators
 *      with dashes: `/Users/viz/dev/zesto` becomes `--Users-viz-dev-zesto--`.
 *      A grep for `/Users/` does not find it, and it leaks exactly as much.
 *
 * A first version of the audit script and two documents carried form 2 without
 * anyone noticing, which is why this is a test and not a habit.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vite-plus/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Directories that are not part of the repository's content, plus this file.
 *
 * This guard necessarily contains the patterns it hunts for — as samples it
 * proves it can catch — so it must exclude itself or it would always fail.
 */
const SKIP = new Set(['.git', 'node_modules', 'coverage']);
const SELF = 'no-machine-paths.test.ts';

/** Text files worth scanning; binary and lock files are skipped. */
const TEXT = /\.(ts|mts|mjs|js|json|md|yml|yaml)$/;

/** Every tracked-looking file under the root. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      found.push(...walk(path));
    } else if (TEXT.test(entry) && entry !== SELF) {
      found.push(path);
    }
  }
  return found;
}

const files = walk(ROOT);

/**
 * Home-directory names that are placeholders, not people.
 *
 * The global instructions tell contributors to write neutral placeholders like
 * `/home/you/projects/my-app`. A guard that flags its own house style is a guard
 * that gets disabled, so those names are allowed through explicitly.
 *
 * `someone` is deliberately **not** here: it is the realistic-looking sample the
 * self-proof below uses, and a name that is both allowed and used as a positive
 * sample would make that proof vacuous.
 */
const PLACEHOLDER_HOMES = new Set([
  'you',
  'yourname',
  'user',
  'username',
  'u',
  'me',
  'name',
  'example',
]);

/**
 * Patterns that identify a machine path, each capturing the home name so it can
 * be checked against {@link PLACEHOLDER_HOMES}.
 *
 * The documentation *describes* these patterns, so a line that is only naming
 * one is allowed — matched lines are checked against `MENTION` below.
 */
const PATTERNS: [string, RegExp][] = [
  ['a POSIX home path', /\/Users\/([a-z][\w.-]*)\//i],
  ['a Linux home path', /\/home\/([a-z][\w.-]*)\//i],
  ['a Windows home path', /C:\\Users\\([a-z][\w.-]*)\\/i],
  ['a DSH session directory encoding', /--(?:Users|home)-([\w.-]+?)--/],
];

/** The home name a match captured, or `undefined` for a pattern without one. */
function homeNameOf(match: RegExpMatchArray): string | undefined {
  const captured = match[1];
  if (captured === undefined) return undefined;
  // The encoding form captures the whole encoded path; only its first segment is
  // the home directory name.
  return captured.split('-')[0]?.toLowerCase();
}

/** Whether a match is a placeholder rather than a real home directory. */
function isPlaceholder(match: RegExpMatchArray): boolean {
  const name = homeNameOf(match);
  return name !== undefined && PLACEHOLDER_HOMES.has(name);
}

/** A line that is talking about the pattern rather than containing a path. */
const MENTION =
  /finds no|no local absolute|must not leak|doesNotMatch|MUST NOT|never appear|does not find it|becomes|replaces a path's/i;

describe('no machine paths in the repository', () => {
  it('scans a meaningful number of files', () => {
    assert.ok(files.length > 40, `only ${files.length} files scanned; the walk is wrong`);
  });

  for (const [label, pattern] of PATTERNS) {
    it(`contains no ${label}`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const [index, line] of text.split('\n').entries()) {
          const match = line.match(pattern);
          if (match === null) continue;
          if (isPlaceholder(match)) continue;
          if (MENTION.test(line)) continue;
          offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
      assert.deepEqual(offenders, [], `machine path(s) found:\n${offenders.join('\n')}`);
    });
  }

  it('the patterns actually match the forms they claim to catch', () => {
    // A guard that cannot fail is not a guard. Each pattern is proved against a
    // sample of the form it exists to catch.
    const samples: [string, string][] = [
      ['a POSIX home path', 'see /Users/someone/dev/project/README.md for details'],
      ['a Linux home path', 'stored at /home/someone/projects/app'],
      ['a Windows home path', 'C:\\Users\\someone\\dev\\app'],
      ['a DSH session directory encoding', '~/.dsh/sessions/--Users-someone-dev-app--/session-x'],
    ];
    for (const [label, sample] of samples) {
      const entry = PATTERNS.find(([name]) => name === label);
      assert.ok(entry, `${label} must be a declared pattern`);
      assert.ok(entry[1].test(sample), `${label} must match its own sample: ${sample}`);
    }
  });

  it('still flags a real-looking home directory', () => {
    // The placeholder allowance must not have swallowed the pattern itself.
    for (const line of [
      '/Users/someone/dev/app',
      '/home/someone/projects/app',
      'C:\\Users\\someone\\dev\\app',
      '--Users-someone-dev-app--',
    ]) {
      const matched = PATTERNS.some(([, pattern]) => {
        const match = line.match(pattern);
        return match !== null && !isPlaceholder(match);
      });
      assert.ok(matched, `must flag: ${line}`);
    }
  });

  it('allows the placeholder style the global instructions recommend', () => {
    // `/home/you/projects/my-app` is the documented neutral form. A guard that
    // rejects its own house style is a guard someone turns off.
    for (const line of [
      '/home/you/projects/my-app',
      '/Users/you/dev/app',
      '--home-you-projects-my-app--',
      '--Users-you-dev-app--',
      '/home/user/projects/app',
      '/Users/example/dev/app',
    ]) {
      const flagged = PATTERNS.some(([, pattern]) => {
        const match = line.match(pattern);
        return match !== null && !isPlaceholder(match);
      });
      assert.equal(flagged, false, `must not flag a placeholder: ${line}`);
    }
  });
});
