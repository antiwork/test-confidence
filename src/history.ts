import type { TestHistoryEntry } from "./analyzer";

/**
 * Stores historical test data in Cloudflare KV.
 * Key scheme:
 *   history:{repo} → TestHistoryEntry[]
 *   engine:{repo}:{prNumber} → serialized BayesianEngine state
 */
export class HistoryStore {
  private kv: KVNamespace;
  private repo: string;

  constructor(kv: KVNamespace, repo: string) {
    this.kv = kv;
    this.repo = repo;
  }

  async getTestHistory(): Promise<TestHistoryEntry[]> {
    const data = await this.kv.get(`history:${this.repo}`, "json");
    return (data as TestHistoryEntry[]) || [];
  }

  async saveEngineState(prNumber: number, serialized: string): Promise<void> {
    // TTL: 24 hours (engine state is ephemeral per PR run)
    await this.kv.put(`engine:${this.repo}:${prNumber}`, serialized, {
      expirationTtl: 86400,
    });
  }

  async getEngineState(prNumber: number): Promise<string | null> {
    return this.kv.get(`engine:${this.repo}:${prNumber}`);
  }

  async saveBatchFiles(prNumber: number, files: string[]): Promise<void> {
    await this.kv.put(`batch:${this.repo}:${prNumber}`, JSON.stringify(files), {
      expirationTtl: 86400,
    });
  }

  async getBatchFiles(prNumber: number): Promise<string[]> {
    const data = await this.kv.get(`batch:${this.repo}:${prNumber}`, "json");
    return (data as string[]) || [];
  }

  async saveAllTestFiles(prNumber: number, files: string[]): Promise<void> {
    await this.kv.put(`alltests:${this.repo}:${prNumber}`, JSON.stringify(files), {
      expirationTtl: 86400,
    });
  }

  async getAllTestFiles(prNumber: number): Promise<string[]> {
    const data = await this.kv.get(`alltests:${this.repo}:${prNumber}`, "json");
    return (data as string[]) || [];
  }

  async recordResults(
    results: Array<{ testFile: string; passed: boolean; durationSeconds: number }>,
  ): Promise<void> {
    const history = await this.getTestHistory();
    const histMap = new Map(history.map(h => [h.testFile, h]));

    for (const result of results) {
      const existing = histMap.get(result.testFile);
      if (existing) {
        // Rolling average update
        const n = existing.totalRuns;
        existing.avgRuntime = (existing.avgRuntime * n + result.durationSeconds) / (n + 1);
        existing.passRate = (existing.passRate * n + (result.passed ? 1 : 0)) / (n + 1);
        existing.totalRuns = n + 1;
      } else {
        histMap.set(result.testFile, {
          testFile: result.testFile,
          avgRuntime: result.durationSeconds,
          passRate: result.passed ? 1 : 0,
          fileCorrelations: {},
          totalRuns: 1,
        });
      }
    }

    await this.kv.put(`history:${this.repo}`, JSON.stringify(Array.from(histMap.values())));
  }
}
