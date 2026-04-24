import { getInstallationOctokit } from "./github.js";

interface PRAnalysis {
  changedFiles: FileChange[];
  testPriority: TestPriority[];
  diffCoverage: DiffCoverage[];
}

interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  patch: string;
}

interface TestPriority {
  testFile: string;
  /** P(catches regression | diff) / expected_runtime_seconds */
  infoGainPerSecond: number;
  /** Historical pass rate for this test */
  basePassRate: number;
  /** Expected runtime in seconds */
  expectedRuntime: number;
  /** Which changed files this test covers */
  coversFiles: string[];
}

interface DiffCoverage {
  filename: string;
  coveredByTests: string[];
  status: "covered" | "uncovered" | "running";
}

interface AnalyzePRParams {
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  installationId: number;
}

export async function analyzePR(params: AnalyzePRParams): Promise<PRAnalysis> {
  const octokit = await getInstallationOctokit(params.installationId);

  // Get the diff
  const { data: compareData } = await octokit.rest.repos.compareCommits({
    owner: params.owner,
    repo: params.repo,
    base: params.baseSha,
    head: params.headSha,
  });

  const changedFiles: FileChange[] = (compareData.files || []).map((f) => ({
    filename: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || "",
  }));

  // Map changed files to test files
  // Phase 1: Convention-based mapping (spec/file_spec.rb ↔ app/file.rb)
  // Phase 2: Historical correlation from test results DB
  // Phase 3: LLM call graph analysis
  const testPriority = mapChangesToTests(changedFiles);
  const diffCoverage = computeDiffCoverage(changedFiles, testPriority);

  return { changedFiles, testPriority, diffCoverage };
}

function mapChangesToTests(changedFiles: FileChange[]): TestPriority[] {
  const testMap: Map<string, TestPriority> = new Map();

  for (const file of changedFiles) {
    const testFiles = findTestsForFile(file.filename);
    for (const testFile of testFiles) {
      const existing = testMap.get(testFile);
      if (existing) {
        existing.coversFiles.push(file.filename);
      } else {
        testMap.set(testFile, {
          testFile,
          // Phase 1: Heuristic scoring
          // Files with more changes = higher probability of regression
          infoGainPerSecond: (file.additions + file.deletions) / 10, // placeholder
          basePassRate: 0.95, // default, will be replaced by historical data
          expectedRuntime: 5, // default seconds, will be replaced by historical data
          coversFiles: [file.filename],
        });
      }
    }
  }

  // Sort by information gain per second (descending)
  return Array.from(testMap.values()).sort(
    (a, b) => b.infoGainPerSecond - a.infoGainPerSecond,
  );
}

function findTestsForFile(filename: string): string[] {
  // Convention-based mapping for Rails/RSpec
  const tests: string[] = [];

  if (filename.startsWith("app/")) {
    // app/models/user.rb → spec/models/user_spec.rb
    // app/controllers/foo_controller.rb → spec/controllers/foo_controller_spec.rb
    // app/services/foo_service.rb → spec/services/foo_service_spec.rb
    const specFile = filename.replace("app/", "spec/").replace(/\.rb$/, "_spec.rb");
    tests.push(specFile);

    // Also check for request specs (E2E)
    if (filename.startsWith("app/controllers/")) {
      const requestSpec = filename
        .replace("app/controllers/", "spec/requests/")
        .replace(/_controller\.rb$/, "_spec.rb");
      tests.push(requestSpec);
    }
  }

  if (filename.startsWith("lib/")) {
    const specFile = filename.replace("lib/", "spec/lib/").replace(/\.rb$/, "_spec.rb");
    tests.push(specFile);
  }

  // JS/TS files
  if (filename.match(/\.(ts|tsx|js|jsx)$/)) {
    const testFile = filename.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1");
    tests.push(testFile);
  }

  return tests;
}

function computeDiffCoverage(
  changedFiles: FileChange[],
  testPriority: TestPriority[],
): DiffCoverage[] {
  const coveredFiles = new Set(testPriority.flatMap((t) => t.coversFiles));

  return changedFiles
    .filter((f) => !f.filename.match(/\.(md|txt|yml|yaml|json)$/)) // skip non-code
    .map((f) => ({
      filename: f.filename,
      coveredByTests: testPriority
        .filter((t) => t.coversFiles.includes(f.filename))
        .map((t) => t.testFile),
      status: coveredFiles.has(f.filename)
        ? ("covered" as const)
        : ("uncovered" as const),
    }));
}
