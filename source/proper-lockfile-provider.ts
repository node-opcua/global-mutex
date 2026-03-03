import type { LockProvider, MutexOption, RetryOptions } from "./interfaces";

export class ProperLockfileProvider implements LockProvider {
    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    public async acquire(options: MutexOption): Promise<() => Promise<void>> {
        const { lock: properLock } = await import("proper-lockfile");
        // We use the fileToLock as the locking target for proper-lockfile
        const { fileToLock, stale, retries, onCompromised } = options;

        // Convert retries options to proper-lockfile compatible options
        let properRetries: Record<string, unknown> | undefined;
        if (retries === undefined) {
            properRetries = {
                retries: 10000, // effectively forever (approx 5.5 hours at 2s max timeout)
                factor: 2,
                minTimeout: 100,
                maxTimeout: 2000,
                randomize: true
            };
        } else if (typeof retries === "number") {
            properRetries = { retries, factor: 1, minTimeout: 1000 };
        } else if (retries && !retries.forever) {
            properRetries = {
                retries: (retries as RetryOptions).retries ?? 10,
                factor: 2,
                minTimeout: (retries as RetryOptions).minTimeout,
                maxTimeout: retries.maxTimeout,
                randomize: retries.randomize
            };
        } else if (retries?.forever) {
            properRetries = {
                retries: 10000, // effectively forever (approx 5.5 hours at 2s max timeout)
                factor: 2,
                minTimeout: retries.minTimeout ?? 100,
                maxTimeout: retries.maxTimeout ?? 2000,
                randomize: retries.randomize ?? true
            };
        }

        const properOptions = {
            stale: stale ?? 2 * 60 * 1000, // default 2 mins
            retries: properRetries,
            onCompromised: onCompromised || (() => {})
        };

        const release = await properLock(fileToLock, properOptions);

        return async () => {
            await release();
        };
    }

    public async isLocked(fileToLock: string): Promise<boolean> {
        const { check: properCheck } = await import("proper-lockfile");
        return properCheck(fileToLock, { stale: 2 * 60 * 1000 });
    }

    public async drainPendingLocks(): Promise<void> {
        // No-op for this provider itself, any global tracking happens in index.ts
    }
}
