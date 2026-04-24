# Contributing to Test Confidence

## Architecture

```
src/
├── index.ts          # Express server, webhook endpoint
├── config.ts         # Environment config
├── webhook.ts        # GitHub webhook handler (PR events, check run events)
├── analyzer.ts       # Diff analysis + test-to-file mapping
├── engine.ts         # Bayesian confidence engine (SPRT)
└── github.ts         # GitHub API client (Octokit, PR comments)
```

## The Math

### Prior
P(regression) starts based on diff size. Larger diffs = higher prior.
Base rate: ~15% of PRs have a regression. Scaled by log(changes).

### Likelihood
- P(test passes | no regression) ≈ historical pass rate (accounts for flakiness)
- P(test passes | regression) ≈ pass rate * (1 - detection power)

### Posterior (Bayes' theorem)
After each test result:
```
P(regression | test passed) = P(pass | regression) * P(regression) / P(pass)
```

### Stopping rule (SPRT)
Stop when P(no regression | all tests passed so far) >= threshold from config.

## Pull requests

- **What** — What this PR does
- **Why** — Why this approach
- **Before/After** — Video or terminal recording
- **Test Results** — Screenshot of tests passing

Include AI disclosure with model name.
