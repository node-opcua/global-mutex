import * as fs from "fs";
import * as path from "path";
import assert from "assert";

export const defaultStaleDuration = 2 * 60 * 1000; // two minutes

const doDebug = false;

interface MutexOptions2 {
    lockfile: string;
    /**
     *   stale duration in millisecond
     * @default 120000 (2 minutes)
     */
    maxStaleDuration: number;
    /**
     * interval between two retries
     * @default 100 (milliseconds)
     */
    retryInterval: number;

    /*
    */
    _id: number;
}

export interface MutexOptions extends Partial<MutexOptions2> {
    lockfile: string;
}

const toSentinel = (lockfile: string) => lockfile + ".sentinel";

function smartRemove(file: string) {
    try {
        fs.unlinkSync(file);
        assert(!fs.existsSync(file));
    } catch (err) {
        if (err.message.match(/ENOENT/)) {
            return;
        }
        //    console.log("smartRemove = ", file, err.message);
        throw err;
    }

}
function removeIfTooOld(
    lockfile: string,
    maxStaleDuration: number
): boolean {
    const sentinel = toSentinel(lockfile);
    try {
        const stat = fs.statSync(sentinel);
        const now = Date.now();
        if (stat.mtime.getTime() < now - maxStaleDuration) {
            smartRemove(sentinel);
            smartRemove(lockfile);
            return false;
        }
    } catch (err) {
        if (err.message.match(/ENOENT/)) {
            // sentinel file doesn't not exists , or is locked
            try {
                smartRemove(lockfile);
            } catch (err) {
                if (err.message.match(/EPERM/)) {
                    // file is really locked ; it cannot be removed :
                    return true;
                }
            }
            return false;
        }
        if (err.message.match(/EPERM/)) {
            // file is really locked ; it cannot be removed :
            return true;
        }
        // unexpected case
        console.log(err);
    } finally {
    }
    return false;
}

interface Stuff {
    active: boolean, id?: NodeJS.Timer
}
const _safeGuard: { [key: string]: Stuff } = {};
async function pause(duration: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, duration));
}
const pulse = (sentinel: string, interval: number, data: Stuff) => {
    if (data.active) {
        fs.writeFileSync(sentinel, Date.now().toString());
        if (data.active) {
            data.id = setTimeout(pulse, interval, sentinel, interval, data);
        }
    }
};

function acquireLock(lockfile: string): boolean {
    // let's make a attempt to open the lock file with exclusive access
    try {
        const fd = fs.openSync(lockfile, "wx+");
        fs.writeSync(fd, ".");
        fs.closeSync(fd);
        return true;
    } catch (err) {
        return false;;
    }
}

async function retryLater(options: MutexOptions): Promise<void> {
    if (doDebug) {
        console.log("retry in ", options.retryInterval!);
    }
    await pause(options.retryInterval!);
    return await lock(options);
}
let lockCount = 0;
async function lock(options: MutexOptions): Promise<void> {
    options = adjustOptions(options) as MutexOptions2;
    /*    if (options._id === undefined && _safeGuard[options.lockfile]) {
            throw new Error("Lock rentrancy detected");
        }
        options._id = 1;
    */
    if (_safeGuard[options.lockfile]) {
        // already lock  by a internal process : let's wait"
        await pause(options.retryInterval!);
        return lock(options);
    }

    const reallyLocked = removeIfTooOld(
        options.lockfile,
        options.maxStaleDuration!
    );
    if (reallyLocked) {
        return await retryLater(options);
    }

    if (!acquireLock(options.lockfile)) {
        // we cannot acquire the lock, let's try again a little bit later
        return await retryLater(options);
    }

    if (doDebug) {
        console.log("lock aquired !!!");
    }
    /* first thing to do here */
    /* istanbul ignore next */
    if (_safeGuard[options.lockfile]) {
        // throw new Error("Error in lock");
        /// argh! shit raise condition!
        return await retryLater(options);
    }
    const data = { active: true };
    _safeGuard[options.lockfile] = data;
    const sentinel = toSentinel(options.lockfile);
    pulse(sentinel, options.maxStaleDuration! / 3, data);

    // istanbul ignore next
    if (doDebug) {
        console.log("Locked !", lockCount);
    }
    lockCount += 1;
}

function unlock(options: MutexOptions) {
    const data = _safeGuard[options.lockfile];
    // istanbul ignore next
    if (!data) {
        throw new Error("File is not locked" + options.lockfile);
    }
    if (data.id) {
        clearTimeout(data.id);
        data.id = undefined;
    }
    const sentinel = toSentinel(options.lockfile);
    data.active = false;

    lockCount -= 1;
    // istanbul ignore next
    if (doDebug) {
        console.log('unlocked', lockCount);
    }

    delete _safeGuard[options.lockfile];
    smartRemove(sentinel);
    smartRemove(options.lockfile);
}

export async function withLock<T>(
    options: MutexOptions,
    action: () => Promise<T>
): Promise<T> {
    await lock(options);
    try {
        return await action();
    } finally {
        try {
            unlock(options);
        } catch (err) {
            // istanbul ignore next
            console.log("Error in Unlock !!!", err.message);
        }
    }
}
function adjustOptions(options: MutexOptions): MutexOptions2 {

    // check lock file
    if (!options.lockfile || !fs.existsSync(path.dirname(options.lockfile))) {
        throw new Error("Invalid lockfile specified :" + options.lockfile);
    }
    if (fs.existsSync(options.lockfile) && fs.lstatSync(options.lockfile).isDirectory()) {
        throw new Error("Invalid lockfile specified (cannot be a existing folder):" + options.lockfile);
    }

    options.maxStaleDuration =
        !options.maxStaleDuration || options.maxStaleDuration <= 100
            ? defaultStaleDuration
            : options.maxStaleDuration;

    options.retryInterval = Math.min(
        Math.floor(options.maxStaleDuration / 2.5),
        !options.retryInterval || options.retryInterval <= 0
            ? 100
            : options.retryInterval
    );
    return options as MutexOptions2;
}

export function resetLock(lockfile: string) {
    smartRemove(lockfile);
    smartRemove(toSentinel(lockfile));
}
