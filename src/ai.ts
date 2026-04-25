/**
 * AI-powered test ranking using Claude Opus 4.7.
 * Given a diff and list of test files, returns a ranked list of tests
 * most likely to catch regressions, with confidence weights.
 */

interface RankedTest {
  testFile: string;
  weight: number; // 0-100, how likely this test catches a regression from this diff
  reason: string;
}

export async function rankTestsWithAI(
  diff: Array<{ filename: string; additions: number; deletions: number; patch?: string }>,
  allTestFiles: string[],
  apiKey: string,
): Promise<RankedTest[]> {
  const diffSummary = diff.map(f => {
    const changes = f.additions + f.deletions;
    return `${f.filename} (+${f.additions}/-${f.deletions})${f.patch ? `\n${f.patch.slice(0, 500)}` : ""}`;
  }).join("\n\n");

  // Cap test file list to avoid token overflow
  const testFileList = allTestFiles.slice(0, 500).join("\n");

  const prompt = `You are analyzing a code diff to determine which tests are most likely to catch regressions.

## Changed files:
${diffSummary}

## Available test files (${allTestFiles.length} total):
${testFileList}

Rank the test files by how likely they are to catch a regression introduced by this diff. Consider:
- Direct unit tests for changed files (highest priority)
- Integration tests that exercise changed code paths
- Tests for classes/modules that depend on the changed code
- Feature/E2E tests covering affected user flows
- Tests that have historically been flaky around these areas

Return a JSON array of objects with:
- "testFile": exact filename from the list above
- "weight": 0-100 (100 = almost certainly tests this change, 0 = unrelated)
- "reason": brief explanation (one sentence)

Only include tests with weight > 5. Sort by weight descending.
Return ONLY the JSON array, no other text.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Claude API error (${response.status}): ${text}`);
    return [];
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.[0]?.text || "";

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("No JSON array found in Claude response:", text.slice(0, 200));
      return [];
    }
    const ranked: RankedTest[] = JSON.parse(jsonMatch[0]);

    // Validate and normalize
    return ranked
      .filter(r => r.testFile && typeof r.weight === "number" && r.weight > 0)
      .map(r => ({
        testFile: r.testFile,
        weight: Math.max(0, Math.min(100, r.weight)),
        reason: r.reason || "",
      }))
      .sort((a, b) => b.weight - a.weight);
  } catch (err: any) {
    console.error("Failed to parse Claude response:", err.message, text.slice(0, 200));
    return [];
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
    // Get the full tree recursively
    const tree = await gh.api("GET", `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const files = (tree.tree as Array<{ path: string; type: string }>)
      .filter(f => f.type === "blob")
      .map(f => f.path);

    // Filter to test files
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
