export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  HISTORY: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.7.0" });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const event = request.headers.get("x-github-event") || "";
      const bodyText = await request.text();
      let body: Record<string, any>;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }

      // Log event
      console.log(`Webhook: ${event}/${body.action}`);
      if (env.HISTORY) {
        await env.HISTORY.put("debug:last_event", JSON.stringify({
          event, action: body.action, ts: new Date().toISOString(),
          pr: body.pull_request?.number,
          repo: body.repository?.full_name,
          installation: body.installation?.id,
        }));
      }

      if ((event === "pull_request" || event === "pull_request_target") && ["opened", "synchronize", "reopened"].includes(body.action)) {
        ctx.waitUntil(handlePR(env, body).catch(async (err) => {
          console.error("handlePR error:", err.message, err.stack);
          if (env.HISTORY) {
            await env.HISTORY.put("debug:last_error", JSON.stringify({
              error: err.message, stack: err.stack, ts: new Date().toISOString(),
              pr: body.pull_request?.number,
            }));
          }
        }));
        return Response.json({ ok: true, event, action: body.action });
      }

      if (event === "workflow_job" && body.action === "completed") {
        ctx.waitUntil(handleWaveComplete(env, body).catch(async (err) => {
          console.error("handleWaveComplete error:", err.message, err.stack);
          if (env.HISTORY) {
            await env.HISTORY.put("debug:last_error", JSON.stringify({
              error: err.message, stack: err.stack, ts: new Date().toISOString(),
            }));
          }
        }));
        return Response.json({ ok: true, event, action: body.action });
      }

      return Response.json({ ok: true, ignored: true, event, action: body.action });
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      const lastEvent = await env.HISTORY.get("debug:last_event", "json");
      const lastError = await env.HISTORY.get("debug:last_error", "json");
      const keys = await env.HISTORY.list({ prefix: "state:", limit: 10 });
      return Response.json({
        version: "0.7.0",
        lastEvent,
        lastError,
        activePRs: keys.keys.map(k => k.name),
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

import { planTestWaves, getTestFileList, type TestWavePlan, type Wave } from "./ai";
import { GitHubClient } from "./github";

// ── State stored in KV per PR ──

interface PRState {
  prNumber: number;
  repo: string;
  owner: string;
  headSha: string;
  headRef: string;
  installationId: number;
  plan: TestWavePlan;
  currentWave: number;       // 0-indexed, which wave we're running
  completedTests: string[];  // tests that have passed
  failedTests: string[];     // tests that have failed
  allTestFiles: string[];    // full repo test list
  confidence: number;        // current confidence (from wave targets)
  status: "running" | "passing" | "failing";
}

async function savePRState(kv: KVNamespace, state: PRState) {
  await kv.put(`state:${state.repo}/${state.owner}:${state.prNumber}`, JSON.stringify(state), {
    expirationTtl: 86400,
  });
}

async function getPRState(kv: KVNamespace, repo: string, owner: string, prNumber: number): Promise<PRState | null> {
  const data = await kv.get(`state:${repo}/${owner}:${prNumber}`, "json");
  return data as PRState | null;
}

// ── PR opened/synchronize handler ──

async function handlePR(env: Env, payload: Record<string, any>) {
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  if (!installationId) return;

  console.log(`PR #${pr.number}: analyzing diff with Claude Opus...`);

  const gh = new GitHubClient(env, installationId);
  await gh.ensureAuth();

  // Get diff with patches
  const diff = await gh.getPRDiff(repo.owner.login, repo.name, pr.number);
  console.log(`PR #${pr.number}: ${diff.length} files changed`);

  // Get all test files
  const allTestFiles = await getTestFileList(gh, repo.owner.login, repo.name, pr.head.sha);
  console.log(`PR #${pr.number}: ${allTestFiles.length} test files in repo`);

  // Ask Claude to plan the waves
  const plan = await planTestWaves(diff, allTestFiles, env.ANTHROPIC_API_KEY);
  console.log(`PR #${pr.number}: ${plan.waves.length} waves planned`);
  for (const w of plan.waves) {
    const testCount = w.tests.includes("ALL_REMAINING") ? "ALL_REMAINING" : w.tests.length;
    console.log(`  Wave ${(w.targetConfidence * 100).toFixed(0)}%: ${testCount} tests - ${w.reason}`);
  }

  // Initialize state
  const state: PRState = {
    prNumber: pr.number,
    repo: repo.name,
    owner: repo.owner.login,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    installationId,
    plan,
    currentWave: 0,
    completedTests: [],
    failedTests: [],
    allTestFiles,
    confidence: 0,
    status: "running",
  };

  // Post initial comment
  const comment = formatComment(state);
  await gh.postConfidenceComment(repo.owner.login, repo.name, pr.number, comment);
  await gh.createCheckRun(repo.owner.login, repo.name, pr.head.sha, "Test Confidence", "in_progress", state);

  // Save state
  await savePRState(env.HISTORY, state);

  // Trigger wave 1
  if (plan.waves.length > 0) {
    const wave = plan.waves[0];
    const tests = resolveWaveTests(wave, state);
    console.log(`PR #${pr.number}: triggering wave 1 with ${tests.length} tests`);
    await gh.triggerTestSubset(repo.owner.login, repo.name, pr.head.ref, tests, pr.number);
    // Store which tests are in this batch
    await env.HISTORY.put(`batch:${pr.number}`, JSON.stringify(tests), { expirationTtl: 86400 });
  } else {
    // No waves = trivial change
    state.confidence = 1;
    state.status = "passing";
    await savePRState(env.HISTORY, state);
    await gh.postConfidenceComment(repo.owner.login, repo.name, pr.number, formatComment(state));
    await gh.createCheckRun(repo.owner.login, repo.name, pr.head.sha, "Test Confidence", "completed", state);
  }
}

// ── Wave completion handler ──

async function handleWaveComplete(env: Env, payload: Record<string, any>) {
  const job = payload.workflow_job;
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  if (!installationId) return;

  // Match tc-pr-XXXX
  const prNumber = parseInt(job.name?.match(/tc-pr-(\d+)/)?.[1] || "0", 10);
  if (!prNumber) return;
  if (job.name === "Build images") return;

  const passed = job.conclusion === "success";
  console.log(`PR #${prNumber}: wave completed (${passed ? "PASS" : "FAIL"})`);

  const gh = new GitHubClient(env, installationId);
  await gh.ensureAuth();

  const state = await getPRState(env.HISTORY, repo.name, repo.owner.login, prNumber);
  if (!state) {
    console.log(`PR #${prNumber}: no state found`);
    return;
  }

  // Get which tests were in this batch
  const batchJson = await env.HISTORY.get(`batch:${prNumber}`);
  const batchTests: string[] = batchJson ? JSON.parse(batchJson) : [];

  if (passed) {
    state.completedTests.push(...batchTests);
    // Confidence = the target of the wave we just completed
    const wave = state.plan.waves[state.currentWave];
    if (wave) {
      state.confidence = wave.targetConfidence;
    }
    state.currentWave++;
  } else {
    state.failedTests.push(...batchTests);
    state.status = "failing";
    state.confidence = 0;
  }

  // Update comment
  await gh.postConfidenceComment(state.owner, state.repo, prNumber, formatComment(state));

  if (state.status === "failing") {
    // Failed — stop
    await gh.createCheckRun(state.owner, state.repo, state.headSha, "Test Confidence", "completed", state);
    await savePRState(env.HISTORY, state);
    console.log(`PR #${prNumber}: FAILED at wave ${state.currentWave}`);
    return;
  }

  // Check if we've hit 99.99% threshold
  if (state.confidence >= 0.9999) {
    state.status = "passing";
    await gh.createCheckRun(state.owner, state.repo, state.headSha, "Test Confidence", "completed", state);
    await savePRState(env.HISTORY, state);
    console.log(`PR #${prNumber}: ✅ PASSED at ${(state.confidence * 100).toFixed(2)}%`);
    return;
  }

  // Trigger next wave
  if (state.currentWave < state.plan.waves.length) {
    const nextWave = state.plan.waves[state.currentWave];
    const tests = resolveWaveTests(nextWave, state);
    console.log(`PR #${prNumber}: triggering wave ${state.currentWave + 1} (target ${(nextWave.targetConfidence * 100).toFixed(0)}%) with ${tests.length} tests`);
    await env.HISTORY.put(`batch:${prNumber}`, JSON.stringify(tests), { expirationTtl: 86400 });
    await savePRState(env.HISTORY, state);
    await gh.triggerTestSubset(state.owner, state.repo, state.headRef, tests, prNumber);
  } else {
    // All waves complete
    state.status = "passing";
    state.confidence = 1;
    await gh.createCheckRun(state.owner, state.repo, state.headSha, "Test Confidence", "completed", state);
    await savePRState(env.HISTORY, state);
    console.log(`PR #${prNumber}: all waves complete`);
  }
}

// ── Helpers ──

function resolveWaveTests(wave: Wave, state: PRState): string[] {
  if (wave.tests.includes("ALL_REMAINING")) {
    const completed = new Set(state.completedTests);
    // Also exclude tests from earlier waves that haven't run yet
    for (let i = 0; i < state.plan.waves.indexOf(wave); i++) {
      for (const t of state.plan.waves[i].tests) {
        if (t !== "ALL_REMAINING") completed.add(t);
      }
    }
    return state.allTestFiles.filter(t => !completed.has(t));
  }
  return wave.tests;
}

function formatComment(state: PRState): string {
  const marker = "<!-- test-confidence -->";
  const pct = (state.confidence * 100).toFixed(1);
  const barLen = 20;
  const filled = Math.round(state.confidence * barLen);
  const bar = "▓".repeat(filled) + "░".repeat(barLen - filled);

  const emoji = state.status === "passing" ? "🟢"
    : state.status === "failing" ? "🔴"
    : "⏳";

  let md = `${marker}\n## ${emoji} Test Confidence: ${pct}%\n\n`;
  md += "```\n";
  md += `${bar} ${pct}%\n`;

  const totalPassed = state.completedTests.length;
  const totalFailed = state.failedTests.length;
  const totalRun = totalPassed + totalFailed;
  md += `${totalPassed} tests passed`;
  if (totalFailed > 0) md += ` · ${totalFailed} failed`;
  md += "\n";

  md += "```\n\n";

  // Wave progress
  if (state.plan.waves.length > 0) {
    md += "**Waves**\n";
    for (let i = 0; i < state.plan.waves.length; i++) {
      const w = state.plan.waves[i];
      const target = `${(w.targetConfidence * 100).toFixed(0)}%`;
      const testCount = w.tests.includes("ALL_REMAINING")
        ? `~${state.allTestFiles.length - state.completedTests.length} remaining`
        : `${w.tests.length} tests`;

      let icon: string;
      if (i < state.currentWave) {
        icon = "✅";
      } else if (i === state.currentWave && state.status === "running") {
        icon = "⏳";
      } else if (i === state.currentWave && state.status === "failing") {
        icon = "❌";
      } else {
        icon = "⬜";
      }

      md += `${icon} **${target}** — ${testCount} — ${w.reason}\n`;
    }
    md += "\n";
  }

  if (state.status === "passing") {
    md += `**PASSED** — Reached ${pct}% confidence after ${totalPassed} tests.\n`;
  } else if (state.status === "failing") {
    md += `**FAILED** — ${totalFailed} test(s) failed.\n`;
  } else {
    md += `**RUNNING** — Wave ${state.currentWave + 1} of ${state.plan.waves.length}\n`;
  }

  return md;
}
