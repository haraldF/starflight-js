/**
 * Named places in Starflight I, as listed by the Starflight Resource Pages:
 * http://www.starflt.com/tables/index.php/starflight1/locations/
 *
 * Planets are numbered by their position from the star, as on the colonizable list (Arth, in orbit 3 of a system
 * with nothing in orbit 2, is planet 2). Regions are star patterns on the starmap rather than planets.
 */

import type { StarSystemInfo } from './starsystems.ts';

export interface LocationInfo {
  name: string;
  // The planet's position counted outward from the star.
  position: number;
  description: string;
  // Where on the surface, as latitude x longitude (e.g. "11N x 104W"); undefined when the page lists none.
  surface?: string;
  // The race whose homeworld this is.
  homeworldOf?: string;
}

export interface RegionInfo {
  name: string;
  x: number;
  y: number;
}

// Name, x, y, position from the star, surface coordinates ('' for none), description, homeworld race.
// The page lists Thoss and Eleran in one row ("4/2", one surface coordinate for both).
const LOCATIONS: readonly [string, number, number, number, string, string, string?][] = [
  ['Arth', 125, 100, 2, '', 'Starport'],
  ['Thoss', 129, 33, 4, '60S x 45E', 'Thrynn homeworld', 'Thrynn'],
  ['Eleran', 129, 33, 2, '60S x 45E', 'Former Elowan homeworld'],
  ["Harrison's Base", 81, 98, 1, '44S x 137W', 'Focusing Stone'],
  ['Sphexi', 132, 165, 1, '46N x 14E', 'Crystal Orb'],
  ['Spewia', 82, 148, 1, '', 'Spemin homeworld', 'Spemin'],
  ['Earth', 215, 86, 3, '11N x 104W', 'Hypercube'],
  ['Mardan 2', 217, 88, 2, '56N x 13W', 'Message'],
  ['Mardan 4', 217, 88, 4, '0 x 0', 'Message'],
  ['New Scotland', 180, 124, 2, '59N x 22E', 'Rod Device; message at 54N x 13E'],
  ['Old Empire Base', 180, 120, 1, '34N x 28E', 'Message'],
  ['Koann 3', 112, 200, 3, '59N x 64W', 'Red Cylinder; Old Empire outpost world'],
  ['Heaven', 145, 107, 4, '', 'Terraformed world (Mechans)', 'Mechans'],
  ['Uhlek Brain World', 55, 32, 2, '', 'Destroy to cripple the Uhlek', 'Uhlek'],
  ['Noah 9', 175, 94, 1, '22N x 97W', 'Lasthope crash'],
  ['Gaal', 164, 85, 8, '79S x 68E', 'Message'],
  ['Akteron / The Institute', 165, 84, 6, '75S x 66E', 'Message'],
  ['City of the Ancients', 56, 144, 1, '29N x 13W', 'Crystal Pearl'],
  ['Mars', 215, 86, 4, '90N x 0', 'Ring Device'],
  ['Crystal Planet', 192, 152, 1, '47N x 45E', 'Control Nexus (destroy to win the game)'],
  ['Elan', 148, 63, 2, '', 'Elowan homeworld (destroy to wipe out the Elowan)', 'Elowan'],
  ['Votiputox', 150, 148, 2, '', 'Veloxi homeworld', 'Veloxi'],
  ['Nirvana', 86, 55, 4, '', 'Gazurtoid homeworld', 'Gazurtoid'],
  ['Former Uhlek Homeworld', 7, 118, 7, '', '100% life, 100% bio, Ancients']
];

export const REGIONS: readonly RegionInfo[] = [
  { name: 'The 4 Seedlings', x: 165, y: 84 },
  { name: 'The Axe', x: 230, y: 25 },
  { name: 'The Cross', x: 180, y: 120 },
  { name: 'The Staff', x: 100, y: 80 },
  { name: 'Pythagoras', x: 215, y: 88 }
];

// Attach LocationInfo to the listed planets; returns the systems that have any, in list order.
export function markLocations(systems: StarSystemInfo[]): StarSystemInfo[] {
  const marked: StarSystemInfo[] = [];
  for (const [name, x, y, position, surface, description, homeworldOf] of LOCATIONS) {
    const system = systems.find(candidate => candidate.x === x && candidate.y === y);
    const planet = system && [...system.planets].sort((a, b) => a.orbit - b.orbit)[position - 1];
    if (!system || !planet) {
      console.warn(`Location ${name} (planet ${position} at ${x}, ${y}) is not in the game data.`);
      continue;
    }
    (planet.locations ??= []).push({ name, position, description, surface: surface || undefined, homeworldOf });
    if (!marked.includes(system)) marked.push(system);
  }
  return marked;
}
