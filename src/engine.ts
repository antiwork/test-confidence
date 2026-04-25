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
  totalTestsInRepo = 0;
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

    // Start at 0% confidence. Grows as tests pass.
    // Model: each test that passes reduces remaining uncertainty.
    // AI-ranked tests get their weight from Claude (0-100).
    // Subsequent wave tests get equal share of remaining weight.
    this.pRegression = 1.0;
    this.totalTestsInRepo = 0; // Set externally after construction
  }

  observe(testFile: string, passed: boolean, durationSeconds: number) {
    const test = this.analysis.priorityQueue.find(t => t.testFile === testFile);
    if (!test) {
      // Test not in priority queue (added in later wave)
      this.results.push({ testFile, passed, durationSeconds });
      if (!passed) this.pRegression = Math.min(1.0, this.pRegression + 0.5);
      this.recalculateConfidence();
      return;
    }

    this.results.push({ testFile, passed, durationSeconds });
    this.remainingQueue = this.remainingQueue.filter(t => t.testFile !== testFile);

    if (!passed) {
      this.pRegression = Math.min(1.0, this.pRegression + 0.5);
    }

    this.recalculateConfidence();

    // Update diff coverage status
    const statuses = passed ? "passed" : "failed";
    for (const dc of this.analysis.diffCoverage) {
      if (test.coversFiles.includes(dc.filename)) {
        dc.status = statuses as any;
      }
    }
  }

  private recalculateConfidence() {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;

    if (failed > 0) {
      // Any failure = low confidence
      this.pRegression = 0.5 + 0.5 * (failed / (passed + failed));
      return;
    }

    // Confidence model: how much of the test suite have we covered?
    // Use totalTestsInRepo if known, otherwise estimate
    const totalTests = this.totalTestsInRepo || Math.max(passed * 3, 1000);
    const coverage = passed / totalTests;

    // Confidence curve: fast start, then asymptotic approach to 100%
    // confidence = 1 - (1 - coverage)^k
    // k controls how quickly confidence rises.
    // With k=4 and 3000 tests:
    //   50 tests (1.7%)  → 6.5% confidence (Wave 1: AI)
    //   500 tests (17%)  → 52% confidence (Wave 2)
    //   1200 tests (40%) → 87% confidence (Wave 3)
    //   2100 tests (70%) → 99.2% confidence (Wave 4)
    //   2700 tests (90%) → 99.99% confidence (Wave 5)
    const k = 4;
    const confidence = 1 - Math.pow(1 - coverage, k);

    this.pRegression = 1 - confidence;
  }

  getState(): ConfidenceState {
    const confidence = 1 - this.pRegression;
    const completed = this.results.length;
    const remaining = this.remainingQueue.length;
    const elapsed = this.results.reduce((s, r) => s + r.durationSeconds, 0);

    const eta = 0;
    const accuracy = 0;

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

  /** Add new tests to the queue (for subsequent waves) */
  addTests(testFiles: string[]) {
    const existingFiles = new Set(this.analysis.priorityQueue.map(t => t.testFile));
    for (const file of testFiles) {
      if (existingFiles.has(file)) continue;
      const entry: TestPriority = {
        testFile: file,
        infoGainPerSecond: 1, // Low weight for non-AI-ranked tests
        basePassRate: 0.95,
        expectedRuntime: 5,
        coversFiles: [],
        failRateWhenFilesChange: 0.01,
      };
      this.analysis.priorityQueue.push(entry);
      this.remainingQueue.push(entry);
      existingFiles.add(file);
    }
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
      totalTestsInRepo: this.totalTestsInRepo,
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
    engine.totalTestsInRepo = parsed.totalTestsInRepo || 0;
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
