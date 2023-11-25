<h1><img src="https://github.com/DaniGuardiola/bunzx/raw/main/bun.png" alt="Bun logo" height="32" valign="middle"><img src="https://google.github.io/zx/img/logo.svg" alt="Zx logo" height="32" valign="middle"> bunzx</h1>

```js
#!/usr/bin/env bunzx

await $`cat package.json | grep name`

const branch = await $`git branch --show-current`
await $`dep deploy --branch=${branch}`

await Promise.all([
  $`sleep 1; echo 1`,
  $`sleep 2; echo 2`,
  $`sleep 3; echo 3`,
])

const name = 'foo bar'
await $`mkdir /tmp/${name}`
```

Bash is great, but when it comes to writing more complex scripts,
many people prefer a more convenient programming language.

JavaScript/TypeScript is a perfect choice, but the Bun standard library requires additional hassle before using. The `bunzx` package provides useful wrappers around `Bun.spawn`, escapes arguments and gives sensible defaults.

## Install

```bash
bun add bunzx
```

## bunzx and zx

bunzx is a fork of [google/zx](https://github.com/google/zx). It relies on Bun's APIs instead of Node's where possible. The API is mostly unchanged, so you can probably use bunzx as a drop-in replacement for zx if you use Bun.

Notably, one important change is that since bunzx uses `Bun.spawn` instead of Node's `child_process.spawn`, the corresponding interfaces (such as i/o streams) are different.

Another change is that `globby` is not re-exported. You can install and use it yourself, or use Bun's `glob` instead.

There are no benchmarks and no performance claims are made. One neat thing though is that bunzx can run TypeScript files directly.

## Documentation

The bunzx API is the same as zx. Read zx's documentation on [google.github.io/zx](https://google.github.io/zx/).

## Progress

This project is not completely done. Most tests pass, but some do not. Help is very welcome. Here's the current progress:

- Features:
  - [x] Basic functionality.
  - [ ] REPL - Bun does not support it yet.
  - [ ] Optimization (e.g. replace even more Node API's with Bun's).
  - [ ] `installDeps()` `prefix` option.
- Tests:
  - [ ] CLI: 21/25 (two failing tests are related to REPL).
  - [ ] Core: 32/35
  - [x] Deps: 6/6
  - [x] Experimental: 0/0
  - [x] Extra: 1/1
  - [x] Global: 2/2
  - [x] Goods: 13/13
  - [x] Package: 1/2 (looks related to `cd()`/`within()` problems)
  - [x] Util: 9/9
  - [x] Win 32: ?/2
- Other:
  - [ ] Clean up logs during testing.
  - [ ] Test script exits with code 1 even if all tests pass.
  - [ ] Coverage script does not work.
  - [ ] Mutation script does not work.

## License

[Apache-2.0](LICENSE)

The modifications made to the original project are the necessary changes made to adapt it to Bun.

Disclaimer: _This is not an officially supported Google or Bun product._
