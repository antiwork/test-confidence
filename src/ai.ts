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
    return `${f.filename} (+${f.additions}/-${f.deletions})${f.patch ? `\n${f.patch.slice(0, 2000)}` : ""}`;
  }).join("\n\n");

  // Cap test file list to avoid token overflow
  const testFileList = allTestFiles.slice(0, 500).join("\n");

  // Group test files by directory for better context
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

  const prompt = `You are a senior Rails engineer analyzing a code diff to determine which tests could catch regressions.

This is a large Rails monolith (Gumroad). Think carefully about:
1. DIRECT unit tests for changed files
2. TRANSITIVE DEPENDENCIES: if User model changes, what other models/services/controllers use User? Those tests matter too.
3. INTEGRATION tests (spec/requests/, spec/features/) that exercise code paths touching the changed files
4. E2E/feature specs that cover user-facing flows affected by the change
5. Controller specs for any endpoints that use the changed models/services
6. Service specs that call into changed code

Be thorough. A change to a core model like User, Purchase, Link, or Subscription affects MANY tests. Include them.

For a typical model change, you should identify 30-100+ relevant tests across unit, request, controller, feature, and service specs.

## Changed files with patches:
${diffSummary}

## Test file tree (${allTestFiles.length} files):
${testTreeStr}

Return a JSON array of objects:
- "testFile": exact full path from the tree above
- "weight": 0-100 (100 = direct unit test, 80 = integration test for this code path, 50 = tests code that depends on changed code, 20 = tangentially related)
- "reason": one sentence

Include ALL tests with weight >= 10. Be generous. Err on the side of including too many rather than too few.
Sort by weight descending.
Return ONLY the JSON array, no markdown, no explanation.`;

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
