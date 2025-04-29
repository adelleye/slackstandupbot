import cron from "node-cron";
import { Queue } from "bullmq";
import { startOfToday } from "date-fns"; // Import date-fns utility
import IORedis from "ioredis"; // Import IORedis

// Import shared DB pool
import { dbPool } from "./lib/db";

// Import summary function
import { maybePostSummary } from "./summary";

interface Schedule {
  id: number;
  user_id: string;
  // Assuming questions might be stored or retrieved elsewhere, or a default is used.
  // For now, we only pass user_id based on the skeleton.
  next_run_at: Date;
}

// Function to process due schedules
async function processSchedules() {
  console.log("Scheduler checking for due schedules...");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    // Select rows where next_run_at is due
    const { rows }: { rows: Schedule[] } = await client.query(
      "SELECT id, user_id, next_run_at FROM schedules WHERE next_run_at <= now() FOR UPDATE SKIP LOCKED"
    );

    if (rows.length === 0) {
      console.log("No schedules due.");
      await client.query("COMMIT");
      return;
    }

    console.log(`Found ${rows.length} schedules to process.`);

    for (const sched of rows) {
      console.log(
        `Processing schedule ID: ${sched.id} for user: ${sched.user_id}`
      );

      // Enqueue a job to BullMQ
      await dmQueue.add("send_dm", {
        userId: sched.user_id /*, questions: [] */,
      });
      console.log(`Enqueued job for user: ${sched.user_id}`);

      // Update next_run_at to tomorrow
      await client.query(
        "UPDATE schedules SET next_run_at = next_run_at + interval '1 day' WHERE id = $1",
        [sched.id]
      );
      console.log(`Updated next_run_at for schedule ID: ${sched.id}`);
    }

    await client.query("COMMIT");
    console.log("Finished processing schedules.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error processing schedules:", error);
  } finally {
    client.release();
  }
}

// Create an IORedis connection instance using REDIS_URL or defaults
const redisConnection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) // Use URL
  : new IORedis({
      // Use host/port
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      maxRetriesPerRequest: null, // Recommended for BullMQ
    });

// Initialize BullMQ Queue using the IORedis instance
const dmQueue = new Queue("send_dm", {
  connection: redisConnection.duplicate(), // Pass the duplicated ioredis instance
});

// Schedule the job to check for due DMs every minute
cron.schedule("* * * * *", processSchedules);

// NEW: Schedule the summary job to run daily at 17:05 UTC
cron.schedule(
  "5 17 * * *",
  async () => {
    console.log("Scheduler running daily summary check (17:05 UTC)...");
    const todayUTC = startOfToday(); // Get the start of today in UTC
    const client = await dbPool.connect();
    try {
      // Get all active workspaces (fetch slack_team_id, not internal id)
      const { rows }: { rows: { slack_team_id: string }[] } =
        await client.query(
          `SELECT DISTINCT w.slack_team_id
         FROM schedules s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.is_active = TRUE`
        );

      if (rows.length === 0) {
        console.log("No active workspaces found for summary.");
        return;
      }

      const slackTeamIds = rows.map((row) => row.slack_team_id);
      console.log(
        `Found ${slackTeamIds.length} active workspaces for summary.`
      );

      // Attempt to post summary for each workspace concurrently
      const summaryPromises = slackTeamIds.map((slackTeamId) =>
        maybePostSummary(slackTeamId, todayUTC)
      );

      const results = await Promise.allSettled(summaryPromises);

      // Log results (optional: more detailed logging)
      results.forEach((result, index) => {
        const workspaceId = slackTeamIds[index];
        if (result.status === "fulfilled") {
          console.log(
            `Summary check/post completed for workspace ${workspaceId}: ${result.value}`
          );
        } else {
          console.error(
            `Summary check/post failed for workspace ${workspaceId}:`,
            result.reason
          );
        }
      });

      console.log("Finished daily summary check.");
    } catch (error) {
      console.error("Error during daily summary scheduling:", error);
    } finally {
      client.release();
    }
  },
  {
    scheduled: true,
    timezone: "Etc/UTC", // Explicitly set timezone to UTC
  }
);

console.log(
  "Scheduler started. Checks DMs every minute, posts summaries daily at 17:05 UTC."
);

// Graceful shutdown for Queue (and Redis connection)
process.on("SIGTERM", async () => {
  console.log("SIGTERM signal received: closing queue and Redis connection");
  await dmQueue.close();
  await redisConnection.quit(); // Quit the IORedis connection
  console.log("Scheduler queue and Redis connection closed.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT signal received: closing queue and Redis connection");
  await dmQueue.close();
  await redisConnection.quit(); // Quit the IORedis connection
  console.log("Scheduler queue and Redis connection closed.");
  process.exit(0);
});
