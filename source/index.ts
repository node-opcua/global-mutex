import fs from "node:fs";
import path from "node:path";
import type { LockProvider, MutexOption } from "./interfaces";
import { NativeLockProvider } from "./native-provider";
import { ProperLockfileProvider } from "./proper-lockfile-provider";

export * from "./interfaces";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

// ---------------------------------------------------------------------------
// Lock provider management
// ---------------------------------------------------------------------------

let overriddenProviderType: "native" | "proper-lockfile" | undefined;
let _resolvedProvider: LockProvider | undefined;

export function setLockProvider(type: "native" | "proper-lockfile") {
    overriddenProviderType = type;
    _resolvedProvider = undefined; // force re-evaluation
}

async function getProvider(): Promise<LockProvider> {
    if (_resolvedProvider) return _resolvedProvider;

    let targetType = overriddenProviderType;

    // Check environment variable
    if (!targetType) {
        const envType = process.env.GLOBAL_MUTEX_PROVIDER;
        if (envType === "native" || envType === "proper-lockfile") {
            targetType = envType;
            console.log(`[global-mutex] Forcing lock provider to '${envType}' as specified by GLOBAL_MUTEX_PROVIDER env variable.`);
        }
    }

    // Default target
    if (!targetType) {
        targetType = "proper-lockfile";
    }

    if (targetType === "proper-lockfile") {
        try {
            // Test that proper-lockfile is loadable before instantiating its class
            await import("proper-lockfile");
            _resolvedProvider = new ProperLockfileProvider();
            return _resolvedProvider;
        } catch (_e) {
            // Not available
            if (overriddenProviderType === "proper-lockfile" || process.env.GLOBAL_MUTEX_PROVIDER === "proper-lockfile") {
                console.warn(
                    "[global-mutex] proper-lockfile was explicitly requested but is not installed. Falling back to native provider."
                );
            }
            // Fallback to native
            _resolvedProvider = new NativeLockProvider();
            return _resolvedProvider;
        }
    }

    _resolvedProvider = new NativeLockProvider();
    return _resolvedProvider;
}

const pendingLocks = new Set<Promise<unknown>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a file-based mutex, execute `action`, then release.
 */
export async function withLock<T>(options: MutexOption, action: () => Promise<T>): Promise<T> {
    const { fileToLock } = options;

    const lockPromise = (async () => {
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

        const provider = await getProvider();
        const release = await provider.acquire(options);

        try {
            return await action();
        } finally {
            try {
                await release();
            } catch (err) {
                /* v8 ignore next */
                console.warn("Error in Unlock !!!", (err as Error).message);
            }
        }
    })();

    // Register synchronously — before the first await above runs.
    pendingLocks.add(lockPromise);
    const cleanup = () => pendingLocks.delete(lockPromise);
    lockPromise.then(cleanup, cleanup);

    return lockPromise;
}

/**
 * Check whether a file is currently locked.
 */
export async function isLocked(fileToLock: string): Promise<boolean> {
    const provider = await getProvider();
    return provider.isLocked(fileToLock);
}

/**
 * Wait for all in-flight `withLock` operations to complete.
 */
export async function drainPendingLocks(): Promise<void> {
    if (_resolvedProvider) {
        await _resolvedProvider.drainPendingLocks();
    }
    await Promise.allSettled([...pendingLocks]);
}
