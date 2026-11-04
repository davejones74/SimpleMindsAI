# Cumulative Learning Effectiveness Report

Generated: 2026-11-04T20:45:53.506Z
Stable reference: v493 loss 7.810239921224878

## Working trajectory

| Run | Version | Candidate loss | Δ vs stable | Fresh tokens | Replay tokens | Replay share |
|---|---|---:|---:|---:|---:|---:|
| run-420 | v495 | 7.819038700550161 | 0.008799 | 767 | 1329 | 63.4% |
| run-421 | v496 | 7.837955160343901 | 0.027715 | 2054 | 1180 | 36.5% |
| run-422 | v497 | 7.804189088496756 | -0.006051 | 2106 | 1479 | 41.3% |
| run-423 | v498 | 7.809954133439572 | -0.000286 | 1658 | 1074 | 39.3% |
| run-424 | v499 | 7.812545385766537 | 0.002305 | 586 | 1196 | 67.1% |
| run-425 | v500 | 7.821772199995975 | 0.011532 | 1909 | 1105 | 36.7% |

## Summary

- Working advances: 6
- Measured advances: 6
- Net Δ vs stable: 0.011532278771096749 nats (positive = worse)
- Best Δ vs stable: -0.006050832728122124 (v497)
- Worst Δ vs stable: 0.02771523911902296 (v496)
- Regressions vs stable: 4 / 6
- Cumulative drift: 0.011532278771096749 nats
- Drift velocity: 0.00230645575421935 nats/advance
- Efficiency: -0.0012700747545260737 nats improvement per 1,000 fresh tokens
- Activity: 52 stable promotions, 389 rejections, 51 inconclusive
- Sealed prospective benchmark: not configured
- Retention probe: not configured

## Limitations

- Working advancement is not a learning result; only frozen/sealed effect measurements are.
- A trajectory with no sealed prospective benchmark cannot demonstrate generalisation to unseen knowledge.
- A trajectory with no fixed retention probe cannot demonstrate retention of previously learned knowledge.
