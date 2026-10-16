/**
 * Forth Code Explorer Component
 *
 * Provides a UI to search, browse, and inspect decompiled Forth functions
 * across STARFLT.COM and all 52 game code overlays.
 */

import { type ForthEngine, type ForthWord } from './forth-decompiler';
import { disassembleX86 } from './x86-disassembler';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character];
  });
}

function formatHex(bytes: Uint8Array, baseOffset = 0, bytesPerLine = 16): string {
  if (bytes.length === 0) return '(empty)';
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += bytesPerLine) {
    const chunk = bytes.subarray(i, Math.min(i + bytesPerLine, bytes.length));
    const offsetHex = (baseOffset + i).toString(16).padStart(4, '0');
    let hex = '';
    let ascii = '';
    for (let j = 0; j < bytesPerLine; j++) {
      if (j === 8) hex += ' ';
      if (j < chunk.length) {
        const b = chunk[j];
        hex += b.toString(16).padStart(2, '0') + ' ';
        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
        ascii += ' ';
      }
    }
    lines.push(`${offsetHex}:  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}

export class ForthExplorer {
  private engine: ForthEngine;
  private selectedWord: ForthWord | null = null;
  private container: HTMLElement | null = null;
  private selectedModule: string = 'all';
  private selectedType: string = 'all';
  private searchQuery: string = '';
  private navigationHistory: ForthWord[] = [];
  private navigationIndex = -1;
  private disassemblyCache = new Map<string, string>();

  constructor(engine: ForthEngine) {
    this.engine = engine;
    this.selectedWord = engine.get('W_0x0937', 'KERNEL')
      ?? engine.get('TRANSACT')
      ?? engine.get('COLD')
      ?? engine.words[0]
      ?? null;
    if (this.selectedWord) {
      this.navigationHistory.push(this.selectedWord);
      this.navigationIndex = 0;
    }
  }

  mount(target: HTMLElement) {
    this.container = target;
    this.render();
  }

  private render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <!-- Top Toolbar & Filters -->
        <div style="display: flex; justify-content: space-between; align-items: center; background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 12px 18px; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div style="font-size: 13px; color: #82aaff; font-weight: bold;">
              &#9881; Forth Reverse Engineering Engine
            </div>
            <div style="font-size: 12px; color: #7982a9;">
              Total Words: <strong style="color: #c792ea;">${this.engine.words.length.toLocaleString()}</strong> |
              Overlays: <strong style="color: #89ddff;">${this.engine.modules.length - 1}</strong>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <select id="select-module" class="btn" style="padding: 4px 8px;">
              <option value="all">All Modules (${this.engine.words.length})</option>
              ${this.engine.modules.map(m => `
                <option value="${m}" ${this.selectedModule === m ? 'selected' : ''}>
                  ${m} (${this.engine.filter(m).length})
                </option>
              `).join('')}
            </select>

            <select id="select-type" class="btn" style="padding: 4px 8px;">
              <option value="all">All Word Types</option>
              <option value="colon">: Colon Definitions</option>
              <option value="constant">CONSTANT</option>
              <option value="variable">VARIABLE</option>
              <option value="afield">AFIELD (Instance Records)</option>
              <option value="table">Forth Parameter Tables</option>
              <option value="sigfield">Signature Fields</option>
              <option value="primitive">CODE (Machine Primitives)</option>
            </select>

            <input type="text" id="forth-search" placeholder="Search functions (e.g. TRANSACT, D@...)"
              value="${this.searchQuery}"
              style="background: #11131c; border: 1px solid #363e58; color: #c3ccdb; padding: 4px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; width: 220px;" />
          </div>
        </div>

        <!-- Word List on the Left, Selected Word Detail on the Right -->
        <div class="forth-workspace" style="display: grid; gap: 20px; align-items: start;">
          <!-- Left Column: Word List -->
          <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 14px; display: flex; flex-direction: column;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; color: #7982a9;">
              <span id="filtered-count">Functions</span>
              <span>Click word to decompile</span>
            </div>

            <div id="word-list" class="forth-word-list" style="overflow-y: auto; overflow-x: hidden; border: 1px solid #1f2537; border-radius: 6px; background: #0c0e17;">
            </div>
          </div>

          <!-- Right Column: Decompiled Code & Flow -->
          <div id="code-detail-panel">
          </div>
        </div>
      </div>
    `;

    // Filter event listeners
    const moduleSelect = this.container.querySelector('#select-module') as HTMLSelectElement | null;
    moduleSelect?.addEventListener('change', () => {
      this.selectedModule = moduleSelect.value;
      this.renderWordList();
    });

    const typeSelect = this.container.querySelector('#select-type') as HTMLSelectElement | null;
    typeSelect?.addEventListener('change', () => {
      this.selectedType = typeSelect.value;
      this.renderWordList();
    });

    const searchInput = this.container.querySelector('#forth-search') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.renderWordList();
    });

    // Word list clicks
    this.container.querySelector('#word-list')?.addEventListener('click', (ev) => {
      const item = (ev.target as HTMLElement).closest('.word-item');
      if (!item) return;
      const cfaStr = item.getAttribute('data-cfa');
      if (!cfaStr) return;
      const cfa = parseInt(cfaStr, 10);
      const module = item.getAttribute('data-module');
      const word = this.engine.get(cfa, module ?? undefined);
      if (word) {
        this.selectWord(word);
      }
    });

    this.renderWordList();
    this.renderDetailPanel();
  }

  private renderWordList() {
    const listEl = this.container?.querySelector('#word-list');
    const countEl = this.container?.querySelector<HTMLElement>('#filtered-count');
    if (!listEl) return;

    const filtered = this.engine.filter(this.selectedModule, this.selectedType, this.searchQuery);
    if (countEl) {
      countEl.innerText = `Functions (${filtered.length.toLocaleString()})`;
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #7982a9; font-size: 12px;">No matching Forth words found.</div>`;
      return;
    }

    listEl.innerHTML = filtered.map(w => {
      const isSelected = this.selectedWord?.cfa === w.cfa && this.selectedWord.module === w.module;
      const typeBadgeColor = w.type === 'colon' ? '#82aaff' : (w.type === 'constant' ? '#ffcb6b' : (w.type === 'variable' ? '#c792ea' : '#7982a9'));
      const wordName = escapeHtml(w.name);
      const moduleName = escapeHtml(w.module);
      const cfaHex = escapeHtml(w.cfaHex);

      return `
        <div class="word-item ${isSelected ? 'selected' : ''}" data-cfa="${w.cfa}" data-module="${moduleName}" title="${wordName}"
          style="padding: 8px 12px; border-bottom: 1px solid #161926; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px; transition: background 0.15s ease; ${isSelected ? 'background: #232a3d; border-left: 3px solid #82aaff;' : ''}">
          <div class="forth-word-info">
            <div class="forth-word-name" style="font-weight: bold; color: ${isSelected ? '#82aaff' : '#c3e88d'}; font-size: 13px;">${wordName}</div>
            <div class="forth-word-meta" style="font-size: 10px; color: #7982a9; margin-top: 2px;">
              <span style="color: #89ddff;">${moduleName}</span> &bull; CFA: ${cfaHex}
            </div>
          </div>
          <span class="forth-word-type" style="font-size: 10px; color: ${typeBadgeColor}; background: #151824; border: 1px solid #232a3d; padding: 2px 6px; border-radius: 4px;">
            ${w.type === 'colon' ? ':' : w.type.toUpperCase()}
          </span>
        </div>
      `;
    }).join('');
  }

  private selectWord(word: ForthWord, addToHistory = true) {
    if (addToHistory) {
      const current = this.navigationHistory[this.navigationIndex];
      if (!current || current.cfa !== word.cfa || current.module !== word.module) {
        this.navigationHistory = this.navigationHistory.slice(0, this.navigationIndex + 1);
        this.navigationHistory.push(word);
        this.navigationIndex = this.navigationHistory.length - 1;
      }
    }

    this.selectedWord = word;

    // Update active highlight in list
    const items = this.container?.querySelectorAll('.word-item') ?? [];
    items.forEach(el => {
      const cfaStr = el.getAttribute('data-cfa');
      if (cfaStr && parseInt(cfaStr, 10) === word.cfa && el.getAttribute('data-module') === word.module) {
        el.classList.add('selected');
        (el as HTMLElement).style.background = '#232a3d';
        (el as HTMLElement).style.borderLeft = '3px solid #82aaff';
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.classList.remove('selected');
        (el as HTMLElement).style.background = '';
        (el as HTMLElement).style.borderLeft = '';
      }
    });

    this.renderDetailPanel();
  }

  private goBack() {
    if (this.navigationIndex <= 0) return;
    this.navigationIndex--;
    this.selectWord(this.navigationHistory[this.navigationIndex], false);
  }

  private renderDetailPanel() {
    const panel = this.container?.querySelector('#code-detail-panel');
    if (!panel) return;

    const word = this.selectedWord;
    if (!word) {
      panel.innerHTML = `<div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 24px; color: #7982a9; text-align: center;">Select a Forth function to decompile.</div>`;
      return;
    }

    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <!-- Header Info Card -->
        <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 18px 20px;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #232a3d; padding-bottom: 12px; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <span style="color: #7982a9; font-size: 12px;">Function:</span>
              <span style="color: #c3e88d; font-size: 20px; font-weight: bold; margin-left: 8px;">${word.name}</span>
              <span style="background: #232a3d; color: #82aaff; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; border: 1px solid #82aaff44;">
                ${word.module}
              </span>
              <span style="background: #232a3d; color: #ffcb6b; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 6px; border: 1px solid #ffcb6b44;">
                ${word.typeLabel}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <button id="forth-back" class="btn" type="button" title="Go back to the previous function" aria-label="Go back to the previous function" ${this.navigationIndex <= 0 ? 'disabled' : ''}>&larr; Back</button>
              <div style="font-size: 12px; color: #b2ccd6;">
                CFA: <strong style="color: #82aaff;">${word.cfaHex}</strong> |
                PFA: <strong style="color: #89ddff;">${word.pfaHex}</strong> |
                CODEP: <strong style="color: #c792ea;">${word.codepHex}</strong>
              </div>
            </div>
          </div>

          <!-- Decompiled Source Code Editor -->
          <div style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
              <span style="font-size: 12px; color: #ffcb6b; font-weight: bold;">Decompiled Forth Source</span>
              <span style="font-size: 11px; color: #7982a9;">1985 Threaded Code Reconstruction</span>
            </div>

            <div style="background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; padding: 14px 18px; font-family: monospace; font-size: 14px; line-height: 1.6; color: #c3ccdb; overflow-x: auto;">
              ${this.renderForthCode(word)}
            </div>
          </div>

          <div style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
              <span style="font-size: 12px; color: #ffcb6b; font-weight: bold;">Pseudo-JavaScript</span>
              <span style="font-size: 11px; color: #7982a9;">Approximate, stack-oriented translation</span>
            </div>
            <pre style="margin: 0; background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; padding: 14px 18px; font-family: monospace; font-size: 13px; line-height: 1.6; color: #c3ccdb; overflow: auto; white-space: pre;">${escapeHtml(this.translateForthToPseudoJavaScript(word))}</pre>
          </div>

          <!-- Execution Tokens Table -->
          ${word.tokens.length > 0 ? `
            <div>
              <div style="font-size: 12px; color: #ffcb6b; font-weight: bold; margin-bottom: 8px;">
                Compiled Execution Tokens (${word.tokens.length})
              </div>
              <div style="max-height: 240px; overflow-y: auto; border: 1px solid #1f2537; border-radius: 6px; background: #0c0e17;">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px;">
                  <thead style="background: #141724; position: sticky; top: 0; color: #82aaff;">
                    <tr>
                      <th style="padding: 6px 12px; border-bottom: 1px solid #232a3d;">Offset</th>
                      <th style="padding: 6px 12px; border-bottom: 1px solid #232a3d;">CFA Token</th>
                      <th style="padding: 6px 12px; border-bottom: 1px solid #232a3d;">Resolved Target</th>
                      <th style="padding: 6px 12px; border-bottom: 1px solid #232a3d;">Kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${word.tokens.map(t => {
                      const inlineString = t.kind === 'call' ? t.name.match(/^(.*?) ("[\s\S]*")$/) : null;
                      const callName = inlineString?.[1] ?? t.name;
                      const target = t.kind === 'call' ? this.findTokenTarget(callName, word, t.cfa) : undefined;
                      return `
                        <tr style="border-bottom: 1px solid #161926;">
                          <td style="padding: 5px 12px; color: #7982a9;">${t.addrHex}</td>
                          <td style="padding: 5px 12px; color: #f78c6c;">${t.cfaHex}</td>
                          <td style="padding: 5px 12px;">
                            ${target
                              ? `<a href="#" class="token-link" data-cfa="${target.cfa}" data-module="${escapeHtml(target.module)}" style="color: #82aaff; text-decoration: none; font-weight: bold;">${escapeHtml(t.name)}</a>`
                              : `<span style="color: #c3e88d;">${t.name}</span>`}
                          </td>
                          <td style="padding: 5px 12px; color: #89ddff;">${t.kind}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Raw Memory Byte Dump Card -->
        <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 14px 18px;">
          <div style="font-size: 11px; color: #7982a9; text-transform: uppercase; margin-bottom: 6px;">
            Raw Memory Byte Dump (Starting at CFA ${word.cfaHex}):
          </div>
          <pre style="margin: 0; font-family: monospace; font-size: 12px; line-height: 1.4; color: #89ddff; overflow-x: auto;">${formatHex(word.rawBytes, word.cfa)}</pre>
        </div>
        ${word.machineCodeBytes?.length ? `
          <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 14px 18px;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
              <div style="font-size: 11px; color: #7982a9; text-transform: uppercase;">
                16-bit x86 at code pointer ${word.codepHex}
                <span style="display: block; margin-top: 4px; text-transform: none;">${word.machineCodeIsInline ? 'Inline body, bounded by the next dictionary header' : 'Shared implementation sample, capped at 64 bytes'}</span>
              </div>
              <button id="btn-x86-disassemble" class="btn" type="button">Disassemble</button>
            </div>
            <pre id="x86-disassembly" style="margin: 0; font-family: monospace; font-size: 12px; line-height: 1.4; color: #89ddff; overflow: auto; white-space: pre;">Click Disassemble to decode the primitive's implementation bytes.</pre>
          </div>
        ` : ''}
      </div>
    `;

    // Hook up token link clicks
    this.container?.querySelectorAll('.token-link').forEach(link => {
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        const cfaStr = (ev.currentTarget as HTMLElement).getAttribute('data-cfa');
        if (cfaStr) {
          const link = ev.currentTarget as HTMLElement;
          const cfa = parseInt(cfaStr, 10);
          const module = link.getAttribute('data-module');
          const target = this.engine.get(cfa, module ?? undefined);
          if (target) {
            this.selectWord(target);
          }
        }
      });
    });

    this.container?.querySelector('#forth-back')?.addEventListener('click', () => {
      this.goBack();
    });

    this.container?.querySelector('#btn-x86-disassemble')?.addEventListener('click', () => {
      void this.disassembleWord(word);
    });
  }

  private async disassembleWord(word: ForthWord) {
    const key = `${word.module}:${word.cfa}:${word.codep}`;
    const button = this.container?.querySelector<HTMLButtonElement>('#btn-x86-disassemble');
    const output = this.container?.querySelector<HTMLElement>('#x86-disassembly');
    if (!button || !output || !word.machineCodeBytes?.length) return;

    const cached = this.disassemblyCache.get(key);
    if (cached) {
      output.textContent = cached;
      return;
    }

    button.disabled = true;
    output.textContent = 'Loading Capstone and disassembling...';
    try {
      const listing = await disassembleX86(word.machineCodeBytes, word.codep);
      this.disassemblyCache.set(key, listing);
      if (this.selectedWord?.cfa === word.cfa && this.selectedWord.module === word.module) {
        this.container?.querySelector<HTMLElement>('#x86-disassembly')?.replaceChildren(document.createTextNode(listing));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.selectedWord?.cfa === word.cfa && this.selectedWord.module === word.module) {
        const currentOutput = this.container?.querySelector<HTMLElement>('#x86-disassembly');
        if (currentOutput) currentOutput.textContent = `Disassembly failed: ${message}`;
      }
    } finally {
      if (this.selectedWord?.cfa === word.cfa && this.selectedWord.module === word.module) {
        const currentButton = this.container?.querySelector<HTMLButtonElement>('#btn-x86-disassemble');
        if (currentButton) currentButton.disabled = false;
      }
    }
  }

  private highlightForthCode(code: string): string {
    const parts = code.split(/\s+/);
    return parts.map(token => this.highlightForthToken(token)).join(' ');
  }

  private renderForthCode(word: ForthWord): string {
    if (word.tokens.length === 0) {
      return this.highlightForthCode(word.decompiled);
    }

    const header = `<span style="color: #82aaff; font-weight: bold;">:</span> <span style="color: #c3e88d;">${escapeHtml(word.name)}</span>`;
    const body = word.tokens.map(token => {
      const inlineString = token.kind === 'call' ? token.name.match(/^(.*?) ("[\s\S]*")$/) : null;
      const callName = inlineString?.[1] ?? token.name;
      const display = token.kind === 'branch' ? token.name.split(' ')[0] : token.name;
      const target = token.kind === 'call' ? this.findTokenTarget(callName, word, token.cfa) : undefined;

      if (target) {
        const link = `<a href="#" class="token-link" data-cfa="${target.cfa}" data-module="${escapeHtml(target.module)}" title="Open ${escapeHtml(target.name)}" style="color: #82aaff; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;">${escapeHtml(callName)}</a>`;
        return inlineString ? `${link} ${escapeHtml(inlineString[2])}` : link;
      }

      return this.highlightForthToken(display);
    }).join(' ');

    return `${header} ${body}`;
  }

  private highlightForthToken(token: string): string {
      if (token === ':' || token === ';') {
        return `<span style="color: #82aaff; font-weight: bold;">${escapeHtml(token)}</span>`;
      }
      if (token === 'IF' || token === 'ELSE' || token === 'THEN' || token === 'DO' || token === 'LOOP' || token === '+LOOP' || token === 'LEAVE') {
        return `<span style="color: #ffcb6b; font-weight: bold;">${escapeHtml(token)}</span>`;
      }
      if (token === 'DUP' || token === 'DROP' || token === 'SWAP' || token === 'OVER' || token === 'ROT' || token === '2DUP' || token === '2DROP') {
        return `<span style="color: #c792ea; font-weight: bold;">${escapeHtml(token)}</span>`;
      }
      if (token === '@' || token === '!' || token === 'C@' || token === 'C!' || token === '2@' || token === '2!' || token === 'D@' || token === 'D!') {
        return `<span style="color: #f78c6c; font-weight: bold;">${escapeHtml(token)}</span>`;
      }
      if (token === '+' || token === '-' || token === '*' || token === '/' || token === 'M*/' || token === 'D+' || token === 'D-' || token === '1+' || token === '1-') {
        return `<span style="color: #89ddff; font-weight: bold;">${escapeHtml(token)}</span>`;
      }
      if (/^-?\d+$/.test(token)) {
        return `<span style="color: #f78c6c;">${escapeHtml(token)}</span>`;
      }
      if (token.startsWith('W_') || token.startsWith('0x')) {
        return `<span style="color: #7982a9;">${escapeHtml(token)}</span>`;
      }
      return `<span style="color: #c3e88d;">${escapeHtml(token)}</span>`;
  }

  private findTokenTarget(name: string, context: ForthWord, cfa?: number): ForthWord | undefined {
    const addressCandidates = cfa === undefined
      ? []
      : this.engine.wordsByCfa.get(cfa) ?? [];
    const contextualAddressCandidates = addressCandidates.filter(candidate => candidate.module === context.module);
    const requestedName = name.trim().toUpperCase();
    const addressTarget = contextualAddressCandidates.find(candidate => candidate.name.toUpperCase() === requestedName)
      ?? (contextualAddressCandidates.length === 1 ? contextualAddressCandidates[0] : undefined)
      ?? (addressCandidates.length === 1 ? addressCandidates[0] : undefined);
    if (addressTarget) return addressTarget;

    const candidates = this.engine.wordsByName.get(name.trim().toUpperCase()) ?? [];
    return candidates.find(candidate => candidate.module === context.module)
      ?? candidates.find(candidate => candidate.module === 'KERNEL')
      ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  private translateForthToPseudoJavaScript(word: ForthWord): string {
    const identifier = word.name.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^[^a-zA-Z_$]/, '_');
    const lines = [`function ${identifier}(stack = [], runtime) {`, '  // Forth stack top is the last array element.'];

    if (word.tokens.length === 0) {
      lines.push(`  // ${word.typeLabel}; no threaded body to translate.`);
      lines.push('}');
      return lines.join('\n');
    }

    const binaryOperators: Record<string, string> = {
      '+': '+', '-': '-', '*': '*', '/': '/',
      '=': '===', '<>': '!==', '<': '<', '>': '>',
      '0<': '< 0', '0>': '> 0', '0=': '=== 0',
      AND: '&', OR: '|', XOR: '^'
    };

    word.tokens.forEach((token, index) => {
      if (token.kind === 'lit') {
        lines.push(`  stack.push(${JSON.stringify(token.arg)});`);
        return;
      }
      if (token.kind === 'exit') {
        lines.push('  return stack;');
        return;
      }
      if (token.kind === 'branch') {
        const target = typeof token.arg === 'number' ? `0x${token.arg.toString(16)}` : 'unknown';
        if (token.name.startsWith('IF ')) {
          lines.push(`  if (stack.pop() === 0) runtime.jumpTo(${target});`);
        } else {
          lines.push(`  runtime.jumpTo(${target});`);
        }
        return;
      }
      if (token.kind !== 'call') return;

      const inlineString = token.name.match(/^(.*?) "([\s\S]*)"$/);
      if (inlineString) {
        lines.push(`  runtime.setStringParameter(${JSON.stringify(inlineString[2])}); // ${inlineString[1]}`);
        return;
      }

      const name = token.name;
      const target = this.findTokenTarget(name, word, token.cfa);
      if (target?.type === 'variable') {
        lines.push(`  stack.push(runtime.addressOfWord(${JSON.stringify(target.name)}));`);
        return;
      }
      if (target?.type === 'constant') {
        const value = target.rawBytes[4] | ((target.rawBytes[5] ?? 0) << 8);
        lines.push(`  stack.push(${value}); // ${target.name}`);
        return;
      }
      if (target?.type === 'user') {
        const offset = target.rawBytes[4] | ((target.rawBytes[5] ?? 0) << 8);
        lines.push(`  stack.push(runtime.userVariableAddress(${offset})); // ${target.name}`);
        return;
      }
      if (target?.type === 'afield') {
        lines.push(`  stack.push(runtime.instanceFieldOffset(${JSON.stringify(target.name)}));`);
        return;
      }
      if (name in binaryOperators) {
        const operator = binaryOperators[name];
        if (name === '0<' || name === '0>' || name === '0=') {
          lines.push(`  stack.push(stack.pop() ${operator});`);
        } else {
          lines.push(`  const right${index} = stack.pop();`);
          lines.push(`  const left${index} = stack.pop();`);
          lines.push(`  stack.push(left${index} ${operator} right${index});`);
        }
        return;
      }

      switch (name) {
        case 'DUP':
          lines.push('  stack.push(stack[stack.length - 1]);');
          break;
        case 'DROP':
          lines.push('  stack.pop();');
          break;
        case 'SWAP':
          lines.push(`  stack.push(...stack.splice(-2, 2).reverse());`);
          break;
        case 'OVER':
          lines.push('  stack.push(stack[stack.length - 2]);');
          break;
        case 'ROT':
          lines.push(`  const rotated${index} = stack.splice(-3, 3);`);
          lines.push(`  stack.push(rotated${index}[1], rotated${index}[2], rotated${index}[0]);`);
          break;
        case '2DUP':
          lines.push('  stack.push(...stack.slice(-2));');
          break;
        case '2DROP':
          lines.push('  stack.splice(-2, 2);');
          break;
        case '1+':
          lines.push('  stack.push(stack.pop() + 1);');
          break;
        case '1-':
          lines.push('  stack.push(stack.pop() - 1);');
          break;
        case '2+':
          lines.push('  stack.push(stack.pop() + 2);');
          break;
        case '2-':
          lines.push('  stack.push(stack.pop() - 2);');
          break;
        case 'NEGATE':
          lines.push('  stack.push(-stack.pop());');
          break;
        case 'NOT':
          lines.push('  stack.push(stack.pop() === 0);');
          break;
        case '@':
          lines.push('  stack.push(runtime.readWord(stack.pop()));');
          break;
        case 'C@':
          lines.push('  stack.push(runtime.readByte(stack.pop()));');
          break;
        case '!':
        case 'C!':
          lines.push(`  const address${index} = stack.pop();`);
          lines.push(`  const value${index} = stack.pop();`);
          lines.push(`  runtime.${name === '!' ? 'writeWord' : 'writeByte'}(address${index}, value${index});`);
          break;
        case '2@':
          lines.push(`  const address${index} = stack.pop();`);
          lines.push(`  const pair${index} = runtime.readDouble(address${index});`);
          lines.push(`  stack.push(pair${index}[1], pair${index}[0]);`);
          break;
        case '2!':
          lines.push(`  const address${index} = stack.pop();`);
          lines.push(`  const high${index} = stack.pop();`);
          lines.push(`  const low${index} = stack.pop();`);
          lines.push(`  runtime.writeDouble(address${index}, low${index}, high${index});`);
          break;
        default:
          if (target) {
            lines.push(`  runtime.callWord(${JSON.stringify(target.name)}, ${JSON.stringify(target.module)}, stack);`);
          } else if (name.startsWith('W_0x')) {
            lines.push(`  runtime.callUnknown(${name.slice(2)}, stack);`);
          } else {
            lines.push(`  runtime.call(${JSON.stringify(name)}, stack);`);
          }
      }
    });

    if (word.tokens[word.tokens.length - 1]?.kind !== 'exit') {
      lines.push('  return stack;');
    }
    lines.push('}');
    return lines.join('\n');
  }
}
