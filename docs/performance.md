# Performance baseline

Benchmarks for the in-memory paths in `packages/core`, run with:

```
pnpm bench
```

The data is generated from a fixed seed (100,000 events, 10,000 holders), so runs are comparable. Numbers vary by machine and the run-to-run error is up to about 13%; treat them as a baseline for spotting regressions, not as a guarantee.

## Environment

- Machine: Intel Core i5-6300U, 4 threads, a laptop
- Node: 24.18.0, Vitest 5.0.3
- Date recorded: 2026-10-18
- Settings: 1 warmup iteration, 10 iterations per benchmark

## Results

| Benchmark | mean (ms) | p99 (ms) | ops/sec |
| --- | --- | --- | --- |
| `replay`, events already in id order | 210.61 | 229.67 | 4.76 |
| `replay`, events in random order | 687.12 | 759.59 | 1.46 |
| `reconcilePositions`, register matches chain | 46.83 | 79.01 | 22.74 |
| `reconcilePositions`, 1% of holders mismatched | 42.07 | 81.67 | 24.74 |

## Notes

- `replay` copies and re-sorts the full event array on every call (`sortEvents`), so its cost grows with event count even when the input is already ordered.
- `reconcilePositions` sorts all addresses once and builds one line per address.
- The CI `bench` job is advisory (`continue-on-error`) and does not fail the build.
