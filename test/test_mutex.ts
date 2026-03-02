import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as async from "async";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drainPendingLocks, isLocked, withLock } from "../source";

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

    describe("Interval lifecycle", () => {
        const intervalLockFile = path.join(__dirname, "intervalTest.txt");

        beforeAll(() => {
            cleanupStaleLocks(intervalLockFile);
        });
        afterAll(() => {
            cleanupStaleLocks(intervalLockFile);
        });

        function createIntervalTracker() {
            const originalSetInterval = globalThis.setInterval;
            const originalClearInterval = globalThis.clearInterval;

            const active = new Set<NodeJS.Timeout>();
            let totalSet = 0;
            let totalCleared = 0;

            globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
                const id = originalSetInterval(...args);
                active.add(id);
                totalSet++;
                return id;
            }) as typeof setInterval;

            globalThis.clearInterval = ((id: NodeJS.Timeout) => {
                if (active.has(id)) {
                    active.delete(id);
                    totalCleared++;
                }
                return originalClearInterval(id);
            }) as typeof clearInterval;

            return {
                get leaking() {
                    return active.size;
                },
                get totalSet() {
                    return totalSet;
                },
                get totalCleared() {
                    return totalCleared;
                },
                restore() {
                    // Clean up any remaining intervals
                    for (const id of active) {
                        originalClearInterval(id);
                    }
                    globalThis.setInterval = originalSetInterval;
                    globalThis.clearInterval = originalClearInterval;
                }
            };
        }

        it("T16 - single withLock must clear its interval", async () => {
            const tracker = createIntervalTracker();
            try {
                await withLock({ fileToLock: intervalLockFile }, async () => {
                    await pause(10);
                    return 1;
                });

                expect(tracker.totalSet).toBe(1);
                expect(tracker.totalCleared).toBe(1);
                expect(tracker.leaking).toBe(0);
            } finally {
                tracker.restore();
            }
        });

        it("T17 - parallel nested locks must clear all intervals", async () => {
            const fileToLock1 = path.join(__dirname, "intervalTest1.txt");
            const fileToLock2 = path.join(__dirname, "intervalTest2.txt");

            cleanupStaleLocks(fileToLock1, fileToLock2);

            const tracker = createIntervalTracker();
            try {
                async function task() {
                    return await withLock({ fileToLock: fileToLock1 }, async () => {
                        await pause(10 + Math.ceil(Math.random() * 20));
                        return await withLock({ fileToLock: fileToLock2 }, async () => {
                            await pause(10);
                            return 42;
                        });
                    });
                }

                const results = await Promise.all([task(), task(), task(), task(), task(), task()]);
                expect(results).toEqual([42, 42, 42, 42, 42, 42]);

                // 6 tasks × 2 locks each = 12 intervals
                expect(tracker.totalSet).toBe(12);
                expect(tracker.totalCleared).toBe(12);
                expect(tracker.leaking).toBe(0);
            } finally {
                tracker.restore();
                cleanupStaleLocks(fileToLock1, fileToLock2);
            }
        }, 20000);
    });

    describe("drainPendingLocks", () => {
        const drainLockFile = path.join(__dirname, "drainTest.txt");

        beforeAll(() => {
            cleanupStaleLocks(drainLockFile);
        });
        afterAll(() => {
            cleanupStaleLocks(drainLockFile);
        });

        it("T21 - should wait for fire-and-forget withLock calls to complete", async () => {
            const results: number[] = [];

            // Launch 5 fire-and-forget withLock calls (not awaited)
            for (let i = 0; i < 5; i++) {
                const n = i;
                // deliberately NOT awaited — simulates CertificateManager.trustCertificate
                withLock({ fileToLock: drainLockFile }, async () => {
                    await pause(20);
                    results.push(n);
                });
            }

            // Yield to let the first lock acquire
            await pause(1);

            // drainPendingLocks should wait for all of them
            await drainPendingLocks();

            expect(results.length).toBe(5);
            expect(results.sort()).toEqual([0, 1, 2, 3, 4]);
        }, 20000);

        it("T22 - drainPendingLocks ensures all intervals are cleared", async () => {
            const originalSetInterval = globalThis.setInterval;
            const originalClearInterval = globalThis.clearInterval;
            const active = new Set<NodeJS.Timeout>();

            globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
                const id = originalSetInterval(...args);
                active.add(id);
                return id;
            }) as typeof setInterval;

            globalThis.clearInterval = ((id: NodeJS.Timeout) => {
                active.delete(id);
                return originalClearInterval(id);
            }) as typeof clearInterval;

            try {
                // Launch fire-and-forget locks
                for (let i = 0; i < 3; i++) {
                    withLock({ fileToLock: drainLockFile }, async () => {
                        await pause(10);
                    });
                }

                // Intervals may be active
                // Drain waits for all locks to release
                await drainPendingLocks();

                // After drain, ALL intervals must be cleared
                expect(active.size).toBe(0);
            } finally {
                // safety cleanup
                for (const id of active) {
                    originalClearInterval(id);
                }
                globalThis.setInterval = originalSetInterval;
                globalThis.clearInterval = originalClearInterval;
            }
        }, 20000);

        it("T23 - drainPendingLocks resolves immediately when no locks pending", async () => {
            const start = Date.now();
            await drainPendingLocks();
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(50);
        });
    });

    describe("EPERM regression — file at lock path", () => {
        const epermLockFile = path.join(__dirname, "epermTest.txt");
        const epermLockDir = `${epermLockFile}.lock`;

        beforeAll(() => {
            cleanupStaleLocks(epermLockFile);
            try {
                fs.unlinkSync(epermLockFile);
            } catch {}
        });

        afterAll(async () => {
            await drainPendingLocks();
            cleanupStaleLocks(epermLockFile);
            try {
                fs.unlinkSync(epermLockFile);
            } catch {}
        });

        it("T18 - EPERM with existing artifact at lock path → treated as contention", async () => {
            // Scenario: a regular file exists at the .lock path (left
            // by a different locking library).  On Windows, mkdir
            // throws EPERM (not EEXIST) when the target is a file.
            //
            // The fix checks stat(lp) after EPERM: if something is
            // there, it falls through to the staleness/retry logic.
            //
            // This test:
            //   1. Creates a real file at the lock path
            //   2. Monkey-patches mkdir to throw EPERM on the 1st call
            //   3. Verifies withLock recovers via retry

            // Ensure a file exists at the lock path for stat() to find
            fs.writeFileSync(epermLockDir, "leftover", "utf-8");
            // Backdate it so it's stale
            const past = new Date(Date.now() - 10_000);
            fs.utimesSync(epermLockDir, past, past);

            const originalMkdir = fs.promises.mkdir;
            let mkdirCalls = 0;

            fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
                mkdirCalls++;
                if (mkdirCalls === 1) {
                    const e = new Error(`EPERM: operation not permitted, mkdir '${args[0]}'`) as NodeJS.ErrnoException;
                    e.code = "EPERM";
                    throw e;
                }
                return originalMkdir.apply(fs.promises, args);
            }) as typeof originalMkdir;

            try {
                const result = await withLock(
                    {
                        fileToLock: epermLockFile,
                        stale: 500,
                        retries: { retries: 5, minTimeout: 100 }
                    },
                    async () => {
                        await pause(10);
                        return 42;
                    }
                );

                expect(result).toBe(42);
                expect(mkdirCalls).toBeGreaterThanOrEqual(2);
            } finally {
                fs.promises.mkdir = originalMkdir;
                cleanupStaleLocks(epermLockFile);
            }
        }, 15000);

        it("T19 - non-EEXIST/non-EPERM errors (e.g. EACCES) must propagate", async () => {
            const originalMkdir = fs.promises.mkdir;

            fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
                const e = new Error(`EACCES: permission denied, mkdir '${args[0]}'`) as NodeJS.ErrnoException;
                e.code = "EACCES";
                throw e;
            }) as typeof originalMkdir;

            try {
                let caught: Error | null = null;
                try {
                    await withLock(
                        {
                            fileToLock: epermLockFile,
                            stale: 500,
                            retries: { retries: 1, minTimeout: 100 }
                        },
                        async () => 42
                    );
                } catch (e) {
                    caught = e as Error;
                }

                expect(caught).not.toBeNull();
                expect((caught as Error).message).toMatch(/EACCES/);
            } finally {
                fs.promises.mkdir = originalMkdir;
            }
        });

        it("T20 - EPERM with nothing at lock path → rethrown (genuine permission issue)", async () => {
            // If mkdir throws EPERM but nothing exists at the lock
            // path, it's a real permission problem (bad ACL, etc.).
            // withLock must NOT silently swallow it.

            cleanupStaleLocks(epermLockFile);

            const originalMkdir = fs.promises.mkdir;

            fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
                const e = new Error(`EPERM: operation not permitted, mkdir '${args[0]}'`) as NodeJS.ErrnoException;
                e.code = "EPERM";
                throw e;
            }) as typeof originalMkdir;

            try {
                let caught: Error | null = null;
                try {
                    await withLock(
                        {
                            fileToLock: epermLockFile,
                            stale: 500,
                            retries: { retries: 3, minTimeout: 100 }
                        },
                        async () => 42
                    );
                } catch (e) {
                    caught = e as Error;
                }

                // Must get the original EPERM, NOT "Lock file is
                // already being held"
                expect(caught).not.toBeNull();
                expect((caught as Error).message).toMatch(/EPERM/);
            } finally {
                fs.promises.mkdir = originalMkdir;
            }
        });
    });

    describe("Process-exit lock cleanup", () => {
        const exitLockFile = path.join(os.tmpdir(), "exit-cleanup-test.txt");
        const exitLockDir = `${exitLockFile}.lock`;
        const markerFile = path.join(os.tmpdir(), "exit-cleanup-marker.txt");
        const projectDir = path.resolve(__dirname, "..");

        beforeAll(() => {
            cleanupStaleLocks(exitLockFile);
        });

        afterAll(() => {
            cleanupStaleLocks(exitLockFile);
            fs.rmSync(markerFile, { force: true });
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
            fs.rmSync(markerFile, { force: true });

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
