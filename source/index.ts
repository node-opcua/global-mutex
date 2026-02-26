import * as fs from "node:fs";
import * as path from "node:path";
import { type CheckOptions, check, type LockOptions, lock, unlock } from "proper-lockfile";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

export interface MutexOption extends LockOptions {
    fileToLock: string;
}

export async function withLock<T>(options: MutexOption, action: () => Promise<T>): Promise<T> {
    const { fileToLock, ...lockOptions } = { ...options };

    lockOptions.stale = lockOptions.stale || defaultStaleDuration;
    lockOptions.retries = lockOptions.retries ?? {
        forever: true,
        minTimeout: 100,
        maxTimeout: 2000,
        randomize: true
    };

    try {
        await fs.promises.access(path.dirname(fileToLock));
    } catch {
        throw new Error(`Invalid lockfile: ${fileToLock}`);
    }
    try {
        await fs.promises.writeFile(fileToLock, "", { flag: "wx" });
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    await lock(fileToLock, lockOptions);
    try {
        return await action();
    } finally {
        try {
            await unlock(fileToLock, lockOptions);
        } catch (err) {
            // istanbul ignore next
            console.warn("Error in Unlock !!!", (err as Error).message);
        }
    }
}

export async function isLocked(fileToLock: string, options?: CheckOptions): Promise<boolean> {
    return await check(fileToLock, options);
}
