import {
  CFA_0BRANCH,
  CFA_BRANCH,
  CFA_EXIT1,
  CFA_EXIT2,
  CODE_CALL,
  type ForthEngine,
  type ForthToken,
  type ForthWord
} from './forth-decompiler';

interface CallFrame {
  word: ForthWord;
  tokenIndex: number;
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

  constructor(engine: ForthEngine, starflt: Uint8Array) {
    this.engine = engine;
    this.memory = new Uint8Array(0x10000);
    this.memory.set(starflt.subarray(0, 0x10000 - 0x100), 0x100);
    this.initialMemory = this.memory.slice();
  }

  run(entryCfa = 0x0937, maxSteps = 1000): ForthBootResult {
    this.memory = this.initialMemory.slice();
    const entry = this.engine.get(entryCfa, 'KERNEL');
    if (!entry) {
      return { steps: 0, trace: [], output: '', stopReason: `No kernel word at CFA 0x${entryCfa.toString(16)}.` };
    }

    const dataStack: number[] = [];
    const returnStack: number[] = [];
    const frames: CallFrame[] = [{ word: entry, tokenIndex: 0 }];
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
        const target = candidates.find(word => word.module === frame.word.module)
          ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!target) {
          stopReason = `Unresolved call ${token.name} at CFA ${token.cfaHex} in ${frame.word.module}.`;
          break;
        }

        if (target.module !== 'KERNEL') {
          stopReason = `Overlay ${target.module} is not loaded in this boot harness.`;
          break;
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

        if (target.codep === CODE_CALL) {
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `call ${target.name}`));
          frames.push({ word: target, tokenIndex: 0 });
          continue;
        }

        const handled = this.executePrimitive(target, dataStack, returnStack, output, push, pop, readWord, writeWord);
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
    writeWord: (address: number, value: number) => void
  ): { supported: boolean; note: string; output: string } {
    const name = word.name;
    const binary = (operation: (left: number, right: number) => number) => {
      const right = pop(dataStack, 'data');
      const left = pop(dataStack, 'data');
      push(dataStack, operation(left, right));
    };

    switch (name) {
      case '@':
        push(dataStack, readWord(pop(dataStack, 'data')));
        return { supported: true, note: 'read word', output };
      case '!': {
        const address = pop(dataStack, 'data');
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'write word', output };
      }
      case '2@': {
        const address = pop(dataStack, 'data');
        push(dataStack, readWord(address + 2));
        push(dataStack, readWord(address));
        return { supported: true, note: 'read double cell', output };
      }
      case '2!_2': {
        const address = pop(dataStack, 'data');
        const first = pop(dataStack, 'data');
        const second = pop(dataStack, 'data');
        writeWord(address, first);
        writeWord(address + 2, second);
        return { supported: true, note: 'write double cell', output };
      }
      case 'OR':
        binary((left, right) => left | right);
        return { supported: true, note: 'bitwise OR', output };
      case 'AND':
        binary((left, right) => left & right);
        return { supported: true, note: 'bitwise AND', output };
      case '+':
        binary((left, right) => left + right);
        return { supported: true, note: 'add', output };
      case '-':
        binary((left, right) => left - right);
        return { supported: true, note: 'subtract', output };
      case '0=':
        push(dataStack, pop(dataStack, 'data') === 0 ? 0xffff : 0);
        return { supported: true, note: 'zero test', output };
      case '(CS?)':
        push(dataStack, 0x0192);
        return { supported: true, note: 'push current code segment', output };
      case '2+':
        push(dataStack, pop(dataStack, 'data') + 2);
        return { supported: true, note: 'add two', output };
      case 'DUP': {
        const value = pop(dataStack, 'data');
        push(dataStack, value);
        push(dataStack, value);
        return { supported: true, note: 'duplicate', output };
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
      case 'R@':
        push(dataStack, returnStack[returnStack.length - 1] ?? 0);
        return { supported: true, note: 'copy return-stack top', output };
      case 'SWAP': {
        const top = pop(dataStack, 'data');
        const next = pop(dataStack, 'data');
        push(dataStack, top);
        push(dataStack, next);
        return { supported: true, note: 'swap', output };
      }
      case 'CMOVE_2': {
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        const copy = new Uint8Array(count);
        for (let index = 0; index < count; index++) copy[index] = this.memory[(source + index) & 0xffff];
        for (let index = 0; index < count; index++) this.memory[(destination + index) & 0xffff] = copy[index];
        return { supported: true, note: `copy ${count} bytes`, output };
      }
      default:
        return { supported: false, note: 'native primitive', output };
    }
  }

  private formatTrace(steps: number, word: ForthWord, token: ForthToken, stack: number[], note: string): string {
    const stackText = stack.slice(-8).map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
    return `${steps.toString().padStart(3, ' ')} ${word.module}:${word.name} ${token.name}  [${stackText}] ${note}`;
  }
}