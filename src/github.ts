import type { Env } from "./worker";
import type { ConfidenceState } from "./engine";

export class GitHubClient {
  private env: Env;
  private installationId: number;
  private token: string | null = null;

  constructor(env: Env, installationId: number) {
    this.env = env;
    this.installationId = installationId;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    // Create JWT from App credentials
    const jwt = await createAppJWT(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY);

    // Exchange for installation token
    const resp = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "test-confidence/0.2.0",
        },
      },
    );

    const data = await resp.json() as { token: string };
    this.token = data.token;
    return this.token;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getToken();
    const resp = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "test-confidence/0.2.0",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return resp.json();
  }

  async getPRDiff(owner: string, repo: string, prNumber: number) {
    const data = await this.api("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    return (data as any[]).map((f: any) => ({
      filename: f.filename as string,
      additions: f.additions as number,
      deletions: f.deletions as number,
    }));
  }

  async getRepoConfig(owner: string, repo: string, ref: string) {
    try {
      const data = await this.api("GET", `/repos/${owner}/${repo}/contents/.test-confidence.yml?ref=${ref}`);
      const content = atob((data as any).content);
      return parseYamlConfig(content);
    } catch {
      return { threshold: 0.9999, paths: {} };
    }
  }

  async postConfidenceComment(owner: string, repo: string, prNumber: number, body: string) {
    const marker = "<!-- test-confidence -->";
    const fullBody = marker + "\n" + body;

    const comments = await this.api("GET", `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
    const existing = (comments as any[]).find((c: any) => c.body?.includes(marker));

    if (existing) {
      await this.api("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body: fullBody });
    } else {
      await this.api("POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body: fullBody });
    }
  }

  async createCheckRun(
    owner: string, repo: string, sha: string,
    name: string, status: "in_progress" | "completed",
    state: ConfidenceState,
  ) {
    const conclusion = status === "completed"
      ? (state.confidence >= state.threshold ? "success" : "failure")
      : undefined;

    await this.api("POST", `/repos/${owner}/${repo}/check-runs`, {
      name,
      head_sha: sha,
      status,
      ...(conclusion ? { conclusion } : {}),
      output: {
        title: `${(state.confidence * 100).toFixed(1)}% confidence`,
        summary: state.confidence >= state.threshold
          ? `✅ Reached ${(state.confidence * 100).toFixed(1)}% confidence after ${state.completed}/${state.total} tests (${state.elapsedSeconds.toFixed(0)}s). ${state.remaining} tests skipped.`
          : `${state.completed}/${state.total} tests complete. Confidence: ${(state.confidence * 100).toFixed(1)}%`,
      },
    });
  }

  async triggerTestSubset(
    owner: string, repo: string, ref: string,
    testFiles: string[], prNumber: number,
  ) {
    await this.api("POST", `/repos/${owner}/${repo}/actions/workflows/test-subset.yml/dispatches`, {
      ref,
      inputs: {
        test_files: testFiles.join(","),
        pr_number: String(prNumber),
        run_name: `tc-pr-${prNumber}`,
      },
    });
  }

  async getWorkflowTestResults(owner: string, repo: string, runId: number) {
    // Get artifacts from the workflow run that contain test results
    const artifacts = await this.api("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
    const resultArtifact = (artifacts.artifacts as any[])?.find((a: any) => a.name === "test-confidence-results");

    if (!resultArtifact) {
      // Fallback: infer from job outcomes
      const jobs = await this.api("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
      return (jobs.jobs as any[]).map((j: any) => ({
        testFile: j.name,
        passed: j.conclusion === "success",
        durationSeconds: j.completed_at && j.started_at
          ? (new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000
          : 5,
      }));
    }

    // Download and parse results artifact
    const download = await this.api("GET", `/repos/${owner}/${repo}/actions/artifacts/${resultArtifact.id}/zip`);
    // TODO: unzip and parse JSON results
    return [];
  }
}

// Minimal YAML parser for .test-confidence.yml (no deps)
function parseYamlConfig(content: string): { threshold: number; paths: Record<string, number> } {
  const lines = content.split("\n");
  let threshold = 0.9999;
  const paths: Record<string, number> = {};
  let inPaths = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;

    if (trimmed.startsWith("threshold:")) {
      threshold = parseFloat(trimmed.split(":")[1].trim());
    } else if (trimmed === "paths:") {
      inPaths = true;
    } else if (inPaths && trimmed.includes(":")) {
      const [key, val] = trimmed.split(":");
      const cleanKey = key.trim().replace(/^["']|["']$/g, "");
      const cleanVal = parseFloat(val.trim());
      if (!isNaN(cleanVal)) {
        paths[cleanKey] = cleanVal;
      }
    } else if (!trimmed.startsWith(" ") && !trimmed.startsWith("\t")) {
      inPaths = false;
    }
  }

  return { threshold, paths };
}

// Create a JWT for GitHub App authentication
async function createAppJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 }));
  const unsigned = `${header}.${payload}`;

  // Import the private key and sign
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return `${unsigned}.${sig}`;
}

function pemToBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}
