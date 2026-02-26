import * as fs from "node:fs";
import * as path from "node:path";
import { type CheckOptions, check, type LockOptions, lock, unlock } from "proper-lockfile";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

interface MutexOption extends LockOptions {
    fileToLock: string;
}

export async function withLock<T>(options: MutexOption, action: () => Promise<T>): Promise<T> {
    options.stale = options.stale || defaultStaleDuration;

    const { fileToLock } = options;

    const _fs = options.fs || fs;

    if (!_fs.existsSync(path.dirname(fileToLock))) {
        throw new Error(`Invalid lockfile: ${fileToLock}`);
    }
    if (!_fs.existsSync(fileToLock)) {
        _fs.writeFileSync(fileToLock, "");
    }

    options.stale = options.stale || defaultStaleDuration;
    if (options.retries === undefined) {
        options.retries = { forever: true, minTimeout: 100, maxTimeout: 2000, randomize: true };
    }
    await lock(fileToLock, options);
    try {
        return await action();
    } finally {
        try {
            await unlock(fileToLock, options);
        } catch (err) {
            // istanbul ignore next
            console.log("Error in Unlock !!!", (err as Error).message);
        }
    }
}

export async function isLocked(fileToLock: string, options?: CheckOptions): Promise<boolean> {
    return await check(fileToLock, options);
}
