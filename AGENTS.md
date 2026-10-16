# Inspection CLI

Use the existing TypeScript inspection CLI for Forth investigations instead of
long inline Node scripts. Run commands from the repository root. No browser or
development server is required.

## Requirements

- Install dependencies with `npm install` when needed.
- Use Node with native TypeScript support (verified with Node 26).
- Keep tooling in TypeScript. The package uses `"type": "module"`; use explicit
  `.ts` extensions for local imports executed by Node. Do not add a JavaScript
  wrapper, transpilation step, or TypeScript runtime loader.
- The CLI reads `public/STARA.COM`, `public/STARB.COM`, `public/STARFLT.COM`, and
  `public/forth-dict.json`, not the binary copies in the repository root.

## Commands

```sh
npm run inspect -- --help
npm run inspect -- word 'R/W'
npm run inspect -- word 0x06db
npm run inspect -- callers 'R/W'
npm run inspect -- disasm 0x17b7 --bytes 64 --count 8
npm run inspect -- dump 0x07e4 --bytes 16
npm run inspect -- code 0x17b7
npm run inspect -- word 0x0937 --module KERNEL
npm run inspect -- boot --steps 50000
npm run inspect -- boot --entry 0x0937 --steps 100
```

- `word` prints the word's module, CFA, PFA, code pointer, type, and decompiled
  definition. Names are case-insensitive; CFA queries require a `0x` prefix.
- `callers` looks up the target in the selected module and prints direct callers
  across all modules. Indirect calls through `EXECUTE` are not included.
- `disasm` decodes raw kernel bytes as 16-bit x86 using Capstone. Supply a
  runtime address, not a file offset or CFA: the COM image starts at `0x100`.
  For a native word, inspect its code pointer with `word` first. Addresses accept
  decimal or `0x`-prefixed integers; the output includes addresses and bytes.
  `--bytes` defaults to 128 and `--count` to 32 instructions. Decoding is bounded
  by the image and the 64K segment, but does not follow jumps or distinguish
  instructions from data. Overlay disassembly is not supported.
- `dump` prints raw kernel image bytes from a runtime address as hex,
  little-endian 16-bit words, and ASCII, 16 bytes per row. `--bytes` defaults
  to 64. It shows the initial image, not memory changed during a boot run. Use it
  instead of `xxd` or ad hoc Node scripts.
- `code` lists every word whose code pointer equals the given address, for
  example all user-vectored words sharing code `0x17b7`. `--module` filters it.
- `--module` defaults to `KERNEL` and applies only to `word`, `callers`, and
  `code`. Module names are case-sensitive.
- Code `0x17b7` words (`EMIT`, `KEY_1`, `DISKERROR?`, ...) are user vectors: the
  PFA holds an offset into the user area at `0x078c`, and that cell holds the
  PFA to execute. The runner follows the vector unless it emulates the word
  directly (`CR`, `R/W`, `TYPE`). `WORD` runs the game's own `(WORD)`.
- Overlay words run once `LOAD-OVERLAY` has loaded their overlay: `OV#`
  (`0x55a5`) holds the overlay's VSA, which matches the PFA cell of the kernel
  word named after the overlay (e.g. `GAME-OV`). Calls resolve to the caller's
  module first, then the loaded overlay, then the kernel; a word from any other
  overlay stops the run.
- `EXIT` pops the return stack and resumes at that address, as on the 8086, so
  words that rewrite it (`R> DROP`, `UNRAVEL`, inline-string skips) work; the
  trace notes `return to 0x… in WORD, unwinding N frame(s)` when that happens.
- A code pointer starting with `e8` (`call 0x1649`, DODOES) marks a DOES> word,
  such as the `FILE-*` fields on `0x7227`. The runner pushes the PFA and runs the
  threaded body after the call; read it with `dump <codep+3>` and `word <cell>`.
- Kernel CFAs missing from the dictionary are inferred from their code field:
  constants, variables, user variables, and headerless CODE (`codep == PFA`).
  Headerless CODE runs through the code-pointer cases in `executePrimitive`, so
  implement one there after checking it with `disasm <PFA>`.
- The data stack lives in emulated memory, as on the 8086: it grows down from the
  address in user cell `SP0` (`0x078c`, initially `0xf6f4`), `SP@` pushes the
  address of the top cell, and `SP!` resets to `SP0`. Words such as `PICK`
  (`SP@ + @`) and `DEPTH` therefore work unchanged. The return stack is still a
  JS array, so `RP@` is not supported yet.
- `boot` runs `ForthBootRunner`, printing output, the execution trace, and the
  stop reason. Its defaults are kernel entry CFA `0x0937` and 50,000 steps.
  `--entry` and `--steps` accept decimal or `0x`-prefixed integers.
- The runner presets `?EGA` (`0x5da3`) to 1, as if EGA had been chosen in the
  `GAME-OV` display menu; the shipped image starts with 0 (CGA). Pass `--cga` to
  `boot` (or `{ ega: false }` to `ForthBootRunner`) to keep the image default.

## Repeated Investigations

Start with a bounded boot run, inspect the stopped word, then inspect its
callers. After changing the runner, repeat the same command and compare the
stop reason and trace. Each invocation reloads the images and creates a fresh
engine and runner; no emulated state is persisted or game files modified.

The memory-backed `R/W` handler transfers 1,024-byte blocks using the game's
mounted logical bases: STARA starts at block 1500, STARB at block 720. Writes
modify private images that reset on each run, not the explorer's images or files.

For just the end of a long trace, suppress npm's banner and filter the output:

```sh
npm run --silent inspect -- boot --steps 50000 | tail -n 20
```

A successful CLI exit does not mean boot completed: unsupported primitives,
stack errors, and the step limit are reported in the final `STOP` line. Invalid
CLI arguments and loading failures exit nonzero.

## Verification

After changing the CLI, run the relevant commands above against the real game
images. Check its types separately because the app's TypeScript configuration
includes only `src`:

```sh
npm run typecheck-cli
npm run test-boot
npm run build
```