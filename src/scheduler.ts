import cron from "node-cron";
import { Queue } from "bullmq";

// Import shared DB pool
import { dbPool } from "./lib/db";

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

// Initialize BullMQ Queue (keep this local to scheduler)
const dmQueue = new Queue("send_dm");

// Schedule the job to run every minute
cron.schedule("* * * * *", processSchedules);

console.log("Scheduler started, checking every minute.");

// Graceful shutdown for Queue (DB Pool shutdown can be handled centrally)
process.on("SIGTERM", async () => {
  console.log("SIGTERM signal received: closing queue");
  await dmQueue.close();
  console.log("Scheduler queue closed.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT signal received: closing queue");
  await dmQueue.close();
  console.log("Scheduler queue closed.");
  process.exit(0);
});
