# Test Confidence

Predictive Test Selection as a GitHub App. Runs your tests in order of information gain per second, updates a Bayesian posterior after each result, and stops when confidence crosses your threshold. The rest of the suite never runs.

```
Confidence ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 99.4% → 99.99%
 ├─────────────────┼───┤
 42 tests · 18s    target: 99.999%

Diff coverage
 app/payments/charge.rb  ✓ covered by 8 tests
 app/payments/refund.rb  ✓ covered by 5 tests
 lib/stripe_adapter.rb   ⟳ running (test 3/5)
```

## How it works

1. **Diff analysis**: Reads the PR diff, maps changed files to test files via historical pass/fail data and call graph analysis
2. **Priority ranking**: Tests sorted by `P(catches regression | diff) / expected_runtime` (information gain per second)
3. **Streaming execution**: Tests run in priority order. After each result, the Bayesian posterior updates
4. **Stopping rule**: When `P(no regression | tests passed so far) ≥ threshold`, remaining tests are skipped
5. **Live PR comment**: Confidence bar updates in real-time as tests complete

## Configuration

```yaml
# .test-confidence.yml
threshold: 0.9999          # Stop when 99.99% confident
paths:
  "app/billing/**": 0.99999  # Payment code: higher bar
  "docs/**": 0.95             # Docs: lower bar
  "app/admin/**": 0.999       # Admin: standard
```

## What makes this different from existing PTS

| Feature | Launchable/Develocity | Test Confidence |
|---------|----------------------|-----------------|
| Subset selection | Static upfront | Adaptive streaming |
| Stopping rule | Fixed budget | Bayesian posterior |
| Per-path thresholds | No | Yes, in config |
| Diff understanding | File-level features | LLM + call graph |
| Cold start | Weeks of data needed | Cross-repo priors from day 1 |
| UI | CLI flag | Live confidence bar on PR |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  GitHub App                       │
│                                                   │
│  PR opened/updated                               │
│       │                                           │
│       ▼                                           │
│  ┌─────────────┐    ┌──────────────────┐         │
│  │ Diff Analyzer│───▶│ Priority Ranker  │         │
│  │ (LLM + hist) │    │ (info gain/sec) │         │
│  └─────────────┘    └───────┬──────────┘         │
│                              │                    │
│                              ▼                    │
│                    ┌──────────────────┐           │
│                    │ Test Runner      │           │
│                    │ (streaming)      │           │
│                    └───────┬──────────┘           │
│                            │                      │
│                    ┌───────▼──────────┐           │
│                    │ Bayesian Engine  │           │
│                    │ (SPRT posterior) │           │
│                    └───────┬──────────┘           │
│                            │                      │
│                    ┌───────▼──────────┐           │
│                    │ PR Comment       │           │
│                    │ (live updates)   │           │
│                    └──────────────────┘           │
│                                                   │
│  P(no regression) ≥ threshold? → STOP            │
└─────────────────────────────────────────────────┘
```

## Install

Coming soon. Install the GitHub App on your repo and add `.test-confidence.yml`.

## Development

```bash
npm install
npm run dev     # Local dev server with smee.io webhook proxy
npm test
```

## License

MIT
