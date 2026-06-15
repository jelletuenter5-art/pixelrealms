// PixelRealms — mapgen.js
// Procedural map generation using a seeded pseudo-noise algorithm

class SeededRandom {
  constructor(seed) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }
  next() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }
  nextRange(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

// Simple value noise implementation (no external deps)
class NoiseMap {
  constructor(seed, width, height) {
    this.rng = new SeededRandom(seed);
    this.width = width;
    this.height = height;
    this.gradients = this._buildGradients();
  }

  _buildGradients() {
    const g = [];
    for (let y = 0; y <= this.height; y++) {
      g[y] = [];
      for (let x = 0; x <= this.width; x++) {
        g[y][x] = this.rng.next();
      }
    }
    return g;
  }

  _lerp(a, b, t) { return a + t * (b - a); }
  _smoothstep(t) { return t * t * (3 - 2 * t); }

  sample(x, y) {
    const gx = Math.floor(x), gy = Math.floor(y);
    const fx = x - gx, fy = y - gy;
    const ux = this._smoothstep(fx), uy = this._smoothstep(fy);

    const g = this.gradients;
    const clampX = (v) => Math.min(v, this.width);
    const clampY = (v) => Math.min(v, this.height);

    const n00 = g[clampY(gy)][clampX(gx)];
    const n10 = g[clampY(gy)][clampX(gx + 1)];
    const n01 = g[clampY(gy + 1)][clampX(gx)];
    const n11 = g[clampY(gy + 1)][clampX(gx + 1)];

    return this._lerp(
      this._lerp(n00, n10, ux),
      this._lerp(n01, n11, ux),
      uy
    );
  }

  // Fractional Brownian Motion — layered octaves for realistic terrain
  fbm(x, y, octaves = 6) {
    let val = 0, amp = 0.5, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
      val += this.sample(x * freq / this.width * 8, y * freq / this.height * 8) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return val / max;
  }
}

class MapGenerator {
  constructor(seed, width, height) {
    this.seed = seed;
    this.width = width;
    this.height = height;
    this.noise = new NoiseMap(seed, width, height);
    this.rng = new SeededRandom(seed + 1);
  }

  generate() {
    const map = [];

    // Island mask — fade edges to water for a continent feel
    const islandMask = (x, y) => {
      const nx = (x / this.width) * 2 - 1;
      const ny = (y / this.height) * 2 - 1;
      const dist = Math.max(Math.abs(nx), Math.abs(ny));
      return 1 - Math.pow(dist * 1.2, 2.5);
    };

    for (let y = 0; y < this.height; y++) {
      map[y] = [];
      for (let x = 0; x < this.width; x++) {
        const elevation = this.noise.fbm(x, y) + islandMask(x, y) * 0.4;
        const moisture  = this.noise.fbm(x + 500, y + 500, 4);

        let terrain;
        if (elevation < 0.38) {
          terrain = 'water';
        } else if (elevation < 0.48) {
          terrain = 'grass'; // coastal lowland
        } else if (elevation < 0.62) {
          terrain = moisture > 0.55 ? 'grass' : 'desert';
        } else if (elevation < 0.76) {
          terrain = 'hill';
        } else {
          terrain = 'mountain';
        }

        map[y][x] = { terrain, elevation, country: null };
      }
    }

    // Smooth out isolated single pixels (aesthetic pass)
    this._smooth(map);
    return map;
  }

  _smooth(map) {
    const terrainOrder = ['water','grass','desert','hill','mountain'];
    for (let iter = 0; iter < 2; iter++) {
      for (let y = 1; y < this.height - 1; y++) {
        for (let x = 1; x < this.width - 1; x++) {
          const neighbors = [
            map[y-1][x], map[y+1][x], map[y][x-1], map[y][x+1]
          ].map(n => n.terrain);
          // If all 4 neighbors are the same different terrain, convert
          if (neighbors.every(t => t === neighbors[0] && t !== map[y][x].terrain)) {
            map[y][x].terrain = neighbors[0];
          }
        }
      }
    }
  }

  // Find a random spawn point (grass or hill, away from water)
  findSpawn(map, existingSpawns = []) {
    const candidates = [];
    for (let y = 2; y < this.height - 2; y++) {
      for (let x = 2; x < this.width - 2; x++) {
        if (map[y][x].terrain === 'grass' || map[y][x].terrain === 'hill') {
          // Must not be too close to existing spawns
          const tooClose = existingSpawns.some(s =>
            Math.abs(s.x - x) < 10 && Math.abs(s.y - y) < 10
          );
          if (!tooClose) candidates.push({ x, y });
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(this.rng.next() * candidates.length)];
  }
}

// Terrain rendering colors (with nice gradients)
const TERRAIN_COLORS = {
  water:    { base: '#1e40af', shade: '#1d4ed8', deep: '#1e3a8a' },
  grass:    { base: '#16a34a', shade: '#15803d', light: '#22c55e' },
  hill:     { base: '#854d0e', shade: '#92400e', light: '#a16207' },
  mountain: { base: '#6b7280', shade: '#4b5563', light: '#9ca3af' },
  desert:   { base: '#d97706', shade: '#b45309', light: '#fbbf24' },
};

function getTerrainColor(terrain, x, y, elevation) {
  const t = TERRAIN_COLORS[terrain] || TERRAIN_COLORS.grass;
  // Slight elevation-based variation
  if (terrain === 'water') {
    return elevation < 0.32 ? t.deep : t.base;
  }
  return t.base;
}
