/**
 * AI-powered test selection using Claude Opus.
 * The LLM directly determines which tests are needed for each confidence tier.
 */

export interface TestWavePlan {
  waves: Wave[];
  totalTests: number;
}

export interface Wave {
  targetConfidence: number; // e.g. 0.80, 0.95, 0.99, 0.9999
  tests: string[];
  reason: string;
}

export async function planTestWaves(
  diff: Array<{ filename: string; additions: number; deletions: number; patch?: string }>,
  allTestFiles: string[],
  apiKey: string,
): Promise<TestWavePlan> {
  const diffSummary = diff.map(f => {
    return `${f.filename} (+${f.additions}/-${f.deletions})${f.patch ? `\n${f.patch.slice(0, 2000)}` : ""}`;
  }).join("\n\n");

  // Group test files by directory for context
  const testDirs = new Map<string, string[]>();
  for (const f of allTestFiles) {
    const dir = f.split("/").slice(0, -1).join("/");
    if (!testDirs.has(dir)) testDirs.set(dir, []);
    testDirs.get(dir)!.push(f.split("/").pop()!);
  }
  const testTreeStr = Array.from(testDirs.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => `${dir}/\n${files.map(f => `  ${f}`).join("\n")}`)
    .join("\n");

  const prompt = `You are a senior Rails engineer planning a test execution strategy for a code change.

Your job: determine the minimum tests needed at each confidence level that this diff doesn't introduce a regression.

Think about it like this:
- 80% confidence: "I'm pretty sure this is fine" — run the direct unit tests and closely related integration tests
- 95% confidence: "This almost certainly works" — add broader integration tests, controller specs, and related feature tests  
- 99% confidence: "I'd bet money on it" — add all tests that could conceivably be affected, including transitive dependencies
- 99.99% confidence: "Mathematically certain" — run the entire test suite

The key insight: the FIRST few tests give you the MOST confidence because they directly test the changed code. Each subsequent wave has diminishing returns but increases certainty.

## Changed files with patches:
${diffSummary}

## Test file tree (${allTestFiles.length} files):
${testTreeStr}

Return a JSON object with this structure:
{
  "waves": [
    {
      "targetConfidence": 0.80,
      "tests": ["spec/models/foo_spec.rb", ...],
      "reason": "Direct unit tests for changed files and immediate dependencies"
    },
    {
      "targetConfidence": 0.95,
      "tests": ["spec/controllers/bar_spec.rb", ...],
      "reason": "Integration and controller tests that exercise changed code paths"
    },
    {
      "targetConfidence": 0.99,
      "tests": ["spec/features/baz_spec.rb", ...],
      "reason": "Broader feature tests and transitive dependency coverage"
    },
    {
      "targetConfidence": 0.9999,
      "tests": ["ALL_REMAINING"],
      "reason": "Full suite for mathematical certainty"
    }
  ]
}

Rules:
- Each wave's tests are ADDITIONAL (not cumulative). Wave 2 tests are only the NEW tests beyond wave 1.
- Use exact file paths from the test tree above.
- Wave 4 can use the special value "ALL_REMAINING" to mean all tests not in waves 1-3.
- Be thorough in waves 1-2. These are the most important.
- For a trivial change (docs, config), wave 1 alone might get to 95%.
- For a core model change, wave 1 might need 30-50 tests.
- Wave 3 (99%) MUST include E2E/feature specs (spec/features/ or spec/requests/) that exercise real user flows touching the changed code. This is non-negotiable. Even if the change seems isolated, include the closest E2E tests that exercise the affected code path end-to-end.

Return ONLY the JSON object, no markdown, no explanation.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Claude API error (${response.status}): ${text}`);
    return { waves: [], totalTests: allTestFiles.length };
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.[0]?.text || "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No JSON found in Claude response:", text.slice(0, 200));
      return { waves: [], totalTests: allTestFiles.length };
    }
    const plan = JSON.parse(jsonMatch[0]) as TestWavePlan;
    plan.totalTests = allTestFiles.length;

    // Validate test file paths exist
    const validFiles = new Set(allTestFiles);
    for (const wave of plan.waves) {
      wave.tests = wave.tests.filter(t => t === "ALL_REMAINING" || validFiles.has(t));
    }

    return plan;
  } catch (err: any) {
    console.error("Failed to parse Claude response:", err.message, text.slice(0, 200));
    return { waves: [], totalTests: allTestFiles.length };
  }
}

/**
 * Get the full list of test files from the repo using GitHub tree API.
 */
export async function getTestFileList(
  gh: { api: (method: string, path: string) => Promise<any> },
  owner: string,
  repo: string,
  sha: string,
): Promise<string[]> {
  try {
    const tree = await gh.api("GET", `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const files = (tree.tree as Array<{ path: string; type: string }>)
      .filter(f => f.type === "blob")
      .map(f => f.path);

    return files.filter(f =>
      f.match(/_(spec|test)\.(rb|ts|tsx|js|jsx)$/) ||
      f.match(/\.(spec|test)\.(ts|tsx|js|jsx)$/) ||
      f.match(/^spec\/.*\.rb$/) ||
      f.match(/^test\/.*\.(rb|ts|tsx|js|jsx)$/)
    );
  } catch (err: any) {
    console.error(`Failed to get test file list: ${err.message}`);
    return [];
  }
}
