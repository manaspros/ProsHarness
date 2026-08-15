/**
 * Seeded-bug fixture source (committed to ProsHarness's own repo -- see
 * packages/plan/test/finding.test.ts). The bug is deliberate and precise:
 * line 9 uses `<=` where it should use `<`, reading one element past the
 * end of `arr`.
 */
export function sumAll(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i] as number; // BUG: off-by-one, arr[arr.length] is undefined
  }
  return total;
}
