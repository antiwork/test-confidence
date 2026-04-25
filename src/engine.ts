import type { Analysis, TestPriority, TestHistoryEntry } from "./analyzer";

export interface ConfidenceState {
  confidence: number;
  threshold: number;
  completed: number;
  remaining: number;
  total: number;
  elapsedSeconds: number;
  etaSeconds: number;
  predictionAccuracy: number;
  headSha: string;
  headRef: string;
  diffCoverage: Array<{
    filename: string;
    coveredByTests: string[];
    status: "pending" | "running" | "passed" | "failed" | "uncovered";
  }>;
  results: TestResult[];
  status: "running" | "passing" | "failing";
}

interface TestResult {
  testFile: string;
  passed: boolean;
  durationSeconds: number;
}

interface RepoConfig {
  threshold: number;
  paths: Record<string, number>;
}

export class BayesianEngine {
  private pRegression: number;
  private threshold: number;
  private analysis: Analysis;
  private results: TestResult[] = [];
  private remainingQueue: TestPriority[];
  private batchSize = 10;
  private startTime = Date.now();
  private historicalAccuracy: number[];
  headSha = "";
  headRef = "";

  constructor(analysis: Analysis, config: RepoConfig, history: TestHistoryEntry[]) {
    this.analysis = analysis;
    this.threshold = config.threshold;
    this.remainingQueue = [...analysis.priorityQueue];
    this.historicalAccuracy = [];

    // Resolve per-path thresholds (use highest threshold for any changed file)
    for (const file of analysis.changedFiles) {
      for (const [pattern, pathThreshold] of Object.entries(config.paths)) {
        if (matchGlob(file.filename, pattern)) {
          this.threshold = Math.max(this.threshold, pathThreshold);
        }
      }
    }

    // Prior: start at 0% confidence (100% uncertain / assume regression)
    // Confidence grows as tests pass. 100% = full test suite passed.
    this.pRegression = 1.0;
  }

  observe(testFile: string, passed: boolean, durationSeconds: number) {
    const test = this.analysis.priorityQueue.find(t => t.testFile === testFile);
    if (!test) return;

    this.results.push({ testFile, passed, durationSeconds });
    this.remainingQueue = this.remainingQueue.filter(t => t.testFile !== testFile);

    if (passed) {
      // Each passing test contributes confidence proportional to its
      // relevance to the diff. High-priority tests (directly covering
      // changed files) contribute more than low-priority ones.
      //
      // Model: confidence = fraction of total "evidence weight" collected.
      // A test's weight = its infoGainPerSecond (set by analyzer based on
      // file correlation, change size, historical fail rate).
      //
      // After all tests pass, confidence = 100%.
      // The AI prioritization front-loads high-weight tests so confidence
      // rises fast early, then slows as we run less relevant tests.
      //
      // We track this via pRegression: the remaining uncertainty.
      const totalWeight = this.analysis.priorityQueue.reduce((s, t) => s + t.infoGainPerSecond, 0);
      const testWeight = test.infoGainPerSecond;
      const fraction = totalWeight > 0 ? testWeight / totalWeight : 1 / this.analysis.priorityQueue.length;

      // Reduce remaining uncertainty by this test's fraction
      this.pRegression *= (1 - fraction);
    } else {
      // Failure: strong evidence of regression. Spike uncertainty.
      this.pRegression = Math.min(1.0, this.pRegression + 0.5);
    }

    // Clamp
    this.pRegression = Math.max(0, Math.min(1, this.pRegression));

    // Update diff coverage status
    const statuses = passed ? "passed" : "failed";
    for (const dc of this.analysis.diffCoverage) {
      if (test.coversFiles.includes(dc.filename)) {
        dc.status = statuses as any;
      }
    }
  }

  getState(): ConfidenceState {
    const confidence = 1 - this.pRegression;
    const completed = this.results.length;
    const remaining = this.remainingQueue.length;
    const elapsed = this.results.reduce((s, r) => s + r.durationSeconds, 0);

    // ETA: estimated time to reach threshold based on current convergence rate
    const eta = this.estimateETA();

    // Prediction accuracy from historical data
    const accuracy = this.historicalAccuracy.length > 0
      ? this.historicalAccuracy.reduce((s, a) => s + a, 0) / this.historicalAccuracy.length
      : 0;

    const status = confidence >= this.threshold ? "passing"
      : remaining === 0 && this.results.some(r => !r.passed) ? "failing"
      : "running";

    return {
      confidence,
      threshold: this.threshold,
      completed,
      remaining,
      total: this.analysis.priorityQueue.length,
      elapsedSeconds: elapsed,
      etaSeconds: eta,
      predictionAccuracy: accuracy,
      headSha: this.headSha,
      headRef: this.headRef,
      diffCoverage: this.analysis.diffCoverage,
      results: this.results,
      status,
    };
  }

  /** Estimate how many tests needed to reach threshold */
  estimateTestsNeeded(): number {
    // Start with batch size, will expand if needed
    return Math.min(this.remainingQueue.length, this.batchSize * 2);
  }

  /** Get next batch of tests to run */
  getNextBatch(): TestPriority[] {
    return this.remainingQueue.slice(0, this.batchSize);
  }

  /** Get all remaining tests */
  getRemainingQueue(): TestPriority[] {
    return [...this.remainingQueue];
  }

  private estimateETA(): number {
    if (this.results.length === 0) {
      return this.remainingQueue.reduce((s, t) => s + t.expectedRuntime, 0);
    }

    const confidence = 1 - this.pRegression;
    if (confidence >= this.threshold) return 0;

    // Estimate based on convergence rate so far
    const avgTimePerTest = this.results.reduce((s, r) => s + r.durationSeconds, 0) / this.results.length;
    const testsRemaining = this.remainingQueue.length;

    // How fast is confidence growing per test?
    // Rough: assume similar rate continues
    const confidenceGap = this.threshold - confidence;
    const confidencePerTest = this.results.length > 1
      ? (confidence - (1 - 0.15)) / this.results.length // avg confidence gain per test
      : 0.01;

    if (confidencePerTest <= 0) return testsRemaining * avgTimePerTest;

    const testsNeeded = Math.ceil(confidenceGap / confidencePerTest);
    return Math.min(testsNeeded, testsRemaining) * avgTimePerTest;
  }

  serialize(): string {
    return JSON.stringify({
      pRegression: this.pRegression,
      threshold: this.threshold,
      results: this.results,
      remainingQueue: this.remainingQueue,
      analysis: this.analysis,
      historicalAccuracy: this.historicalAccuracy,
      headSha: this.headSha,
      headRef: this.headRef,
    });
  }

  static deserialize(data: string): BayesianEngine {
    const parsed = JSON.parse(data);
    const engine = Object.create(BayesianEngine.prototype);
    engine.pRegression = parsed.pRegression;
    engine.threshold = parsed.threshold;
    engine.results = parsed.results;
    engine.remainingQueue = parsed.remainingQueue;
    engine.analysis = parsed.analysis;
    engine.historicalAccuracy = parsed.historicalAccuracy || [];
    engine.batchSize = 10;
    engine.headSha = parsed.headSha;
    engine.headRef = parsed.headRef;
    return engine;
  }
}

function matchGlob(filepath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "___DOUBLESTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLESTAR___/g, ".*");
  return new RegExp(`^${regex}$`).test(filepath);
}
