export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface TestPriority {
  testFile: string;
  /** P(catches regression | diff) / expected_runtime_seconds */
  infoGainPerSecond: number;
  /** Historical pass rate (0-1). Lower = flakier */
  basePassRate: number;
  /** Expected runtime in seconds (from history) */
  expectedRuntime: number;
  /** Which changed files this test covers */
  coversFiles: string[];
  /** Historical fail rate when these files change */
  failRateWhenFilesChange: number;
}

export interface DiffCoverage {
  filename: string;
  coveredByTests: string[];
  status: "pending" | "running" | "passed" | "failed" | "uncovered";
}

export interface Analysis {
  changedFiles: FileChange[];
  priorityQueue: TestPriority[];
  diffCoverage: DiffCoverage[];
  totalChanges: number;
}

export interface TestHistoryEntry {
  testFile: string;
  avgRuntime: number;
  passRate: number;
  /** Map of source file → fail rate when that file changes */
  fileCorrelations: Record<string, number>;
  totalRuns: number;
}

export function analyzeDiff(
  changedFiles: FileChange[],
  history: TestHistoryEntry[],
): Analysis {
  const totalChanges = changedFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const historyMap = new Map(history.map(h => [h.testFile, h]));
  const testMap = new Map<string, TestPriority>();

  for (const file of changedFiles) {
    // Skip non-code files
    if (file.filename.match(/\.(md|txt|yml|yaml|json|lock|toml)$/)) continue;

    const testFiles = findTestsForFile(file.filename);
    const changeWeight = file.additions + file.deletions;

    for (const testFile of testFiles) {
      const hist = historyMap.get(testFile);
      const existing = testMap.get(testFile);

      const expectedRuntime = hist?.avgRuntime || 5;
      const basePassRate = hist?.passRate || 0.95;
      const failRate = hist?.fileCorrelations[file.filename] || 0.1;

      // Tier the relevance:
      //   Direct unit test (same file path) = weight 10
      //   Request/integration test = weight 5
      //   Related by directory = weight 2
      //   Everything else = weight 1
      let relevance = 1;
      const srcBase = file.filename.replace(/^app\//, "").replace(/\.rb$/, "");
      const testBase = testFile.replace(/^spec\//, "").replace(/_spec\.rb$/, "");
      if (srcBase === testBase) {
        relevance = 10; // Direct unit test
      } else if (testFile.includes("requests/") || testFile.includes("features/")) {
        relevance = 5; // Integration test
      } else if (testFile.split("/").slice(0, -1).join("/") === file.filename.replace("app/", "spec/").split("/").slice(0, -1).join("/")) {
        relevance = 3; // Same directory
      }

      const infoGain = relevance * (1 + failRate) * Math.max(1, changeWeight) / Math.max(0.1, expectedRuntime);

      if (existing) {
        existing.coversFiles.push(file.filename);
        existing.infoGainPerSecond = Math.max(existing.infoGainPerSecond, infoGain);
        existing.failRateWhenFilesChange = Math.max(existing.failRateWhenFilesChange, failRate);
      } else {
        testMap.set(testFile, {
          testFile,
          infoGainPerSecond: infoGain,
          basePassRate,
          expectedRuntime,
          coversFiles: [file.filename],
          failRateWhenFilesChange: failRate,
        });
      }
    }
  }

  // Sort by information gain per second (highest first)
  const priorityQueue = Array.from(testMap.values())
    .sort((a, b) => b.infoGainPerSecond - a.infoGainPerSecond);

  // Build diff coverage map
  const coveredFiles = new Set(priorityQueue.flatMap(t => t.coversFiles));
  const diffCoverage: DiffCoverage[] = changedFiles
    .filter(f => !f.filename.match(/\.(md|txt|yml|yaml|json|lock|toml)$/))
    .map(f => ({
      filename: f.filename,
      coveredByTests: priorityQueue
        .filter(t => t.coversFiles.includes(f.filename))
        .map(t => t.testFile),
      status: coveredFiles.has(f.filename) ? "pending" as const : "uncovered" as const,
    }));

  return { changedFiles, priorityQueue, diffCoverage, totalChanges };
}

function findTestsForFile(filename: string): string[] {
  const tests: string[] = [];

  // Ruby/Rails conventions
  if (filename.startsWith("app/") && filename.endsWith(".rb")) {
    tests.push(filename.replace("app/", "spec/").replace(/\.rb$/, "_spec.rb"));
    if (filename.startsWith("app/controllers/")) {
      tests.push(
        filename.replace("app/controllers/", "spec/requests/").replace(/_controller\.rb$/, "_spec.rb"),
      );
    }
  }
  if (filename.startsWith("lib/") && filename.endsWith(".rb")) {
    tests.push(filename.replace("lib/", "spec/lib/").replace(/\.rb$/, "_spec.rb"));
  }

  // TypeScript/JavaScript
  if (filename.match(/\.(ts|tsx|js|jsx)$/) && !filename.includes(".test.") && !filename.includes(".spec.")) {
    tests.push(filename.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1"));
    tests.push(filename.replace(/\.(ts|tsx|js|jsx)$/, ".spec.$1"));
  }

  // Go
  if (filename.endsWith(".go") && !filename.endsWith("_test.go")) {
    tests.push(filename.replace(/\.go$/, "_test.go"));
  }

  return tests;
}
