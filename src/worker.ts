export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  HISTORY: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const event = request.headers.get("x-github-event") || "";
      const body = await request.json() as Record<string, any>;

      // Verify webhook signature in production
      // const signature = request.headers.get("x-hub-signature-256");
      // TODO: verify with GITHUB_WEBHOOK_SECRET

      if (event === "pull_request" && ["opened", "synchronize"].includes(body.action)) {
        // Fire and forget — process asynchronously
        const ctx = { env, payload: body };
        // Use waitUntil if available (Cloudflare Workers)
        handlePR(ctx).catch(console.error);
        return Response.json({ ok: true, queued: true });
      }

      if (event === "workflow_run" && body.action === "completed") {
        handleWorkflowComplete({ env, payload: body }).catch(console.error);
        return Response.json({ ok: true, queued: true });
      }

      return Response.json({ ok: true, ignored: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

import { analyzeDiff } from "./analyzer";
import { BayesianEngine } from "./engine";
import { GitHubClient } from "./github";
import { formatComment } from "./ui";
import { HistoryStore } from "./history";

interface Context {
  env: Env;
  payload: Record<string, any>;
}

async function handlePR(ctx: Context) {
  const pr = ctx.payload.pull_request;
  const repo = ctx.payload.repository;
  const installationId = ctx.payload.installation?.id;

  const gh = new GitHubClient(ctx.env, installationId);
  const history = new HistoryStore(ctx.env.HISTORY, repo.full_name);

  // 1. Get the diff
  const diff = await gh.getPRDiff(repo.owner.login, repo.name, pr.number);

  // 2. Read config from repo
  const config = await gh.getRepoConfig(repo.owner.login, repo.name, pr.head.sha);

  // 3. Analyze diff → prioritized test list
  const histData = await history.getTestHistory();
  const analysis = analyzeDiff(diff, histData);

  // 4. Initialize Bayesian engine
  const engine = new BayesianEngine(analysis, config, histData);

  // 5. Post initial comment
  const state = engine.getState();
  await gh.postConfidenceComment(repo.owner.login, repo.name, pr.number, formatComment(state));

  // 6. Create a check run (pending)
  await gh.createCheckRun(repo.owner.login, repo.name, pr.head.sha, "Test Confidence", "in_progress", state);

  // 7. Trigger the subset test workflow
  const testFiles = analysis.priorityQueue
    .slice(0, engine.estimateTestsNeeded())
    .map(t => t.testFile);

  await gh.triggerTestSubset(repo.owner.login, repo.name, pr.head.ref, testFiles, pr.number);

  // 8. Store engine state for webhook callbacks
  await history.saveEngineState(pr.number, engine.serialize());
}

async function handleWorkflowComplete(ctx: Context) {
  const run = ctx.payload.workflow_run;
  const repo = ctx.payload.repository;
  const installationId = ctx.payload.installation?.id;

  // Check if this is a test-confidence triggered run
  const prNumber = parseInt(run.name?.match(/tc-pr-(\d+)/)?.[1] || "0", 10);
  if (!prNumber) return;

  const gh = new GitHubClient(ctx.env, installationId);
  const history = new HistoryStore(ctx.env.HISTORY, repo.full_name);

  // Restore engine state
  const serialized = await history.getEngineState(prNumber);
  if (!serialized) return;

  const engine = BayesianEngine.deserialize(serialized);

  // Get test results from the workflow run
  const results = await gh.getWorkflowTestResults(repo.owner.login, repo.name, run.id);

  // Update posterior with each result
  for (const result of results) {
    engine.observe(result.testFile, result.passed, result.durationSeconds);
  }

  const state = engine.getState();

  // Update PR comment
  await gh.postConfidenceComment(repo.owner.login, repo.name, prNumber, formatComment(state));

  // Check if we've hit threshold
  if (state.confidence >= state.threshold) {
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
    console.log(`PR #${prNumber}: ✅ ${(state.confidence * 100).toFixed(1)}% confidence after ${state.completed}/${state.total} tests (${state.elapsedSeconds}s)`);
  } else if (state.remaining > 0) {
    // Trigger next batch
    const nextBatch = engine.getNextBatch();
    if (nextBatch.length > 0) {
      await gh.triggerTestSubset(
        repo.owner.login, repo.name, state.headRef,
        nextBatch.map(t => t.testFile), prNumber,
      );
    }
  } else {
    // All tests complete, still below threshold
    await gh.createCheckRun(
      repo.owner.login, repo.name, state.headSha,
      "Test Confidence", "completed", state,
    );
  }

  // Save updated state
  await history.saveEngineState(prNumber, engine.serialize());

  // Save test results to history for future runs
  await history.recordResults(results);
}
