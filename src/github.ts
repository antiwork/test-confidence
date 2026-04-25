import type { Env } from "./worker";

export class GitHubClient {
  private env: Env;
  private installationId: number;
  private token: string | null = null;

  constructor(env: Env, installationId: number) {
    this.env = env;
    this.installationId = installationId;
  }

  async ensureAuth(): Promise<void> {
    await this.getToken();
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    const jwt = await createAppJWT(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY);

    const resp = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "test-confidence/0.3.0",
        },
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub auth failed (${resp.status}): ${text}`);
    }

    const data = await resp.json() as { token: string };
    if (!data.token) {
      throw new Error(`GitHub auth: no token in response: ${JSON.stringify(data)}`);
    }
    this.token = data.token;
    return this.token;
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.getToken();
    const resp = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "test-confidence/0.3.0",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`GitHub API ${method} ${path} failed (${resp.status}): ${text}`);
      throw new Error(`GitHub API error ${resp.status}: ${text}`);
    }

    // Some endpoints return 204 with no body
    if (resp.status === 204) return {};

    return resp.json();
  }

  async getPRDiff(owner: string, repo: string, prNumber: number) {
    const data = await this.api("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
    return (data as any[]).map((f: any) => ({
      filename: f.filename as string,
      additions: f.additions as number,
      deletions: f.deletions as number,
      patch: (f.patch as string) || "",
    }));
  }

  async getRepoConfig(owner: string, repo: string, ref: string) {
    try {
      const data = await this.api("GET", `/repos/${owner}/${repo}/contents/.test-confidence.yml?ref=${ref}`);
      const content = atob((data as any).content.replace(/\n/g, ""));
      return parseYamlConfig(content);
    } catch {
      return { threshold: 0.9999, paths: {} };
    }
  }

  async postConfidenceComment(owner: string, repo: string, prNumber: number, body: string) {
    const marker = "<!-- test-confidence -->";
    const fullBody = marker + "\n" + body;

    try {
      const comments = await this.api("GET", `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
      const existing = (comments as any[]).find((c: any) => c.body?.includes(marker));

      if (existing) {
        await this.api("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body: fullBody });
      } else {
        await this.api("POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body: fullBody });
      }
    } catch (err: any) {
      console.error(`Failed to post comment on PR #${prNumber}: ${err.message}`);
    }
  }

  async createCheckRun(
    owner: string, repo: string, sha: string,
    name: string, status: "in_progress" | "completed",
    state: { confidence: number; status: string; completedTests?: string[]; failedTests?: string[] },
  ) {
    const conclusion = status === "completed"
      ? (state.status === "passing" ? "success" : "failure")
      : undefined;

    const pct = (state.confidence * 100).toFixed(1);
    const passed = state.completedTests?.length || 0;
    const failed = state.failedTests?.length || 0;

    try {
      await this.api("POST", `/repos/${owner}/${repo}/check-runs`, {
        name,
        head_sha: sha,
        status,
        ...(conclusion ? { conclusion } : {}),
        output: {
          title: `${pct}% confidence`,
          summary: state.status === "passing"
            ? `✅ ${pct}% confidence after ${passed} tests.`
            : state.status === "failing"
            ? `❌ ${failed} test(s) failed.`
            : `${pct}% confidence — ${passed} tests passed so far.`,
        },
      });
    } catch (err: any) {
      console.error(`Failed to create check run: ${err.message}`);
    }
  }

  async triggerTestSubset(
    owner: string, repo: string, ref: string,
    testFiles: string[], prNumber: number,
  ) {
    try {
      await this.api("POST", `/repos/${owner}/${repo}/actions/workflows/test-subset.yml/dispatches`, {
        ref: "main", // workflow_dispatch needs ref where the workflow file exists
        inputs: {
          test_files: testFiles.join(","),
          pr_number: String(prNumber),
          run_name: `tc-pr-${prNumber}`,
        },
      });
    } catch (err: any) {
      console.error(`Failed to trigger test-subset: ${err.message}`);
    }
  }

  async getWorkflowTestResults(owner: string, repo: string, runId: number) {
    const jobs = await this.api("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
    return (jobs.jobs as any[])
      .filter((j: any) => j.name !== "Build images")
      .map((j: any) => ({
        testFile: j.name,
        passed: j.conclusion === "success",
        durationSeconds: j.completed_at && j.started_at
          ? (new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000
          : 5,
      }));
  }
}

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

async function createAppJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 }));
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sig = base64url(signature);

  return `${unsigned}.${sig}`;
}

function base64url(input: string | ArrayBuffer): string {
  let b64: string;
  if (typeof input === "string") {
    b64 = btoa(input);
  } else {
    b64 = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
