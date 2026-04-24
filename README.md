# Test Confidence

Predictive Test Selection as a GitHub App. Zero infrastructure — runs as a Cloudflare Worker, orchestrates your existing GitHub Actions.

**10 seconds to 99% confidence. Then merge.**

```
🟢 Test Confidence: 99.4%

Confidence ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 99.4%
 ├──────────────────┼──┤
 42 tests · 18s     target: 99.999%
 ⏱ ETA to threshold: ~4s (3 tests remaining)
 📊 Prediction accuracy: 87% (last 30 runs)

Diff coverage
 app/payments/charge.rb  ✓ covered by 8 tests
 app/payments/refund.rb  ✓ covered by 5 tests
 lib/stripe_adapter.rb   ⟳ running (test 3/5)
```

## How it works

1. **PR opens** → Cloudflare Worker receives webhook
2. **Diff analysis** → Maps changed files to tests, ranks by information gain per second
3. **Triggers subset** → `workflow_dispatch` on your existing CI with only the high-priority tests
4. **Bayesian update** → Each test result updates P(no regression). Confidence climbs.
5. **Stops early** → When confidence ≥ threshold, PR gets a green check. Remaining tests skipped.

No new CI infrastructure. No test runner. Just a webhook that tells your existing Actions which tests to run first.

## Architecture

```
PR opened
    │
    ▼
┌─────────────────┐    ┌──────────────────┐
│  Cloudflare     │───▶│  Diff Analyzer   │
│  Worker         │    │  (file → test)   │
│  (webhook)      │    └────────┬─────────┘
└────────┬────────┘             │
         │              ┌───────▼─────────┐
         │              │ Priority Queue  │
         │              │ (info gain/sec) │
         │              └───────┬─────────┘
         │                      │
         │    workflow_dispatch  │
         │◄─────────────────────┘
         │
         ▼
┌─────────────────┐    ┌──────────────────┐
│  GitHub Actions  │───▶│  Bayesian Engine │
│  (existing CI)   │    │  (SPRT)         │
│  runs subset     │    └───────┬──────────┘
└──────────────────┘            │
                         ┌──────▼──────────┐
                         │  PR Comment     │
                         │  (live bar)     │
                         │  + Check Run    │
                         └─────────────────┘
                                │
                    P(no reg) ≥ threshold?
                         YES → ✅ merge
```

## Configuration

```yaml
# .test-confidence.yml (in your repo root)
threshold: 0.9999          # Stop when 99.99% confident

paths:
  "app/billing/**": 0.99999  # Payment code needs higher bar
  "app/payments/**": 0.99999
  "docs/**": 0.95             # Docs changes need less confidence
  "app/admin/**": 0.999
```

## The math

**Prior:** P(regression) = min(0.5, 0.15 × log₁₀(changes/10))

**Update (Bayes):** After each passing test:
```
P(reg | pass) = P(pass | reg) × P(reg) / P(pass)
```

**Stopping rule (SPRT):** Stop when P(no regression | all passed) ≥ threshold

**Priority:** Tests ranked by `P(catches regression | diff) / expected_runtime` — maximum information gain per second of CI time.

## Install

1. Install the GitHub App on your repo
2. Add `.test-confidence.yml` to your repo root
3. Add a `test-subset.yml` workflow that accepts a test file list as input

## Development

```bash
npm install
npm run dev        # Local dev with wrangler
npm run deploy     # Deploy to Cloudflare Workers
npm run typecheck  # Type check
npm test           # Run tests
```

## What's different from Launchable / Gradle PTS

| Feature | Launchable/Develocity | Test Confidence |
|---------|----------------------|-----------------|
| Execution | Static subset upfront | Adaptive streaming |
| Decision | Fixed time budget | Bayesian stopping rule |
| Per-path thresholds | No | Yes |
| Infrastructure | Hosted service | Zero (CF Worker + your Actions) |
| Cold start | Weeks of data | Convention-based from day 1 |
| UI | CLI flag | Live confidence bar on PR |
| Time prediction | No | Yes, with accuracy tracking |

## License

MIT
