import { format } from "date-fns"; // Using date-fns for reliable date formatting

// Import shared instances
import { dbPool } from "./lib/db"; // Correct path relative to src/
import { webClient as slackClient } from "./lib/slack"; // Correct path relative to src/

interface Answer {
  user_id: string;
  yesterday: string;
  today: string;
  blockers: string | null;
}

interface WorkspaceConfig {
  summary_channel: string | null;
  // Assuming a table 'workspaces' stores config like summary channel per workspace_id (team_id)
}

// Cutoff time: 17:00 UTC
const CUTOFF_HOUR_UTC = 17;

/**
 * Checks if conditions are met to post a daily summary and posts it if so.
 * Conditions: EITHER all scheduled participants have answered for the given date,
 * OR the current time is past the daily cutoff time (17:00 UTC).
 *
 * @param workspaceId The Slack workspace ID (team_id)
 * @param date The specific date for which to generate the summary (at 00:00:00 UTC)
 */
export async function maybePostSummary(
  workspaceId: string,
  date: Date
): Promise<void> {
  console.log(
    `[${workspaceId}] Checking summary conditions for date: ${
      date.toISOString().split("T")[0]
    }`
  );
  const client = await dbPool.connect();

  try {
    // 1. Get workspace configuration (summary channel)
    // Assumes a table 'workspaces' with columns 'workspace_id' (TEXT, PRIMARY KEY) and 'summary_channel' (TEXT)
    const configRes = await client.query<WorkspaceConfig>(
      "SELECT summary_channel FROM workspaces WHERE workspace_id = $1",
      [workspaceId]
    );

    if (configRes.rows.length === 0 || !configRes.rows[0].summary_channel) {
      console.log(
        `[${workspaceId}] No summary channel configured. Skipping summary.`
      );
      return;
    }
    const summaryChannel = configRes.rows[0].summary_channel;

    // 2. Get list of active participants scheduled for stand-up
    // Assumes 'schedules' table has 'workspace_id' and 'is_active' (BOOLEAN) columns
    const participantsRes = await client.query<{ user_id: string }>(
      "SELECT user_id FROM schedules WHERE workspace_id = $1 AND is_active = TRUE",
      [workspaceId]
    );
    const participantUserIds = new Set(
      participantsRes.rows.map((p) => p.user_id)
    );

    if (participantUserIds.size === 0) {
      console.log(
        `[${workspaceId}] No active participants found for this workspace. Skipping summary.`
      );
      return;
    }
    console.log(
      `[${workspaceId}] Found ${participantUserIds.size} active participants.`
    );

    // 3. Calculate date range for answers (full day in UTC based on the input date)
    const startDate = new Date(date); // Input 'date' is assumed to be the start of the day UTC
    const endDate = new Date(startDate);
    endDate.setUTCDate(startDate.getUTCDate() + 1);

    // 4. Get answers submitted within the date range for this workspace
    // Assumes 'answers' table has 'workspace_id' (TEXT) column
    const answersRes = await client.query<Answer>(
      `SELECT user_id, yesterday, today, blockers
       FROM answers
       WHERE workspace_id = $1 AND submitted_at >= $2 AND submitted_at < $3`,
      [workspaceId, startDate, endDate]
    );
    const answers: Answer[] = answersRes.rows;
    const answeredUserIds = new Set(answers.map((a) => a.user_id));
    console.log(
      `[${workspaceId}] Found ${answeredUserIds.size} answers submitted for ${
        startDate.toISOString().split("T")[0]
      }.`
    );

    // 5. Check completion status
    let allAnswered = false;
    if (participantUserIds.size > 0) {
      allAnswered = [...participantUserIds].every((id) =>
        answeredUserIds.has(id)
      );
    }
    console.log(`[${workspaceId}] All participants answered: ${allAnswered}`);

    // 6. Check if past cutoff time relative to the *start* of the summary day
    const now = new Date();
    const cutoffTime = new Date(date); // Start with the summary day date
    cutoffTime.setUTCHours(CUTOFF_HOUR_UTC, 0, 0, 0);
    const pastCutoff = now >= cutoffTime;
    console.log(
      `[${workspaceId}] Current time ${now.toISOString()} >= Cutoff time ${cutoffTime.toISOString()}: ${pastCutoff}`
    );

    // 7. If conditions met, build and post summary
    if (allAnswered || pastCutoff) {
      if (answers.length === 0) {
        console.log(
          `[${workspaceId}] Conditions met, but no answers found to summarise.`
        );
        // Optionally post a message indicating no one submitted?
        return;
      }

      // Check if summary for this workspace/date has already been posted (requires a 'summaries_posted' table)
      // const alreadyPostedRes = await client.query('SELECT 1 FROM summaries_posted WHERE workspace_id = $1 AND summary_date = $2', [workspaceId, date]);
      // if (alreadyPostedRes.rows.length > 0) {
      //   console.log(`[${workspaceId}] Summary for ${date.toISOString().split('T')[0]} already posted. Skipping.`);
      //   return;
      // }

      console.log(
        `[${workspaceId}] Conditions met. Building and posting summary to channel ${summaryChannel}.`
      );

      // Build Markdown summary using user mentions <@USER_ID>
      const formattedDate = format(date, "EEEE, MMMM do, yyyy"); // e.g., Tuesday, July 27th, 2024
      let summaryBody = "";

      for (const answer of answers) {
        const yesterday = answer.yesterday || "_Not provided_";
        const today = answer.today || "_Not provided_";
        const blockers = answer.blockers || "_None_";
        summaryBody += `• <@${answer.user_id}> – *Yesterday:* ${yesterday} / *Today:* ${today} / *Blockers:* ${blockers}\n`;
      }

      // Add users who didn't respond (if past cutoff and not everyone answered)
      let missedUsersText = "";
      if (pastCutoff && !allAnswered) {
        const missedUsers = [...participantUserIds].filter(
          (id) => !answeredUserIds.has(id)
        );
        if (missedUsers.length > 0) {
          missedUsersText = `\n\n_Did not respond:_ ${missedUsers
            .map((id) => `<@${id}>`)
            .join(", ")}`;
          summaryBody += missedUsersText; // Append to the main body for Slack message
        }
      }

      const fallbackText = `Daily Stand-up Summary for ${formattedDate} (${answeredUserIds.size}/${participantUserIds.size} responded)`;

      try {
        // Post to Slack using Blocks for better formatting
        const postResult = await slackClient.chat.postMessage({
          channel: summaryChannel,
          text: fallbackText,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `Daily Stand-up Summary – ${formattedDate}`, // Consistent title
                emoji: true,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `*${answeredUserIds.size}* of *${participantUserIds.size}* participants responded.`,
                },
              ],
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: summaryBody.trim(), // Post the main body of updates
              },
            },
          ],
          mrkdwn: true, // Allow user mentions
        });

        if (postResult.ok) {
          console.log(
            `[${workspaceId}] Successfully posted summary to channel ${summaryChannel}. Message ts: ${postResult.ts}`
          );
          // Optional: Mark summary as posted for this workspace/date to prevent duplicates
          // await client.query('INSERT INTO summaries_posted (workspace_id, summary_date) VALUES ($1, $2) ON CONFLICT DO NOTHING', [workspaceId, date]);
        } else {
          throw new Error(`Slack API error: ${postResult.error}`);
        }
      } catch (postError: any) {
        console.error(
          `[${workspaceId}] Failed to post summary to channel ${summaryChannel}:`,
          postError.message || postError
        );
      }
    } else {
      console.log(`[${workspaceId}] Summary conditions not met yet.`);
    }
  } catch (error) {
    console.error(
      `[${workspaceId}] Error in maybePostSummary for date ${
        date.toISOString().split("T")[0]
      }:`,
      error
    );
  } finally {
    client.release();
  }
}

// Note: This file exports the function maybePostSummary.
// It needs to be imported and called from a separate process or scheduler.
// Example call structure:
// import { maybePostSummary } from './summary';
// const todayUTC = new Date();
// todayUTC.setUTCHours(0, 0, 0, 0);
// schedule('0 17 * * *', () => maybePostSummary('YOUR_WORKSPACE_ID', todayUTC)); // Run check at 17:00 UTC
// Or check more frequently, e.g., every 15 mins after a certain hour.

// Graceful shutdown for DB pool if this were a long-running process
/*
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing DB pool');
  await db.end();
  console.log('DB pool closed.');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing DB pool');
  await db.end();
  console.log('DB pool closed.');
  process.exit(0);
});
*/
