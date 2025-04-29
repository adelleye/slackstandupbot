import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";

dotenv.config();

// Initialize Bolt App
export const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel:
    process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  // Note: app.start() needs to be called elsewhere (typically server.ts)
});

// Initialize WebClient (used by worker, summary)
export const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

console.log("Slack Bolt App and WebClient initialized.");
