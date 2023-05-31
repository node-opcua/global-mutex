import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import should from "should";
import * as async from "async";

import { withLock, resetLock, toSentinel } from "../source";

async function pause(duration: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, duration));
}
describe("File Mutex", function (this) {
  this.timeout(20000);
  const fileToLock = path.join(__dirname, "fileToLock.lock");
  before(() => {
    resetLock(fileToLock);
  });
  it("T1- should transmit return value ", async () => {
    const result = await withLock({ lockfile: fileToLock }, async () => {
      await pause(1);
      return 42;
    });
    result.should.eql(42);
  });
  it("T2- should remove stall file, if maxStaleDuration delay is reached", async () => {
    // given that the lock file exists already
    fs.writeFileSync(fileToLock, "some data");
    await pause(1000);

    // the withLock method will eventually remove the lock file if it is stall
    await withLock(
      {
        lockfile: fileToLock,
        maxStaleDuration: 500,
      },
      async () => {
        await pause(100);
      }
    );
  });
  it("T3- should execute 10 parallel tasks sequentially due to lock ", async () => {
    const retryInterval = 200;
    const NS_PER_SEC = 1e9;
    const MS_PER_NS = 1e-6;
    const startTime = process.hrtime();

    const verif: number[] = [];
    let nbFunctionInExecution = 0;
    let nbFunctionInExecutionMax = 0;

    async function f(n: number) {
      await withLock({ lockfile: fileToLock, retryInterval }, async () => {
        nbFunctionInExecution += 1;
        nbFunctionInExecutionMax = Math.max(
          nbFunctionInExecution,
          nbFunctionInExecutionMax
        );
        await pause(Math.random() * 10);
        verif.push(n);
        nbFunctionInExecution -= 1;
      });
    }

    const promises: any[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(f(i));
    }
    await Promise.all(promises);

    const diff = process.hrtime(startTime);
    const duration = (diff[0] * NS_PER_SEC + diff[1]) * MS_PER_NS;

    nbFunctionInExecution.should.eql(0);
    nbFunctionInExecutionMax.should.eql(
      1,
      "there should be only one execution of Action at a time"
    );

    verif.sort().should.eql([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    duration.should.be.greaterThan(3 * retryInterval);
  });
  it("T4- should handle a exception in action", async () => {
    let _err: Error | null = null;
    try {
      await withLock(
        {
          lockfile: fileToLock,
          maxStaleDuration: 500,
        },
        async () => {
          throw new Error("Some Error");
        }
      );
    } catch (err) {
      _err = err as Error;
    }
    should.exist(_err);
    _err?.message.should.eql("Some Error");
  });
  xit("T5- should detect raise-condition", async () => {
    let _err: Error | null = null;
    try {
      const value = await withLock(
        {
          lockfile: fileToLock,
          maxStaleDuration: 2500,
        },
        async () => {
          return await withLock(
            {
              lockfile: fileToLock,
              maxStaleDuration: 2500,
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
    _err?.message.should.match(/Lock rentrancy detected/);
  });
  xit("T6- evaluation fs.unlink when file is opened", async () => {
    // given that the lock file exists already and is opened
    try {
      resetLock(fileToLock);
    } catch (err) {
      throw err;
    }

    fs.writeFileSync(fileToLock, "Hello");
    fs.existsSync(fileToLock).should.eql(true);

    let counter = 0;
    let t: NodeJS.Timeout;
    function pulse() {
      t = setTimeout(async () => {
        fs.writeFileSync(
          fileToLock,
          "Hello World + " + new Date().toUTCString()
        );
        counter += 1;
        const sentinel = toSentinel(fileToLock);
        console.log("pulse", fs.statSync(sentinel).mtime.toISOString());
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
        lockfile: fileToLock,
        maxStaleDuration: 3 * 1000,
        retryInterval: 100,
      },
      async () => 42
    );

    result.should.eql(42);
    counter.should.be.greaterThan(6);
  });

  async function returnWithDelay<T>(n: T): Promise<T> {
    return new Promise<T>((resolve) => setImmediate(() => resolve(n)));
  }
  it("T7 - Lock then Lock", async () => {
    const result = await new Promise<number>((resolve) =>
      withLock({ lockfile: fileToLock }, async () => returnWithDelay(21))
        .then((value) =>
          withLock<number>({ lockfile: fileToLock }, async () =>
            returnWithDelay(value * 2)
          )
        )
        .then(resolve)
    );
    result.should.eql(42);
  });
  it("T8 - Trying to lock a file that cannot be created - in a missing folder", async () => {
    const lockfile1 = path.join(
      path.dirname(fileToLock),
      "missing_folder",
      path.basename(fileToLock)
    );

    let err: Error | null = null;
    try {
      const result = await withLock<number>({ lockfile: lockfile1 }, async () =>
        returnWithDelay(21)
      );
      result.should.eql(42);
    } catch (_e) {
      err = _e as Error;
    }
    should.exist(err);
    err!.message.should.match(/Invalid lockfile/);
  });
  it("T9 - Trying to lock a file that cannot be created - because lock is a folder !", async () => {
    const folderToLock = path.join(path.dirname(fileToLock));
    let err: Error | null = null;
    try {
      const result = await withLock<number>(
        { lockfile: folderToLock },
        async () => returnWithDelay(21)
      );
      result.should.eql(42);
    } catch (_e) {
      err = _e as Error;
    }
    should.exist(err);
    err!.message.should.match(/Invalid lockfile/);
  });
  it("T10 - Parallel tasks", async () => {
    const fileToLock1 = path.join(__dirname, "lock1.lock");
    const fileToLock2 = path.join(__dirname, "lock2.lock");

    async function task() {
      return await withLock({ lockfile: fileToLock1 }, async () => {
        await pause(100 + Math.ceil(Math.random() * 200));

        return await withLock({ lockfile: fileToLock2 }, async () => {
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
    result.should.eql([42, 42, 42, 42, 42, 42]);
  });
  it("T11 -  async", (done) => {
    let counter = 10;
    let maxSimultaneous = 0;
    function f(callback: (err: Error | null, n?: number[]) => void) {
      withLock({ lockfile: fileToLock }, async () => {
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
      (f: any, callback: (err: Error | null, n?: number[]) => void) => {
        f(callback);
      },
      (err?: Error | null, results?: (number[] | undefined)[]) => {
        console.log(results);
        done(err);
      }
    );
  });

  it("T12 -  combined lockers", (done) => {
    let maxSimultaneous = 0;
    let counter = 0;
    function f(callback: (err: Error | null, n?: number[]) => void) {
      withLock({ lockfile: fileToLock }, async () => {
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
      (f: any, callback: (err: Error | null, n?: number[]) => void) => {
        f(callback);
      },
      (err?: Error | null, results?: (number[] | undefined)[]) => {
        console.log(results);
        done(err);
      }
    );
  });

  it("T14 - use the same lock on same file (with different path)", async () => {
    const filenameVariation1 = path.join(__dirname, "toto/../fileToLock.lock");
    const filenameVariation2 = path.join(__dirname, "./fileToLock.lock");

    toSentinel(filenameVariation1).should.eql(toSentinel(filenameVariation2));
  });

  describe("Within ReadOnly Folders", () => {
    const readOnlyFolder = path.join(os.tmpdir(), "_readOnlyFolder");
    before(() => {
      if (fs.existsSync(readOnlyFolder)) {
        fs.chmodSync(readOnlyFolder, 0o777);
        fs.rmSync(readOnlyFolder, { recursive: true });
      }
      fs.mkdirSync(readOnlyFolder);
    });

    it("T13 - Locking file in read-only folder", async () => {
      const fileToLock = path.join(readOnlyFolder, "fileToLock.lock");
      fs.writeFileSync(fileToLock, "Hello", "utf-8");
      fs.chmodSync(readOnlyFolder, 0o500); // 0x5 = r-x
      console.log("acquiring lock");

      await withLock({ lockfile: fileToLock }, async () => {
        console.log("Lock acquired!");
        /** */
        await fs.promises.writeFile(fileToLock, "Hello-World", "utf-8");
      });
      console.log("Done!");
    });
  });
});
