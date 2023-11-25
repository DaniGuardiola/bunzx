// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from 'node:assert'
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { inspect } from 'node:util'
import chalk, { ChalkInstance } from 'chalk'
import which from 'which'
import {
  Duration,
  // errnoMessage,
  exitCodeInfo,
  formatCmd,
  noop,
  onData,
  parseDuration,
  pipeReadableStreamToFileSink,
  psTree,
  quote,
  quotePowerShell,
  typedArrayConcat,
} from './util.js'
import { BunFile, FileSink, Subprocess } from 'bun'

export type Shell = (
  pieces: TemplateStringsArray,
  ...args: any[]
) => ProcessPromise

const processCwd = Symbol('processCwd')

export type Options = {
  [processCwd]: string
  cwd?: string
  verbose: boolean
  env: NodeJS.ProcessEnv
  shell: string | boolean
  prefix: string
  quote: typeof quote
  spawn: typeof Bun.spawn
  log: typeof log
}

const storage = new AsyncLocalStorage<Options>()
const hook = createHook({
  init: syncCwd,
  before: syncCwd,
  promiseResolve: syncCwd,
  after: syncCwd,
  destroy: syncCwd,
})
hook.enable()

export const defaults: Options = {
  [processCwd]: process.cwd(),
  verbose: true,
  env: process.env,
  shell: true,
  prefix: '',
  quote: () => {
    throw new Error('No quote function is defined: https://ï.at/no-quote-func')
  },
  spawn: Bun.spawn,
  log,
}

try {
  defaults.shell = which.sync('bash')
  defaults.prefix = 'set -euo pipefail;'
  defaults.quote = quote
} catch (err) {
  if (process.platform == 'win32') {
    defaults.shell = which.sync('powershell.exe')
    defaults.quote = quotePowerShell
  }
}

function getStore() {
  return storage.getStore() || defaults
}

export const $ = new Proxy<Shell & Options>(
  function (pieces, ...args) {
    const from = new Error().stack!.split(/^\s*at\s/m)[2].trim()
    if (pieces.some((p) => p == undefined)) {
      throw new Error(`Malformed command at ${from}`)
    }
    let resolve: Resolve, reject: Resolve
    const promise = new ProcessPromise((...args) => ([resolve, reject] = args))
    let cmd = pieces[0],
      i = 0
    while (i < args.length) {
      let s
      if (Array.isArray(args[i])) {
        s = args[i].map((x: any) => $.quote(substitute(x))).join(' ')
      } else {
        s = $.quote(substitute(args[i]))
      }
      cmd += s + pieces[++i]
    }
    promise._bind(cmd, from, resolve!, reject!, getStore())
    // Postpone run to allow promise configuration.
    setImmediate(() => promise.isHalted || promise.run())
    return promise
  } as Shell & Options,
  {
    set(_, key, value) {
      const target = key in Function.prototype ? _ : getStore()
      Reflect.set(target, key, value)
      return true
    },
    get(_, key) {
      const target = key in Function.prototype ? _ : getStore()
      return Reflect.get(target, key)
    },
  }
)

function substitute(arg: ProcessPromise | any) {
  if (arg?.stdout) {
    return arg.stdout.replace(/\n$/, '')
  }
  return `${arg}`
}

type Resolve = (out: ProcessOutput) => void
type StdioNull = 'inherit' | 'ignore'
type StdioPipeNamed = 'pipe'
type StdioPipe = undefined | null | StdioPipeNamed
type WritableIO = StdioPipe | StdioNull | ReadableStream<Uint8Array>
type ReadableIO = StdioPipe | StdioNull | BunFile

export class ProcessPromise extends Promise<ProcessOutput> {
  child?: Subprocess
  private _command = ''
  private _from = ''
  private _resolve: Resolve = noop
  private _reject: Resolve = noop
  private _snapshot = getStore()
  private _stdio: [WritableIO, ReadableIO, ReadableIO] = [
    'inherit',
    'pipe',
    'pipe',
  ]
  private _nothrow = false
  private _quiet = false
  private _timeout?: number
  private _timeoutSignal?: string
  private _resolved = false
  private _halted = false
  private _piped = false
  _prerun = noop
  _postrun = noop

  _bind(
    cmd: string,
    from: string,
    resolve: Resolve,
    reject: Resolve,
    options: Options
  ) {
    this._command = cmd
    this._from = from
    this._resolve = resolve
    this._reject = reject
    this._snapshot = { ...options }
  }

  run(): ProcessPromise {
    const $ = this._snapshot
    if (this.child) return this // The _run() can be called from a few places.
    this._prerun() // In case $1.pipe($2), the $2 returned, and on $2._run() invoke $1._run().
    $.log({
      kind: 'cmd',
      cmd: this._command,
      verbose: $.verbose && !this._quiet,
    })
    const command = $.prefix + this._command
    this.child = $.spawn(
      [typeof $.shell === 'string' ? $.shell : 'bash', '-c', command],
      {
        cwd: $.cwd ?? $[processCwd],
        shell: typeof $.shell === 'string' ? $.shell : true,
        stdio: this._stdio,
        windowsHide: true,
        env: $.env,
      }
    )

    this.child.exited.then(() => {
      const { exitCode: code, signalCode: signal } = this.child!
      const decoder = new TextDecoder()
      const stdoutString = decoder.decode(typedArrayConcat(Uint8Array, stdout))
      const stderrString = decoder.decode(typedArrayConcat(Uint8Array, stderr))
      const combinedString = decoder.decode(
        typedArrayConcat(Uint8Array, combined)
      )
      let message = `exit code: ${code}`
      if (code != 0 || signal != null) {
        message = `${stderrString || '\n'}    at ${this._from}`
        message += `\n    exit code: ${code}${
          exitCodeInfo(code) ? ' (' + exitCodeInfo(code) + ')' : ''
        }`
        if (signal != null) {
          message += `\n    signal: ${signal}`
        }
      }
      let output = new ProcessOutput(
        code,
        signal,
        stdoutString,
        stderrString,
        combinedString,
        message
      )
      if (code === 0 || this._nothrow) {
        this._resolve(output)
      } else {
        this._reject(output)
      }
      this._resolved = true
    })
    // TODO: what's the Bun equivalent?
    // this.child.on('error', (err: NodeJS.ErrnoException) => {
    //   const message =
    //     `${err.message}\n` +
    //     `    errno: ${err.errno} (${errnoMessage(err.errno)})\n` +
    //     `    code: ${err.code}\n` +
    //     `    at ${this._from}`
    //   this._reject(
    //     new ProcessOutput(null, null, stdout, stderr, combined, message)
    //   )
    //   this._resolved = true
    // })
    let stdout: Uint8Array[] = [],
      stderr: Uint8Array[] = [],
      combined: Uint8Array[] = []
    let onStdout = (data: Uint8Array) => {
      $.log({ kind: 'stdout', data, verbose: $.verbose && !this._quiet })
      stdout.push(data)
      combined.push(data)
    }
    let onStderr = (data: any) => {
      $.log({ kind: 'stderr', data, verbose: $.verbose && !this._quiet })
      stderr.push(data)
      combined.push(data)
    }
    if (
      !this._piped && // If process is piped, don't collect or print output.
      this.child.stdout &&
      typeof this.child.stdout !== 'number'
    )
      onData(this.child.stdout, onStdout)
    if (this.child.stderr && typeof this.child.stderr !== 'number')
      onData(this.child.stderr, onStderr) // Stderr should be printed regardless of piping.
    this._postrun() // In case $1.pipe($2), after both subprocesses are running, we can pipe $1.stdout to $2.stdin.
    if (this._timeout && this._timeoutSignal) {
      const t = setTimeout(() => this.kill(this._timeoutSignal), this._timeout)
      this.finally(() => clearTimeout(t)).catch(noop)
    }
    return this
  }

  get stdin(): FileSink {
    this.stdio('pipe')
    this.run()
    assert(this.child)
    if (this.child.stdin == null)
      throw new Error('The stdin of subprocess is null.')
    if (typeof this.child.stdin === 'number')
      throw new Error('The stdin of subprocess is number.')
    return this.child.stdin
  }

  get stdout(): ReadableStream<Uint8Array> {
    this.run()
    assert(this.child)
    if (this.child.stdout == null)
      throw new Error('The stdout of subprocess is null.')
    if (typeof this.child.stdout === 'number')
      throw new Error('The stdout of subprocess is number.')
    return this.child.stdout
  }

  get stderr(): ReadableStream<Uint8Array> {
    this.run()
    assert(this.child)
    if (this.child.stderr == null)
      throw new Error('The stderr of subprocess is null.')
    if (typeof this.child.stderr === 'number')
      throw new Error('The stderr of subprocess is number.')
    return this.child.stderr
  }

  get exitCode(): Promise<number | null> {
    return this.then(
      (p) => p.exitCode,
      (p) => p.exitCode
    )
  }

  then<R = ProcessOutput, E = ProcessOutput>(
    onfulfilled?:
      | ((value: ProcessOutput) => PromiseLike<R> | R)
      | undefined
      | null,
    onrejected?:
      | ((reason: ProcessOutput) => PromiseLike<E> | E)
      | undefined
      | null
  ): Promise<R | E> {
    if (this.isHalted && !this.child) {
      throw new Error('The process is halted!')
    }
    return super.then(onfulfilled, onrejected)
  }

  catch<T = ProcessOutput>(
    onrejected?:
      | ((reason: ProcessOutput) => PromiseLike<T> | T)
      | undefined
      | null
  ): Promise<ProcessOutput | T> {
    return super.catch(onrejected)
  }

  pipe(dest: FileSink | ProcessPromise): ProcessPromise {
    if (typeof dest == 'string')
      throw new Error('The pipe() method does not take strings. Forgot $?')
    if (this._resolved) {
      if (dest instanceof ProcessPromise) dest.stdin.end() // In case of piped stdin, we may want to close stdin of dest as well.
      throw new Error(
        "The pipe() method shouldn't be called after promise is already resolved!"
      )
    }
    this._piped = true
    if (dest instanceof ProcessPromise) {
      dest.stdio('pipe')
      dest._prerun = this.run.bind(this)
      dest._postrun = () => {
        if (!dest.child)
          throw new Error(
            'Access to stdin of pipe destination without creation a subprocess.'
          )
        pipeReadableStreamToFileSink(this.stdout, dest.stdin)
      }
      return dest
    } else {
      this._postrun = () => pipeReadableStreamToFileSink(this.stdout, dest)
      return this
    }
  }

  async kill(signal = 'SIGTERM'): Promise<void> {
    if (!this.child)
      throw new Error('Trying to kill a process without creating one.')
    if (!this.child.pid) throw new Error('The process pid is undefined.')
    let children = await psTree(this.child.pid)
    for (const p of children) {
      try {
        process.kill(+p.PID, signal)
      } catch (e) {}
    }
    try {
      process.kill(this.child.pid, signal)
    } catch (e) {}
  }

  stdio(
    stdin: WritableIO,
    stdout: ReadableIO = 'pipe',
    stderr: ReadableIO = 'pipe'
  ): ProcessPromise {
    this._stdio = [stdin, stdout, stderr]
    return this
  }

  nothrow(): ProcessPromise {
    this._nothrow = true
    return this
  }

  quiet(): ProcessPromise {
    this._quiet = true
    return this
  }

  timeout(d: Duration, signal = 'SIGTERM'): ProcessPromise {
    this._timeout = parseDuration(d)
    this._timeoutSignal = signal
    return this
  }

  halt(): ProcessPromise {
    this._halted = true
    return this
  }

  get isHalted(): boolean {
    return this._halted
  }
}

export class ProcessOutput extends Error {
  private readonly _code: number | null
  private readonly _signal: NodeJS.Signals | null
  private readonly _stdout: string
  private readonly _stderr: string
  private readonly _combined: string

  constructor(
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    combined: string,
    message: string
  ) {
    super(message)
    this._code = code
    this._signal = signal
    this._stdout = stdout
    this._stderr = stderr
    this._combined = combined
  }

  toString() {
    return this._combined
  }

  get stdout() {
    return this._stdout
  }

  get stderr() {
    return this._stderr
  }

  get exitCode() {
    return this._code
  }

  get signal() {
    return this._signal
  }

  [inspect.custom]() {
    let stringify = (s: string, c: ChalkInstance) =>
      s.length === 0 ? "''" : c(inspect(s))
    return `ProcessOutput {
  stdout: ${stringify(this.stdout, chalk.green)},
  stderr: ${stringify(this.stderr, chalk.red)},
  signal: ${inspect(this.signal)},
  exitCode: ${(this.exitCode === 0 ? chalk.green : chalk.red)(this.exitCode)}${
      exitCodeInfo(this.exitCode)
        ? chalk.grey(' (' + exitCodeInfo(this.exitCode) + ')')
        : ''
    }
}`
  }
}

export function within<R>(callback: () => R): R {
  return storage.run({ ...getStore() }, callback)
}

function syncCwd() {
  if ($[processCwd] != process.cwd()) process.chdir($[processCwd])
}

export function cd(dir: string | ProcessOutput) {
  if (dir instanceof ProcessOutput) {
    dir = dir.toString().replace(/\n+$/, '')
  }

  $.log({ kind: 'cd', dir })
  process.chdir(dir)
  $[processCwd] = process.cwd()
}

export type LogEntry =
  | {
      kind: 'cmd'
      verbose: boolean
      cmd: string
    }
  | {
      kind: 'stdout' | 'stderr'
      verbose: boolean
      data: Uint8Array
    }
  | {
      kind: 'cd'
      dir: string
    }
  | {
      kind: 'fetch'
      url: string
      init?: RequestInit
    }
  | {
      kind: 'retry'
      error: string
    }
  | {
      kind: 'custom'
      data: any
    }

export function log(entry: LogEntry) {
  switch (entry.kind) {
    case 'cmd':
      if (!entry.verbose) return
      process.stderr.write(formatCmd(entry.cmd))
      break
    case 'stdout':
    case 'stderr':
      if (!entry.verbose) return
      Bun.write(Bun.stderr, entry.data)
      break
    case 'cd':
      if (!$.verbose) return
      process.stderr.write('$ ' + chalk.greenBright('cd') + ` ${entry.dir}\n`)
      break
    case 'fetch':
      if (!$.verbose) return
      const init = entry.init ? ' ' + inspect(entry.init) : ''
      process.stderr.write(
        '$ ' + chalk.greenBright('fetch') + ` ${entry.url}${init}\n`
      )
      break
    case 'retry':
      if (!$.verbose) return
      process.stderr.write(entry.error + '\n')
  }
}
