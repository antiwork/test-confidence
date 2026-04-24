import express from "express";
import { handleWebhook } from "./webhook.js";
import { config } from "./config.js";

const app = express();
app.use(express.json());

app.post("/webhook", handleWebhook);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

const port = config.port;
app.listen(port, () => {
  console.log(`Test Confidence listening on port ${port}`);
});
