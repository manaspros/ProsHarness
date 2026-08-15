# seeded-bug fixture

A tiny, deliberately-buggy source file used by
`packages/plan/test/finding.test.ts`'s real-CLI acceptance test. `loop.ts`
line 9 uses `<=` instead of `<` in a loop bound, an off-by-one that reads one
element past the end of the array.

At test time these source files are copied into a fresh `git init`'d
temporary directory (NOT committed as a nested repo inside ProsHarness) so
`runFinding` has a real repo to investigate.
