export const config = {
  port: parseInt(process.env.PORT || "3400", 10),
  githubAppId: process.env.GITHUB_APP_ID || "",
  githubPrivateKey: process.env.GITHUB_PRIVATE_KEY || "",
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  defaultThreshold: 0.9999,
};
