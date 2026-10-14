/**
 * Forth Code Explorer Component
 *
 * Provides a UI to search, browse, and inspect decompiled Forth functions
 * across STARFLT.COM and all 52 game code overlays.
 */

import { type ForthEngine, type ForthWord } from './forth-decompiler';

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

  constructor(engine: ForthEngine) {
    this.engine = engine;
    // Default selection: a prominent game function e.g. TRANSACT or ?CAN-LEAVE or COLD
    this.selectedWord = engine.get('TRANSACT') ?? engine.get('COLD') ?? engine.words[0] ?? null;
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
              <option value="primitive">CODE (Machine Primitives)</option>
            </select>

            <input type="text" id="forth-search" placeholder="Search functions (e.g. TRANSACT, D@...)" 
              value="${this.searchQuery}"
              style="background: #11131c; border: 1px solid #363e58; color: #c3ccdb; padding: 4px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; width: 220px;" />
          </div>
        </div>

        <!-- 2-Column Grid: List on Left, Decompiler on Right -->
        <div style="display: grid; grid-template-columns: 380px 1fr; gap: 20px; align-items: start;">
          <!-- Left Column: Word List -->
          <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 14px; display: flex; flex-direction: column;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; color: #7982a9;">
              <span id="filtered-count">Functions</span>
              <span>Click word to decompile</span>
            </div>

            <div id="word-list" style="max-height: 640px; overflow-y: auto; border: 1px solid #1f2537; border-radius: 6px; background: #0c0e17;">
            </div>
          </div>

          <!-- Right Column: Decompiled Code & Flow -->
          <div id="code-detail-panel">
          </div>
        </div>
      </div>
    `;

    // Filter event listeners
    const moduleSelect = document.getElementById('select-module') as HTMLSelectElement | null;
    moduleSelect?.addEventListener('change', () => {
      this.selectedModule = moduleSelect.value;
      this.renderWordList();
    });

    const typeSelect = document.getElementById('select-type') as HTMLSelectElement | null;
    typeSelect?.addEventListener('change', () => {
      this.selectedType = typeSelect.value;
      this.renderWordList();
    });

    const searchInput = document.getElementById('forth-search') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.renderWordList();
    });

    // Word list clicks
    document.getElementById('word-list')?.addEventListener('click', (ev) => {
      const item = (ev.target as HTMLElement).closest('.word-item');
      if (!item) return;
      const cfaStr = item.getAttribute('data-cfa');
      if (!cfaStr) return;
      const cfa = parseInt(cfaStr, 10);
      const word = this.engine.get(cfa);
      if (word) {
        this.selectWord(word);
      }
    });

    this.renderWordList();
    this.renderDetailPanel();
  }

  private renderWordList() {
    const listEl = document.getElementById('word-list');
    const countEl = document.getElementById('filtered-count');
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
      const isSelected = this.selectedWord?.cfa === w.cfa;
      const typeBadgeColor = w.type === 'colon' ? '#82aaff' : (w.type === 'constant' ? '#ffcb6b' : (w.type === 'variable' ? '#c792ea' : '#7982a9'));

      return `
        <div class="word-item ${isSelected ? 'selected' : ''}" data-cfa="${w.cfa}"
          style="padding: 8px 12px; border-bottom: 1px solid #161926; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s ease; ${isSelected ? 'background: #232a3d; border-left: 3px solid #82aaff;' : ''}">
          <div>
            <div style="font-weight: bold; color: ${isSelected ? '#82aaff' : '#c3e88d'}; font-size: 13px;">${w.name}</div>
            <div style="font-size: 10px; color: #7982a9; margin-top: 2px;">
              <span style="color: #89ddff;">${w.module}</span> &bull; CFA: ${w.cfaHex}
            </div>
          </div>
          <span style="font-size: 10px; color: ${typeBadgeColor}; background: #151824; border: 1px solid #232a3d; padding: 2px 6px; border-radius: 4px;">
            ${w.type === 'colon' ? ':' : w.type.toUpperCase()}
          </span>
        </div>
      `;
    }).join('');
  }

  private selectWord(word: ForthWord) {
    this.selectedWord = word;

    // Update active highlight in list
    const items = document.querySelectorAll('.word-item');
    items.forEach(el => {
      const cfaStr = el.getAttribute('data-cfa');
      if (cfaStr && parseInt(cfaStr, 10) === word.cfa) {
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

  private renderDetailPanel() {
    const panel = document.getElementById('code-detail-panel');
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
            <div style="font-size: 12px; color: #b2ccd6;">
              CFA: <strong style="color: #82aaff;">${word.cfaHex}</strong> | 
              PFA: <strong style="color: #89ddff;">${word.pfaHex}</strong> | 
              CODEP: <strong style="color: #c792ea;">${word.codepHex}</strong>
            </div>
          </div>

          <!-- Decompiled Source Code Editor -->
          <div style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
              <span style="font-size: 12px; color: #ffcb6b; font-weight: bold;">Decompiled Forth Source</span>
              <span style="font-size: 11px; color: #7982a9;">1985 Threaded Code Reconstruction</span>
            </div>

            <div style="background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; padding: 14px 18px; font-family: monospace; font-size: 14px; line-height: 1.6; color: #c3ccdb; overflow-x: auto;">
              ${this.highlightForthCode(word.decompiled)}
            </div>
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
                      const isClickable = this.engine.wordsByCfa.has(t.cfa);
                      return `
                        <tr style="border-bottom: 1px solid #161926;">
                          <td style="padding: 5px 12px; color: #7982a9;">${t.addrHex}</td>
                          <td style="padding: 5px 12px; color: #f78c6c;">${t.cfaHex}</td>
                          <td style="padding: 5px 12px;">
                            ${isClickable 
                              ? `<a href="#" class="token-link" data-cfa="${t.cfa}" style="color: #82aaff; text-decoration: none; font-weight: bold;">${t.name}</a>`
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
      </div>
    `;

    // Hook up token link clicks
    document.querySelectorAll('.token-link').forEach(link => {
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        const cfaStr = (ev.currentTarget as HTMLElement).getAttribute('data-cfa');
        if (cfaStr) {
          const target = this.engine.get(parseInt(cfaStr, 10));
          if (target) {
            this.selectWord(target);
          }
        }
      });
    });
  }

  private highlightForthCode(code: string): string {
    const parts = code.split(/\s+/);
    return parts.map(token => {
      if (token === ':' || token === ';') {
        return `<span style="color: #82aaff; font-weight: bold;">${token}</span>`;
      }
      if (token === 'IF' || token === 'ELSE' || token === 'THEN' || token === 'DO' || token === 'LOOP' || token === '+LOOP' || token === 'LEAVE') {
        return `<span style="color: #ffcb6b; font-weight: bold;">${token}</span>`;
      }
      if (token === 'DUP' || token === 'DROP' || token === 'SWAP' || token === 'OVER' || token === 'ROT' || token === '2DUP' || token === '2DROP') {
        return `<span style="color: #c792ea; font-weight: bold;">${token}</span>`;
      }
      if (token === '@' || token === '!' || token === 'C@' || token === 'C!' || token === '2@' || token === '2!' || token === 'D@' || token === 'D!') {
        return `<span style="color: #f78c6c; font-weight: bold;">${token}</span>`;
      }
      if (token === '+' || token === '-' || token === '*' || token === '/' || token === 'M*/' || token === 'D+' || token === 'D-' || token === '1+' || token === '1-') {
        return `<span style="color: #89ddff; font-weight: bold;">${token}</span>`;
      }
      if (/^-?\d+$/.test(token)) {
        return `<span style="color: #f78c6c;">${token}</span>`;
      }
      if (token.startsWith('W_') || token.startsWith('0x')) {
        return `<span style="color: #7982a9;">${token}</span>`;
      }
      return `<span style="color: #c3e88d;">${token}</span>`;
    }).join(' ');
  }
}
