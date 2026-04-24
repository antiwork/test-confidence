import { Octokit } from "octokit";
import { config } from "./config.js";
import { createAppAuth } from "@octokit/auth-app";

const appOctokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
  },
});

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const { data: { token } } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  return new Octokit({ auth: token });
}

interface PostCommentParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  state: {
    confidence: number;
    threshold: number;
    completed: number;
    remaining: number;
    total: number;
    elapsedSeconds: number;
    diffCoverage: Array<{
      filename: string;
      coveredByTests: string[];
      status: string;
    }>;
    results: Array<{
      testFile: string;
      passed: boolean;
      durationSeconds: number;
    }>;
  };
}

export async function postConfidenceComment(params: PostCommentParams): Promise<void> {
  const { owner, repo, prNumber, installationId, state } = params;
  const octokit = await getInstallationOctokit(installationId);

  const body = formatConfidenceComment(state);

  // Find existing comment
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  const marker = "<!-- test-confidence -->";
  const existing = comments.find((c) => c.body?.includes(marker));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: marker + "\n" + body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: marker + "\n" + body,
    });
  }
}

function formatConfidenceComment(state: PostCommentParams["state"]): string {
  const pct = (state.confidence * 100).toFixed(1);
  const targetPct = (state.threshold * 100).toFixed(2);
  const barFilled = Math.round(state.confidence * 20);
  const barEmpty = 20 - barFilled;
  const bar = "▓".repeat(barFilled) + "░".repeat(barEmpty);

  const emoji = state.confidence >= state.threshold ? "🟢" :
    state.confidence >= 0.99 ? "🟡" : "🔴";

  const status = state.confidence >= state.threshold ? "PASSING" :
    state.remaining === 0 ? "FAILING" : "RUNNING";

  let body = `## ${emoji} Test Confidence: ${pct}%\n\n`;
  body += "```\n";
  body += `Confidence ${bar} ${pct}%\n`;
  body += ` ├${"─".repeat(barFilled)}┼${"─".repeat(Math.max(0, barEmpty - 1))}┤\n`;
  body += ` ${state.completed} tests · ${state.elapsedSeconds.toFixed(0)}s    target: ${targetPct}%\n`;
  body += "```\n\n";

  if (status === "PASSING") {
    body += `✅ **${status}** — Confidence threshold reached after ${state.completed}/${state.total} tests. ${state.remaining} tests skipped.\n\n`;
  } else if (status === "FAILING") {
    const failedTests = state.results.filter((r) => !r.passed);
    body += `❌ **${status}** — ${failedTests.length} test(s) failed.\n\n`;
  } else {
    body += `⏳ **${status}** — ${state.completed}/${state.total} tests complete, ${state.remaining} remaining.\n\n`;
  }

  // Diff coverage
  const coverageItems = state.diffCoverage.filter((d) => d.coveredByTests.length > 0);
  if (coverageItems.length > 0) {
    body += "**Diff coverage**\n```\n";
    for (const dc of coverageItems) {
      const icon = dc.status === "passed" ? "✓" :
        dc.status === "failed" ? "✗" :
        dc.status === "running" ? "⟳" :
        dc.status === "covered" ? "·" : "?";
      const testCount = dc.coveredByTests.length;
      const statusText = dc.status === "running"
        ? `running`
        : `covered by ${testCount} test${testCount !== 1 ? "s" : ""}`;
      body += ` ${dc.filename}  ${icon} ${statusText}\n`;
    }
    body += "```\n";
  }

  return body;
}
