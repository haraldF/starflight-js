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
npm run inspect -- primitives
npm run inspect -- disasm 0x17b7 --bytes 64 --count 8
npm run inspect -- dump 0x07e4 --bytes 16
npm run inspect -- dump 0xe2c0 --module MUSIC --bytes 32
npm run inspect -- disasm 0x0487 --segment 0x76d6 --steps 200000 --keys '5{Enter}'
npm run --silent inspect -- boot --steps 4721122 --keys '5{Enter}' --page 0xa200 | head -n 53
npm run inspect -- code 0x17b7
npm run inspect -- word 0x0937 --module KERNEL
npm run inspect -- boot --steps 50000
npm run inspect -- boot --entry 0x0937 --steps 100
npm run inspect -- boot --steps 500000 --keys '5{Enter}'
npm run inspect -- boot --steps 6000000 --keys '5{Enter}' --key-at '4800000:{ArrowRight}'
```

- `word` prints the word's module, CFA, PFA, code pointer, type, and decompiled
  definition. Names are case-insensitive; CFA queries require a `0x` prefix.
- `callers` looks up the target in the selected module and prints direct callers
  across all modules. Indirect calls through `EXECUTE` are not included.
- `disasm` decodes raw bytes as 16-bit x86 using Capstone. Supply a runtime
  address, not a file offset or CFA: the COM image starts at `0x100`, and an
  overlay (`--module`) sits at its load address. For a native word, inspect its
  code pointer with `word` first. Addresses accept decimal or `0x`-prefixed
  integers; the output includes addresses and bytes. `--bytes` defaults to 128
  and `--count` to 32 instructions. Decoding is bounded by the image or overlay
  and the 64K segment, but does not follow jumps or distinguish instructions
  from data.
- `dump` prints raw bytes from a runtime address as hex, little-endian 16-bit
  words, and ASCII, 16 bytes per row: the kernel image, or with `--module` an
  overlay at its load address (an error names the valid range). `--bytes`
  defaults to 64. It shows the images from the game files, not memory changed
  during a boot run. Use it instead of `xxd` or ad hoc Node scripts.
- `dump` and `disasm` with `--segment <seg>` read **runtime** memory instead:
  they run the boot first (with `--steps`, `--keys`, `--cga`, `--entry`) and
  then read `seg:address` as the run left it. Use it for code the game loads
  or patches at run time, such as the EGA driver at `REMSEG` (`0x76d6`),
  reached through far-call stubs like `0x9125` (`call far 76d6:04fb`).
- In EGA mode `boot` prints a thumbnail of the visible page (one hex color per
  4x4 block) instead of the text screen; `--page <seg>` shows another page,
  such as the hidden page `0xa200`. `--crop <x,y,w,h>` (screen pixels from the
  top left) prints just that rectangle at one hex digit per 2x1 pixels, which
  is enough to see sprites such as the starport crew member.
- `code` lists every word whose code pointer equals the given address, for
  example all user-vectored words sharing code `0x17b7`. `--module` filters it.
- `--module` defaults to `KERNEL`; it selects the lookup module for `word`,
  `callers`, and `code`, and the overlay image for `dump` and `disasm`. Module
  names are case-sensitive and follow the disk directory (`GAME-OV`, `MUSIC`).
- Code `0x17b7` words (`EMIT`, `KEY_1`, `DISKERROR?`, ...) are user vectors: the
  PFA holds an offset into the user area at `0x078c`, and that cell holds the
  PFA to execute. The runner follows the vector unless it emulates the word
  directly (`R/W` only); `WORD`, `CR`, `TYPE`, and `EMIT` run the game's own
  `(WORD)`, `(CR)`, `(TYPE)`, and `(EMIT)`.
- Text output is real video memory: `(TYPE)`/`(EMIT)` write char/attribute
  cells to the segment in `VIDEOMEM` (`0xB800`) through `V!`/`>VMOVE`, and
  `(POSITION)`, `SCROLLUP`, and mode sets update the BIOS cursor and buffer.
  `(.")` prints through the `TYPE` vector. `boot` prints the 80x25 screen (CP437
  mapped to Unicode) before the trace; the result's `screen` holds the cells, and
  the Game tab draws them on the canvas at 640x200.
- Overlay words run once `LOAD-OVERLAY` has loaded their overlay: `OV#`
  (`0x55a5`) holds the overlay's VSA, its start paragraph in the disk
  directory (`ForthEngine.overlays`). Kernel OVERLAY word names don't always
  match module names (`MUSIC-OV` loads `MUSIC`). Calls resolve to the caller's
  module first, then the loaded overlay, then the kernel; a word from any other
  overlay stops the run.
- `EXIT` pops the return stack and resumes at that address, as on the 8086, so
  words that rewrite it (`R> DROP`, `UNRAVEL`, inline-string skips) work; the
  trace notes `return to 0x… in WORD, unwinding N frame(s)` when that happens.
- A code pointer starting with `e8` (`call 0x1649`, DODOES) marks a DOES> word,
  such as the `FILE-*` fields on `0x7227`. The runner pushes the PFA and runs the
  threaded body after the call; read it with `dump <codep+3>` and `word <cell>`.
- CFAs missing from the dictionary are inferred from their code field in
  runtime memory, in the kernel or the loaded overlay: constants, variables,
  user variables, headerless CODE (`codep == PFA`), DOES> children (code field
  calls `0x1649`), and colon definitions (`0x224c`, decoded from memory once
  per run). Both the decompiler and the runner keep decoding past an EXIT that
  a forward branch jumps over (`IF ... EXIT THEN ...`).
  Headerless CODE runs through the code-pointer cases in `executePrimitive`.
  Inspect a failure with `disasm <PFA>`, then add a direct TypeScript handler;
  there is no x86 interpreter or native-execution fallback. Keep an inline word
  name and stack-effect comment on each new case. `GO` handles DOS return, the
  known COM bootstrap, and translated primitive entry points. Arbitrary `GO`
  targets and unrecognized `(>CODE)` blocks stop explicitly.
- `primitives` lists dictionary entries without recognized handlers. Unresolved raw dictionary metadata is
  listed separately, not counted as verified machine code. This is a static
  inventory, not a guarantee that every input or device service is supported.
- The data stack lives in emulated memory, as on the 8086: it grows down from the
  address in user cell `SP0` (`0x078c`, initially `0xf6f4`), `SP@` pushes the
  address of the top cell, and `SP!` resets to `SP0`. Words such as `PICK`
  (`SP@ + @`) and `DEPTH` therefore work unchanged. The return stack has an
  array-compatible interface backed by RAM below `RP0` (`0x078e`, initially
  `0xf7d0`), so `RP@`, translated primitives, and stores through return-stack addresses
  observe the same cells. Checkpoints serialize its values as an ordinary array.
- `boot` runs `ForthBootRunner`, printing output, the execution trace, and the
  stop reason. Its defaults are kernel entry CFA `0x0937` and 50,000 steps.
  `--entry` and `--steps` accept decimal or `0x`-prefixed integers.
- `ForthBootRunner.run()` is `start()` + `advance(maxSteps)` + `snapshot()`.
  A live caller uses those directly: `advance(n)` executes up to `n` steps and
  returns `running`, `waiting` (in `(KEY)`, which retries after `pressKey()`),
  or `stopped`. The Game tab plays the boot in real time this way, advancing
  the runner's `stepsPerMillisecond` steps per elapsed millisecond each
  animation frame, so intro pictures stay up as long as on the PC and keys go
  straight to the running machine (a key also skips the intro waits, as in the
  game). Its CPU selector picks that rate: PC/XT 4.77 MHz (50), AT 8 MHz (170,
  the default) or 386 16 MHz (400).
- `setBreakpoint(module, cfa)` makes `advance()` return `break` just before a
  call to that word; the next `advance()` makes the call. `run()` passes
  breakpoints. The Game tab's "Skip intro" option uses one on `GAME-OV`
  `0xf525` (`?GAME.IN.PROGRESS`, called by `START.` right after the police
  screen): it runs unpaced until then, then switches to real time.
- The trace keeps only the last 1,024 lines (a ring buffer; the runner reports
  how many earlier lines it dropped), so multi-million-step runs stay fast.
  Pass `--trace-lines all` (or a number) to `boot` to keep more, e.g. to grep a
  whole run. The runner's own default step limit, used by the Game tab, is
  5,000,000.
- EGA graphics (mode 0Dh, 320x200x16) is modelled in `src/ega.ts`: four 64K
  planes, the sequencer Map Mask, the graphics-controller registers (port
  writes via `EgaAdapter.out`), latches, read modes 0/1, and write modes 0-2.
  While mode 0Dh is set, far byte/word accesses to `A000:0000-FFFF` go through
  it instead of plain RAM. `>LORES` enters it on EGA; its CGA and Hercules
  paths stop the run. In mode 0Dh the result's `graphics` holds the 320x200
  color indices of the page at `A000:0000` (the CRTC start address is not
  modelled), and the Game tab draws it with the default 16-color palette.
- The BIOS timer interrupt is emulated from game time: every 65536/1193182 s
  the runner delivers INT 1Ch. The kernel's clock handler (`0192:018E`) is a
  no-op here (`TIME` already follows the steps); the MUSIC overlay's player,
  which `HIMUS` copies to `MUSSEG:00FF`, runs as a TypeScript translation. Any
  other INT 1Ch handler stops the run. `TONE`, `BEEPON`/`BEEPOFF`, `P!` to
  ports 42h/43h/61h, and the player report speaker changes as timed
  `SpeakerEvent`s (`takeSpeakerEvents()`), which the Game tab plays as a Web
  Audio square wave (the Sound checkbox; the intro music needs Skip intro off).
- `--keys` types ahead for `boot`: each character types itself, and `{Name}`
  types a named key using `KeyboardEvent.key` names (`{Enter}`, `{Escape}`,
  `{ArrowUp}`, `{F1}`, ...). `(KEY)` and `(?TERMINAL)` read this queue as BIOS
  INT 16h words; when `(KEY)` finds it empty the run stops with "Waiting for a
  key". The boot reaches the display-mode menu after about 117,000 steps, so use
  a larger `--steps` than the default. The Game tab replays the boot with every
  key typed on the focused canvas since the last Run.
- Time is emulated deterministically from the step count:
  `STEPS_PER_MILLISECOND` (50) steps per millisecond by default, or the
  `stepsPerMillisecond` runner option. `setStepsPerMillisecond()` changes the
  rate mid-run and `TIME` continues from where it was (the session's `clock`
  keeps the base, so checkpoints load at any rate). `TIME` returns `0x188`,
  a double millisecond counter (high cell at `0x188`, low at `0x18a`). The
  intro's timed waits mean that with `--keys '5{Enter}'` boot needs about 4.7
  million steps, so pass a large `--steps` and pipe through `tail`.
- `--key-at <step>:<keys>` (repeatable) presses keys once the run reaches that
  step, or earlier if `(KEY)` is already waiting, so input during play can be
  reproduced deterministically (`--keys` types everything ahead, which skips
  the intro waits). With `5{Enter}`, the starport polls the keyboard from about
  step 4,705,000; `run()` takes the same list as `timedKeys`.
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
DOS FCB random reads and writes (INT 21h AH=21h/22h) use the same private
images, picked by the FCB name (`STARA`/`STARB`); a write past the end extends
the private copy.

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