import { postConfidenceComment } from "./github.js";
import { config } from "./config.js";

interface ConfidenceState {
  /** Current P(no regression | tests passed so far) */
  confidence: number;
  /** Target threshold */
  threshold: number;
  /** Tests completed */
  completed: number;
  /** Tests remaining */
  remaining: number;
  /** Total tests in priority queue */
  total: number;
  /** Elapsed seconds */
  elapsedSeconds: number;
  /** Per-file coverage status */
  diffCoverage: Array<{
    filename: string;
    coveredByTests: string[];
    status: "covered" | "uncovered" | "running" | "passed" | "failed";
  }>;
  /** Test results so far */
  results: TestResult[];
}

interface TestResult {
  testFile: string;
  passed: boolean;
  durationSeconds: number;
  /** Prior P(fail | diff) before running */
  priorFailProb: number;
}

interface RunParams {
  analysis: {
    changedFiles: Array<{ filename: string; additions: number; deletions: number; patch: string }>;
    testPriority: Array<{
      testFile: string;
      infoGainPerSecond: number;
      basePassRate: number;
      expectedRuntime: number;
      coversFiles: string[];
    }>;
    diffCoverage: Array<{
      filename: string;
      coveredByTests: string[];
      status: "covered" | "uncovered" | "running";
    }>;
  };
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  installationId: number;
}

/**
 * Bayesian confidence engine.
 *
 * Prior: P(regression) based on historical base rate for this repo + diff size
 * Likelihood: P(test passes | no regression) vs P(test passes | regression exists)
 * Posterior: Updated after each test result via Bayes' theorem
 *
 * Stopping rule: Stop when P(no regression | all tests passed so far) >= threshold
 * This is a Sequential Probability Ratio Test (Wald, 1945).
 */
export async function runConfidenceLoop(params: RunParams): Promise<void> {
  const { analysis, owner, repo, prNumber, headSha, installationId } = params;
  const threshold = config.defaultThreshold;

  // Initial prior: P(regression) based on diff size
  // Larger diffs = higher prior probability of regression
  const totalChanges = analysis.changedFiles.reduce(
    (sum, f) => sum + f.additions + f.deletions,
    0,
  );

  // Base rate: ~15% of PRs have a regression (industry average)
  // Scale up for larger diffs
  const basePriorRegression = Math.min(0.5, 0.15 * (1 + Math.log10(Math.max(1, totalChanges / 10))));
  let pRegression = basePriorRegression;

  const state: ConfidenceState = {
    confidence: 1 - pRegression,
    threshold,
    completed: 0,
    remaining: analysis.testPriority.length,
    total: analysis.testPriority.length,
    elapsedSeconds: 0,
    diffCoverage: analysis.diffCoverage.map((d) => ({ ...d })),
    results: [],
  };

  // Post initial comment
  await postConfidenceComment({
    owner,
    repo,
    prNumber,
    installationId,
    state,
  });

  // Run tests in priority order
  for (const test of analysis.testPriority) {
    // Check stopping condition
    if (state.confidence >= threshold) {
      console.log(
        `Stopping at ${(state.confidence * 100).toFixed(2)}% confidence after ${state.completed}/${state.total} tests`,
      );
      break;
    }

    // Mark test as running
    updateDiffCoverageStatus(state, test.coversFiles, "running");

    // TODO: Actually trigger the test execution via GitHub Actions API
    // For now, simulate: check if the test is in the CI results
    const result = await executeTest(test);

    state.results.push(result);
    state.completed++;
    state.remaining--;
    state.elapsedSeconds += result.durationSeconds;

    // Bayesian update
    if (result.passed) {
      // P(test passes | no regression) ≈ basePassRate (accounts for flakiness)
      // P(test passes | regression) ≈ basePassRate * (1 - test's regression detection power)
      const pPassGivenNoRegression = test.basePassRate;
      const detectionPower = test.infoGainPerSecond * test.expectedRuntime; // proxy for how good this test is at catching issues
      const pPassGivenRegression = test.basePassRate * Math.max(0.1, 1 - Math.min(0.9, detectionPower / 100));

      // Bayes' theorem
      // P(regression | test passed) = P(pass | regression) * P(regression) / P(pass)
      const pPass = pPassGivenNoRegression * (1 - pRegression) + pPassGivenRegression * pRegression;
      pRegression = (pPassGivenRegression * pRegression) / pPass;
      state.confidence = 1 - pRegression;

      updateDiffCoverageStatus(state, test.coversFiles, "passed");
    } else {
      // Test failed — confidence drops sharply
      // A real failure is very strong evidence of regression
      // But account for flaky tests (basePassRate < 1.0 means some expected failures)
      const pFailGivenRegression = 1 - test.basePassRate * 0.5; // high
      const pFailGivenNoRegression = 1 - test.basePassRate; // flakiness rate

      const pFail = pFailGivenNoRegression * (1 - pRegression) + pFailGivenRegression * pRegression;
      pRegression = (pFailGivenRegression * pRegression) / pFail;
      state.confidence = 1 - pRegression;

      updateDiffCoverageStatus(state, test.coversFiles, "failed");
    }

    // Update PR comment every 5 tests or on significant confidence change
    if (state.completed % 5 === 0 || state.confidence >= threshold || !result.passed) {
      await postConfidenceComment({
        owner,
        repo,
        prNumber,
        installationId,
        state,
      });
    }
  }

  // Final update
  await postConfidenceComment({
    owner,
    repo,
    prNumber,
    installationId,
    state,
  });
}

function updateDiffCoverageStatus(
  state: ConfidenceState,
  files: string[],
  status: "running" | "passed" | "failed",
) {
  for (const dc of state.diffCoverage) {
    if (files.includes(dc.filename)) {
      dc.status = status;
    }
  }
}

async function executeTest(test: {
  testFile: string;
  expectedRuntime: number;
  basePassRate: number;
}): Promise<TestResult> {
  // TODO: Replace with actual test execution via GitHub Actions API
  // For now, return placeholder based on base pass rate
  return {
    testFile: test.testFile,
    passed: true, // placeholder
    durationSeconds: test.expectedRuntime,
    priorFailProb: 1 - test.basePassRate,
  };
}
