import { App, LogLevel, ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";

dotenv.config();

// Create an Express Receiver
export const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET || "",
});

// Initialize Bolt App with the receiver
export const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  logLevel:
    process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  // Note: app.start() needs to be called elsewhere (typically server.ts)
});

// Initialize WebClient (used by worker, summary)
export const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

console.log("Slack Bolt App and WebClient initialized.");
