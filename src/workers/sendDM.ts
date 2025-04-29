import { Worker, Job } from "bullmq";
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
    type: "input",
    block_id: "yesterday",
    label: {
      type: "plain_text",
      text: "What did you accomplish yesterday?",
    },
    element: {
      type: "plain_text_input",
      action_id: "yesterday_input",
      multiline: true,
    },
  },
  {
    type: "input",
    block_id: "today",
    label: {
      type: "plain_text",
      text: "What are your top priorities for today?",
    },
    element: {
      type: "plain_text_input",
      action_id: "today_input",
      multiline: true,
    },
  },
  {
    type: "input",
    block_id: "blockers",
    label: {
      type: "plain_text",
      text: "Any blockers impeding your progress?",
    },
    element: {
      type: "plain_text_input",
      action_id: "blockers_input",
      multiline: true,
    },
    optional: true, // Making blockers optional
  },
  {
    type: "actions",
    block_id: "submit_standup",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Submit Stand-up",
          emoji: true,
        },
        style: "primary",
        action_id: "submit_standup_action", // We'll need to handle this action in the main app
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

// Initialize BullMQ Worker
// Default connection is Redis at 127.0.0.1:6379
const worker = new Worker("send_dm", processSendDmJob, {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    // password: process.env.REDIS_PASSWORD // Add if needed
  },
  // Optional: Add concurrency, rate limiting, etc.
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
  console.log("Closing SendDM worker...");
  await worker.close();
  console.log("SendDM worker closed.");
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
