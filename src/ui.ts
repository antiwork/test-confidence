import type { ConfidenceState } from "./engine";

export function formatComment(state: ConfidenceState): string {
  const pct = (state.confidence * 100).toFixed(1);
  const targetPct = (state.threshold * 100).toFixed(3);
  const barLen = 20;
  const filled = Math.round(state.confidence * barLen);
  const empty = barLen - filled;
  const bar = "▓".repeat(filled) + "░".repeat(empty);

  const emoji = state.status === "passing" ? "🟢"
    : state.status === "failing" ? "🔴"
    : "⏳";

  const statusLabel = state.status === "passing" ? "PASSING"
    : state.status === "failing" ? "FAILING"
    : "RUNNING";

  let md = `## ${emoji} Test Confidence: ${pct}%\n\n`;
  md += "```\n";
  md += `Confidence ${bar} ${pct}%\n`;

  // Scale bar with markers
  const markerPos = Math.round(state.threshold * barLen);
  const leftDash = "─".repeat(Math.max(0, markerPos));
  const rightDash = "─".repeat(Math.max(0, barLen - markerPos - 1));
  md += ` ├${leftDash}┼${rightDash}┤\n`;

  md += ` ${state.completed} tests · ${state.elapsedSeconds.toFixed(0)}s`;
  md += `    target: ${targetPct}%\n`;

  if (state.etaSeconds > 0 && state.status === "running") {
    md += ` ⏱ ETA to threshold: ~${Math.ceil(state.etaSeconds)}s`;
    md += ` (${state.remaining} tests remaining)\n`;
  }

  if (state.predictionAccuracy > 0) {
    md += ` 📊 Prediction accuracy: ${(state.predictionAccuracy * 100).toFixed(0)}% (last 30 runs)\n`;
  }

  md += "```\n\n";

  // Status line
  if (state.status === "passing") {
    md += `**${statusLabel}** — Reached ${pct}% confidence after ${state.completed}/${state.total} tests.`;
    if (state.remaining > 0) {
      md += ` ${state.remaining} tests skipped.`;
    }
    md += `\n\n`;
  } else if (state.status === "failing") {
    const failed = state.results.filter(r => !r.passed);
    md += `**${statusLabel}** — ${failed.length} test(s) failed.\n\n`;
    if (failed.length > 0) {
      md += "Failed tests:\n";
      for (const f of failed.slice(0, 10)) {
        md += `- \`${f.testFile}\`\n`;
      }
      md += "\n";
    }
  } else {
    md += `**${statusLabel}** — ${state.completed}/${state.total} tests complete.\n\n`;
  }

  // Diff coverage
  const covered = state.diffCoverage.filter(d => d.coveredByTests.length > 0);
  if (covered.length > 0) {
    md += "**Diff coverage**\n```\n";
    for (const dc of covered) {
      const icon = dc.status === "passed" ? "✓"
        : dc.status === "failed" ? "✗"
        : dc.status === "running" ? "⟳"
        : dc.status === "pending" ? "·"
        : "?";

      const n = dc.coveredByTests.length;
      const detail = dc.status === "running"
        ? "running"
        : `covered by ${n} test${n !== 1 ? "s" : ""}`;

      md += ` ${dc.filename}  ${icon} ${detail}\n`;
    }
    md += "```\n";
  }

  // Uncovered files warning
  const uncovered = state.diffCoverage.filter(d => d.status === "uncovered");
  if (uncovered.length > 0) {
    md += "\n⚠️ **Uncovered files** (no matching tests found):\n";
    for (const dc of uncovered) {
      md += `- \`${dc.filename}\`\n`;
    }
  }

  return md;
}
