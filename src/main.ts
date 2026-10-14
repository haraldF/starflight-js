import './style.css';
import { createStarflightFS, type StarflightFS, type DirEntry } from './starflight-fs';
import { extractStarSystems, type StarSystemInfo } from './starsystems';
import { SystemVisualizer } from './system-visualizer';

const RECORDS_PER_PAGE = 20;
const RAW_CHUNK_SIZE = 512;

type FilterMode = 'all' | 'mapped' | 'virtual' | 'pad';
type ActiveTab = 'explorer' | 'systems';

async function loadStar(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

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

class MainApp {
  private activeTab: ActiveTab = 'systems'; // Start with the star system visualizer!
  private explorerApp: ExplorerApp;
  private systemVisualizer: SystemVisualizer;

  constructor(fs: StarflightFS, systems: StarSystemInfo[]) {
    this.explorerApp = new ExplorerApp(fs);
    this.systemVisualizer = new SystemVisualizer(systems);
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
            <button id="nav-btn-systems" class="nav-tab ${this.activeTab === 'systems' ? 'active' : ''}">
              &#9733; Star Systems & Galaxy
            </button>
            <button id="nav-btn-explorer" class="nav-tab ${this.activeTab === 'explorer' ? 'active' : ''}">
              &#9776; File System Explorer
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

    this.renderCurrentTab();
  }

  private switchTab(tab: ActiveTab) {
    if (this.activeTab === tab) return;
    this.activeTab = tab;

    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    if (tab === 'systems') {
      document.getElementById('nav-btn-systems')?.classList.add('active');
    } else {
      document.getElementById('nav-btn-explorer')?.classList.add('active');
    }

    this.renderCurrentTab();
  }

  private renderCurrentTab() {
    const content = document.getElementById('tab-content-area');
    if (!content) return;

    if (this.activeTab === 'systems') {
      this.systemVisualizer.mount(content);
    } else {
      this.systemVisualizer.destroy();
      this.explorerApp.mount(content);
    }
  }
}

async function main() {
  console.log("Loading Starflight game files...");
  const [stara, starb] = await Promise.all([
    loadStar('STARA.COM'),
    loadStar('STARB.COM')
  ]);

  console.log("Downloaded STARA.COM:", stara.byteLength, "bytes, STARB.COM:", starb.byteLength, "bytes");

  const fs = createStarflightFS(stara, starb);
  console.log(`Mapped all ${fs.entries.length} directory slots from Starflight virtual disk.`);

  console.log("Extracting star systems and planets from STARB.COM instance tree...");
  const systems = extractStarSystems(fs.starb);
  console.log(`Extracted ${systems.length} star systems.`);

  // Expose on window for easy browser console exploration
  (window as unknown as { starflightFS: StarflightFS; starSystems: StarSystemInfo[] }).starflightFS = fs;
  (window as unknown as { starflightFS: StarflightFS; starSystems: StarSystemInfo[] }).starSystems = systems;

  // Mount Application
  if (typeof document !== 'undefined') {
    const mainApp = new MainApp(fs, systems);
    mainApp.mount();
  }
}

main().catch(console.error);