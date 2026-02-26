import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as async from "async";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocked, withLock } from "../source";

async function pause(duration: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, duration));
}

function cleanupStaleLocks(...files: string[]) {
    for (const f of files) {
        const lockDir = `${f}.lock`;
        if (fs.existsSync(lockDir)) {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    }
}

function getInternalLockFile(fileToLock: string) {
    return `${fileToLock}.lock`;
}
function simulateLockFile(fileToLock: string) {
    const internalLockFile = getInternalLockFile(fileToLock);
    if (!fs.existsSync(internalLockFile)) {
        fs.mkdirSync(internalLockFile);
    }
}

describe("File Mutex", () => {
    const fileToLock = path.join(__dirname, "fileToLock.txt");
    const fileToLock1 = path.join(__dirname, "fileToLock1.txt");
    const fileToLock2 = path.join(__dirname, "fileToLock2.txt");

    beforeAll(() => {
        cleanupStaleLocks(fileToLock, fileToLock1, fileToLock2);
    });

    afterAll(() => {
        cleanupStaleLocks(fileToLock, fileToLock1, fileToLock2);
    });

    it("T1- should transmit return value", async () => {
        const result = await withLock({ fileToLock }, async () => {
            await pause(1);
            return 42;
        });
        expect(result).toBe(42);
    });

    it("T2- should remove stall file, if maxStaleDuration delay is reached", async () => {
        // given that the lock exists already
        await simulateLockFile(fileToLock);

        await pause(2000 * 2); // min stale is 2000 in proper-lockfile

        // the withLock method will eventually remove the lock file if it is stall
        await withLock(
            {
                fileToLock,
                stale: 2000,
                retries: { minTimeout: 100, maxRetryTime: 100, retries: 1 }
            },
            async () => {
                await pause(3000);
            }
        );

        expect(await isLocked(fileToLock)).toBe(false);
    }, 20000);

    it("T3- should execute 10 parallel tasks sequentially due to lock", async () => {
        const retryInterval = 200;

        const NS_PER_SEC = 1e9;
        const MS_PER_NS = 1e-6;

        const startTime = process.hrtime();

        const verification: number[] = [];
        let nbFunctionInExecution = 0;
        let nbFunctionInExecutionMax = 0;

        async function f(n: number) {
            await withLock(
                {
                    fileToLock,
                    retries: { maxTimeout: retryInterval, minTimeout: retryInterval },
                    onCompromised: () => {
                        console.log("Compromised");
                    }
                },
                async () => {
                    nbFunctionInExecution += 1;
                    nbFunctionInExecutionMax = Math.max(nbFunctionInExecution, nbFunctionInExecutionMax);
                    await pause(Math.random() * 10);
                    verification.push(n);
                    nbFunctionInExecution -= 1;
                }
            );
        }

        const promises: Promise<void>[] = [];
        for (let i = 0; i < 10; i++) {
            promises.push(f(i));
        }
        await Promise.all(promises);

        const diff = process.hrtime(startTime);
        const duration = (diff[0] * NS_PER_SEC + diff[1]) * MS_PER_NS;

        expect(nbFunctionInExecution).toBe(0);
        expect(nbFunctionInExecutionMax).toBe(1);
        expect(verification.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(duration).toBeGreaterThan(3 * retryInterval);
    }, 20000);

    it("T4- should handle a exception in action", async () => {
        let _err: Error | null = null;
        try {
            await withLock(
                {
                    fileToLock,
                    stale: 500
                },
                async () => {
                    throw new Error("Some Error");
                }
            );
        } catch (err) {
            _err = err as Error;
        }
        expect(_err).toBeTruthy();
        expect(_err?.message).toBe("Some Error");
    });

    it.skip("T5- should detect raise-condition", async () => {
        let _err: Error | null = null;
        try {
            await withLock(
                {
                    fileToLock,
                    stale: 2500
                },
                async () => {
                    return await withLock(
                        {
                            fileToLock,
                            stale: 2500
                        },
                        async () => {
                            return 42;
                        }
                    );
                }
            );
        } catch (err) {
            _err = err as Error;
        }
        expect(_err?.message).toMatch(/Lock re-entrancy detected/);
    });

    it.skip("T6- evaluation fs.unlink when file is opened", async () => {
        try {
            cleanupStaleLocks(fileToLock);
        } catch (err) {
            throw err;
        }

        fs.writeFileSync(fileToLock, "Hello");
        expect(fs.existsSync(fileToLock)).toBe(true);

        let counter = 0;
        let t: NodeJS.Timeout;
        function pulse() {
            t = setTimeout(async () => {
                fs.writeFileSync(fileToLock, `Hello World + ${new Date().toUTCString()}`);
                counter += 1;
                pulse();
            }, 200);
        }
        pulse();
        await pause(300);
        // let's close fd in t
        setTimeout(() => {
            clearInterval(t);
        }, 2000);

        // the withLock method will eventually remove the lock file if it is stall
        const result = await withLock(
            {
                fileToLock,
                stale: 3 * 1000,
                retries: { minTimeout: 100 }
            },
            async () => 42
        );

        expect(result).toBe(42);
        expect(counter).toBeGreaterThan(6);
    });

    async function returnWithDelay<T>(n: T): Promise<T> {
        return new Promise<T>((resolve) => setImmediate(() => resolve(n)));
    }

    it("T7 - Lock then Lock", async () => {
        const result = await new Promise<number>((resolve) =>
            withLock({ fileToLock }, async () => returnWithDelay(21))
                .then((value) => withLock<number>({ fileToLock }, async () => returnWithDelay(value * 2)))
                .then(resolve)
        );
        expect(result).toBe(42);
    });

    it("T8 - Trying to lock a file that cannot be created - in a missing folder", async () => {
        const lockfile1 = path.join(path.dirname(fileToLock), "missing_folder", path.basename(fileToLock));

        let err: Error | null = null;
        try {
            const result = await withLock<number>({ fileToLock: lockfile1 }, async () => returnWithDelay(21));
            expect(result).toBe(42);
        } catch (_e) {
            err = _e as Error;
        }
        expect(err).toBeTruthy();
        expect(err!.message).toMatch(/Invalid lockfile/);
    });

    it.skip("T9 - Trying to lock a file that cannot be created - because lock is a folder !", async () => {
        const folderToLock = path.join(path.dirname(fileToLock));
        let err: Error | null = null;
        try {
            const result = await withLock<number>({ fileToLock: folderToLock }, async () => returnWithDelay(21));
            expect(result).toBe(42);
        } catch (_e) {
            err = _e as Error;
        }
        expect(err).toBeTruthy();
        expect(err!.message).toMatch(/Invalid lockfile/);
    });

    it("T10 - Parallel tasks", async () => {
        const fileToLock1 = path.join(__dirname, "fileToLock1.txt");
        const fileToLock2 = path.join(__dirname, "fileToLock2.txt");

        async function task() {
            return await withLock({ fileToLock: fileToLock1 }, async () => {
                await pause(100 + Math.ceil(Math.random() * 200));

                return await withLock({ fileToLock: fileToLock2 }, async () => {
                    await pause(100 + Math.ceil(Math.random() * 200));
                    return 42;
                });
            });
        }
        const p1 = task();
        const p2 = task();
        const p3 = task();
        const p4 = task();
        const p5 = task();
        const p6 = task();
        const result = await Promise.all([p1, p2, p3, p4, p5, p6]);
        expect(result).toEqual([42, 42, 42, 42, 42, 42]);
    }, 20000);

    it(
        "T11 - async",
        () =>
            new Promise<void>((done) => {
                let counter = 10;
                let maxSimultaneous = 0;
                function f(callback: (err: Error | null, n?: number[]) => void) {
                    withLock({ fileToLock }, async () => {
                        const n = counter;
                        maxSimultaneous += 1;
                        counter++;
                        await pause(Math.random() * 50);
                        const data = [n, maxSimultaneous];
                        maxSimultaneous--;
                        return data;
                    }).then((data) => callback(null, data));
                }
                const tasks = [f, f, f, f, f, f, f, f, f];
                async.mapLimit(
                    tasks,
                    10,
                    (
                        f: (callback: (err: Error | null, n?: number[]) => void) => void,
                        callback: (err: Error | null, n?: number[]) => void
                    ) => {
                        f(callback);
                    },
                    (_err?: Error | null, _results?: (number[] | undefined)[]) => {
                        done();
                    }
                );
            }),
        20000
    );

    it(
        "T12 - combined lockers",
        () =>
            new Promise<void>((done) => {
                let maxSimultaneous = 0;
                let counter = 0;
                function f(callback: (err: Error | null, n?: number[]) => void) {
                    withLock({ fileToLock }, async () => {
                        const n = counter;
                        maxSimultaneous += 1;
                        counter++;
                        await pause(Math.random() * 50);
                        const data = [n, maxSimultaneous];
                        maxSimultaneous--;
                        return data;
                    }).then((data) => callback(null, data));
                }
                const tasks = [f, f, f, f, f, f, f, f, f];
                async.mapLimit(
                    tasks,
                    10,
                    (
                        f: (callback: (err: Error | null, n?: number[]) => void) => void,
                        callback: (err: Error | null, n?: number[]) => void
                    ) => {
                        f(callback);
                    },
                    (_err?: Error | null, _results?: (number[] | undefined)[]) => {
                        done();
                    }
                );
            }),
        20000
    );

    describe("Within ReadOnly Folders", () => {
        const readOnlyFolder = path.join(os.tmpdir(), "_readOnlyFolder");
        beforeAll(() => {
            if (fs.existsSync(readOnlyFolder)) {
                fs.chmodSync(readOnlyFolder, 0o777);
                fs.rmSync(readOnlyFolder, { recursive: true });
            }
            fs.mkdirSync(readOnlyFolder);
        });

        it.skip("T13 - Locking file in read-only folder", async () => {
            const fileToLock = path.join(readOnlyFolder, "fileToLock.txt");
            fs.writeFileSync(fileToLock, "Hello", "utf-8");
            fs.chmodSync(readOnlyFolder, 0o500); // 0x5 = r-x
            console.log("acquiring lock");

            await withLock({ fileToLock }, async () => {
                console.log("Lock acquired!");
                await fs.promises.writeFile(fileToLock, "Hello-World", "utf-8");
            });
            console.log("Done!");
        });
    });

    describe("Process-exit lock cleanup", () => {
        const exitLockFile = path.join(os.tmpdir(), "exit-cleanup-test.txt");
        const exitLockDir = `${exitLockFile}.lock`;
        const markerFile = path.join(os.tmpdir(), "exit-cleanup-marker.txt");
        const projectDir = path.resolve(__dirname, "..");

        beforeAll(() => {
            cleanupStaleLocks(exitLockFile);
            // Build to ensure dist/ matches current source
            const { execSync } = require("node:child_process") as typeof import("node:child_process");
            execSync("npm run build", { cwd: projectDir, stdio: "pipe" });
        });

        afterAll(() => {
            cleanupStaleLocks(exitLockFile);
            try {
                fs.unlinkSync(markerFile);
            } catch {}
        });

        function runChildScript(scriptBody: string) {
            const code = [
                `const fs = require("node:fs");`,
                `const { withLock } = require(".");`,
                `const fileToLock = ${JSON.stringify(exitLockFile)};`,
                `const markerFile = ${JSON.stringify(markerFile)};`,
                `(async () => {`,
                scriptBody,
                `})();`
            ].join("\n");

            // Remove marker from previous run
            try {
                fs.unlinkSync(markerFile);
            } catch {}

            const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
            return spawnSync(process.execPath, ["-e", code], {
                cwd: projectDir,
                timeout: 10000,
                stdio: "pipe"
            });
        }

        it("T14 - should clean up lock on process.exit()", () => {
            cleanupStaleLocks(exitLockFile);

            runChildScript(`
                await withLock({ fileToLock }, async () => {
                    // Prove we acquired the lock
                    fs.writeFileSync(markerFile, "lock-acquired");
                    process.exit(0);
                });
            `);

            // 1) Verify the lock WAS acquired (child ran successfully)
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(fs.readFileSync(markerFile, "utf-8")).toBe("lock-acquired");

            // 2) Verify the lock dir was cleaned up by the exit handler
            expect(fs.existsSync(exitLockDir)).toBe(false);
        });

        it("T15 - should clean up lock on uncaught exception", () => {
            cleanupStaleLocks(exitLockFile);

            runChildScript(`
                await withLock({ fileToLock }, async () => {
                    // Prove we acquired the lock
                    fs.writeFileSync(markerFile, "lock-acquired");
                    throw new Error("crash");
                });
            `);

            // 1) Verify the lock WAS acquired
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(fs.readFileSync(markerFile, "utf-8")).toBe("lock-acquired");

            // 2) Verify the lock dir was cleaned up
            expect(fs.existsSync(exitLockDir)).toBe(false);
        });
    });
});
