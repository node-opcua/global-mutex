import fs from "node:fs";
import type { LockProvider, MutexOption, RetryOptions } from "./interfaces";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

interface ActiveLock {
    timer: NodeJS.Timeout;
    released: boolean;
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

function lockPath(fileToLock: string): string {
    return `${fileToLock}.lock`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStale(lp: string, staleDuration: number): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(lp);
        return Date.now() - stat.mtimeMs > staleDuration;
    } catch {
        return true; // directory gone → treat as stale
    }
}

export class NativeLockProvider implements LockProvider {
    private activeLocks = new Map<string, ActiveLock>();
    private exitHandlerRegistered = false;

    private cleanupLocksOnExit = () => {
        for (const [lp, entry] of this.activeLocks) {
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
        this.activeLocks.clear();
    };

    private ensureExitHandler(): void {
        if (this.exitHandlerRegistered) return;
        this.exitHandlerRegistered = true;
        process.on("exit", this.cleanupLocksOnExit);
    }

    private async acquireLock(
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
                this.ensureExitHandler();
                const timer = setInterval(async () => {
                    const entry = this.activeLocks.get(lp);
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
                this.activeLocks.set(lp, { timer, released: false });
                return;
            } catch (err: unknown) {
                const code = (err as NodeJS.ErrnoException).code;

                if (code === "EEXIST") {
                    // Normal contention — lock dir already exists
                } else if (code === "EPERM") {
                    // On Windows, mkdir can throw EPERM when the lock
                    // path already exists as a regular file (e.g.
                    // leftover from a different locking library).
                    // Disambiguate from genuine permission issues by
                    // checking whether something actually exists at lp.
                    try {
                        await fs.promises.stat(lp);
                        // Something exists → treat like EEXIST below
                    } catch {
                        // Nothing at lp → real permission problem
                        throw err;
                    }
                } else {
                    throw err;
                }

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

    private async releaseLock(lp: string): Promise<void> {
        const entry = this.activeLocks.get(lp);
        if (entry) {
            entry.released = true;
            clearInterval(entry.timer);
            this.activeLocks.delete(lp);
        }
        await fs.promises.rm(lp, { recursive: true, force: true });
    }

    public async acquire(options: MutexOption): Promise<() => Promise<void>> {
        const { fileToLock, stale = defaultStaleDuration, update, retries, onCompromised } = options;

        const retry = normalizeRetry(retries);
        const updateInterval = update ?? Math.floor(stale / 2);
        const lp = lockPath(fileToLock);

        await this.acquireLock(lp, stale, retry, updateInterval, onCompromised);

        return async () => {
            await this.releaseLock(lp);
        };
    }

    public async isLocked(fileToLock: string): Promise<boolean> {
        try {
            await fs.promises.access(lockPath(fileToLock));
            return true;
        } catch {
            return false;
        }
    }

    public async drainPendingLocks(): Promise<void> {
        // Since we moved pendingLocks tracking to the provider level,
        // we need to keep track of the promises. But the actual tracking
        // happens inside index.ts withLock method which wraps these.
        // So for the legacy provider itself, drainPendingLocks only needs
        // to handle what it specifically manages if anything.
        // Currently, index.ts managed `pendingLocks`.
        // We will move that logic into `index.ts` top level so `drainPendingLocks`
        // is actually universal, or we track it here.
        // It's cleaner to track pending operations per-provider or globally in index.js.
        // Let's implement an empty drain here and handle `pendingLocks` globally in `index.ts`.
    }
}
