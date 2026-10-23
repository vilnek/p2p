// Damm check digit: catches every single wrong digit and every swap of two neighbouring digits.
// Table: the standard weakly totally anti-symmetric quasigroup of order 10 (H. Michael Damm, 2004).

const TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

function interim(digits: string): number {
  let i = 0;
  for (const ch of digits) {
    const d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) throw new Error('digits only');
    i = TABLE[i][d];
  }
  return i;
}

/** The check digit to append to `digits`. */
export function dammDigit(digits: string): string {
  return String(interim(digits));
}

/** True when the last digit is the correct Damm check digit for the rest. */
export function dammValid(digitsWithCheck: string): boolean {
  if (!/^\d+$/.test(digitsWithCheck)) return false;
  return interim(digitsWithCheck) === 0;
}
