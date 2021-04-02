import * as path from "path";
import * as fs from "fs";
import should from "should";

import { withLock, resetLock } from "../source";

async function pause(duration: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, duration));
}
describe("File Mutex", function (this: Mocha.Suite) {
  this.timeout(20000);
  const lockfile = path.join(__dirname, "lock.lock");
  before(() => {
    resetLock(lockfile);
  });
  it("T1- should transmit return value ", async () => {
    const result = await withLock({ lockfile: lockfile }, async () => {
      await pause(1);
      return 42;
    });
    result.should.eql(42);
  });
  it("T2- should remove stall file, if maxStaleDuration delay is reached", async () => {
    // given that the lock file exists already
    fs.writeFileSync(lockfile, "some data");
    await pause(1000);

    // the withLock method will eventually remove the lock file if it is stall
    await withLock(
      {
        lockfile: lockfile,
        maxStaleDuration: 500,
      },
      async () => {
        await pause(100);
      }
    );
  });
  it("T3- should excute 10 parallel tasks sequencially due to lock ", async () => {
    const retryInterval = 200;
    const startTime = Date.now();

    const verif: number[] = [];
    let nbFunctionInExecution = 0;
    let nbFunctionInExecutionMax = 0;

    async function f(n: number) {
      await withLock({ lockfile, retryInterval }, async () => {
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

    const endTime = Date.now();
    const duration = endTime - startTime;

    nbFunctionInExecution.should.eql(0);
    nbFunctionInExecutionMax.should.eql(
      1,
      "there should be only one exection of Action at a time"
    );

    verif.sort().should.eql([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    duration.should.be.greaterThan(4 * retryInterval);
  });
  it("T4- should handle a exception in action", async () => {
    let _err: Error | null = null;
    try {
      await withLock(
        {
          lockfile: lockfile,
          maxStaleDuration: 500,
        },
        async () => {
          throw new Error("Some Error");
        }
      );
    } catch (err) {
      _err = err;
    }
    should.exist(_err);
    _err?.message.should.eql("Some Error");
  });
  it("T5- should detect raise-condition", async () => {
    let _err: Error | null = null;
    try {
      const value = await withLock(
        {
          lockfile: lockfile,
          maxStaleDuration: 2500,
        },
        async () => {
          return await withLock(
            {
              lockfile: lockfile,
              maxStaleDuration: 2500,
            },
            async () => {
              return 42;
            }
          );
        }
      );
    } catch (err) {
      _err = err;
    }
    _err?.message.should.match(/Lock rentrancy detected/);
  });
  it("T6- evaluation fs.unlink when file is opened", async () => {
    // given that the lock file exists already and is opened
    try {
      resetLock(lockfile);
    } catch (err) {
      throw err;
    }
    
    const sentinel =lockfile + ".sentinel";
    fs.writeFileSync(lockfile,"Hello");
    fs.existsSync(lockfile).should.eql(true);

    let counter = 0;
    let t: NodeJS.Timeout;
    function pulse(){
      t = setTimeout(async ()=>{
        fs.writeFileSync(sentinel,"Hello World + " + (new Date()).toUTCString());
        counter+=1;
        // console.log("pulse", fs.statSync(sentinel).mtime.toISOString());
        pulse();
      },200)
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
        lockfile,
        maxStaleDuration: 3*1000, 
        retryInterval: 100,
      },
      async () => 42
    );

    result.should.eql(42);
    counter.should.be.greaterThan(6);
  });
});
