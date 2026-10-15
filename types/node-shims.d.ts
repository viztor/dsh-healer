/**
 * Minimal declarations for the Node built-ins the tests use.
 *
 * The plugin's own `src/` needs no Node types at all — it imports nothing from
 * Node — so this file exists only so the test suite can be typechecked without
 * requiring `@types/node` to be installed in a repo that deliberately has no
 * `node_modules`. Only the surface actually used is declared.
 */

declare module 'node:test' {
  export function describe(name: string, fn: () => void): void;
  export function describe(
    name: string,
    options: { skip?: boolean | string; concurrency?: number },
    fn: () => void,
  ): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function it(
    name: string,
    options: { skip?: boolean | string; concurrency?: number },
    fn: () => void | Promise<void>,
  ): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: unknown): { digest(encoding: string): string };
  };
}

declare module 'node:fs' {
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
  };
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function cpSync(
    source: string,
    destination: string,
    options?: { recursive?: boolean },
  ): void;
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  /** The `PATH`/`NODE_PATH` list separator: `:` on POSIX, `;` on Windows. */
  export const delimiter: string;
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:module' {
  export function createRequire(filename: string | URL): {
    (specifier: string): unknown;
    resolve(specifier: string): string;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  execPath: string;
  /** Terminates the process; typed `never` so guards narrow afterwards. */
  exit(code?: number): never;
  hrtime: {
    (time?: [number, number]): [number, number];
    bigint(): bigint;
  };
  memoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

/** Global `fetch`, used by the opt-in live acceptance script. */
declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; text(): Promise<string> }>;

declare const global: {
  gc?: () => void;
};

interface ImportMeta {
  url: string;
  /** Directory of the current module; used by the build script. */
  dirname: string;
}

/**
 * The global `URL`, declared explicitly.
 *
 * esbuild's bundled types contain `declare global { interface URL {} }` — an
 * empty declaration kept for backwards compatibility. Installing esbuild as a
 * dependency therefore *replaces* whatever `URL` resolved to before, and every
 * `.href` access stops typechecking. Declaring the surface used here makes the
 * resolution ours instead of a side effect of which packages are installed; the
 * declarations merge, so it is compatible with esbuild's empty one.
 */
interface URL {
  readonly href: string;
}

declare function structuredClone<T>(value: T): T;

declare module 'node:child_process' {
  /** Options shared by the synchronous spawn helpers. */
  interface SyncOptions {
    encoding?: string;
    maxBuffer?: number;
    env?: Record<string, string | undefined>;
    cwd?: string;
    /** `'inherit'` or `'pipe'`; the scripts use both and ignore the result. */
    stdio?: unknown;
    timeout?: number;
  }
  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: SyncOptions,
  ): string;
  export function execSync(command: string, options?: SyncOptions): string;
}
