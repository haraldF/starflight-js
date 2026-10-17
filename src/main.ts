import './style.css';
import { createStarflightFS, type StarflightFS, type DirEntry } from './starflight-fs';
import { extractFluxes, extractStarSystems, type StarSystemInfo } from './starsystems';
import { markColonizablePlanets } from './colonizable';
import { markLocations } from './locations';
import { SystemVisualizer } from './system-visualizer';
import { createForthEngine, type ForthEngine } from './forth-decompiler';
import { ForthExplorer } from './forth-explorer';
import { KernelDisassembler } from './kernel-disassembler';
import { SpeakerAudio } from './speaker-audio';
import { SAVE_FILE_EXTENSION, decodeSaveFile, encodeSaveFile, saveFileName } from './save-file';
import { fetchGameFiles, hasAllGameFiles, loadCachedGameFiles, showGameFilesPage, type GameFiles } from './game-files';
import {
  CP437,
  ForthBootRunner,
  STEPS_PER_MILLISECOND,
  biosKey,
  type BootState,
  type ForthCheckpoint,
  type ForthGraphicsScreen,
  type ForthTextScreen
} from './forth-boot';

// The hidden cheat: type this word on the page (outside the game screen) to add the amount to the bank account.
const CHEAT_WORD = 'money';
const CHEAT_AMOUNT = 100000;
// How long keys that could start the cheat word wait before the game gets them anyway.
const CHEAT_HOLD_MILLISECONDS = 1000;

// GAME-OV's ?GAME.IN.PROGRESS (:TIMESTAMP @), which START. calls right after the intro screens.
const INTRO_DONE_CFA = 0xf525;

// Emulated CPUs, in Forth steps per millisecond: about 60-90 cycles per threaded word on an 8088 at 4.77 MHz, and
// roughly 3x and 8x that throughput on a 286 at 8 MHz and a 386 at 16 MHz.
const CPU_SPEEDS = [
  { label: 'PC/XT 4.77 MHz', rate: STEPS_PER_MILLISECOND },
  { label: 'AT 8 MHz', rate: 170 },
  { label: '386 16 MHz', rate: 400 }
];
const DEFAULT_CPU_SPEED = 170;

interface SavedGame {
  machine: ForthCheckpoint;
  keysTyped: number;
  fastForward: boolean;
  autoEga: boolean;
  skipIntro: boolean;
  cpuSpeed?: number;
}

async function gameCheckpoint(saved?: SavedGame): Promise<SavedGame | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('starflight-checkpoints', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checkpoints');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Checkpoint storage is blocked by another tab.'));
  });
  try {
    return await new Promise<SavedGame | undefined>((resolve, reject) => {
      const transaction = database.transaction('checkpoints', saved ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('checkpoints');
      const request = saved ? store.put(saved, 'game') : store.get('game');
      transaction.oncomplete = () => resolve(saved ?? request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Checkpoint storage was interrupted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Checkpoint storage failed.'));
    });
  } finally {
    database.close();
  }
}

// The 16 CGA/EGA text colors, indexed by attribute nibble.
const TEXT_PALETTE = [
  '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'
];

const RECORDS_PER_PAGE = 20;
const RAW_CHUNK_SIZE = 512;

type FilterMode = 'all' | 'mapped' | 'virtual' | 'pad';
type ActiveTab = 'explorer' | 'systems' | 'forth' | 'kernel' | 'game';

/**
 * Formats a Uint8Array into a colored hex dump HTML string.
 */
function formatHexDumpHtml(bytes: Uint8Array, baseOffset = 0, bytesPerLine = 16): string {
  if (bytes.length === 0) {
    return `<span style="color: #545c7e; font-style: italic;">(Empty buffer - 0 bytes)</span>`;
  }
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += bytesPerLine) {
    const chunk = bytes.subarray(i, Math.min(i + bytesPerLine, bytes.length));
    const offsetHex = (baseOffset + i).toString(16).padStart(6, '0');

    let hexHtml = '';
    let asciiHtml = '';

    for (let j = 0; j < bytesPerLine; j++) {
      if (j === 8) hexHtml += ' ';
      if (j < chunk.length) {
        const b = chunk[j];
        const hexStr = b.toString(16).padStart(2, '0');
        const color = b === 0 ? '#4e5579' : (b === 0x20 ? '#5a628a' : '#c3e88d');
        hexHtml += `<span style="color: ${color}">${hexStr}</span> `;

        if (b >= 32 && b <= 126) {
          const char = String.fromCharCode(b)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          asciiHtml += `<span style="color: #ffcb6b;">${char}</span>`;
        } else {
          asciiHtml += `<span style="color: #4e5579;">.</span>`;
        }
      } else {
        hexHtml += '   ';
        asciiHtml += ' ';
      }
    }

    lines.push(
      `<span style="color: #697098;">${offsetHex}:</span>  ${hexHtml} <span style="color: #545c7e;">|</span>${asciiHtml}<span style="color: #545c7e;">|</span>`
    );
  }
  return lines.join('\n');
}

export class ExplorerApp {
  private fs: StarflightFS;
  private selectedEntry: DirEntry | null = null;
  private currentPage = 0;
  private filterMode: FilterMode = 'all';
  private searchQuery = '';
  private container: HTMLElement | null = null;

  constructor(fs: StarflightFS) {
    this.fs = fs;
    this.selectedEntry = fs.get('INSTANCE') ?? fs.entries[0] ?? null;
  }

  mount(target: HTMLElement) {
    this.container = target;
    this.render();
  }

  private render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <!-- Stats Overview -->
        <div style="display: flex; gap: 16px; flex-wrap: wrap;">
          <div style="background: #151824; padding: 12px 18px; border-radius: 6px; border: 1px solid #232a3d;">
            <div style="color: #7982a9; font-size: 11px; text-transform: uppercase;">Total Directory Slots</div>
            <div style="color: #c792ea; font-size: 18px; font-weight: bold; margin-top: 4px;">192</div>
          </div>
          <div style="background: #151824; padding: 12px 18px; border-radius: 6px; border: 1px solid #232a3d;">
            <div style="color: #7982a9; font-size: 11px; text-transform: uppercase;">Disk Mapped Entries</div>
            <div style="color: #c792ea; font-size: 18px; font-weight: bold; margin-top: 4px;">${this.fs.entries.filter(e => e.size > 0 && e.file !== 'PAD').length}</div>
          </div>
          <div style="background: #151824; padding: 12px 18px; border-radius: 6px; border: 1px solid #232a3d;">
            <div style="color: #7982a9; font-size: 11px; text-transform: uppercase;">Virtual / Schema Types</div>
            <div style="color: #c792ea; font-size: 18px; font-weight: bold; margin-top: 4px;">${this.fs.entries.filter(e => e.size === 0 && e.file === 'NONE').length}</div>
          </div>
          <div style="background: #151824; padding: 12px 18px; border-radius: 6px; border: 1px solid #232a3d;">
            <div style="color: #7982a9; font-size: 11px; text-transform: uppercase;">Pad Slots (0x20)</div>
            <div style="color: #c792ea; font-size: 18px; font-weight: bold; margin-top: 4px;">${this.fs.entries.filter(e => e.file === 'PAD').length}</div>
          </div>
        </div>

        <!-- Filter and Search Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; gap: 6px;" id="filter-tabs">
            <button class="tab-btn ${this.filterMode === 'all' ? 'active' : ''}" data-filter="all">All Slots (192)</button>
            <button class="tab-btn ${this.filterMode === 'mapped' ? 'active' : ''}" data-filter="mapped">Disk Mapped</button>
            <button class="tab-btn ${this.filterMode === 'virtual' ? 'active' : ''}" data-filter="virtual">Virtual / Schemas</button>
            <button class="tab-btn ${this.filterMode === 'pad' ? 'active' : ''}" data-filter="pad">0x20 Pad Slots</button>
          </div>
          <div>
            <input type="text" id="search-input" placeholder="Search entry name..." value="${this.searchQuery}"
              style="background: #151822; border: 1px solid #363e58; color: #c3ccdb; padding: 5px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; width: 180px;" />
          </div>
        </div>

        <!-- Table Container -->
        <div style="max-height: 360px; overflow-y: auto; border: 1px solid #232a3d; border-radius: 6px; background: #12141f;">
          <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px;">
            <thead style="background: #181c2b; position: sticky; top: 0; color: #82aaff; z-index: 10;">
              <tr>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Idx</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Name</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">File</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Global Offset</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Size (bytes)</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Records</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Block Size</th>
                <th style="padding: 8px 12px; border-bottom: 1px solid #232a3d;">Logical Size</th>
              </tr>
            </thead>
            <tbody id="entries-tbody">
            </tbody>
          </table>
        </div>

        <!-- Detail Hexdump Panel -->
        <div id="detail-panel"></div>
      </div>
    `;

    // Filter tab clicks
    document.getElementById('filter-tabs')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button.tab-btn');
      if (!btn) return;
      const filter = btn.getAttribute('data-filter') as FilterMode;
      if (filter) {
        this.filterMode = filter;
        document.querySelectorAll('button.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderTableRows();
      }
    });

    // Search input
    document.getElementById('search-input')?.addEventListener('input', (ev) => {
      this.searchQuery = (ev.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTableRows();
    });

    // Row clicks
    const tbody = document.getElementById('entries-tbody');
    tbody?.addEventListener('click', (ev) => {
      const tr = (ev.target as HTMLElement).closest('tr.entry-row');
      if (!tr) return;
      const idxStr = tr.getAttribute('data-idx');
      if (idxStr == null) return;
      const idx = parseInt(idxStr, 10);
      const entry = this.fs.get(idx);
      if (entry) {
        this.selectEntry(entry);
      }
    });

    this.renderTableRows();
    this.renderDetailPanel();
  }

  private getFilteredEntries(): DirEntry[] {
    return this.fs.entries.filter(e => {
      if (this.searchQuery && !e.name.toLowerCase().includes(this.searchQuery)) {
        return false;
      }
      if (this.filterMode === 'mapped') {
        return e.size > 0 && e.file !== 'PAD';
      }
      if (this.filterMode === 'virtual') {
        return e.size === 0 && e.file === 'NONE';
      }
      if (this.filterMode === 'pad') {
        return e.file === 'PAD';
      }
      return true;
    });
  }

  private renderTableRows() {
    const tbody = document.getElementById('entries-tbody');
    if (!tbody) return;

    const filtered = this.getFilteredEntries();
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding: 16px; text-align: center; color: #7982a9;">No matching directory entries found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(e => {
      const isSelected = this.selectedEntry?.idx === e.idx;
      const idxHex = `0x${e.idx.toString(16).padStart(2, '0')}`;
      const offsetHex = e.size > 0 ? `0x${e.startOffset.toString(16).padStart(6, '0')}` : 'none';
      const fileColor = e.file === 'STARA' ? '#89ddff' : (e.file === 'STARB' ? '#c792ea' : (e.file === 'PAD' ? '#5a628a' : '#7982a9'));

      return `
        <tr class="entry-row ${isSelected ? 'selected' : ''}" data-idx="${e.idx}">
          <td style="padding: 6px 12px; color: #f78c6c;">${idxHex}</td>
          <td style="padding: 6px 12px; color: #c3e88d; font-weight: bold;">${e.name}</td>
          <td style="padding: 6px 12px; color: ${fileColor};">${e.file}</td>
          <td style="padding: 6px 12px; color: #b2ccd6;">${offsetHex}</td>
          <td style="padding: 6px 12px; color: #b2ccd6;">${e.size > 0 ? e.size.toLocaleString() : '-'}</td>
          <td style="padding: 6px 12px; color: #b2ccd6;">${e.nblocks > 0 ? e.nblocks.toLocaleString() : '-'}</td>
          <td style="padding: 6px 12px; color: #b2ccd6;">${e.blockSize > 0 ? e.blockSize : '-'}</td>
          <td style="padding: 6px 12px; color: #b2ccd6;">0x${e.lsize.toString(16).padStart(2, '0')}</td>
        </tr>
      `;
    }).join('');
  }

  private selectEntry(entry: DirEntry) {
    this.selectedEntry = entry;
    this.currentPage = 0;

    const rows = document.querySelectorAll('tr.entry-row');
    rows.forEach(r => {
      const idxStr = r.getAttribute('data-idx');
      if (idxStr != null && parseInt(idxStr, 10) === entry.idx) {
        r.classList.add('selected');
        r.scrollIntoView({ block: 'nearest' });
      } else {
        r.classList.remove('selected');
      }
    });

    this.renderDetailPanel();
  }

  private renderDetailPanel() {
    const panel = document.getElementById('detail-panel');
    if (!panel) return;

    const entry = this.selectedEntry;
    if (!entry) {
      panel.innerHTML = `<div style="color: #7982a9; font-style: italic;">Select an entry to view its records and hexdump.</div>`;
      return;
    }

    const hasRecords = entry.blockSize > 0 && entry.nblocks > 0 && entry.size > 0;
    const totalRecords = entry.nblocks;
    const totalRawChunks = Math.ceil(entry.size / RAW_CHUNK_SIZE);

    let contentHtml = '';

    if (hasRecords) {
      const totalPages = Math.ceil(totalRecords / RECORDS_PER_PAGE);
      if (this.currentPage >= totalPages) this.currentPage = Math.max(0, totalPages - 1);

      const startRec = this.currentPage * RECORDS_PER_PAGE;
      const endRec = Math.min(startRec + RECORDS_PER_PAGE, totalRecords);

      const paginationHtml = `
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap;">
          <button class="btn" id="btn-first" ${this.currentPage === 0 ? 'disabled' : ''}>&laquo; First</button>
          <button class="btn" id="btn-prev" ${this.currentPage === 0 ? 'disabled' : ''}>&lsaquo; Prev</button>
          <span style="font-size: 12px; color: #b2ccd6; margin: 0 4px;">
            Showing records <strong>${startRec}</strong> &ndash; <strong>${Math.max(startRec, endRec - 1)}</strong> of <strong>${totalRecords.toLocaleString()}</strong> (Page ${this.currentPage + 1} of ${totalPages})
          </span>
          <button class="btn" id="btn-next" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Next &rsaquo;</button>
          <button class="btn" id="btn-last" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Last &raquo;</button>

          <span style="border-left: 1px solid #232a3d; height: 16px; margin: 0 6px;"></span>

          <label style="font-size: 12px; color: #7982a9;">Jump to Record:
            <input type="number" min="0" max="${totalRecords - 1}" id="jump-rec-input" class="input-num" value="${startRec}" />
          </label>
          <button class="btn" id="btn-jump">Go</button>
        </div>
      `;

      let recordsHtml = '';
      for (let r = startRec; r < endRec; r++) {
        const recBytes = entry.getRecord(r);
        const globalOffset = this.fs.getRecordOffset(entry, r);

        recordsHtml += `
          <div style="background: #12141f; border: 1px solid #232a3d; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px;">
              <span style="color: #c792ea; font-weight: bold;">Record #${r}</span>
              <span style="color: #7982a9;">Global Offset: <strong style="color: #89ddff;">0x${globalOffset.toString(16).padStart(6, '0')}</strong> (${entry.file}) | Length: ${recBytes.length} bytes</span>
            </div>
            <pre style="margin: 0; font-family: inherit; font-size: 12px; line-height: 1.4; overflow-x: auto;">${formatHexDumpHtml(recBytes, globalOffset)}</pre>
          </div>
        `;
      }

      contentHtml = paginationHtml + recordsHtml;

    } else if (entry.size > 0 && entry.data.length > 0) {
      const totalPages = Math.max(1, totalRawChunks);
      if (this.currentPage >= totalPages) this.currentPage = Math.max(0, totalPages - 1);

      const startByte = this.currentPage * RAW_CHUNK_SIZE;
      const endByte = Math.min(startByte + RAW_CHUNK_SIZE, entry.size);
      const chunkBytes = entry.data.subarray(startByte, endByte);
      const globalOffset = entry.startOffset + startByte;

      const paginationHtml = totalPages > 1 ? `
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap;">
          <button class="btn" id="btn-first" ${this.currentPage === 0 ? 'disabled' : ''}>&laquo; First</button>
          <button class="btn" id="btn-prev" ${this.currentPage === 0 ? 'disabled' : ''}>&lsaquo; Prev</button>
          <span style="font-size: 12px; color: #b2ccd6; margin: 0 4px;">
            Showing bytes <strong>${startByte}</strong> &ndash; <strong>${endByte}</strong> of <strong>${entry.size.toLocaleString()}</strong> (Page ${this.currentPage + 1} of ${totalPages})
          </span>
          <button class="btn" id="btn-next" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Next &rsaquo;</button>
          <button class="btn" id="btn-last" ${this.currentPage >= totalPages - 1 ? 'disabled' : ''}>Last &raquo;</button>
        </div>
      ` : '';

      contentHtml = `
        ${paginationHtml}
        <div style="background: #12141f; border: 1px solid #232a3d; border-radius: 6px; padding: 12px 16px;">
          <div style="margin-bottom: 8px; font-size: 12px; color: #7982a9;">
            Global Offset: <strong style="color: #89ddff;">0x${globalOffset.toString(16).padStart(6, '0')}</strong> (${entry.file}) | Continuous Data View
          </div>
          <pre style="margin: 0; font-family: inherit; font-size: 12px; line-height: 1.4; overflow-x: auto;">${formatHexDumpHtml(chunkBytes, globalOffset)}</pre>
        </div>
      `;
    } else {
      contentHtml = `
        <div style="background: #12141f; border: 1px solid #232a3d; border-radius: 6px; padding: 16px; color: #7982a9; font-size: 13px;">
          <p style="margin: 0 0 8px 0; color: #82aaff; font-weight: bold;">Virtual / In-Memory Schema Definition</p>
          <p style="margin: 0;">This entry has no allocated disk slice (size = 0, start = 0). It defines instance attributes with logical size = <strong>${entry.lsize} bytes</strong>.</p>
        </div>
      `;
    }

    panel.innerHTML = `
      <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 18px 20px;">
        <!-- Header Info -->
        <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #232a3d; padding-bottom: 12px; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
          <div>
            <span style="color: #7982a9; font-size: 12px;">Selected Entry:</span>
            <span style="color: #c3e88d; font-size: 18px; font-weight: bold; margin-left: 8px;">${entry.name}</span>
            <span style="background: #232a3d; color: #82aaff; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 8px;">Slot: 0x${entry.idx.toString(16).padStart(2, '0')} (${entry.idx})</span>
            <span style="background: #232a3d; color: #89ddff; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 4px;">File: ${entry.file}</span>
          </div>
          <div style="font-size: 12px; color: #b2ccd6;">
            Start: <strong style="color: #82aaff;">0x${entry.startOffset.toString(16).padStart(6, '0')}</strong> |
            Size: <strong style="color: #82aaff;">${entry.size.toLocaleString()} bytes</strong> |
            Records: <strong style="color: #c792ea;">${entry.nblocks}</strong> &times; <strong style="color: #c792ea;">${entry.blockSize}b</strong>
          </div>
        </div>

        <!-- 21-byte Directory Header Hexdump -->
        <div style="background: #11131c; border: 1px dashed #2b3247; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px;">
          <div style="font-size: 11px; color: #7982a9; text-transform: uppercase; margin-bottom: 4px;">
            Directory Table Record (21 bytes at STARA.COM offset 0x${entry.dirTableOffset.toString(16).padStart(4, '0')}):
          </div>
          <pre style="margin: 0; font-family: inherit; font-size: 12px; line-height: 1.4; overflow-x: auto;">${formatHexDumpHtml(entry.entryBytes, entry.dirTableOffset)}</pre>
        </div>

        <!-- Main Payload / Records -->
        <div style="font-size: 12px; color: #ffcb6b; font-weight: bold; margin-bottom: 10px;">Mapped Data / Records:</div>
        ${contentHtml}
      </div>
    `;

    // Pagination listeners
    document.getElementById('btn-first')?.addEventListener('click', () => {
      this.currentPage = 0;
      this.renderDetailPanel();
    });

    document.getElementById('btn-prev')?.addEventListener('click', () => {
      if (this.currentPage > 0) {
        this.currentPage--;
        this.renderDetailPanel();
      }
    });

    const totalPages = hasRecords
      ? Math.ceil(totalRecords / RECORDS_PER_PAGE)
      : Math.ceil(entry.size / RAW_CHUNK_SIZE);

    document.getElementById('btn-next')?.addEventListener('click', () => {
      if (this.currentPage < totalPages - 1) {
        this.currentPage++;
        this.renderDetailPanel();
      }
    });

    document.getElementById('btn-last')?.addEventListener('click', () => {
      this.currentPage = Math.max(0, totalPages - 1);
      this.renderDetailPanel();
    });

    const jumpInput = document.getElementById('jump-rec-input') as HTMLInputElement | null;
    const jumpBtn = document.getElementById('btn-jump');

    const handleJump = () => {
      if (!jumpInput) return;
      const targetRec = parseInt(jumpInput.value, 10);
      if (!isNaN(targetRec) && targetRec >= 0 && targetRec < totalRecords) {
        this.currentPage = Math.floor(targetRec / RECORDS_PER_PAGE);
        this.renderDetailPanel();
      }
    };

    jumpBtn?.addEventListener('click', handleJump);
    jumpInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') handleJump();
    });
  }
}

class GameScreen {
  private runner: ForthBootRunner;
  // Keys typed into the current run, and the animation frame that plays it in real time.
  private keysTyped = 0;
  private animationFrame = 0;
  private readonly speaker = new SpeakerAudio();
  // True while "Skip intro" runs the boot unpaced, until the intro-done breakpoint.
  private fastForward = false;
  // Whether a run exists, and the state its loop last reported; the loop pauses while the Game tab is not shown or
  // the page is hidden, and resumes from there.
  private started = false;
  private loopState: BootState = 'stopped';
  // The game options, kept while the Game tab is unmounted.
  private settings = { autoEga: true, skipIntro: false, sound: true, cpuSpeed: DEFAULT_CPU_SPEED };
  // Aborted on unmount: removes this mount's document listeners.
  private mounted?: AbortController;

  // STARFLT.COM, which save files name so they only load with the same game program.
  private readonly starflt: Uint8Array;

  constructor(forthEngine: ForthEngine, starflt: Uint8Array, fs: StarflightFS) {
    this.runner = new ForthBootRunner(forthEngine, starflt, fs);
    this.starflt = starflt;
  }

  // Add MU to the running game's bank account; false when no game is running.
  credit(amount: number): boolean {
    return this.started && this.runner.creditBalance(amount);
  }

  // The cheat word typed on the game screen: while the keys spell the start of it they are held back from the
  // game; the whole word credits the account and the game never sees it. Any other key, or a pause, passes the held
  // keys on first, so play is unaffected. Returns true when `key` was held.
  private heldKeys: string[] = [];
  private heldTimer = 0;

  private holdForCheat(key: string): boolean {
    const matches = (index: number) => key.length === 1 && key.toLowerCase() === CHEAT_WORD[index];
    window.clearTimeout(this.heldTimer);
    if (!matches(this.heldKeys.length)) {
      this.releaseHeldKeys();
      if (!matches(0)) return false;
    }
    this.heldKeys.push(key);
    if (this.heldKeys.length === CHEAT_WORD.length) {
      this.heldKeys = [];
      if (this.credit(CHEAT_AMOUNT)) console.info(`Credited ${CHEAT_AMOUNT.toLocaleString('en-US')} MU.`);
      return true;
    }
    this.heldTimer = window.setTimeout(() => this.releaseHeldKeys(), CHEAT_HOLD_MILLISECONDS);
    return true;
  }

  private releaseHeldKeys() {
    window.clearTimeout(this.heldTimer);
    const held = this.heldKeys;
    this.heldKeys = [];
    for (const name of held) {
      const key = biosKey(name);
      if (key !== undefined) this.sendKey(key);
    }
  }

  private sendKey(key: number) {
    if (this.runner.pressKey(key)) this.keysTyped++;
  }

  // Stop the animation loop and the sound, e.g. when another tab is shown. The run itself is kept.
  unmount(): void {
    this.mounted?.abort();
    this.mounted = undefined;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.speaker.silence();
  }

  mount(target: HTMLElement) {
    this.unmount();
    const mounted = new AbortController();
    this.mounted = mounted;
    const { signal } = mounted;
    target.innerHTML = `
      <div class="game-view">
        <canvas class="game-canvas" width="320" height="200" role="img" tabindex="0" aria-label="Starflight game screen, 320 by 200 pixels"></canvas>
        <section class="boot-console">
          <div class="boot-controls">
            <button id="run-forth-boot" class="btn" type="button">Run Forth Boot</button>
            <button id="save-game" class="btn" type="button" disabled>Save</button>
            <button id="load-game" class="btn" type="button">Load</button>
            <div class="save-files">
              <button id="save-files-button" class="btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="save-files-menu">Save files &#9662;</button>
              <div id="save-files-menu" class="save-files-menu" role="menu" aria-labelledby="save-files-button" hidden>
                <button id="download-save" type="button" role="menuitem">Download save file</button>
                <button id="upload-save" type="button" role="menuitem">Upload save file&hellip;</button>
              </div>
              <input id="upload-save-input" type="file" accept="${SAVE_FILE_EXTENSION},application/gzip,application/json" hidden>
            </div>
            <button id="full-screen" class="btn" type="button">Full screen</button>
            <label><input id="auto-ega" type="checkbox" checked> Auto-select EGA</label>
            <label><input id="skip-intro" type="checkbox"> Skip intro</label>
            <label><input id="sound" type="checkbox" checked> Sound</label>
            <label>CPU <select id="cpu-speed">${CPU_SPEEDS.map(({ label, rate }) =>
              `<option value="${rate}"${rate === DEFAULT_CPU_SPEED ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
            <span>Entry: W_0x0937 · 16-bit cells · 64K memory · click the screen and type to send keys</span>
          </div>
          <div id="forth-boot-status" role="status">Ready to start from the first Forth CFA.</div>
          <div id="checkpoint-status" role="status"></div>
          <pre id="forth-boot-trace">Boot trace will appear here.</pre>
        </section>
      </div>
    `;

    const canvas = this.containerCanvas(target);
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);

    const autoEga = target.querySelector<HTMLInputElement>('#auto-ega');
    const skipIntro = target.querySelector<HTMLInputElement>('#skip-intro');
    const cpuSpeed = target.querySelector<HTMLSelectElement>('#cpu-speed');
    const sound = target.querySelector<HTMLInputElement>('#sound');
    if (autoEga) autoEga.checked = this.settings.autoEga;
    if (skipIntro) skipIntro.checked = this.settings.skipIntro;
    if (sound) sound.checked = this.settings.sound;
    if (cpuSpeed) cpuSpeed.value = String(this.settings.cpuSpeed);
    const applyCpuSpeed = () => {
      this.settings.cpuSpeed = Number(cpuSpeed?.value ?? DEFAULT_CPU_SPEED);
      this.runner.setStepsPerMillisecond(this.settings.cpuSpeed);
    };
    applyCpuSpeed();
    // Answers the display-mode menu with "5. EGA" and Enter before the keys typed on the canvas.
    const egaKeys = [biosKey('5')!, biosKey('Enter')!];

    const status = target.querySelector<HTMLElement>('#forth-boot-status');
    const trace = target.querySelector<HTMLElement>('#forth-boot-trace');
    const saveButton = target.querySelector<HTMLButtonElement>('#save-game')!;
    const loadButton = target.querySelector<HTMLButtonElement>('#load-game')!;
    const checkpointStatus = target.querySelector<HTMLElement>('#checkpoint-status')!;
    saveButton.disabled = !this.started;

    const show = (state: BootState, updateTrace: boolean) => {
      const result = this.runner.snapshot();
      if (result.graphics) this.renderGraphicsScreen(canvas, result.graphics);
      else this.renderTextScreen(canvas, result.screen);
      const seconds = (this.runner.milliseconds / 1000).toFixed(1);
      const keys = `${autoEga?.checked ? 'EGA auto-selected · ' : ''}${this.keysTyped} key(s) typed`;
      const where = state === 'waiting' ? 'waiting for a key'
        : state === 'stopped' ? result.stopReason
        : this.fastForward ? 'skipping the intro at full speed' : 'running';
      if (status) status.textContent = `${result.steps} threaded steps (${seconds} s emulated) · ${keys} · ${where}`;
      if (trace && updateTrace) {
        const output = result.output ? `Output: ${result.output}\n\n` : '';
        const dropped = result.droppedTraceLines ? `… ${result.droppedTraceLines.toLocaleString()} earlier trace lines dropped; showing the last ${result.trace.length}\n` : '';
        trace.textContent = `${output}${dropped}${result.trace.join('\n')}`;
      }
    };

    // Run the boot in real time: each animation frame executes the steps for the time that has passed, so timed
    // waits such as the intro screens last as long as on the PC. A frame's slice is capped at 100 ms.
    const resume = (initialState: BootState) => {
      cancelAnimationFrame(this.animationFrame);
      this.loopState = initialState;
      let last = performance.now();
      let lastTrace = 0;
      let lastState = initialState;
      const tick = (now: number) => {
        const elapsed = Math.min(now - last, 100);
        last = now;
        let state: BootState;
        if (this.fastForward) {
          // As many steps as fit in about 15 ms, so the page stays responsive and the canvas keeps updating.
          do state = this.runner.advance(25_000);
          while (state === 'running' && performance.now() - now < 15);
          if (state === 'break') {
            this.fastForward = false;
            this.runner.clearBreakpoints();
          }
        } else {
          state = this.runner.advance(Math.round(elapsed * this.runner.stepsPerMillisecond));
        }
        const events = this.runner.takeSpeakerEvents();
        if (sound?.checked && !this.fastForward && state !== 'stopped' && !document.hidden) {
          this.speaker.play(events, this.runner.milliseconds, this.runner.speakerTone);
        } else {
          this.speaker.silence();
        }
        const updateTrace = state !== lastState || now - lastTrace > 1000;
        if (updateTrace) lastTrace = now;
        lastState = state;
        this.loopState = state;
        show(state, updateTrace);
        // A hidden page keeps no loop; visibilitychange resumes it.
        if (state !== 'stopped' && !document.hidden) this.animationFrame = requestAnimationFrame(tick);
      };
      show(initialState, true);
      if (initialState !== 'stopped' && !document.hidden) this.animationFrame = requestAnimationFrame(tick);
      canvas.focus();
    };
    const play = () => {
      this.speaker.resume();
      this.speaker.silence();
      this.keysTyped = 0;
      this.fastForward = skipIntro?.checked ?? false;
      this.runner.clearBreakpoints();
      if (this.fastForward) this.runner.setBreakpoint('GAME-OV', INTRO_DONE_CFA);
      this.settings.autoEga = autoEga?.checked ?? false;
      this.settings.skipIntro = skipIntro?.checked ?? false;
      this.runner.start(0x0937, autoEga?.checked ? egaKeys : []);
      this.started = true;
      saveButton.disabled = false;
      checkpointStatus.textContent = '';
      resume('running');
    };
    // The whole game for a checkpoint or a save file, and the way back.
    const snapshotGame = (): SavedGame => ({
      machine: this.runner.saveState(), keysTyped: this.keysTyped, fastForward: this.fastForward,
      autoEga: autoEga?.checked ?? false, skipIntro: skipIntro?.checked ?? false,
      cpuSpeed: this.runner.stepsPerMillisecond
    });
    const restoreGame = (saved: SavedGame) => {
      this.speaker.resume();
      this.speaker.silence();
      const state = this.runner.loadState(saved.machine);
      this.keysTyped = saved.keysTyped ?? 0;
      this.fastForward = saved.fastForward ?? false;
      if (autoEga) autoEga.checked = saved.autoEga;
      if (skipIntro) skipIntro.checked = saved.skipIntro;
      this.settings.autoEga = saved.autoEga;
      this.settings.skipIntro = saved.skipIntro;
      if (cpuSpeed && saved.cpuSpeed !== undefined && CPU_SPEEDS.some(({ rate }) => rate === saved.cpuSpeed)) {
        cpuSpeed.value = String(saved.cpuSpeed);
      }
      applyCpuSpeed();
      this.started = true;
      resume(state);
    };
    // Run one save or load at a time, with its progress and outcome in the checkpoint status line.
    const busy = async (message: string, action: () => Promise<string>) => {
      saveButton.disabled = true;
      loadButton.disabled = true;
      filesButton.disabled = true;
      checkpointStatus.textContent = message;
      try {
        checkpointStatus.textContent = await action();
      } catch (error) {
        checkpointStatus.textContent = error instanceof Error ? error.message : 'Checkpoint storage is unavailable.';
      } finally {
        saveButton.disabled = !this.started;
        loadButton.disabled = false;
        filesButton.disabled = false;
      }
    };
    const persist = (saving: boolean) => busy(saving ? 'Saving checkpoint...' : 'Loading checkpoint...', async () => {
      if (saving) {
        await gameCheckpoint(snapshotGame());
        return 'Checkpoint saved.';
      }
      const saved = await gameCheckpoint();
      if (!saved) throw new Error('No saved checkpoint.');
      restoreGame(saved);
      return 'Checkpoint loaded.';
    });

    // The "Save files" menu: download the running game as a file, or load one.
    const filesButton = target.querySelector<HTMLButtonElement>('#save-files-button')!;
    const filesMenu = target.querySelector<HTMLElement>('#save-files-menu')!;
    const downloadItem = target.querySelector<HTMLButtonElement>('#download-save')!;
    const uploadItem = target.querySelector<HTMLButtonElement>('#upload-save')!;
    const uploadInput = target.querySelector<HTMLInputElement>('#upload-save-input')!;
    const menuItems = [downloadItem, uploadItem];
    const setMenu = (open: boolean, focusButton = false) => {
      filesMenu.hidden = !open;
      filesButton.setAttribute('aria-expanded', String(open));
      downloadItem.disabled = !this.started;
      if (open) (menuItems.find(item => !item.disabled) ?? uploadItem).focus();
      else if (focusButton) filesButton.focus();
    };
    filesButton.addEventListener('click', () => setMenu(Boolean(filesMenu.hidden)));
    filesMenu.addEventListener('keydown', event => {
      const enabled = menuItems.filter(item => !item.disabled);
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') setMenu(false, true);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        enabled[(index + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
      } else return;
      event.stopPropagation();
    });
    document.addEventListener('click', event => {
      if (!filesMenu.hidden && !(event.target as Element).closest('.save-files')) setMenu(false);
    }, { signal });
    downloadItem.addEventListener('click', () => {
      setMenu(false, true);
      void busy('Preparing save file...', async () => {
        const blob = await encodeSaveFile(snapshotGame(), this.starflt);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = saveFileName();
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        return `Save file downloaded (${Math.ceil(blob.size / 1024).toLocaleString('en-US')} KB).`;
      });
    });
    uploadItem.addEventListener('click', () => {
      setMenu(false);
      uploadInput.click();
    });
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = '';
      if (!file) return;
      void busy(`Loading ${file.name}...`, async () => {
        const saved = await decodeSaveFile(file, this.starflt) as SavedGame;
        if (!saved || typeof saved !== 'object' || !saved.machine) throw new Error('This save file has no game in it.');
        restoreGame(saved);
        return `Loaded ${file.name}.`;
      });
    });
    saveButton.addEventListener('click', () => { void persist(true); });
    loadButton.addEventListener('click', () => { void persist(false); });
    target.querySelector('#run-forth-boot')?.addEventListener('click', play);
    autoEga?.addEventListener('change', play);
    skipIntro?.addEventListener('change', play);
    sound?.addEventListener('change', () => {
      this.settings.sound = sound.checked;
      if (sound.checked) this.speaker.resume();
      else this.speaker.silence();
      canvas.focus();
    });
    // A hidden page runs no loop at all; showing it again resumes the run where it was.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(this.animationFrame);
        this.animationFrame = 0;
        this.speaker.silence();
      } else if (this.started && this.animationFrame === 0) {
        resume(this.loopState);
      }
    }, { signal });
    cpuSpeed?.addEventListener('change', () => {
      applyCpuSpeed();
      canvas.focus();
    });

    // The canvas itself goes full screen; Esc leaves full screen instead of reaching the game.
    const fullScreenButton = target.querySelector<HTMLButtonElement>('#full-screen')!;
    fullScreenButton.disabled = !document.fullscreenEnabled;
    // Browsers may leave full screen on Esc themselves and still deliver the keydown; that Esc is not for the game.
    let leftFullScreen = -Infinity;
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) leftFullScreen = performance.now();
    }, { signal });
    fullScreenButton.addEventListener('click', () => {
      canvas.requestFullscreen().then(() => canvas.focus(), (error: unknown) => {
        checkpointStatus.textContent = error instanceof Error ? `Full screen is unavailable: ${error.message}` : 'Full screen is unavailable.';
      });
    });

    canvas.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (document.fullscreenElement === canvas || performance.now() - leftFullScreen < 500)) {
        event.preventDefault();
        if (document.fullscreenElement === canvas) void document.exitFullscreen();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (sound?.checked) this.speaker.resume(); // a key press may unlock audio the page could not start yet
      const key = biosKey(event.key);
      if (key === undefined) return;
      event.preventDefault();
      // Held keys auto-repeat faster than the game reads them; queueing every repeat would keep the player moving
      // after the key is released. Repeats only count once the game has taken the previous key.
      if (event.repeat && this.runner.pendingKeys > 0) return;
      if (!event.repeat && this.holdForCheat(event.key)) return;
      this.sendKey(key);
    });

    // Back on the Game tab: carry on with the run that was paused when another tab was shown.
    if (this.started) resume(this.loopState);
  }

  // Draw an EGA mode 0Dh picture; the default EGA palette maps its 16 color indices to the RGBI text colors.
  private renderGraphicsScreen(canvas: HTMLCanvasElement, screen: ForthGraphicsScreen) {
    canvas.width = screen.width;
    canvas.height = screen.height;
    canvas.setAttribute('aria-label', `Starflight EGA screen, ${screen.width} by ${screen.height} pixels`);
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(screen.width, screen.height);
    const rgb = TEXT_PALETTE.map(color => [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16)));
    screen.pixels.forEach((color, index) => {
      image.data.set([...rgb[color & 0x0f], 0xff], index * 4);
    });
    context.putImageData(image, 0, 0);
  }

  // Draw a BIOS text screen with 8x8 cells, as on CGA/EGA in 200-line text modes (640x200 for 80 columns).
  private renderTextScreen(canvas: HTMLCanvasElement, screen: ForthTextScreen) {
    canvas.width = screen.columns * 8;
    canvas.height = screen.rows * 8;
    canvas.setAttribute('aria-label', `Starflight text screen, ${screen.columns} by ${screen.rows} characters`);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '8px "Courier New", monospace';
    context.textBaseline = 'top';
    for (let row = 0; row < screen.rows; row++) {
      for (let col = 0; col < screen.columns; col++) {
        const cell = screen.cells[row * screen.columns + col];
        const attribute = cell >>> 8;
        context.fillStyle = TEXT_PALETTE[(attribute >>> 4) & 0x07]; // bit 7 is blink, not background intensity
        context.fillRect(col * 8, row * 8, 8, 8);
        const glyph = CP437[cell & 0xff];
        if (glyph === ' ') continue;
        context.fillStyle = TEXT_PALETTE[attribute & 0x0f];
        context.fillText(glyph, col * 8, row * 8, 8);
      }
    }
  }

  private containerCanvas(target: HTMLElement): HTMLCanvasElement | null {
    return target.querySelector<HTMLCanvasElement>('.game-canvas');
  }
}

class MainApp {
  private activeTab: ActiveTab = 'game';
  private explorerApp: ExplorerApp;
  private systemVisualizer: SystemVisualizer;
  private forthExplorer: ForthExplorer;
  private kernelDisassembler: KernelDisassembler;
  private gameScreen: GameScreen;

  constructor(fs: StarflightFS, systems: StarSystemInfo[], forthEngine: ForthEngine, starflt: Uint8Array) {
    this.explorerApp = new ExplorerApp(fs);
    this.systemVisualizer = new SystemVisualizer(systems, extractFluxes(fs.starb));
    this.forthExplorer = new ForthExplorer(forthEngine);
    this.kernelDisassembler = new KernelDisassembler(starflt);
    this.gameScreen = new GameScreen(forthEngine, starflt, fs);
  }


  mount() {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <div style="min-height: 100vh; display: flex; flex-direction: column;">
        <!-- Header & Nav -->
        <header style="background: #0b0d14; border-bottom: 1px solid #1f2537; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <h1 style="color: #82aaff; margin: 0; font-size: 20px; letter-spacing: 0.5px;">STARFLIGHT I &mdash; Reverse Engineering Lab</h1>
            <div style="font-size: 11px; color: #7982a9; margin-top: 2px;">
              STARA.COM + STARB.COM &bull; Virtual Forth OS &bull; 270 Star Systems &bull; 192 Directory Slots
            </div>
          </div>

          <!-- Top Navigation Tabs -->
          <nav style="display: flex; gap: 8px;">
            <button id="nav-btn-game" class="nav-tab ${this.activeTab === 'game' ? 'active' : ''}">
              Game
            </button>
            <button id="nav-btn-systems" class="nav-tab ${this.activeTab === 'systems' ? 'active' : ''}">
              &#9733; Star Systems & Galaxy
            </button>
            <button id="nav-btn-explorer" class="nav-tab ${this.activeTab === 'explorer' ? 'active' : ''}">
              &#9776; File System Explorer
            </button>
            <button id="nav-btn-forth" class="nav-tab ${this.activeTab === 'forth' ? 'active' : ''}">
              Forth Explorer
            </button>
            <button id="nav-btn-kernel" class="nav-tab ${this.activeTab === 'kernel' ? 'active' : ''}">
              STARFLT.COM x86
            </button>
          </nav>
        </header>

        <!-- Main Tab Content Area -->
        <main id="tab-content-area" style="padding: 24px; flex: 1;">
        </main>
      </div>
    `;

    document.getElementById('nav-btn-systems')?.addEventListener('click', () => {
      this.switchTab('systems');
    });

    document.getElementById('nav-btn-explorer')?.addEventListener('click', () => {
      this.switchTab('explorer');
    });

    document.getElementById('nav-btn-forth')?.addEventListener('click', () => {
      this.switchTab('forth');
    });

    document.getElementById('nav-btn-kernel')?.addEventListener('click', () => {
      this.switchTab('kernel');
    });

    document.getElementById('nav-btn-game')?.addEventListener('click', () => {
      this.switchTab('game');
    });

    this.renderCurrentTab();
    this.listenForCheats();
  }

  // An easter egg: typing "money" anywhere on the page except form fields credits the running game's bank account
  // with 100,000 MU. Nothing on the page hints at it. On the game screen GameScreen.holdForCheat handles it, so the
  // letters do not reach the game.
  private listenForCheats() {
    let typed = '';
    document.addEventListener('keydown', event => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      if (target?.closest('input, textarea, select, [contenteditable], canvas')) return; // typing there is not page input
      typed = (typed + event.key.toLowerCase()).slice(-CHEAT_WORD.length);
      if (typed === CHEAT_WORD && this.gameScreen.credit(CHEAT_AMOUNT)) {
        typed = '';
        console.info(`Credited ${CHEAT_AMOUNT.toLocaleString('en-US')} MU.`);
      }
    });
  }

  private switchTab(tab: ActiveTab) {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-btn-${tab}`)?.classList.add('active');

    this.renderCurrentTab();
  }

  private renderCurrentTab() {
    const content = document.getElementById('tab-content-area');
    if (!content) return;

    if (this.activeTab !== 'game') this.gameScreen.unmount();
    if (this.activeTab === 'systems') {
      this.systemVisualizer.mount(content);
    } else if (this.activeTab === 'explorer') {
      this.systemVisualizer.destroy();
      this.explorerApp.mount(content);
    } else if (this.activeTab === 'forth') {
      this.systemVisualizer.destroy();
      this.forthExplorer.mount(content);
    } else if (this.activeTab === 'kernel') {
      this.systemVisualizer.destroy();
      this.kernelDisassembler.mount(content);
    } else {
      this.systemVisualizer.destroy();
      this.gameScreen.mount(content);
    }
  }
}

// Fetch the game files as usual; take any the server lacks from the browser's cache, and ask the user for the rest.
async function main() {
  console.log("Loading Starflight game files...");
  const [fetched, forthDictResponse] = await Promise.all([fetchGameFiles(), fetch('forth-dict.json')]);
  const files = hasAllGameFiles(fetched) ? fetched : { ...(await loadCachedGameFiles()), ...fetched };
  if (!forthDictResponse.ok) {
    throw new Error(`Failed to load forth-dict.json: ${forthDictResponse.status} ${forthDictResponse.statusText}`);
  }
  const forthDict = await forthDictResponse.json();
  if (hasAllGameFiles(files)) {
    await startApp(files, forthDict);
    return;
  }
  console.log("Game files missing on the server and in the cache; asking for them.");
  const app = document.getElementById('app');
  if (!app) throw new Error('The page has no #app element.');
  showGameFilesPage(app, files, chosen => { startApp(chosen, forthDict).catch(console.error); });
}

async function startApp(files: GameFiles, forthDict: Parameters<typeof createForthEngine>[3]) {
  const { 'STARA.COM': stara, 'STARB.COM': starb, 'STARFLT.COM': starflt } = files;
  console.log("Loaded STARA.COM:", stara.byteLength, "bytes, STARB.COM:", starb.byteLength, "bytes");

  const fs = createStarflightFS(stara, starb);
  console.log(`Mapped all ${fs.entries.length} directory slots from Starflight virtual disk.`);

  const forthEngine = await createForthEngine(stara, starb, starflt, forthDict);
  console.log(`Loaded ${forthEngine.words.length} Forth words across ${forthEngine.modules.length} modules.`);

  console.log("Extracting star systems and planets from STARB.COM instance tree...");
  const planetFile = fs.get('PLANET');
  // PLSET-OV's LO-MASS and HI-MASS tables (DOES> words: the cell at PFA + 2 * class), for the planets' mass roll.
  const massTable = (name: string) => {
    const word = forthEngine.words.find(candidate => candidate.name === name && candidate.module === 'PLSET-OV');
    const memory = forthEngine.overlays.get('PLSET-OV')?.memory;
    return word && memory ? (planetClass: number) => {
      const address = word.pfa + planetClass * 2;
      return memory[address] | (memory[address + 1] << 8);
    } : undefined;
  };
  const low = massTable('LO-MASS'), high = massTable('HI-MASS');
  const systems = extractStarSystems(fs.starb, {
    planetRecord: species => planetFile && fs.getRecord(planetFile, species),
    starflt: new Uint8Array(starflt),
    massTables: low && high ? { low, high } : undefined
  });
  console.log(`Extracted ${systems.length} star systems.`);
  markColonizablePlanets(systems);
  markLocations(systems);

  // Expose on window for easy browser console exploration
  (window as unknown as { starflightFS: StarflightFS; starSystems: StarSystemInfo[] }).starflightFS = fs;
  (window as unknown as { starflightFS: StarflightFS; starSystems: StarSystemInfo[] }).starSystems = systems;

  // Mount Application
  if (typeof document !== 'undefined') {
    const mainApp = new MainApp(fs, systems, forthEngine, new Uint8Array(starflt));
    mainApp.mount();
  }
}

main().catch(console.error);