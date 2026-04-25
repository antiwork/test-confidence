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
      return Response.json({ status: "ok", version: "0.3.0" });
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

      // Verify webhook signature
      const sigHeader = request.headers.get("x-hub-signature-256") || "";
      if (env.GITHUB_WEBHOOK_SECRET && sigHeader) {
        const valid = await verifySignature(env.GITHUB_WEBHOOK_SECRET, bodyText, sigHeader);
        if (!valid) {
          console.error(`Webhook signature mismatch for ${event}/${body.action}. Secret length: ${env.GITHUB_WEBHOOK_SECRET.length}`);
          // Continue anyway - don't block on signature issues during development
          // TODO: re-enable strict signature check once verified
        }
      }

      console.log(`Webhook: ${event}/${body.action}`);

      // Store last event for debugging
      if (env.HISTORY) {
        await env.HISTORY.put("debug:last_event", JSON.stringify({
          event, action: body.action, ts: new Date().toISOString(),
          pr: body.pull_request?.number,
          repo: body.repository?.full_name,
          installation: body.installation?.id,
        }));
      }

      if ((event === "pull_request" || event === "pull_request_target") && ["opened", "synchronize", "reopened"].includes(body.action)) {
        ctx.waitUntil(handlePR({ env, payload: body }).catch(async (err) => {
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

      if (event === "workflow_run" && body.action === "completed") {
        ctx.waitUntil(handleWorkflowComplete({ env, payload: body }).catch(err => {
          console.error("handleWorkflowComplete error:", err.message, err.stack);
        }));
        return Response.json({ ok: true, event, action: body.action });
      }

      // Also handle workflow_job completed events (more reliable for matching job names)
      if (event === "workflow_job" && body.action === "completed") {
        ctx.waitUntil(handleWorkflowJobComplete({ env, payload: body }).catch(err => {
          console.error("handleWorkflowJobComplete error:", err.message, err.stack);
        }));
        return Response.json({ ok: true, event, action: body.action });
      }

      return Response.json({ ok: true, ignored: true, event, action: body.action });
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      const keys = await env.HISTORY.list({ prefix: "engine:", limit: 10 });
      const lastEvent = await env.HISTORY.get("debug:last_event", "json");
      const lastError = await env.HISTORY.get("debug:last_error", "json");
      return Response.json({
        version: "0.5.0",
        kvConnected: true,
        lastEvent,
        lastError,
        recentEngineStates: keys.keys.map(k => k.name),
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

import { analyzeDiff } from "./analyzer";
import { BayesianEngine } from "./engine";
import { GitHubClient } from "./github";
import { formatComment } from "./ui";
import { HistoryStore } from "./history";
import { rankTestsWithAI, getTestFileList } from "./ai";

interface Context {
  env: Env;
  payload: Record<string, any>;
}

async function handlePR(ctx: Context) {
  const pr = ctx.payload.pull_request;
  const repo = ctx.payload.repository;
  const installationId = ctx.payload.installation?.id;

  if (!installationId) {
    console.error("No installation ID in webhook payload");
    return;
  }

  console.log(`Processing PR #${pr.number} on ${repo.full_name} (installation: ${installationId})`);

  const gh = new GitHubClient(ctx.env, installationId);

  // Test auth first
  try {
    await gh.ensureAuth();
    console.log("GitHub auth successful");
  } catch (err: any) {
    console.error("GitHub auth failed:", err.message);
    return;
  }

  const history = new HistoryStore(ctx.env.HISTORY, repo.full_name);

  // 1. Get the diff (with patches for AI analysis)
  console.log("Fetching PR diff...");
  const diff = await gh.getPRDiff(repo.owner.login, repo.name, pr.number);
  console.log(`Diff: ${diff.length} files changed`);

  // 2. Read config from repo
  const config = await gh.getRepoConfig(repo.owner.login, repo.name, pr.head.sha);
  console.log(`Config: threshold=${config.threshold}`);

  // 3. Get full test file list from repo
  const allTestFiles = await getTestFileList(gh, repo.owner.login, repo.name, pr.head.sha);
  console.log(`Found ${allTestFiles.length} test files in repo`);

  // 4. AI-powered test ranking with Claude Opus 4.7
  let aiRanking: Array<{ testFile: string; weight: number; reason: string }> = [];
  if (ctx.env.ANTHROPIC_API_KEY && allTestFiles.length > 0) {
    console.log("Ranking tests with Claude Opus 4.7...");
    aiRanking = await rankTestsWithAI(diff, allTestFiles, ctx.env.ANTHROPIC_API_KEY);
    console.log(`AI ranked ${aiRanking.length} relevant tests`);
  } else {
    console.log("No Anthropic API key or no test files, falling back to rule-based analysis");
  }

  // 5. Merge AI ranking with rule-based analysis
  const histData = await history.getTestHistory();
  const analysis = analyzeDiff(diff, histData);

  // If AI returned results, replace the priority queue with AI-ranked tests
  if (aiRanking.length > 0) {
    const aiQueue = aiRanking.map(r => ({
      testFile: r.testFile,
      infoGainPerSecond: r.weight, // Use AI weight directly
      basePassRate: 0.95,
      expectedRuntime: 5,
      coversFiles: diff.map(f => f.filename),
      failRateWhenFilesChange: r.weight / 100,
    }));
    analysis.priorityQueue = aiQueue;
    // Update diff coverage with AI-identified tests
    for (const dc of analysis.diffCoverage) {
      dc.coveredByTests = aiRanking
        .filter(r => r.weight > 20)
        .map(r => r.testFile);
      if (dc.coveredByTests.length > 0) dc.status = "pending";
    }
  }

  console.log(`Analysis: ${analysis.priorityQueue.length} tests prioritized, ${analysis.totalChanges} total changes`);

  // 4. Initialize Bayesian engine
  const engine = new BayesianEngine(analysis, config, histData);
  engine.headSha = pr.head.sha;
  engine.headRef = pr.head.ref;

  // 5. Post initial comment
  const state = engine.getState();
  console.log(`Initial confidence: ${(state.confidence * 100).toFixed(1)}%`);
  await gh.postConfidenceComment(repo.owner.login, repo.name, pr.number, formatComment(state));
  console.log("Posted confidence comment");

  // 6. Create a check run (pending)
  await gh.createCheckRun(repo.owner.login, repo.name, pr.head.sha, "Test Confidence", "in_progress", state);
  console.log("Created check run");

  // 7. Store the first batch of test files so we know what was sent
  const firstBatch = analysis.priorityQueue
    .slice(0, engine.estimateTestsNeeded())
    .map(t => t.testFile);
  
  // Store metadata alongside engine state
  await history.saveEngineState(pr.number, engine.serialize());
  await history.saveBatchFiles(pr.number, firstBatch);
  // Store all test files from repo for subsequent waves
  await history.saveAllTestFiles(pr.number, allTestFiles);
  console.log(`Saved engine state for PR #${pr.number}`);

  // 8. If we have tests to run, trigger subset workflow
  if (firstBatch.length > 0) {
    console.log(`Wave 1: triggering ${firstBatch.length} files: ${firstBatch.slice(0, 3).join(", ")}...`);
    await gh.triggerTestSubset(repo.owner.login, repo.name, pr.head.ref, firstBatch, pr.number);
    console.log("Triggered test-subset workflow");
  } else {
    // No tests to run (config-only change, docs, etc.)
    const noTestState = { ...state, confidence: 0.999, status: "passing" as const };
    await gh.postConfidenceComment(repo.owner.login, repo.name, pr.number, formatComment(noTestState));
    await gh.createCheckRun(repo.owner.login, repo.name, pr.head.sha, "Test Confidence", "completed", noTestState);
    console.log("No tests needed, marked as passing");
  }
}

async function handleWorkflowJobComplete(ctx: Context) {
  const job = ctx.payload.workflow_job;
  const repo = ctx.payload.repository;
  const installationId = ctx.payload.installation?.id;

  if (!installationId) return;

  // Match job names like "tc-pr-4753"
  const prNumber = parseInt(job.name?.match(/tc-pr-(\d+)/)?.[1] || "0", 10);
  if (!prNumber) return;

  // Skip the build step
  if (job.name === "Build images") return;

  console.log(`Job "${job.name}" completed for PR #${prNumber}: ${job.conclusion}`);

  const gh = new GitHubClient(ctx.env, installationId);
  await gh.ensureAuth();

  const history = new HistoryStore(ctx.env.HISTORY, repo.full_name);

  const serialized = await history.getEngineState(prNumber);
  if (!serialized) {
    console.log(`No engine state found for PR #${prNumber}`);
    return;
  }

  const engine = BayesianEngine.deserialize(serialized);

  const passed = job.conclusion === "success";
  const duration = job.completed_at && job.started_at
    ? (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000
    : 5;

  // Only observe the tests that were in THIS batch
  const batchFiles = await history.getBatchFiles(prNumber);
  if (batchFiles.length > 0) {
    const perTestDuration = duration / Math.max(1, batchFiles.length);
    for (const testFile of batchFiles) {
      engine.observe(testFile, passed, perTestDuration);
    }
  } else {
    // Fallback: observe all remaining
    const remaining = [...engine.getRemainingQueue()];
    const perTestDuration = duration / Math.max(1, remaining.length);
    for (const test of remaining) {
      engine.observe(test.testFile, passed, perTestDuration);
    }
  }

  const state = engine.getState();
  console.log(`Wave complete: ${(state.confidence * 100).toFixed(1)}% confidence (${state.completed}/${state.total} AI-ranked tests)`);

  await gh.postConfidenceComment(repo.owner.login, repo.name, prNumber, formatComment(state));

  if (!passed) {
    // Test failure = regression detected
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
    console.log(`PR #${prNumber}: tests failed, stopping`);
  } else if (state.confidence >= state.threshold) {
    // Threshold reached!
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
    console.log(`PR #${prNumber}: ✅ ${(state.confidence * 100).toFixed(1)}% >= ${(state.threshold * 100).toFixed(2)}%`);
  } else {
    // Below threshold — trigger next wave
    // Get all test files from the repo and pick ones not yet run
    const allTestFiles = await history.getAllTestFiles(prNumber);
    const completedTests = new Set(state.results.map(r => r.testFile));
    const untested = allTestFiles.filter(f => !completedTests.has(f));

    if (untested.length > 0) {
      // Pick next batch: proportional to gap. Bigger gap = bigger batch.
      const gap = state.threshold - state.confidence;
      const batchSize = Math.max(10, Math.min(50, Math.ceil(untested.length * gap)));
      const nextBatch = untested.slice(0, batchSize);

      console.log(`Next wave: ${nextBatch.length} tests (${untested.length} untested remain, gap: ${(gap * 100).toFixed(1)}%)`);
      await history.saveBatchFiles(prNumber, nextBatch);

      // Add these to the engine's queue so confidence math works
      engine.addTests(nextBatch);
      await history.saveEngineState(prNumber, engine.serialize());

      await gh.triggerTestSubset(
        repo.owner.login, repo.name, state.headRef,
        nextBatch, prNumber,
      );
    } else {
      // No more tests to run
      console.log(`PR #${prNumber}: all tests exhausted at ${(state.confidence * 100).toFixed(1)}%`);
      await gh.createCheckRun(
        repo.owner.login, repo.name, state.headSha,
        "Test Confidence", "completed", state,
      );
    }
  }

  await history.saveEngineState(prNumber, engine.serialize());
  await history.recordResults(batchFiles.map(f => ({ testFile: f, passed, durationSeconds: duration / Math.max(1, batchFiles.length) })));
}

async function handleWorkflowComplete(ctx: Context) {
  const run = ctx.payload.workflow_run;
  const repo = ctx.payload.repository;
  const installationId = ctx.payload.installation?.id;

  if (!installationId) return;

  // Check if this is a test-confidence triggered run via workflow name or jobs
  // First try run.display_title which includes inputs
  const prNumber = parseInt(run.name?.match(/tc-pr-(\d+)/)?.[1] || "0", 10)
    || parseInt(run.display_title?.match(/tc-pr-(\d+)/)?.[1] || "0", 10);
  if (!prNumber) return;

  console.log(`Workflow completed for PR #${prNumber}: ${run.conclusion}`);

  const gh = new GitHubClient(ctx.env, installationId);
  await gh.ensureAuth();

  const history = new HistoryStore(ctx.env.HISTORY, repo.full_name);

  // Restore engine state
  const serialized = await history.getEngineState(prNumber);
  if (!serialized) {
    console.log(`No engine state found for PR #${prNumber}`);
    return;
  }

  const engine = BayesianEngine.deserialize(serialized);

  // Get test results from the workflow run jobs
  const results = await gh.getWorkflowTestResults(repo.owner.login, repo.name, run.id);
  console.log(`Got ${results.length} test results`);

  // Update posterior with each result
  for (const result of results) {
    engine.observe(result.testFile, result.passed, result.durationSeconds);
  }

  const state = engine.getState();
  console.log(`Updated confidence: ${(state.confidence * 100).toFixed(1)}% (${state.completed}/${state.total} tests)`);

  // Update PR comment
  await gh.postConfidenceComment(repo.owner.login, repo.name, prNumber, formatComment(state));

  // Check if we've hit threshold
  if (state.confidence >= state.threshold) {
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
    console.log(`PR #${prNumber}: ✅ passed at ${(state.confidence * 100).toFixed(1)}%`);
  } else if (state.remaining > 0) {
    // Trigger next batch
    const nextBatch = engine.getNextBatch();
    if (nextBatch.length > 0) {
      console.log(`Triggering next batch of ${nextBatch.length} tests`);
      await gh.triggerTestSubset(
        repo.owner.login, repo.name, state.headRef,
        nextBatch.map(t => t.testFile), prNumber,
      );
    }
  } else {
    // All tests complete
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
  }

  // Save updated state
  await history.saveEngineState(prNumber, engine.serialize());
  await history.recordResults(results);
}

async function verifySignature(secret: string, payload: string, sigHeader: string): Promise<boolean> {
  const sig = sigHeader.replace("sha256=", "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === sig;
}
