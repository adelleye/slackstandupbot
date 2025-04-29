import {
  LogLevel,
  ViewSubmitAction,
  BlockAction,
  ViewResponseAction,
} from "@slack/bolt";
import { QueryResult } from "pg";
import {
  format,
  toZonedTime,
  fromZonedTime,
  formatInTimeZone,
} from "date-fns-tz";
import {
  getDay,
  setHours,
  setMinutes,
  setSeconds,
  addDays,
  parse,
} from "date-fns";
import { Request, Response } from "express"; // Import Request and Response types

// Import shared instances
import { dbPool } from "./lib/db";
import { boltApp as app, receiver } from "./lib/slack"; // Rename imported app and import receiver

// --- Type Imports for Handlers ---
import {
  SlackCommandMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
} from "@slack/bolt";

/** Throws if the value is null/undefined and tells TS it's now non-nullable */
function assertDefined<T>(
  val: T | null | undefined,
  name: string
): asserts val is T {
  if (val === null || val === undefined) {
    throw new Error(`${name} is required but was ${val}`);
  }
}

// Timezone data (might need explicit loading depending on environment)
// import { listTimeZones } from "@vvo/tzdb"; // Optional: for a fuller list

// Define common timezones for the select menu (can be expanded)
const commonTimezones: {
  text: { type: "plain_text"; text: string; emoji?: boolean };
  value: string;
}[] = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
].map((tz) => ({ text: { type: "plain_text", text: tz }, value: tz }));

// --- Utility Function for Next Run Time Calculation ---
function calculateNextRunAtUTC(
  localTime: string,
  timezone: string
): Date | null {
  try {
    const parsedTime = parse(localTime, "HH:mm", new Date());
    const localHour = parsedTime.getHours();
    const localMinute = parsedTime.getMinutes();

    const nowInTargetTz = toZonedTime(new Date(), timezone);

    let nextRunInTargetTz = setSeconds(
      setMinutes(setHours(nowInTargetTz, localHour), localMinute),
      0
    );

    if (nextRunInTargetTz <= nowInTargetTz) {
      nextRunInTargetTz = addDays(nextRunInTargetTz, 1);
    }

    const nextRunUTC = fromZonedTime(nextRunInTargetTz, timezone);
    return nextRunUTC;
  } catch (error) {
    console.error("Error calculating next run time:", error);
    return null;
  }
}

// --- Modal Callback ID ---
const SETUP_MODAL_CALLBACK_ID = "standup_setup_modal";
const STANDUP_MODAL_CALLBACK_ID = "standup_modal_submit"; // New Callback ID for stand-up submission

// --- Slash Command Handler ---
app.command("/standup", async ({ command, ack, body, client, logger }) => {
  await ack(); // Acknowledge command quickly

  const subCommand = command.text.trim();

  if (subCommand === "setup") {
    logger.info(`User ${command.user_id} triggered /standup setup`);
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: SETUP_MODAL_CALLBACK_ID,
          title: { type: "plain_text", text: "Configure Stand-up" },
          submit: { type: "plain_text", text: "Save Settings" },
          close: { type: "plain_text", text: "Cancel" },
          private_metadata: command.channel_id,
          blocks: [
            {
              type: "input",
              block_id: "timezone_block",
              label: { type: "plain_text", text: "Your Timezone" },
              element: {
                type: "static_select",
                action_id: "timezone_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select your timezone",
                },
                options: commonTimezones,
              },
            },
            {
              type: "input",
              block_id: "time_block",
              label: { type: "plain_text", text: "Stand-up Time (local)" },
              element: {
                type: "timepicker",
                action_id: "time_select",
                initial_time: "09:30",
                placeholder: { type: "plain_text", text: "Select time" },
              },
            },
            {
              type: "input",
              block_id: "channel_block",
              label: { type: "plain_text", text: "Summary Channel" },
              element: {
                type: "channels_select",
                action_id: "channel_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select a public channel",
                },
              },
            },
          ],
        },
      });
      logger.info(`Opened setup modal for user ${command.user_id}`);
    } catch (error) {
      logger.error("Error opening setup modal:", error);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `😥 Sorry, I couldn\'t open the setup modal. Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  } else {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/standup setup` to configure your stand-up settings.",
    });
  }
});

// --- View Submission Handler ---
app.view<ViewSubmitAction>(
  SETUP_MODAL_CALLBACK_ID,
  async ({ ack, body, view, client, logger }) => {
    const { id: slackUserId } = body.user;
    const originalChannelId = view.private_metadata;
    const slackTeamId = body.team?.id;
    const values = view.state.values;

    /* --------- pull raw values ---------- */
    const tzOption = values.timezone_block.timezone_select.selected_option;
    const standupTime = values.time_block.time_select.selected_time; // string | undefined
    const summaryChan = values.channel_block.channel_select.selected_channel; // string | undefined

    /* --------- basic validation ---------- */
    if (!slackTeamId) {
      await ack(); // close modal
      logger.error("No team ID in submission");
      return;
    }

    // First validation check (only returns errors to modal)
    if (!tzOption || !standupTime || !summaryChan) {
      // Construct errors object dynamically
      const errors: Record<string, string> = {};
      if (!tzOption) errors.timezone_block = "Please select a timezone";
      if (!standupTime) errors.time_block = "Please select a time";
      if (!summaryChan) errors.channel_block = "Please select a channel";

      await ack({
        response_action: "errors",
        errors, // Pass the dynamically built errors object
      });
      logger.warn(
        `Setup submission validation failed (missing fields) for user ${slackUserId}`
      );
      return;
    }

    /* --------- runtime + TS guarantee via asserts ----- */
    try {
      // These calls will throw if any are null/undefined, and TS knows they are defined afterwards
      assertDefined(tzOption, "timezone option");
      assertDefined(standupTime, "stand-up time");
      assertDefined(summaryChan, "summary channel");
    } catch (assertionError: any) {
      // This catch block handles errors from assertDefined
      logger.error(
        "Assertion failed during setup validation:",
        assertionError.message,
        { slackUserId }
      );
      await ack(); // Close the modal on assertion failure
      // Optionally send an ephemeral message about the internal error
      try {
        await client.chat.postEphemeral({
          channel: originalChannelId || slackUserId,
          user: slackUserId,
          text: `😥 An unexpected error occurred during setup validation: ${assertionError.message}. Please try again.`,
        });
      } catch (ephemError) {
        logger.error("Failed to send assertion error ephemeral", ephemError);
      }
      return;
    }

    /* --------- success ack() -------------------------- */
    // Now we are certain the values exist and are valid, acknowledge success.
    await ack(); // ⏱ done within 3 s

    /* --------- non-nullable aliases ------- */
    // These are now guaranteed to be strings because assertDefined passed
    const finalTimezone: string = tzOption.value;
    const finalTime: string = standupTime;
    const finalChannel: string = summaryChan;

    logger.info(
      `Processing validated setup submission from user ${slackUserId} in team ${slackTeamId}`
    );
    logger.debug("Final values:", { finalTimezone, finalTime, finalChannel });

    /* --------- existing DB logic ---------- */
    let workspaceId: number | null = null;
    let userId: number | null = null;

    const dbClient = await dbPool.connect();
    try {
      await dbClient.query("BEGIN");
      // ... [DB logic using finalTimezone, finalTime, finalChannel] ...
      const workspaceRes: QueryResult<{ id: number }> = await dbClient.query(
        `INSERT INTO workspaces (slack_team_id, summary_channel)
       VALUES ($1, $2)
       ON CONFLICT (slack_team_id) DO UPDATE SET summary_channel = EXCLUDED.summary_channel, updated_at = NOW()
       RETURNING id;`,
        [slackTeamId, finalChannel]
      );
      workspaceId = workspaceRes.rows[0].id;
      logger.info(
        `Upserted workspace ${slackTeamId} (DB ID: ${workspaceId}) with channel ${finalChannel}`
      );

      const userRes: QueryResult<{ id: number }> = await dbClient.query(
        `INSERT INTO users (slack_user_id, workspace_id, tz)
       VALUES ($1, $2, $3)
       ON CONFLICT (slack_user_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, tz = EXCLUDED.tz, updated_at = NOW()
       RETURNING id;`,
        [slackUserId, workspaceId, finalTimezone]
      );
      userId = userRes.rows[0].id;
      logger.info(
        `Upserted user ${slackUserId} (DB ID: ${userId}) in workspace ${workspaceId} with timezone ${finalTimezone}`
      );

      const nextRunAt = calculateNextRunAtUTC(finalTime, finalTimezone);
      if (!nextRunAt) {
        throw new Error("Could not calculate next run time from inputs.");
      }
      logger.info(
        `Calculated next run time for user ${userId} as ${nextRunAt.toISOString()} UTC`
      );

      const scheduleRes: QueryResult<{ id: number }> = await dbClient.query(
        `INSERT INTO schedules (user_id, workspace_id, next_run_at, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET next_run_at = EXCLUDED.next_run_at, is_active = TRUE, updated_at = NOW()
       RETURNING id;`,
        [userId, workspaceId, nextRunAt]
      );
      logger.info(
        `Upserted schedule (DB ID: ${
          scheduleRes.rows[0].id
        }) for user ${userId}, workspace ${workspaceId}, next run at ${nextRunAt.toISOString()}`
      );

      await dbClient.query("COMMIT");
      logger.debug(`DB transaction committed for user ${slackUserId} setup`);

      // Send confirmation message (using final vars)
      await client.chat.postEphemeral({
        channel: originalChannelId || slackUserId,
        user: slackUserId,
        text: `✅ Stand-up configured! I\'ll ping you daily around ${finalTime} (${finalTimezone}). Summaries will go to <#${finalChannel}>.`,
      });
      logger.info(`Sent setup confirmation to user ${slackUserId}`);
    } catch (dbError) {
      // ... [DB error handling] ...
      await dbClient.query("ROLLBACK");
      logger.error(
        `Error processing setup DB operations for user ${slackUserId}:`,
        dbError
      );
      try {
        await client.chat.postEphemeral({
          channel: originalChannelId || slackUserId,
          user: slackUserId,
          text: `😥 Apologies, there was an error saving your configuration: ${
            dbError instanceof Error ? dbError.message : String(dbError)
          }. Please try \`/standup setup\` again.`,
        });
      } catch (ephemeralError) {
        logger.error(
          `Failed to send ephemeral DB error message to user ${slackUserId}:`,
          ephemeralError
        );
      }
    } finally {
      dbClient.release();
      logger.debug(`DB client released for user ${slackUserId} setup`);
    }
  }
);

// Healthcheck command
app.command("/healthcheck", async ({ ack }) => {
  await ack("pong");
});

// NEW: Simple HTTP health check route using the exported receiver's router
receiver.router.get("/healthz", (_: Request, res: Response) => {
  res.status(200).send("ok");
});

// NEW: Handle the button click to open the stand-up modal
app.action<BlockAction>(
  "open_standup_modal",
  async ({ ack, body, client, logger }) => {
    await ack(); // Acknowledge the button click quickly

    const triggerId = body.trigger_id;
    const userId = body.user.id;

    logger.info(`User ${userId} clicked button to open stand-up modal`);

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: STANDUP_MODAL_CALLBACK_ID, // Use the new callback ID
          title: { type: "plain_text", text: "Daily Stand-up" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "yesterday_block",
              label: {
                type: "plain_text",
                text: "Yesterday's accomplishments",
              },
              element: {
                type: "plain_text_input",
                action_id: "yesterday_input",
                multiline: true,
              },
            },
            {
              type: "input",
              block_id: "today_block",
              label: { type: "plain_text", text: "Today's priorities" },
              element: {
                type: "plain_text_input",
                action_id: "today_input",
                multiline: true,
              },
            },
            {
              type: "input",
              block_id: "blockers_block",
              label: { type: "plain_text", text: "Blockers" },
              element: {
                type: "plain_text_input",
                action_id: "blockers_input",
                multiline: true,
              },
              optional: true,
            },
          ],
        },
      });
      logger.info(`Successfully opened stand-up modal for user ${userId}`);
    } catch (error) {
      logger.error(`Error opening stand-up modal for user ${userId}:`, error);
      // Optionally notify the user if the modal fails to open
      try {
        await client.chat.postEphemeral({
          channel: body.channel?.id || userId,
          user: userId,
          text: `😥 Sorry, I couldn't open the stand-up form. Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } catch (ephemError) {
        logger.error(
          `Failed to send ephemeral error for modal open failure to user ${userId}:`,
          ephemError
        );
      }
    }
  }
);

// NEW: Handle the stand-up submission from the modal
app.view<ViewSubmitAction>(
  STANDUP_MODAL_CALLBACK_ID,
  async ({ ack, body, view, client, logger }) => {
    const slackUserId = body.user.id;
    const values = view.state.values;
    const slackTeamId = body.team?.id; // Needed for workspace lookup

    const yesterdayAnswer =
      values.yesterday_block?.yesterday_input?.value || "";
    const todayAnswer = values.today_block?.today_input?.value || "";
    const blockersAnswer = values.blockers_block?.blockers_input?.value || "";

    logger.info(
      `Received stand-up submission via modal from user ${slackUserId}`
    );

    // Basic validation (can be expanded)
    if (!yesterdayAnswer || !todayAnswer) {
      const errors: Record<string, string> = {};
      if (!yesterdayAnswer) {
        errors.yesterday_block = "Please fill out what you did yesterday.";
      }
      if (!todayAnswer) {
        errors.today_block = "Please fill out what you plan to do today.";
      }

      await ack({
        response_action: "errors",
        errors: errors, // Pass the explicitly constructed errors object
      });
      logger.warn(
        `Stand-up modal validation failed for user ${slackUserId} (missing required fields)`
      );
      return;
    }

    // Acknowledge the view submission immediately if validation passes
    await ack();

    let userId: number | null = null;
    let workspaceId: number | null = null;

    const dbClient = await dbPool.connect();
    try {
      // Find user and workspace IDs
      const userRes = await dbClient.query(
        "SELECT id, workspace_id, tz, (SELECT s.next_run_at FROM schedules s WHERE s.user_id = users.id AND s.workspace_id = users.workspace_id AND s.is_active = TRUE LIMIT 1) as next_run_at FROM users WHERE slack_user_id = $1",
        [slackUserId]
      );

      if (userRes.rows.length === 0) {
        throw new Error(
          `User ${slackUserId} not found during modal answer submission.`
        );
      }

      userId = userRes.rows[0].id;
      workspaceId = userRes.rows[0].workspace_id;
      const userTimezone = userRes.rows[0].tz;
      const currentNextRunAt: Date | null = userRes.rows[0].next_run_at;

      if (!workspaceId || !userTimezone || !userId) {
        throw new Error(
          `Missing workspace ID, timezone, or user ID for Slack user ${slackUserId}`
        );
      }

      logger.debug(
        `Found DB user ID ${userId}, workspace ID ${workspaceId}, TZ ${userTimezone} for Slack user ${slackUserId}`
      );

      // Start transaction
      await dbClient.query("BEGIN");

      // Insert the answers
      const insertQuery = `
        INSERT INTO answers (user_id, workspace_id, yesterday, today, blockers)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `;
      const result = await dbClient.query(insertQuery, [
        userId,
        workspaceId,
        yesterdayAnswer,
        todayAnswer,
        blockersAnswer,
      ]);
      logger.info(
        `Saved stand-up answer (DB ID: ${result.rows[0].id}) for user ${userId} via modal`
      );

      // Calculate the *next* next run time based on the *current* one
      let newNextRunAt: Date | null = null;
      if (currentNextRunAt) {
        const nextDay = addDays(currentNextRunAt, 1); // Simply add 1 day to the last scheduled time
        newNextRunAt = nextDay;
        logger.info(
          `Calculated next run time for user ${userId} as ${newNextRunAt.toISOString()} UTC (based on previous ${currentNextRunAt.toISOString()})`
        );

        // Update the schedule
        await dbClient.query(
          "UPDATE schedules SET next_run_at = $1, updated_at = NOW() WHERE user_id = $2 AND workspace_id = $3 AND is_active = TRUE",
          [newNextRunAt, userId, workspaceId]
        );
        logger.info(
          `Updated schedule for user ${userId} to next run at ${newNextRunAt.toISOString()}`
        );
      } else {
        // This case should ideally not happen if the user received a DM, but handle defensively
        logger.warn(
          `Could not find current next_run_at for user ${userId} to update schedule.`
        );
        // Optional: Could try recalculating based on their settings if needed, but might indicate another issue.
      }

      // Commit transaction
      await dbClient.query("COMMIT");

      // Send confirmation message
      await client.chat.postEphemeral({
        channel: slackUserId, // Send confirmation to the user directly
        user: slackUserId,
        text: "✅ Your stand-up has been submitted successfully! Thanks!",
      });
      logger.info(`Sent modal submission confirmation to user ${slackUserId}`);
    } catch (error) {
      await dbClient.query("ROLLBACK");
      logger.error(
        `Error saving stand-up from modal for user ${slackUserId}:`,
        error
      );
      // Inform the user about the error via ephemeral message
      try {
        await client.chat.postEphemeral({
          channel: slackUserId,
          user: slackUserId,
          text: `😥 Apologies, there was an error saving your stand-up: ${
            error instanceof Error ? error.message : String(error)
          }. Please try again or contact support.`,
        });
      } catch (ephemError) {
        logger.error(
          `Failed to send ephemeral error message for modal submission to user ${slackUserId}:`,
          ephemError
        );
      }
    } finally {
      dbClient.release();
    }
  }
);

// Start the Bolt App (must be done here where handlers are attached)
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log(`⚡️ Bolt app is running on port ${process.env.PORT || 3000}!`);
})();
