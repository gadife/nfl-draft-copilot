// Seeded PRNG. Math.random is banned project-wide: every draft must replay
// exactly from its log, and paired comparisons depend on opponents behaving
// identically across strategies for a given seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rngFor(...parts) {
  return mulberry32(hashStr(parts.join('|')));
}

/** Box-Muller, so noise is gaussian rather than uniform. */
export function gauss(rand, mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
