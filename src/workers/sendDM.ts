import { Worker, Job } from "bullmq";
import IORedis from "ioredis"; // Import IORedis
// import { WebClient } from "@slack/web-api"; // Removed import
// import dotenv from "dotenv"; // Removed import

// Import shared WebClient
import { webClient as slackClient } from "../lib/slack"; // Correct path relative to src/workers/

// Define standard stand-up questions using Block Kit
const standupQuestionsBlocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "👋 Hey there! Time for your daily stand-up.",
    },
  },
  {
    type: "divider",
  },
  {
    type: "actions",
    block_id: "open_standup_modal_block",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "📝 Fill out your stand-up",
          emoji: true,
        },
        style: "primary",
        action_id: "open_standup_modal",
      },
    ],
  },
];

// Worker processor function (uses imported slackClient)
const processSendDmJob = async (job: Job<{ userId: string }>) => {
  const { userId } = job.data;
  console.log(`Processing send_dm job ${job.id} for user ${userId}`);

  try {
    // Send the message using WebClient
    const result = await slackClient.chat.postMessage({
      channel: userId, // Send DM to the user
      text: "Time for your daily stand-up!", // Fallback text for notifications
      blocks: standupQuestionsBlocks,
    });

    if (result.ok) {
      console.log(
        `Successfully sent stand-up DM to user ${userId}, job ${job.id}`
      );
    } else {
      throw new Error(`Slack API error: ${result.error}`);
    }
  } catch (error: any) {
    console.error(
      `Failed to send stand-up DM to user ${userId}, job ${job.id}:`,
      error.message || error
    );
    // Re-throw the error so BullMQ knows the job failed
    throw error;
  }
};

// Create an IORedis connection instance using REDIS_URL or defaults
const redisConnection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new IORedis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      maxRetriesPerRequest: null,
    });

// Initialize BullMQ Worker using the IORedis instance
const worker = new Worker("send_dm", processSendDmJob, {
  connection: redisConnection.duplicate(), // Use duplicated ioredis instance
  limiter: { max: 45, duration: 60000 }, // Add rate limiting (45 jobs per minute)
  // Optional: Add concurrency
  // concurrency: 5,
});

// Event listeners for logging
worker.on("completed", (job: Job, returnValue: any) => {
  console.log(
    `Job ${job.id} (send_dm for user ${job.data.userId}) completed successfully.`
  );
});

worker.on("failed", (job: Job | undefined, err: Error) => {
  if (job) {
    console.error(
      `Job ${job.id} (send_dm for user ${job.data.userId}) failed with error: ${err.message}`
    );
  } else {
    console.error(`A job failed with error: ${err.message}`);
  }
});

console.log("SendDM worker started, waiting for jobs...");

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log("Closing SendDM worker and Redis connection...");
  await worker.close();
  await redisConnection.quit(); // Quit the IORedis connection
  console.log("SendDM worker and Redis connection closed.");
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
