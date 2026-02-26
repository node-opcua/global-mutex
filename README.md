# @ster5/global-mutex

[![CI](https://github.com/node-opcua/global-mutex/actions/workflows/ci.yml/badge.svg)](https://github.com/node-opcua/global-mutex/actions/workflows/ci.yml)
[![NPM Version](https://img.shields.io/npm/v/@ster5/global-mutex.svg)](https://www.npmjs.com/package/@ster5/global-mutex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

A file-based mutex for Node.js — coordinate access to shared
resources across multiple processes.

Built on top of
[proper-lockfile](https://github.com/moxystudio/node-proper-lockfile),
`@ster5/global-mutex` provides a simple, promise-based API for
cross-process locking with automatic stale-lock detection and retry
support.

## Features

- **Cross-process locking** — synchronize work across independent
  Node.js processes using the filesystem.
- **Automatic stale-lock recovery** — stale locks are automatically
  detected and removed (default: 2 minutes).
- **Configurable retries** — built-in retry logic with exponential
  back-off and jitter (retries forever by default).
- **Promise-based API** — clean `async`/`await` interface with a
  `withLock` scoped-lock pattern.
- **Dual ESM / CJS** — ships both ES module (`.mjs`) and CommonJS
  (`.js`) builds with full TypeScript declarations.
- **Zero runtime dependencies** — only
  [proper-lockfile](https://www.npmjs.com/package/proper-lockfile).

## Installation

```bash
npm install @ster5/global-mutex
```

## Usage

### `withLock(options, action)`

Acquires a file-based lock, executes the provided `action`, and
releases the lock when the action completes — even if it throws.

```typescript
import { withLock } from "@ster5/global-mutex";

const result = await withLock({ fileToLock: "/tmp/my-app.lock" }, async () => {
    // critical section — only one process at a time
    return await doExclusiveWork();
});
```

#### Options

| Option       | Type     | Default                                                                 | Description                                                                                               |
| ------------ | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fileToLock` | `string` | _(required)_                                                            | Path to the lock file. The file is created automatically if it does not exist.                            |
| `stale`      | `number` | `120000` (2 min)                                                        | Duration in ms after which a lock is considered stale and can be reclaimed.                               |
| `retries`    | `object` | `{ forever: true, minTimeout: 100, maxTimeout: 2000, randomize: true }` | Retry configuration passed to [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile#lock). |
| `fs`         | `object` | Node.js `fs`                                                            | Optional custom filesystem implementation.                                                                |

All additional options from
[proper-lockfile `LockOptions`](https://github.com/moxystudio/node-proper-lockfile#lockfile-options)
are also accepted.

### `isLocked(fileToLock, options?)`

Check whether a file is currently locked.

```typescript
import { isLocked } from "@ster5/global-mutex";

if (await isLocked("/tmp/my-app.lock")) {
    console.log("Another process holds the lock");
}
```

### `defaultStaleDuration`

The default stale duration constant (`120000` ms / 2 minutes).

```typescript
import { defaultStaleDuration } from "@ster5/global-mutex";
```

## Examples

### Serialize parallel tasks

```typescript
import { withLock } from "@ster5/global-mutex";

const tasks = Array.from({ length: 10 }, (_, i) =>
    withLock({ fileToLock: "/tmp/app.lock" }, async () => {
        console.log(`Task ${i} running exclusively`);
        await doWork(i);
    }),
);

await Promise.all(tasks);
// All 10 tasks ran one at a time
```

### Nested locks on different files

```typescript
import { withLock } from "@ster5/global-mutex";

await withLock({ fileToLock: "/tmp/lock-a" }, async () => {
    // holds lock A
    await withLock({ fileToLock: "/tmp/lock-b" }, async () => {
        // holds both lock A and lock B
        await doWork();
    });
});
```

## Development

### Prerequisites

- Node.js ≥ 18

### Setup

```bash
git clone git@github.com:node-opcua/global-mutex.git
cd global-mutex
npm install
```

### Scripts

| Command              | Description                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run build`      | Build the package with [tsup](https://tsup.egoist.dev/) (outputs ESM + CJS + `.d.ts` to `dist/`) |
| `npm test`           | Run the test suite with [Vitest](https://vitest.dev/)                                            |
| `npm run test:watch` | Run tests in watch mode                                                                          |
| `npm run lint`       | Lint with [Biome](https://biomejs.dev/)                                                          |
| `npm run format`     | Format with [Biome](https://biomejs.dev/)                                                        |

### CI / CD

- **CI** — runs on every push to `master` and on pull requests.
  Tests against Node.js 18, 20, 22, and 24 on Ubuntu, macOS, and
  Windows.
- **Publish** — triggered by pushing a `v*` tag or via manual
  workflow dispatch. Builds, tests, and publishes to
  [npmjs](https://www.npmjs.com/package/@ster5/global-mutex) with
  provenance.

## License

[MIT](./LICENSE) © 2021 Etienne Rossignon, 2022–2026 Sterfive SAS
