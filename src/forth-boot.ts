import {
  CFA_0BRANCH,
  CFA_BRANCH,
  CFA_EXIT1,
  CFA_EXIT2,
  CODE_CALL,
  CODE_CONSTANT,
  CODE_SIGFLD,
  CODE_TABLE,
  CODE_USER,
  CODE_VARIABLE,
  type ForthEngine,
  type ForthToken,
  type ForthWord
} from './forth-decompiler.ts';

interface CallFrame {
  word: ForthWord;
  tokenIndex: number;
  returnStackBase?: number;
}

interface LoopFrame {
  frame: CallFrame;
  index: number;
  limit: number;
  returnStackBase: number;
}

function toSignedCell(value: number): number {
  return (value << 16) >> 16;
}

export interface ForthBootResult {
  steps: number;
  trace: string[];
  output: string;
  stopReason: string;
}

export class ForthBootRunner {
  private engine: ForthEngine;
  private initialMemory: Uint8Array;
  private memory: Uint8Array;
  private initialPhysicalMemory: Uint8Array;
  private physicalMemory: Uint8Array;
  private dtaSegment = 0;
  private dtaOffset = 0;

  constructor(engine: ForthEngine, starflt: Uint8Array) {
    this.engine = engine;
    this.memory = new Uint8Array(0x10000);
    this.memory.set(starflt.subarray(0, 0x10000 - 0x100), 0x100);
    this.initialMemory = this.memory.slice();
    this.physicalMemory = new Uint8Array(0x100000);
    const comPhysicalStart = (0x0192 << 4) + 0x0100;
    this.physicalMemory.set(starflt.subarray(0, Math.min(starflt.length, this.physicalMemory.length - comPhysicalStart)), comPhysicalStart);
    this.initialPhysicalMemory = this.physicalMemory.slice();
  }

  run(entryCfa = 0x0937, maxSteps = 50000): ForthBootResult {
    this.memory = this.initialMemory.slice();
    this.physicalMemory = this.initialPhysicalMemory.slice();
    this.dtaSegment = 0;
    this.dtaOffset = 0;
    const entry = this.engine.get(entryCfa, 'KERNEL');
    if (!entry) {
      const stopReason = `No kernel word at CFA 0x${entryCfa.toString(16)}.`;
      return { steps: 0, trace: [`STOP: ${stopReason}`], output: '', stopReason };
    }

    const dataStack: number[] = [];
    const returnStack: number[] = [];
    const frames: CallFrame[] = [{ word: entry, tokenIndex: 0 }];
    const loops: LoopFrame[] = [];
    const trace: string[] = [];
    let output = '';
    let steps = 0;
    let stopReason = 'Forth returned from the entry word.';

    const pop = (stack: number[], label: string): number => {
      const value = stack.pop();
      if (value === undefined) throw new Error(`${label} stack underflow`);
      return value;
    };
    const push = (stack: number[], value: number) => stack.push(value & 0xffff);
    const readWord = (address: number) => this.memory[address & 0xffff] | (this.memory[(address + 1) & 0xffff] << 8);
    const writeWord = (address: number, value: number) => {
      this.memory[address & 0xffff] = value & 0xff;
      this.memory[(address + 1) & 0xffff] = (value >>> 8) & 0xff;
    };
    const readFarWord = (segment: number, offset: number) => {
      const address = (((segment & 0xffff) << 4) + (offset & 0xffff)) & 0xfffff;
      return this.physicalMemory[address] | (this.physicalMemory[(address + 1) & 0xfffff] << 8);
    };
    const writeFarWord = (segment: number, offset: number, value: number) => {
      const address = (((segment & 0xffff) << 4) + (offset & 0xffff)) & 0xfffff;
      this.physicalMemory[address] = value & 0xff;
      this.physicalMemory[(address + 1) & 0xfffff] = (value >>> 8) & 0xff;
    };

    try {
      while (frames.length > 0 && steps < maxSteps) {
        const frame = frames[frames.length - 1];
        const token = frame.word.tokens[frame.tokenIndex++];
        if (!token) {
          stopReason = `No EXIT token in ${frame.word.name}@${frame.word.module}.`;
          break;
        }
        steps++;

        if (token.kind === 'lit') {
          push(dataStack, Number(token.arg ?? 0));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, 'literal'));
          continue;
        }

        if (token.kind === 'exit' || token.cfa === CFA_EXIT1 || token.cfa === CFA_EXIT2) {
          if (frame.returnStackBase !== undefined) {
            if (returnStack.length <= frame.returnStackBase) {
              throw new RangeError(`return stack underflow returning from ${frame.word.name}`);
            }
            returnStack.pop();
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, 'return'));
          frames.pop();
          continue;
        }

        if (token.kind === 'branch' || token.cfa === CFA_0BRANCH || token.cfa === CFA_BRANCH) {
          const shouldBranch = token.cfa === CFA_BRANCH || (token.cfa === CFA_0BRANCH && pop(dataStack, 'data') === 0);
          if (shouldBranch) {
            const targetIndex = frame.word.tokens.findIndex(candidate => candidate.addr === token.arg);
            if (targetIndex < 0) {
              stopReason = `Branch target 0x${Number(token.arg).toString(16)} is not in ${frame.word.name}.`;
              break;
            }
            frame.tokenIndex = targetIndex;
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, shouldBranch ? 'branch' : 'fall through'));
          continue;
        }

        if (token.kind !== 'call') {
          stopReason = `Unsupported token kind '${token.kind}' in ${frame.word.name}.`;
          break;
        }

        const inlineString = token.name.match(/^(.*?) "([\s\S]*)"$/);
        if (inlineString && (inlineString[1] === '(.\")' || inlineString[1] === '(ABORT\")')) {
          output += inlineString[2];
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, 'inline string'));
          continue;
        }

        const candidates = this.engine.wordsByCfa.get(token.cfa) ?? [];
        let target = candidates.find(word => word.module === frame.word.module)
          ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!target && frame.word.module === 'KERNEL') {
          const codep = readWord(token.cfa);
          const type = codep === CODE_CONSTANT ? 'constant' : codep === CODE_VARIABLE ? 'variable' : codep === CODE_USER ? 'user' : undefined;
          if (type || codep === 0x3672) {
            const pfa = (token.cfa + 2) & 0xffff;
            target = {
              name: token.name,
              cfa: token.cfa,
              cfaHex: token.cfaHex,
              pfa,
              pfaHex: `0x${pfa.toString(16).padStart(4, '0')}`,
              codep,
              codepHex: `0x${codep.toString(16).padStart(4, '0')}`,
              module: 'KERNEL',
              type: type ?? 'primitive',
              typeLabel: type ? `${type} inferred from code field` : 'OFFSET primitive inferred from code field',
              decompiled: type ? `${type.toUpperCase()} ${token.name}` : `OFFSET ${token.name}`,
              tokens: [],
              rawBytes: this.memory.subarray(token.cfa, Math.min(token.cfa + 32, this.memory.length))
            };
          }
        }
        if (!target) {
          stopReason = `Unresolved call ${token.name} at CFA ${token.cfaHex} in ${frame.word.module}.`;
          break;
        }

        if (target.module !== 'KERNEL') {
          stopReason = `Overlay ${target.module} is not loaded in this boot harness.`;
          break;
        }

        if (target.codep === CODE_TABLE) {
          const tableIndex = pop(dataStack, 'data');
          const entryAddress = target.pfa + tableIndex * 2;
          if (entryAddress < 0 || entryAddress + 1 >= this.memory.length) {
            stopReason = `Table index ${tableIndex} is outside ${target.name} at PFA ${target.pfaHex}.`;
            break;
          }
          const entry = readWord(entryAddress);
          push(dataStack, entry);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${target.name}[${tableIndex}] = 0x${entry.toString(16).padStart(4, '0')}`));
          continue;
        }

        if (target.codep === CODE_SIGFLD) {
          const helperNames = ['@', 'SIGBLK', 'BLOCK_2', '+'];
          const helperWords = helperNames.map(name => this.engine.get(name, 'KERNEL'));
          if (helperWords.some(word => !word)) {
            stopReason = `Cannot execute signature-field helper for ${target.name}: helper word is missing.`;
            break;
          }

          const helperTokens: ForthToken[] = helperWords.map((word, index) => ({
            addr: 0x6ec4 + index * 2,
            addrHex: `0x${(0x6ec4 + index * 2).toString(16)}`,
            cfa: word!.cfa,
            cfaHex: word!.cfaHex,
            name: word!.name,
            kind: 'call'
          }));
          helperTokens.push({ addr: 0x6ecc, addrHex: '0x6ecc', cfa: CFA_EXIT1, cfaHex: `0x${CFA_EXIT1.toString(16)}`, name: ';', kind: 'exit' });
          const helper: ForthWord = {
            ...target,
            name: `SIGFLD ${target.name}`,
            type: 'colon',
            typeLabel: 'CODESIGFLD helper',
            decompiled: ': SIGFLD  @ SIGBLK BLOCK_2 + ;',
            tokens: helperTokens
          };
          const returnStackBase = returnStack.length;
          push(dataStack, target.pfa);
          push(returnStack, this.getReturnAddress(frame, token));
          frames.push({ word: helper, tokenIndex: 0, returnStackBase });
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `SIGFLD descriptor ${target.name}`));
          continue;
        }

        if (target.type === 'constant') {
          push(dataStack, readWord(target.pfa));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `constant ${target.name}`));
          continue;
        }
        if (target.type === 'variable') {
          push(dataStack, target.pfa);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `address of ${target.name}`));
          continue;
        }
        if (target.type === 'user') {
          push(dataStack, 0x078c + readWord(target.pfa));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `user address ${target.name}`));
          continue;
        }

        if (target.name === '(DO)') {
          const start = pop(dataStack, 'data');
          const limit = pop(dataStack, 'data');
          if (start === limit) {
            const end = this.findMatchingLoop(frame.word.tokens, frame.tokenIndex);
            if (end < 0) {
              stopReason = `No matching LOOP in ${frame.word.name}.`;
              break;
            }
            frame.tokenIndex = end + 2;
          } else {
            const returnStackBase = returnStack.length;
            push(returnStack, limit);
            push(returnStack, start);
            loops.push({ frame, index: start, limit, returnStackBase });
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `DO ${start} to ${limit}`));
          continue;
        }

        if (target.name === '(LOOP)' || target.name === '(+LOOP)' || target.name === '(/LOOP)') {
          let loopIndex = loops.length - 1;
          while (loopIndex >= 0 && loops[loopIndex].frame !== frame) loopIndex--;
          const branchData = frame.word.tokens[frame.tokenIndex];
          if (loopIndex < 0 || !branchData) {
            stopReason = `LOOP without matching DO in ${frame.word.name}.`;
            break;
          }

          const step = target.name === '(LOOP)' ? 1 : pop(dataStack, 'data');
          const loop = loops[loopIndex];
          loop.index = (loop.index + step) & 0xffff;
          returnStack[loop.returnStackBase + 1] = loop.index;
          const relative = toSignedCell(branchData.cfa);
          const doAddress = (token.addr + relative) & 0xffff;
          const doTokenIndex = frame.word.tokens.findIndex(candidate => candidate.addr === doAddress);
          frame.tokenIndex++;
          if (doTokenIndex < 0) {
            stopReason = `LOOP target 0x${doAddress.toString(16)} is not in ${frame.word.name}.`;
            break;
          }

          const continues = loop.index !== loop.limit;
          if (continues) frame.tokenIndex = doTokenIndex + 1;
          else {
            loops.splice(loopIndex, 1);
            returnStack.length = loop.returnStackBase;
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, continues ? `loop index ${loop.index}` : 'loop complete'));
          continue;
        }

        if (target.name === 'I' || target.name === "I'" || target.name === 'J') {
          const depth = target.name === 'I' ? 0 : target.name === "I'" ? 1 : 2;
          const value = returnStack[returnStack.length - 1 - depth];
          if (value === undefined) {
            stopReason = `${target.name} used with no corresponding return-stack cell.`;
            break;
          }
          push(dataStack, value);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `return-stack cell ${value}`));
          continue;
        }

        if (target.name === 'EXECUTE' || target.name === '@EXECUTE') {
          const executionOperand = pop(dataStack, 'data');
          const executionPfa = target.name === '@EXECUTE' ? readWord(executionOperand) : executionOperand;
          const executionCfa = (executionPfa - 2) & 0xffff;
          const executionCandidates = this.engine.wordsByCfa.get(executionCfa) ?? [];
          const executionTarget = executionCandidates.find(word => word.module === frame.word.module)
            ?? (executionCandidates.length === 1 ? executionCandidates[0] : undefined);
          if (!executionTarget) {
            const codep = readWord(executionCfa);
            trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${target.name} PFA 0x${executionPfa.toString(16)} -> CFA 0x${executionCfa.toString(16)} (code pointer 0x${codep.toString(16)})`));
            stopReason = `${target.name} target PFA 0x${executionPfa.toString(16)} resolves to unindexed CFA 0x${executionCfa.toString(16)} (code pointer 0x${codep.toString(16)}).`;
            break;
          }
          if (executionTarget.type === 'constant') {
            push(dataStack, readWord(executionTarget.pfa));
          } else if (executionTarget.type === 'variable') {
            push(dataStack, executionTarget.pfa);
          } else if (executionTarget.type === 'user') {
            push(dataStack, 0x078c + readWord(executionTarget.pfa));
          } else if (executionTarget.codep === CODE_CALL) {
            trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${target.name} ${executionTarget.name}@${executionTarget.module}`));
            const returnStackBase = returnStack.length;
            push(returnStack, this.getReturnAddress(frame, token));
            frames.push({ word: executionTarget, tokenIndex: 0, returnStackBase });
            continue;
          } else {
            const handled = this.executePrimitive(executionTarget, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
            output = handled.output;
            if (!handled.supported) {
              stopReason = `${target.name} reached native primitive ${executionTarget.name} (code pointer ${executionTarget.codepHex}); no JS handler is implemented.`;
              break;
            }
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${target.name} ${executionTarget.name}@${executionTarget.module}`));
          continue;
        }

        if (target.codep === CODE_CALL) {
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `call ${target.name}`));
          const returnStackBase = returnStack.length;
          push(returnStack, this.getReturnAddress(frame, token));
          frames.push({ word: target, tokenIndex: 0, returnStackBase });
          continue;
        }

        const handled = this.executePrimitive(target, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
        output = handled.output;
        trace.push(this.formatTrace(steps, frame.word, token, dataStack, handled.note));
        if (!handled.supported) {
          stopReason = `Stopped at native primitive ${target.name} (code pointer ${target.codepHex}); no JS handler is implemented.`;
          break;
        }
      }

      if (steps >= maxSteps && frames.length > 0) stopReason = `Stopped after the ${maxSteps}-step safety limit.`;
    } catch (error) {
      stopReason = error instanceof Error ? error.message : String(error);
    }

    trace.push(`STOP after ${steps} steps: ${stopReason}`);
    return { steps, trace, output, stopReason };
  }

  private executePrimitive(
    word: ForthWord,
    dataStack: number[],
    returnStack: number[],
    output: string,
    push: (stack: number[], value: number) => number,
    pop: (stack: number[], label: string) => number,
    readWord: (address: number) => number,
    writeWord: (address: number, value: number) => void,
    readFarWord: (segment: number, offset: number) => number,
    writeFarWord: (segment: number, offset: number, value: number) => void
  ): { supported: boolean; note: string; output: string } {
    const name = word.name;

    const binary = (operation: (left: number, right: number) => number) => {
      const right = pop(dataStack, 'data');
      const left = pop(dataStack, 'data');
      push(dataStack, operation(left, right));
    };
    const unary = (operation: (value: number) => number) => {
      push(dataStack, operation(pop(dataStack, 'data')));
    };

    switch (word.codep) {
      case 0x3048: { // (BUFFER)
        const block = pop(dataStack, 'data');
        let segment = readWord(0x2c84); // PREV
        let hit = readFarWord(segment, 6) === block
          && this.readFarByte(segment, 3) === 0;

        if (!hit) {
          segment = readWord(0x2cbe); // USE
          if (readFarWord(segment, 6) === block && this.readFarByte(segment, 3) === 0) {
            hit = true;
            writeWord(0x2cbe, readWord(0x2c84));
            writeWord(0x2c84, segment);
          }
        }

        if (hit) {
          push(dataStack, segment);
          writeWord(0x2c6c, readWord(0x2c84)); // LPREV = PREV
        } else {
          push(dataStack, block);
        }
        push(dataStack, hit ? 1 : 0);
        return { supported: true, note: hit ? 'buffer cache hit' : 'buffer cache miss', output };
      }
      case 0x2ecd: { // LC@
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        push(dataStack, this.readFarByte(segment, offset));
        return { supported: true, note: 'read far byte', output };
      }
      case 0x2f51: { // LWSCAN
        const value = pop(dataStack, 'data');
        const count = pop(dataStack, 'data');
        if (count === 0) {
          pop(dataStack, 'data');
          pop(dataStack, 'data');
          push(dataStack, 0);
          return { supported: true, note: 'empty far-word search', output };
        }

        let offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) {
          if (readFarWord(segment, offset) === value) {
            push(dataStack, offset);
            push(dataStack, 1);
            return { supported: true, note: `far-word found at ${segment.toString(16)}:${offset.toString(16)}`, output };
          }
          offset = (offset + 2) & 0xffff;
        }
        push(dataStack, 0);
        return { supported: true, note: 'far-word not found', output };
      }
      case 0x4873: // ON
        writeWord(pop(dataStack, 'data'), 1);
        return { supported: true, note: 'native ON: set flag to one', output };
      case 0x4886: // OFF
        writeWord(pop(dataStack, 'data'), 0);
        return { supported: true, note: 'native OFF: clear flag', output };
      case 0x0d7c: { // SEG>ADDR
        const segment = pop(dataStack, 'data');
        push(dataStack, (segment - 0x0192) * 16);
        return { supported: true, note: 'convert segment to address relative to CS', output };
      }
      case 0x3672: // OFFSET
        push(dataStack, pop(dataStack, 'data') + readWord(0x2c79));
        return { supported: true, note: 'add DOS disk offset', output };
      case 0x0d10: { // CMOVE_2
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        const copy = new Uint8Array(count);
        for (let index = 0; index < count; index++) copy[index] = this.memory[(source + index) & 0xffff];
        for (let index = 0; index < count; index++) this.memory[(destination + index) & 0xffff] = copy[index];
        return { supported: true, note: `native CMOVE_2: copy ${count} bytes`, output };
      }
      case 0x0d35: { // FILL_2
        const value = pop(dataStack, 'data') & 0xff;
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) this.memory[(destination + index) & 0xffff] = value;
        return { supported: true, note: `native FILL_2: fill ${count} bytes`, output };
      }
      case 0x4da4: { // !OFFSET
        const descriptor = pop(dataStack, 'data');
        const multiplier = readWord(descriptor);
        let count = readWord(descriptor + 2);
        const baseOffset = readWord(descriptor + 4);
        const segment = readWord(descriptor + 6);
        let destination = (baseOffset + count * 2) & 0xffff;
        do {
          writeFarWord(segment, destination, multiplier * count);
          destination = (destination - 2) & 0xffff;
          count = (count - 1) & 0xffff;
        } while (count !== 0);
        writeFarWord(segment, destination, 0);
        return { supported: true, note: 'build 2D-array offset table', output };
      }
    }

    switch (name) {
      case '0':
        push(dataStack, 0);
        return { supported: true, note: 'push zero', output };
      case '1':
        push(dataStack, 1);
        return { supported: true, note: 'push one', output };
      case '2':
        push(dataStack, 2);
        return { supported: true, note: 'push two', output };
      case '@':
        push(dataStack, readWord(pop(dataStack, 'data')));
        return { supported: true, note: 'read word', output };
      case 'C@':
        push(dataStack, this.memory[pop(dataStack, 'data') & 0xffff]);
        return { supported: true, note: 'read byte', output };
      case 'CR':
        return { supported: true, note: 'newline', output: `${output}\n` };
      case 'TYPE': {
        const length = pop(dataStack, 'data');
        const address = pop(dataStack, 'data');
        const text = Array.from({ length }, (_, index) => String.fromCharCode(this.memory[(address + index) & 0xffff])).join('');
        return { supported: true, note: `write ${length} characters`, output: output + text };
      }
      case 'WORD': {
        const delimiter = pop(dataStack, 'data') & 0xff;
        const tibWord = this.engine.get('TIB', 'KERNEL');
        const inputIndexWord = this.engine.get('>IN', 'KERNEL');
        const dpWord = this.engine.get('DP', 'KERNEL');
        if (!tibWord || !inputIndexWord || !dpWord) {
          return { supported: false, note: 'WORD requires TIB, >IN, and DP user variables', output };
        }

        const tibAddress = readWord(0x078c + readWord(tibWord.pfa));
        const inputIndexAddress = 0x078c + readWord(inputIndexWord.pfa);
        let inputIndex = readWord(inputIndexAddress);
        let cursor = (tibAddress + inputIndex) & 0xffff;
        while (this.memory[cursor] === delimiter) {
          cursor = (cursor + 1) & 0xffff;
          inputIndex++;
        }

        const start = cursor;
        while (this.memory[cursor] !== 0 && this.memory[cursor] !== delimiter) {
          cursor = (cursor + 1) & 0xffff;
          inputIndex++;
        }
        const length = (cursor - start) & 0xffff;
        if (this.memory[cursor] === delimiter) inputIndex++;
        if (length > 255) throw new RangeError(`WORD input exceeds 255 bytes (${length})`);

        const here = readWord(0x078c + readWord(dpWord.pfa));
        this.memory[here] = length;
        for (let index = 0; index < length; index++) {
          this.memory[(here + 1 + index) & 0xffff] = this.memory[(start + index) & 0xffff];
        }
        writeWord(inputIndexAddress, inputIndex);
        push(dataStack, here);
        return { supported: true, note: `parsed ${length}-byte word from TIB`, output };
      }
      case '!': {
        const address = pop(dataStack, 'data');
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'write word', output };
      }
      case 'C!_2': {
        const address = pop(dataStack, 'data');
        this.memory[address & 0xffff] = pop(dataStack, 'data') & 0xff;
        return { supported: true, note: 'write byte', output };
      }
      case '?UPDATE': {
        const address = pop(dataStack, 'data');
        const signedAddress = toSignedCell(address);
        if (signedAddress >= 0) {
          if (signedAddress >= 0x63ef && signedAddress < 0x64fd) this.memory[0x63ee] = 0xff;
        } else {
          for (const bufferAddress of [0x54a1, 0x54a5]) {
            const buffer = readWord(bufferAddress);
            const start = (buffer + 7) & 0xffff;
            const end = (start + 0x401) & 0xffff;
            if (signedAddress > toSignedCell(start) && signedAddress < toSignedCell(end)) {
              this.memory[(buffer + 2) & 0xffff] = 0xff;
              break;
            }
          }
        }
        push(dataStack, address);
        return { supported: true, note: 'mark cache buffer dirty if address is cached', output };
      }
      case '2@': {
        const address = pop(dataStack, 'data');
        push(dataStack, readWord(address + 2));
        push(dataStack, readWord(address));
        return { supported: true, note: 'read double cell', output };
      }
      case 'L@': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        push(dataStack, readFarWord(segment, offset));
        return { supported: true, note: 'read far word', output };
      }
      case 'L!': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        writeFarWord(segment, offset, value);
        return { supported: true, note: 'write far word', output };
      }
      case 'LC!': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        const address = (((segment & 0xffff) << 4) + (offset & 0xffff)) & 0xfffff;
        this.physicalMemory[address] = value & 0xff;
        return { supported: true, note: 'write far byte', output };
      }
      case '2!_2': {
        const address = pop(dataStack, 'data');
        const first = pop(dataStack, 'data');
        const second = pop(dataStack, 'data');
        writeWord(address, first);
        writeWord(address + 2, second);
        return { supported: true, note: 'write double cell', output };
      }
      case 'U/MOD': {
        const divisor = pop(dataStack, 'data');
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        if (divisor === 0) throw new RangeError('Forth U/MOD division by zero');
        const dividend = low + high * 0x10000;
        push(dataStack, dividend % divisor);
        push(dataStack, Math.floor(dividend / divisor));
        return { supported: true, note: 'unsigned double-cell divide', output };
      }
      case '(!OLD)': {
        const vector = pop(dataStack, 'data');
        const address = (vector & 0xff) * 4;
        const offset = readFarWord(0, address);
        const segment = readFarWord(0, address + 2);
        push(dataStack, segment);
        push(dataStack, offset);
        return { supported: true, note: `read IVT vector 0x${(vector & 0xff).toString(16).padStart(2, '0')}`, output };
      }
      case '(!SET)': {
        const vector = pop(dataStack, 'data') & 0xff;
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const address = vector * 4;
        writeFarWord(0, address, offset);
        writeFarWord(0, address + 2, segment);
        return { supported: true, note: `write IVT vector 0x${vector.toString(16).padStart(2, '0')}`, output };
      }
      case 'OR':
        binary((left, right) => left | right);
        return { supported: true, note: 'bitwise OR', output };
      case 'NOT':
        unary(value => value === 0 ? 1 : 0);
        return { supported: true, note: 'logical not', output };
      case 'XOR':
        binary((left, right) => left ^ right);
        return { supported: true, note: 'bitwise XOR', output };
      case 'AND':
        binary((left, right) => left & right);
        return { supported: true, note: 'bitwise AND', output };
      case '+':
        binary((left, right) => left + right);
        return { supported: true, note: 'add', output };
      case '*':
        binary((left, right) => left * right);
        return { supported: true, note: 'multiply', output };
      case '-':
        binary((left, right) => left - right);
        return { supported: true, note: 'subtract', output };
      case '/':
        binary((left, right) => {
          const dividend = toSignedCell(left);
          const divisor = toSignedCell(right);
          if (divisor === 0) throw new RangeError('Forth division by zero');
          return Math.trunc(dividend / divisor);
        });
        return { supported: true, note: 'signed divide', output };
      case '0=':
        unary(value => value === 0 ? 1 : 0);
        return { supported: true, note: 'zero test', output };
      case '0<':
        unary(value => toSignedCell(value) < 0 ? 1 : 0);
        return { supported: true, note: 'signed negative test', output };
      case '=':
        binary((left, right) => left === right ? 1 : 0);
        return { supported: true, note: 'equality test', output };
      case 'U<':
        binary((left, right) => left < right ? 0xffff : 0);
        return { supported: true, note: 'unsigned less-than', output };
      case 'UMIN':
        binary((left, right) => Math.min(left, right));
        return { supported: true, note: 'unsigned minimum', output };
      case '<':
        binary((left, right) => toSignedCell(left) < toSignedCell(right) ? 1 : 0);
        return { supported: true, note: 'signed less-than', output };
      case '>':
        binary((left, right) => toSignedCell(left) > toSignedCell(right) ? 1 : 0);
        return { supported: true, note: 'signed greater-than', output };
      case '(CS?)':
      case '@DS':
        push(dataStack, 0x0192);
        return { supported: true, note: name === '(CS?)' ? 'push current code segment' : 'push current data segment', output };
      case 'ME':
        push(dataStack, 0x078c);
        return { supported: true, note: 'push OPERATOR user-area base', output };
      case 'ADDR>SEG':
        push(dataStack, (pop(dataStack, 'data') >>> 4) + 0x0192);
        return { supported: true, note: 'convert real-mode address to segment', output };
      case 'SET0/':
        writeFarWord(0, 0, 0x01d1);
        writeFarWord(0, 2, 0x0192);
        return { supported: true, note: 'install divide-by-zero IVT handler', output };
      case 'INTERRUPT': {
        const interrupt = pop(dataStack, 'data') & 0xff;
        const ax = readWord(0x16b6);
        if (interrupt === 0x10 && (ax >>> 8) === 0x0f) {
          writeWord(0x16b6, 0x0003);
          return { supported: true, note: 'BIOS INT 10h/AH=0Fh current video mode = 3', output };
        }
        if (interrupt === 0x11) {
          writeWord(0x16b6, 0xd426);
          return { supported: true, note: 'BIOS INT 11h equipment list = 0xd426', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x19) {
          writeWord(0x16b6, 0x0002);
          return { supported: true, note: 'DOS INT 21h/AH=19h default drive = 2', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x1a) {
          this.dtaOffset = readWord(0x16bc);
          this.dtaSegment = readWord(0x16c4);
          return { supported: true, note: `DOS INT 21h/AH=1Ah set DTA ${this.dtaSegment.toString(16)}:${this.dtaOffset.toString(16)}`, output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x11) {
          writeWord(0x16b6, 0);
          return { supported: true, note: 'DOS INT 21h/AH=11h FCB find-first: file found', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x0d) {
          return { supported: true, note: 'DOS INT 21h/AH=0Dh drive reset (no-op in reference emulator)', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x0f) {
          const fcb = readWord(0x16c0);
          this.memory[fcb & 0xffff] = 0x03;
          writeWord(0x16b6, 0);
          return { supported: true, note: 'DOS INT 21h/AH=0Fh FCB open', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x29) {
          const source = (((readWord(0x16c4) & 0xffff) << 4) + readWord(0x16c2)) & 0xfffff;
          const destination = (((readWord(0x16c6) & 0xffff) << 4) + readWord(0x16c0)) & 0xfffff;
          this.physicalMemory[destination] = 0;
          for (let index = 0; index < 5; index++) {
            this.physicalMemory[(destination + 1 + index) & 0xfffff] = this.physicalMemory[(source + index) & 0xfffff];
          }
          const fileSize = this.physicalMemory[(source + 4) & 0xfffff] === 0x42 ? 362496 : 256000;
          for (let index = 0; index < 4; index++) {
            this.physicalMemory[(destination + 0x10 + index) & 0xfffff] = (fileSize >>> (index * 8)) & 0xff;
          }
          writeWord(0x16b6, 0);
          writeWord(0x16b8, 0);
          return { supported: true, note: 'DOS INT 21h/AH=29h parsed FCB filename and size', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x4a) {
          writeWord(0x16b6, 0x01fe);
          return { supported: true, note: 'DOS INT 21h/AH=4Ah memory resize', output };
        }
        return { supported: false, note: `unsupported interrupt 0x${interrupt.toString(16).padStart(2, '0')} AX=0x${ax.toString(16).padStart(4, '0')}`, output };
      }
      case '2+':
        unary(value => value + 2);
        return { supported: true, note: 'add two', output };
      case '2*':
        unary(value => value * 2);
        return { supported: true, note: 'multiply by two', output };
      case '16/':
        unary(value => value >>> 4);
        return { supported: true, note: 'divide unsigned value by 16', output };
      case '1+':
        unary(value => value + 1);
        return { supported: true, note: 'increment', output };
      case '1-':
        unary(value => value - 1);
        return { supported: true, note: 'decrement', output };
      case 'NEGATE':
        unary(value => -value);
        return { supported: true, note: 'negate signed cell', output };
      case 'DUP': {
        const value = pop(dataStack, 'data');
        push(dataStack, value);
        push(dataStack, value);
        return { supported: true, note: 'duplicate', output };
      }
      case '2DUP': {
        if (dataStack.length < 2) throw new RangeError('data stack underflow');
        const second = dataStack[dataStack.length - 2];
        const top = dataStack[dataStack.length - 1];
        push(dataStack, second);
        push(dataStack, top);
        return { supported: true, note: 'duplicate top two cells', output };
      }
      case 'OVER': {
        const value = dataStack[dataStack.length - 2];
        if (value === undefined) throw new RangeError('data stack underflow');
        push(dataStack, value);
        return { supported: true, note: 'copy second data-stack cell', output };
      }
      case '?DUP': {
        const value = dataStack[dataStack.length - 1];
        if (value !== undefined && value !== 0) push(dataStack, value);
        return { supported: true, note: 'duplicate if nonzero', output };
      }
      case 'DROP':
        pop(dataStack, 'data');
        return { supported: true, note: 'drop', output };
      case '>R':
        push(returnStack, pop(dataStack, 'data'));
        return { supported: true, note: 'move to return stack', output };
      case 'R>':
        push(dataStack, pop(returnStack, 'return'));
        return { supported: true, note: 'move from return stack', output };
      case 'R@': {
        const value = returnStack[returnStack.length - 1];
        if (value === undefined) throw new RangeError('return stack underflow');
        push(dataStack, value);
        return { supported: true, note: 'copy return-stack top', output };
      }
      case 'SP!':
        dataStack.length = 0;
        return { supported: true, note: 'reset data stack to initialized base', output };
      case 'RP!':
        returnStack.length = 0;
        return { supported: true, note: 'reset return stack to initialized base', output };
      case 'SWAP': {
        const top = pop(dataStack, 'data');
        const next = pop(dataStack, 'data');
        push(dataStack, top);
        push(dataStack, next);
        return { supported: true, note: 'swap', output };
      }
      default:
        return { supported: false, note: 'native primitive', output };
    }
  }

  private formatTrace(steps: number, word: ForthWord, token: ForthToken, stack: number[], note: string): string {
    const stackText = stack.slice(-8).map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
    return `${steps.toString().padStart(3, ' ')} ${word.module}:${word.name} ${token.name}  [${stackText}] ${note}`;
  }

  private getReturnAddress(frame: CallFrame, token: ForthToken): number {
    const inlineString = token.name.match(/^(.*?) "[\s\S]*"$/);
    if (inlineString?.[1] === 'SET_STR_AS_PARAM') return (token.addr + 2) & 0xffff;
    return frame.word.tokens[frame.tokenIndex]?.addr ?? ((token.addr + 2) & 0xffff);
  }

  private findMatchingLoop(tokens: ForthToken[], startIndex: number): number {
    let nestedLoops = 0;
    for (let index = startIndex; index < tokens.length; index++) {
      const name = tokens[index].name;
      if (name === '(DO)') nestedLoops++;
      if (name === '(LOOP)' || name === '(+LOOP)' || name === '(/LOOP)') {
        if (nestedLoops === 0) return index;
        nestedLoops--;
      }
    }
    return -1;
  }

  private readFarByte(segment: number, offset: number): number {
    const address = (((segment & 0xffff) << 4) + (offset & 0xffff)) & 0xfffff;
    return this.physicalMemory[address];
  }
}