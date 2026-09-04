import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";

/** Glob-style patterns for paths that should never trigger a watch reload. */
const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  ".env",
];

/** File extensions that should never trigger a watch reload. */
const IGNORE_EXTENSIONS = new Set([".pyc", ".pyo", ".swp", ".swo", ".swn", ".DS_Store"]);

/**
 * Decide what `--watch` should watch for a given target command.
 *
 * Normally the working directory, minus build outputs. But when the server
 * runs *from* a build output (`node dist/index.js` with a separate compile
 * step), a source save would reconnect before the rebuild lands and spawn the
 * stale code. In that case the build directory itself is the thing to watch:
 * the reconnect then follows the compiler, not the editor.
 */
export function resolveWatchRoot(
  cwd: string,
  targetArgs: string[],
): { path: string; reason: "cwd" | "build-output" } {
  for (const arg of targetArgs) {
    const candidate = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }

    const rel = relative(cwd, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const segments = rel.split(sep);
    const buildDirIndex = segments.findIndex(
      (segment, i) => i < segments.length - 1 && DEFAULT_IGNORE_PATTERNS.includes(segment),
    );
    if (buildDirIndex === -1) continue;
    return {
      path: join(cwd, ...segments.slice(0, buildDirIndex + 1)),
      reason: "build-output",
    };
  }
  return { path: cwd, reason: "cwd" };
}

export interface FileWatcherOptions {
  /** Debounce window in ms. Defaults to 500. */
  debounceMs?: number;
  /** Additional directory/file names to ignore. */
  ignore?: string[];
}

/**
 * Watches a directory tree for file changes, emitting debounced 'change' events.
 *
 * Uses Node's built-in `fs.watch()` with `recursive: true` (supported on
 * macOS and Windows with Node 18+; Linux requires Node 19+).
 *
 * @example
 * ```ts
 * const watcher = new FileWatcher("/path/to/project");
 * watcher.on("change", ({ files }) => {
 *   console.log("Changed:", files);
 * });
 * watcher.start();
 * ```
 */
export class FileWatcher extends EventEmitter {
  private _watchPath: string;
  private _debounceMs: number;
  private _ignorePatterns: string[];
  private _watcher: FSWatcher | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingFiles: Set<string> = new Set();

  constructor(watchPath: string, options?: FileWatcherOptions) {
    super();
    this._watchPath = watchPath;
    this._debounceMs = options?.debounceMs ?? 500;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(options?.ignore ?? [])];
  }

  /** Start watching for file changes. */
  start(): void {
    if (this._watcher) return;

    try {
      this._watcher = watch(this._watchPath, { recursive: true }, (_event, filename) => {
        if (!filename || this._shouldIgnore(filename)) return;

        this._pendingFiles.add(filename);

        // Reset debounce timer
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const files = [...this._pendingFiles];
          this._pendingFiles.clear();
          this.emit("change", { files });
        }, this._debounceMs);
      });

      this._watcher.on("error", (err) => {
        this.emit("error", err);
      });
    } catch (err: any) {
      // fs.watch with recursive may not be supported on all platforms
      this.emit(
        "error",
        new Error(`File watching is not supported on this platform: ${err.message}`),
      );
    }
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    this._pendingFiles.clear();
  }

  /**
   * Check if a filename matches any ignore pattern.
   * Matches against each segment of the path.
   */
  private _shouldIgnore(filename: string): boolean {
    // Check extension
    for (const ext of IGNORE_EXTENSIONS) {
      if (filename.endsWith(ext)) return true;
    }

    // Check path segments against ignore patterns
    const segments = filename.split(/[/\\]/);
    for (const segment of segments) {
      if (this._ignorePatterns.includes(segment)) return true;
    }

    return false;
  }

  /** Get the relative path from the watch root. */
  relativePath(absolutePath: string): string {
    return relative(this._watchPath, absolutePath);
  }
}
