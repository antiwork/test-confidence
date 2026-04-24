import type { Request, Response } from "express";
import { analyzePR } from "./analyzer.js";
import { runConfidenceLoop } from "./engine.js";
import { postConfidenceComment } from "./github.js";

export async function handleWebhook(req: Request, res: Response) {
  const event = req.headers["x-github-event"] as string;
  const payload = req.body;

  if (event === "pull_request" && ["opened", "synchronize"].includes(payload.action)) {
    const pr = payload.pull_request;
    const repo = payload.repository;

    console.log(`PR #${pr.number} on ${repo.full_name}: ${payload.action}`);

    // Fire and forget — respond to GitHub immediately
    res.status(200).json({ ok: true });

    try {
      // 1. Analyze the diff
      const analysis = await analyzePR({
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: pr.number,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        installationId: payload.installation.id,
      });

      // 2. Run the confidence loop
      await runConfidenceLoop({
        analysis,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: pr.number,
        headSha: pr.head.sha,
        installationId: payload.installation.id,
      });
    } catch (error) {
      console.error(`Error processing PR #${pr.number}:`, error);
    }

    return;
  }

  // Check run completed — update confidence in real-time
  if (event === "check_run" && payload.action === "completed") {
    const checkRun = payload.check_run;
    const repo = payload.repository;

    // TODO: Match check run to our tracked test execution
    // Update posterior and refresh PR comment

    res.status(200).json({ ok: true });
    return;
  }

  res.status(200).json({ ok: true, ignored: true });
}
