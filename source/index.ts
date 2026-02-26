import * as fs from "node:fs";
import * as path from "node:path";
import { type CheckOptions, check, type LockOptions, lock, unlock } from "proper-lockfile";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

interface MutexOption extends LockOptions {
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

    const _fs = lockOptions.fs || fs;

    if (!_fs.existsSync(path.dirname(fileToLock))) {
        throw new Error(`Invalid lockfile: ${fileToLock}`);
    }
    if (!_fs.existsSync(fileToLock)) {
        _fs.writeFileSync(fileToLock, "");
    }

    await lock(fileToLock, lockOptions);
    try {
        return await action();
    } finally {
        try {
            await unlock(fileToLock, lockOptions);
        } catch (err) {
            // istanbul ignore next
            console.log("Error in Unlock !!!", (err as Error).message);
        }
    }
}

export async function isLocked(fileToLock: string, options?: CheckOptions): Promise<boolean> {
    return await check(fileToLock, options);
}
