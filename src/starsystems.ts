/**
 * Starflight Star System & Planet Extractor
 *
 * Extracts all 270 star systems and their planets directly from the
 * INSTANCE tree in STARB.COM (starting from IROOT 0x1006).
 */

export interface PlanetInfo {
  addr: number;
  addrHex: string;
  orbit: number;           // 1 to 8
  species: number;         // Planet classification code
  typeName: string;        // Human-readable type (e.g. Terrestrial, Gas Giant, Molten)
  category: string;
  color: string;
  radius: number;
  isArth: boolean;
  hasStarport: boolean;
  childAddr: number;
}

export interface StarSystemInfo {
  addr: number;
  addrHex: string;
  spectralType: string;    // 'O', 'B', 'A', 'F', 'G', 'K', 'M'
  spectralName: string;
  spectralColor: string;
  starColor: string;
  species: number;
  x: number;               // 0 to 250
  y: number;               // 0 to 250
  flaredate: number;       // Days relative to game start
  flareStatus: 'flared' | 'critical' | 'stable';
  orbitmask: number;
  loggedmask: number;
  nplanets: number;
  planets: PlanetInfo[];
  isHomeSystem: boolean;
}

function read24(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function countSetBits(n: number): number {
  let count = 0;
  let val = n;
  while (val > 0) {
    if ((val & 1) === 1) count++;
    val >>= 1;
  }
  return count;
}

export function getSpectralDetails(spectralType: string): { name: string; color: string; starGlow: string } {
  switch (spectralType.toUpperCase()) {
    case 'O':
      return { name: 'Class O (Blue Supergiant)', color: '#689dff', starGlow: 'rgba(104, 157, 255, 0.4)' };
    case 'B':
      return { name: 'Class B (Blue-White)', color: '#9ac2ff', starGlow: 'rgba(154, 194, 255, 0.4)' };
    case 'A':
      return { name: 'Class A (White Star)', color: '#ffffff', starGlow: 'rgba(255, 255, 255, 0.4)' };
    case 'F':
      return { name: 'Class F (Yellow-White)', color: '#fff1a8', starGlow: 'rgba(255, 241, 168, 0.4)' };
    case 'G':
      return { name: 'Class G (Yellow Dwarf)', color: '#ffdc47', starGlow: 'rgba(255, 220, 71, 0.4)' };
    case 'K':
      return { name: 'Class K (Orange Dwarf)', color: '#ffa043', starGlow: 'rgba(255, 160, 67, 0.4)' };
    case 'M':
      return { name: 'Class M (Red Dwarf)', color: '#ff5454', starGlow: 'rgba(255, 84, 84, 0.4)' };
    default:
      return { name: `Class ${spectralType}`, color: '#ffcb6b', starGlow: 'rgba(255, 203, 107, 0.4)' };
  }
}

export function getPlanetTypeInfo(species: number, isArth: boolean): { name: string; category: string; color: string; radius: number } {
  if (isArth) {
    return { name: 'Arth (Homeworld)', category: 'Terrestrial', color: '#4ecdc4', radius: 9 };
  }
  if (species >= 1 && species <= 8) {
    return { name: `Gas Giant (${species})`, category: 'Gas Giant', color: '#e0a96d', radius: 11 };
  } else if (species >= 9 && species <= 12) {
    return { name: `Glaciated / Ice (${species})`, category: 'Ice World', color: '#88d8f7', radius: 6 };
  } else if (species >= 13 && species <= 16) {
    return { name: `Molten / Volcanic (${species})`, category: 'Volcanic', color: '#f75a38', radius: 6 };
  } else if (species >= 17 && species <= 24) {
    return { name: `Rocky / Mineral (${species})`, category: 'Rocky', color: '#9e978e', radius: 5 };
  } else if (species >= 25 && species <= 35) {
    return { name: `Acidic / Toxic (${species})`, category: 'Toxic', color: '#a3d944', radius: 6 };
  } else if (species >= 36 && species <= 45) {
    return { name: `Oceanic / Water (${species})`, category: 'Oceanic', color: '#38a3f7', radius: 7 };
  } else if (species >= 46 && species <= 60) {
    return { name: `Terrestrial / Biosphere (${species})`, category: 'Terrestrial', color: '#68d391', radius: 7 };
  } else {
    return { name: `Exotic (${species})`, category: 'Exotic', color: '#c792ea', radius: 6 };
  }
}

interface InstanceNode {
  addr: number;
  next: number;
  prev: number;
  child: number;
  cls: number;
  species: number;
}

/**
 * Extracts and reconstructs all star systems from STARB.COM instance graph.
 */
export function extractStarSystems(starb: Uint8Array): StarSystemInfo[] {
  const visited = new Set<number>();
  const nodeMap = new Map<number, InstanceNode>();
  const queue: number[] = [0x1006]; // IROOT address

  // Breadth-first traversal of the entire instance tree
  while (queue.length > 0) {
    const addr = queue.shift()!;
    if (visited.has(addr) || addr === 0 || addr >= starb.length - 16) continue;
    visited.add(addr);

    const next = read24(starb, addr);
    const prev = read24(starb, addr + 3);
    const child = read24(starb, addr + 6);
    const cls = starb[addr + 9];
    const species = starb[addr + 10];

    nodeMap.set(addr, { addr, next, prev, child, cls, species });

    if (next !== 0 && !visited.has(next)) queue.push(next);
    if (child !== 0 && !visited.has(child)) queue.push(child);
  }

  const systems: StarSystemInfo[] = [];

  // Parse all STARSYSTEM nodes (cls === 0x17)
  for (const [addr, node] of nodeMap) {
    if (node.cls !== 0x17) continue;

    const spectralType = String.fromCharCode(node.species) || '?';
    const spectralInfo = getSpectralDetails(spectralType);

    // Signed 16-bit flare date
    const rawFlare = (starb[addr + 11] | (starb[addr + 12] << 8));
    const flaredate = (rawFlare << 16) >> 16;

    let flareStatus: 'flared' | 'critical' | 'stable' = 'stable';
    if (flaredate <= 0) {
      flareStatus = 'flared';
    } else if (flaredate < 200) {
      flareStatus = 'critical';
    }

    const x = (starb[addr + 13] | (starb[addr + 14] << 8)) >> 3;
    const y = (starb[addr + 15] | (starb[addr + 16] << 8)) >> 3;
    const rawOrbitMask = starb[addr + 17];
    const loggedmask = starb[addr + 18];
    const nplanets = countSetBits(rawOrbitMask);

    const planets: PlanetInfo[] = [];
    let orbitmask = rawOrbitMask;

    if (nplanets > 0 && node.child !== 0) {
      let nextAddr = node.child;
      let orbit = 0;

      for (let j = 0; j < nplanets; j++) {
        // Advance orbit counter until bit is 1
        while ((orbitmask & 1) === 0 && orbit < 8) {
          orbitmask >>= 1;
          orbit++;
        }
        orbitmask >>= 1;
        orbit++;

        const pNode = nodeMap.get(nextAddr);
        if (!pNode) break;

        let actualPlanetAddr = nextAddr;
        let actualNode = pNode;

        // In Starflight, system contents are wrapped in BOX (cls 0x0b)
        if (pNode.cls === 0x0b) {
          const boxChild = nodeMap.get(pNode.child);
          if (boxChild && boxChild.cls === 0x18) { // Central Star
            const sib = nodeMap.get(pNode.next);
            if (sib) {
              actualNode = nodeMap.get(sib.child) || sib;
              actualPlanetAddr = actualNode.addr;
              nextAddr = sib.next;
            }
          } else if (boxChild) {
            actualNode = boxChild;
            actualPlanetAddr = actualNode.addr;
            nextAddr = pNode.next;
          }
        } else {
          nextAddr = pNode.next;
        }

        const pSpecies = actualNode.species;
        const hasStarport = actualNode.child !== 0 && nodeMap.get(actualNode.child)?.cls === 0x0c;
        const isArth = hasStarport || (x === 125 && y === 100 && orbit === 3);
        const typeInfo = getPlanetTypeInfo(pSpecies, isArth);

        planets.push({
          addr: actualPlanetAddr,
          addrHex: `0x${actualPlanetAddr.toString(16).padStart(4, '0')}`,
          orbit,
          species: pSpecies,
          typeName: typeInfo.name,
          category: typeInfo.category,
          color: typeInfo.color,
          radius: typeInfo.radius,
          isArth,
          hasStarport,
          childAddr: actualNode.child
        });
      }
    }

    const isHomeSystem = x === 125 && y === 100;

    systems.push({
      addr,
      addrHex: `0x${addr.toString(16).padStart(4, '0')}`,
      spectralType,
      spectralName: spectralInfo.name,
      spectralColor: spectralInfo.color,
      starColor: spectralInfo.starGlow,
      species: node.species,
      x,
      y,
      flaredate,
      flareStatus,
      orbitmask: rawOrbitMask,
      loggedmask,
      nplanets,
      planets,
      isHomeSystem
    });
  }

  // Sort: Home system first, then by coordinates (x, y)
  systems.sort((a, b) => {
    if (a.isHomeSystem) return -1;
    if (b.isHomeSystem) return 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });

  return systems;
}
