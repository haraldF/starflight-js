/**
 * Starflight Star System & Galaxy Visualizer
 *
 * Provides an interactive 2D Galaxy Map (250x250 coordinate space)
 * and an animated Solar System Orbital View for inspecting stars and planets.
 */

import { type StarSystemInfo, type PlanetInfo } from './starsystems';

export class SystemVisualizer {
  private systems: StarSystemInfo[];
  private selectedSystem: StarSystemInfo;
  private selectedPlanet: PlanetInfo | null = null;
  private container: HTMLElement | null = null;
  private galaxyCanvas: HTMLCanvasElement | null = null;
  private orbitCanvas: HTMLCanvasElement | null = null;
  private animFrameId: number | null = null;
  private orbitAngles: number[] = [0, 0.8, 2.1, 3.4, 4.2, 5.1, 1.2, 2.7];
  private hoveredSystem: StarSystemInfo | null = null;
  private filterType: string = 'all';
  private searchQuery: string = '';

  constructor(systems: StarSystemInfo[]) {
    this.systems = systems;
    // Default selected system: Arth (125, 100)
    this.selectedSystem = systems.find(s => s.isHomeSystem) ?? systems[0];
  }

  mount(target: HTMLElement) {
    this.container = target;
    this.renderLayout();
    this.initGalaxyCanvas();
    this.initOrbitCanvas();
    this.startAnimation();
  }

  destroy() {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private renderLayout() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <!-- Top Toolbar -->
        <div style="display: flex; justify-content: space-between; align-items: center; background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 12px 18px; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <button class="btn" id="btn-jump-arth" style="background: #1e3a5f; border-color: #388bfd; color: #82aaff; font-weight: bold;">
              &#9678; Jump to Arth (125, 100)
            </button>
            <div style="font-size: 12px; color: #7982a9;">
              Total Stars: <strong style="color: #c792ea;">${this.systems.length}</strong> | 
              Total Planets: <strong style="color: #89ddff;">${this.systems.reduce((acc, s) => acc + s.planets.length, 0)}</strong>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: center;">
            <select id="filter-spectral" class="btn" style="padding: 4px 8px;">
              <option value="all">All Spectral Classes</option>
              <option value="O">Class O (Blue Supergiant)</option>
              <option value="B">Class B (Blue-White)</option>
              <option value="A">Class A (White)</option>
              <option value="F">Class F (Yellow-White)</option>
              <option value="G">Class G (Yellow Dwarf - Arth)</option>
              <option value="K">Class K (Orange Dwarf)</option>
              <option value="M">Class M (Red Dwarf)</option>
              <option value="flared">Flared / Hazard Stars</option>
            </select>

            <input type="text" id="sys-search" placeholder="Search coords (e.g. 125, 100)..." 
              style="background: #11131c; border: 1px solid #363e58; color: #c3ccdb; padding: 4px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; width: 200px;" />
          </div>
        </div>

        <!-- Main 2-Column Grid -->
        <div style="display: grid; grid-template-columns: 460px 1fr; gap: 20px; align-items: start;">
          <!-- Left Column: Galaxy Map -->
          <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
              <h3 style="color: #ffcb6b; margin: 0; font-size: 15px;">Galaxy Sector Starmap</h3>
              <span style="font-size: 11px; color: #7982a9;">Coordinates: 0..250 &times; 0..250</span>
            </div>

            <div style="position: relative; width: 420px; height: 420px; margin: 0 auto; background: #0b0d14; border: 1px solid #1f2537; border-radius: 6px; overflow: hidden;">
              <canvas id="galaxy-canvas" width="420" height="420" style="display: block; cursor: crosshair;"></canvas>
              <div id="galaxy-tooltip" style="position: absolute; pointer-events: none; display: none; background: rgba(18, 22, 34, 0.95); border: 1px solid #82aaff; border-radius: 4px; padding: 6px 10px; font-size: 11px; color: #c3ccdb; white-space: nowrap; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5);"></div>
            </div>

            <!-- Spectral Legend -->
            <div style="display: flex; justify-content: space-between; margin-top: 14px; font-size: 10px; color: #7982a9; padding: 0 4px;">
              <span><span style="color: #689dff;">&#9679;</span> O</span>
              <span><span style="color: #9ac2ff;">&#9679;</span> B</span>
              <span><span style="color: #ffffff;">&#9679;</span> A</span>
              <span><span style="color: #fff1a8;">&#9679;</span> F</span>
              <span><span style="color: #ffdc47;">&#9679;</span> G</span>
              <span><span style="color: #ffa043;">&#9679;</span> K</span>
              <span><span style="color: #ff5454;">&#9679;</span> M</span>
              <span><span style="color: #ff3366;">&#9678;</span> Flared</span>
            </div>
          </div>

          <!-- Right Column: Solar System Orbital View & Telemetry -->
          <div style="display: flex; flex-direction: column; gap: 20px;">
            <!-- System Canvas Card -->
            <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 18px 20px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #232a3d; padding-bottom: 12px; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
                <div>
                  <span style="color: #7982a9; font-size: 12px;">Star System:</span>
                  <span id="sys-title" style="color: #c3e88d; font-size: 18px; font-weight: bold; margin-left: 8px;">
                    ${this.selectedSystem.isHomeSystem ? 'Arth System (Home)' : `Star (${this.selectedSystem.x}, ${this.selectedSystem.y})`}
                  </span>
                  <span id="sys-class-badge" style="background: #232a3d; color: ${this.selectedSystem.spectralColor}; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; border: 1px solid ${this.selectedSystem.spectralColor}44;">
                    ${this.selectedSystem.spectralName}
                  </span>
                </div>
                <div style="font-size: 12px; color: #b2ccd6;" id="sys-stats">
                  Coords: <strong style="color: #82aaff;">(${this.selectedSystem.x}, ${this.selectedSystem.y})</strong> | 
                  Planets: <strong style="color: #c792ea;">${this.selectedSystem.nplanets}</strong> | 
                  Flare Date: <strong style="color: ${this.selectedSystem.flaredate <= 0 ? '#ff5454' : '#ffcb6b'};">${this.selectedSystem.flaredate} days</strong>
                </div>
              </div>

              <!-- Orbit Canvas -->
              <div style="position: relative; width: 100%; height: 380px; background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; overflow: hidden;">
                <canvas id="orbit-canvas" width="600" height="380" style="display: block; width: 100%; height: 100%; cursor: pointer;"></canvas>
              </div>
            </div>

            <!-- Planets Roster Card -->
            <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 18px 20px;">
              <h4 style="color: #ffcb6b; margin: 0 0 12px 0; font-size: 14px;">Planetary Roster (${this.selectedSystem.planets.length} bodies)</h4>
              <div id="planet-cards-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;">
                ${this.renderPlanetCardsHtml()}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('btn-jump-arth')?.addEventListener('click', () => {
      const arth = this.systems.find(s => s.isHomeSystem);
      if (arth) this.selectSystem(arth);
    });

    const filterSelect = document.getElementById('filter-spectral') as HTMLSelectElement | null;
    filterSelect?.addEventListener('change', () => {
      this.filterType = filterSelect.value;
      this.drawGalaxy();
    });

    const searchInput = document.getElementById('sys-search') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.drawGalaxy();
    });
  }

  private renderPlanetCardsHtml(): string {
    if (this.selectedSystem.planets.length === 0) {
      return `<div style="color: #7982a9; font-style: italic; grid-column: 1 / -1; padding: 8px 0;">No planets detected in this system.</div>`;
    }

    return this.selectedSystem.planets.map(p => `
      <div class="planet-card ${this.selectedPlanet?.addr === p.addr ? 'selected' : ''}" data-addr="${p.addr}"
        style="background: #11131c; border: 1px solid ${p.isArth ? '#4ecdc4' : '#232a3d'}; border-radius: 6px; padding: 12px; cursor: pointer; transition: all 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: ${p.color}; box-shadow: 0 0 8px ${p.color}88;"></div>
          <strong style="color: ${p.isArth ? '#4ecdc4' : '#c3e88d'}; font-size: 13px;">
            ${p.isArth ? 'Arth' : `Planet (Orbit ${p.orbit})`}
          </strong>
        </div>
        <div style="font-size: 11px; color: #7982a9;">Type: <span style="color: #b2ccd6;">${p.typeName}</span></div>
        <div style="font-size: 11px; color: #7982a9;">Category: <span style="color: #89ddff;">${p.category}</span></div>
        ${p.hasStarport ? `<div style="font-size: 11px; color: #ffcb6b; margin-top: 4px; font-weight: bold;">&#9733; Starport Colony Facility</div>` : ''}
        <div style="font-size: 10px; color: #545c7e; margin-top: 6px;">STARB Offset: ${p.addrHex}</div>
      </div>
    `).join('');
  }

  private selectSystem(system: StarSystemInfo) {
    this.selectedSystem = system;
    this.selectedPlanet = null;

    // Update DOM headers
    const titleEl = document.getElementById('sys-title');
    if (titleEl) {
      titleEl.innerText = system.isHomeSystem ? 'Arth System (Home)' : `Star (${system.x}, ${system.y})`;
    }

    const badgeEl = document.getElementById('sys-class-badge');
    if (badgeEl) {
      badgeEl.innerText = system.spectralName;
      badgeEl.style.color = system.spectralColor;
      badgeEl.style.borderColor = `${system.spectralColor}44`;
    }

    const statsEl = document.getElementById('sys-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        Coords: <strong style="color: #82aaff;">(${system.x}, ${system.y})</strong> | 
        Planets: <strong style="color: #c792ea;">${system.nplanets}</strong> | 
        Flare Date: <strong style="color: ${system.flaredate <= 0 ? '#ff5454' : '#ffcb6b'};">${system.flaredate} days</strong>
      `;
    }

    // Refresh planet cards
    const container = document.getElementById('planet-cards-container');
    if (container) {
      container.innerHTML = this.renderPlanetCardsHtml();
    }

    this.drawGalaxy();
  }

  private initGalaxyCanvas() {
    this.galaxyCanvas = document.getElementById('galaxy-canvas') as HTMLCanvasElement | null;
    if (!this.galaxyCanvas) return;

    const canvas = this.galaxyCanvas;
    const tooltip = document.getElementById('galaxy-tooltip');

    const getSystemAtCoord = (mx: number, my: number): StarSystemInfo | null => {
      const padding = 15;
      const innerSize = 420 - padding * 2;
      const scale = innerSize / 250;

      for (const sys of this.systems) {
        const sx = padding + sys.x * scale;
        const sy = padding + (250 - sys.y) * scale; // Invert Y so 250 is top
        const dist = Math.hypot(mx - sx, my - sy);
        if (dist <= 6) return sys;
      }
      return null;
    };

    canvas.addEventListener('mousemove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const sys = getSystemAtCoord(mx, my);

      this.hoveredSystem = sys;
      this.drawGalaxy();

      if (sys && tooltip) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${Math.min(mx + 12, 280)}px`;
        tooltip.style.top = `${Math.max(my - 30, 10)}px`;
        tooltip.innerHTML = `
          <strong style="color: ${sys.spectralColor};">${sys.isHomeSystem ? 'Arth System (Home)' : `Star (${sys.x}, ${sys.y})`}</strong><br/>
          Class: ${sys.spectralType} | Planets: ${sys.nplanets} | Flare: ${sys.flaredate}d
        `;
      } else if (tooltip) {
        tooltip.style.display = 'none';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      this.hoveredSystem = null;
      if (tooltip) tooltip.style.display = 'none';
      this.drawGalaxy();
    });

    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const sys = getSystemAtCoord(mx, my);
      if (sys) {
        this.selectSystem(sys);
      }
    });

    this.drawGalaxy();
  }

  private drawGalaxy() {
    if (!this.galaxyCanvas) return;
    const ctx = this.galaxyCanvas.getContext('2d');
    if (!ctx) return;

    const width = this.galaxyCanvas.width;
    const height = this.galaxyCanvas.height;
    ctx.clearRect(0, 0, width, height);

    // Draw background grid lines (every 50 units)
    const padding = 15;
    const innerSize = width - padding * 2;
    const scale = innerSize / 250;

    ctx.strokeStyle = '#141824';
    ctx.lineWidth = 1;
    for (let c = 0; c <= 250; c += 50) {
      const pos = padding + c * scale;
      // Vertical
      ctx.beginPath();
      ctx.moveTo(pos, padding);
      ctx.lineTo(pos, height - padding);
      ctx.stroke();
      // Horizontal
      ctx.beginPath();
      ctx.moveTo(padding, pos);
      ctx.lineTo(width - padding, pos);
      ctx.stroke();
    }

    // Filter systems
    const filtered = this.systems.filter(s => {
      if (this.filterType === 'flared') {
        if (s.flaredate > 0) return false;
      } else if (this.filterType !== 'all') {
        if (s.spectralType.toUpperCase() !== this.filterType) return false;
      }
      if (this.searchQuery) {
        const coordStr = `${s.x},${s.y}`;
        if (!coordStr.includes(this.searchQuery.replace(/\s+/g, ''))) return false;
      }
      return true;
    });

    // Draw stars
    for (const sys of filtered) {
      const sx = padding + sys.x * scale;
      const sy = padding + (250 - sys.y) * scale;
      const isSelected = sys.addr === this.selectedSystem.addr;
      const isHovered = sys.addr === this.hoveredSystem?.addr;

      // Glow if selected or hovered
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(sx, sy, isSelected ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(130, 170, 255, 0.35)' : 'rgba(255, 255, 255, 0.2)';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#82aaff' : '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Star point
      ctx.beginPath();
      const radius = sys.spectralType === 'O' || sys.spectralType === 'B' ? 2.5 : 2;
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = sys.spectralColor;
      ctx.fill();

      // Home system badge
      if (sys.isHomeSystem) {
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Flared indicator
      if (sys.flaredate <= 0) {
        ctx.strokeStyle = 'rgba(255, 50, 80, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 3, sy - 3, 6, 6);
      }
    }
  }

  private initOrbitCanvas() {
    this.orbitCanvas = document.getElementById('orbit-canvas') as HTMLCanvasElement | null;
  }

  private startAnimation() {
    const animate = () => {
      this.drawSolarSystem();
      // Slowly advance orbital angles
      for (let i = 0; i < this.orbitAngles.length; i++) {
        // Outer planets move slower: Kepler's 3rd law approximation
        const speed = 0.008 / Math.sqrt(i + 1);
        this.orbitAngles[i] = (this.orbitAngles[i] + speed) % (Math.PI * 2);
      }
      this.animFrameId = requestAnimationFrame(animate);
    };
    this.animFrameId = requestAnimationFrame(animate);
  }

  private drawSolarSystem() {
    if (!this.orbitCanvas) return;
    const ctx = this.orbitCanvas.getContext('2d');
    if (!ctx) return;

    const width = this.orbitCanvas.width;
    const height = this.orbitCanvas.height;
    ctx.clearRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;

    // Draw central star
    const starColor = this.selectedSystem.spectralColor;
    const starGlow = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 38);
    starGlow.addColorStop(0, starColor);
    starGlow.addColorStop(0.3, starColor);
    starGlow.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(centerX, centerY, 38, 0, Math.PI * 2);
    ctx.fillStyle = starGlow;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 15, 0, Math.PI * 2);
    ctx.fillStyle = starColor;
    ctx.shadowColor = starColor;
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label star
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.selectedSystem.spectralType, centerX, centerY + 3);

    // Orbit radii (8 rings)
    const orbitRadii = [42, 64, 86, 108, 130, 152, 172, 192];

    for (let o = 0; o < 8; o++) {
      const r = orbitRadii[o];
      const hasPlanet = this.selectedSystem.planets.some(p => p.orbit === o + 1);

      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.strokeStyle = hasPlanet ? '#2a334d' : '#171b26';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw planets
    for (const planet of this.selectedSystem.planets) {
      const orbitIdx = Math.max(0, Math.min(planet.orbit - 1, 7));
      const r = orbitRadii[orbitIdx];
      const angle = this.orbitAngles[orbitIdx];
      const px = centerX + Math.cos(angle) * r;
      const py = centerY + Math.sin(angle) * r;

      // Planet body
      ctx.beginPath();
      ctx.arc(px, py, planet.radius, 0, Math.PI * 2);
      ctx.fillStyle = planet.color;
      ctx.shadowColor = planet.color;
      ctx.shadowBlur = planet.isArth ? 10 : 4;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Special highlight for Arth
      if (planet.isArth) {
        ctx.beginPath();
        ctx.arc(px, py, planet.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#4ecdc4';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('ARTH (Homeworld)', px + planet.radius + 6, py + 4);
      } else {
        ctx.fillStyle = '#7982a9';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Orbit ${planet.orbit}`, px + planet.radius + 5, py + 3);
      }
    }
  }
}
