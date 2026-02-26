import fs from "node:fs";
import path from "node:path";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
    /** Maximum number of retries (default: 10 when object, 0 when number). */
    retries?: number;
    /** Retry forever, ignoring `retries` count. */
    forever?: boolean;
    /** Minimum retry delay in ms (default: 1000). */
    minTimeout?: number;
    /** Maximum retry delay in ms (default: Infinity). */
    maxTimeout?: number;
    /** Randomize (jitter) the delay (default: false). */
    randomize?: boolean;
    /** Abort retries after this many ms total (default: Infinity). */
    maxRetryTime?: number;
}

export interface MutexOption {
    /** Path to the file to lock. Created automatically if absent. */
    fileToLock: string;
    /** Duration in ms after which a lock is considered stale. */
    stale?: number;
    /** Interval in ms between lock-refresh touches (default: stale / 2). */
    update?: number;
    /** Retry configuration: a count, a full options object, or undefined for "forever". */
    retries?: number | RetryOptions;
    /** Called if the lock is compromised (removed externally) while held. */
    onCompromised?: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveLock {
    timer: NodeJS.Timeout;
    released: boolean;
}

const activeLocks = new Map<string, ActiveLock>();

// ---------------------------------------------------------------------------
// Process-exit cleanup
// ---------------------------------------------------------------------------

let exitHandlerRegistered = false;

/**
 * Synchronously remove all lock directories held by THIS process.
 * Called on process exit so that locks don't leak to disk.
 */
function cleanupLocksOnExit(): void {
    for (const [lp, entry] of activeLocks) {
        if (!entry.released) {
            entry.released = true;
            clearInterval(entry.timer);
            try {
                fs.rmSync(lp, { recursive: true, force: true });
            } catch {
                /* best-effort cleanup */
            }
        }
    }
    activeLocks.clear();
}

function ensureExitHandler(): void {
    if (exitHandlerRegistered) return;
    exitHandlerRegistered = true;
    process.on("exit", cleanupLocksOnExit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockPath(fileToLock: string): string {
    return `${fileToLock}.lock`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NormalizedRetry {
    maxAttempts: number;
    minTimeout: number;
    maxTimeout: number;
    randomize: boolean;
    maxRetryTime: number;
}

function normalizeRetry(retries: number | RetryOptions | undefined): NormalizedRetry {
    if (retries === undefined) {
        // Default: retry forever with jitter
        return {
            maxAttempts: Number.POSITIVE_INFINITY,
            minTimeout: 100,
            maxTimeout: 2000,
            randomize: true,
            maxRetryTime: Number.POSITIVE_INFINITY
        };
    }
    if (typeof retries === "number") {
        return {
            maxAttempts: retries,
            minTimeout: 1000,
            maxTimeout: Number.POSITIVE_INFINITY,
            randomize: false,
            maxRetryTime: Number.POSITIVE_INFINITY
        };
    }
    const maxAttempts = retries.forever ? Number.POSITIVE_INFINITY : (retries.retries ?? 10);
    return {
        maxAttempts,
        minTimeout: retries.minTimeout ?? 1000,
        maxTimeout: retries.maxTimeout ?? Number.POSITIVE_INFINITY,
        randomize: retries.randomize ?? false,
        maxRetryTime: retries.maxRetryTime ?? Number.POSITIVE_INFINITY
    };
}

function retryDelay(r: NormalizedRetry, attempt: number): number {
    let d = Math.min(r.minTimeout * 2 ** attempt, r.maxTimeout);
    if (r.randomize) {
        d = Math.floor((d * (1 + Math.random())) / 2);
    }
    return d;
}

async function isStale(lp: string, staleDuration: number): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(lp);
        return Date.now() - stat.mtimeMs > staleDuration;
    } catch {
        return true; // directory gone → treat as stale
    }
}

// ---------------------------------------------------------------------------
// Lock / unlock primitives
// ---------------------------------------------------------------------------

async function acquireLock(
    lp: string,
    stale: number,
    retry: NormalizedRetry,
    update: number,
    onCompromised?: (err: Error) => void
): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    for (;;) {
        try {
            await fs.promises.mkdir(lp);

            // — Lock acquired — register exit cleanup + start refresh timer
            ensureExitHandler();
            const timer = setInterval(async () => {
                const entry = activeLocks.get(lp);
                if (!entry || entry.released) return;
                try {
                    const now = new Date();
                    await fs.promises.utimes(lp, now, now);
                } catch (err) {
                    if (onCompromised) {
                        onCompromised(err as Error);
                    }
                }
            }, update);
            timer.unref();
            activeLocks.set(lp, { timer, released: false });
            return;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

            // Lock directory exists — check staleness
            if (await isStale(lp, stale)) {
                try {
                    await fs.promises.rm(lp, { recursive: true, force: true });
                } catch {
                    /* another process may have removed it */
                }
                continue; // retry immediately after removing a stale lock
            }

            // Not stale — obey retry limits
            if (attempt >= retry.maxAttempts) {
                throw new Error("Lock file is already being held");
            }
            if (Date.now() - startTime >= retry.maxRetryTime) {
                throw new Error("Lock file is already being held");
            }

            await sleep(retryDelay(retry, attempt));
            attempt++;
        }
    }
}

async function releaseLock(lp: string): Promise<void> {
    const entry = activeLocks.get(lp);
    if (entry) {
        entry.released = true;
        clearInterval(entry.timer);
        activeLocks.delete(lp);
    }
    await fs.promises.rm(lp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a file-based mutex, execute `action`, then release.
 *
 * The lock is implemented as a directory (`<fileToLock>.lock`)
 * created atomically via `mkdir`.  A background timer refreshes
 * the directory mtime to prevent stale-lock detection while the
 * action is running.
 */
export async function withLock<T>(options: MutexOption, action: () => Promise<T>): Promise<T> {
    const { fileToLock, stale = defaultStaleDuration, update, retries, onCompromised } = options;

    const retry = normalizeRetry(retries);
    const updateInterval = update ?? Math.floor(stale / 2);

    // Validate parent directory
    try {
        await fs.promises.access(path.dirname(fileToLock));
    } catch {
        throw new Error(`Invalid lockfile: ${fileToLock}`);
    }

    // Ensure the lock-target file exists
    try {
        await fs.promises.writeFile(fileToLock, "", { flag: "wx" });
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    const lp = lockPath(fileToLock);

    await acquireLock(lp, stale, retry, updateInterval, onCompromised);
    try {
        return await action();
    } finally {
        try {
            await releaseLock(lp);
        } catch (err) {
            /* v8 ignore next */
            console.warn("Error in Unlock !!!", (err as Error).message);
        }
    }
}

/**
 * Check whether a file is currently locked.
 */
export async function isLocked(fileToLock: string): Promise<boolean> {
    try {
        await fs.promises.access(lockPath(fileToLock));
        return true;
    } catch {
        return false;
    }
}
