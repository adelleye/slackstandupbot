import { LogLevel, ViewSubmitAction, BlockAction } from "@slack/bolt";
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

// Import shared instances
import { dbPool } from "./lib/db";
import { boltApp as app } from "./lib/slack"; // Rename imported app

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

// Handle the stand-up submission from the button click
app.action<BlockAction>(
  "submit_standup_action",
  async ({ ack, body, client, logger }) => {
    await ack();

    const blockActionBody = body as BlockAction;
    const slackUserId = blockActionBody.user.id;
    const values = blockActionBody.state?.values;

    if (!values) {
      logger.error("Missing state values in standup submission", {
        userId: slackUserId,
        body: blockActionBody, // Log the body for debugging
      });
      // **Improvement:** Send ephemeral message to user
      try {
        await client.chat.postEphemeral({
          channel: blockActionBody.channel?.id || slackUserId, // Need a channel context, use original channel or DM user
          user: slackUserId,
          text: "😥 Sorry, I couldn't find the data from your submission. This might be a temporary Slack issue. Please try submitting again.",
        });
      } catch (ephemeralError) {
        logger.error(
          `Failed to send missing state ephemeral message to user ${slackUserId}:`,
          ephemeralError
        );
      }
      return; // Exit the handler
    }

    // Extract answers from the state values object
    // The keys correspond to the block_id and action_id defined in sendDM.ts
    const yesterdayAnswer = values.yesterday?.yesterday_input?.value || "";
    const todayAnswer = values.today?.today_input?.value || "";
    const blockersAnswer = values.blockers?.blockers_input?.value || ""; // Optional block

    logger.info(`Received stand-up submission from user ${slackUserId}`);

    let userId: number | null = null;
    let workspaceId: number | null = null;

    const dbClient = await dbPool.connect();
    try {
      const userRes = await dbClient.query(
        "SELECT id, workspace_id FROM users WHERE slack_user_id = $1",
        [slackUserId]
      );
      if (userRes.rows.length === 0) {
        throw new Error(
          `User ${slackUserId} not found during answer submission.`
        );
      }
      userId = userRes.rows[0].id;
      workspaceId = userRes.rows[0].workspace_id;

      logger.debug(
        `Found DB user ID ${userId} and workspace ID ${workspaceId} for Slack user ${slackUserId}`
      );

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
        `Saved stand-up answer (DB ID: ${result.rows[0].id}) for user ${userId} in workspace ${workspaceId}`
      );

      // **Improvement:** Wrap chat.update in try...catch
      try {
        await client.chat.update({
          channel: blockActionBody.channel?.id || "",
          ts: blockActionBody.message?.ts || "",
          text: "✅ Stand-up submitted successfully!",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "✅ *Stand-up Submitted!* Thanks for sharing.",
              },
            },
          ],
        });
        logger.info(`Updated original message for user ${slackUserId}`);
      } catch (updateError) {
        logger.error(
          `Failed to update original stand-up message for user ${slackUserId}:`,
          updateError
        );
        // Send ephemeral message indicating save was successful but update failed
        try {
          await client.chat.postEphemeral({
            channel: blockActionBody.channel?.id || slackUserId, // Use original channel or DM
            user: slackUserId,
            text: "✅ Your stand-up was saved successfully, but I couldn't update the original message.",
          });
        } catch (ephemError) {
          logger.error(
            `Failed to send chat.update failure ephemeral to user ${slackUserId}:`,
            ephemError
          );
        }
      }
    } catch (error) {
      logger.error(`Error saving stand-up for user ${slackUserId}:`, error);
      // Optionally, inform the user about the error
      try {
        await client.chat.postEphemeral({
          channel: blockActionBody.channel?.id || "",
          user: slackUserId,
          text: "😥 Apologies, there was an error saving your stand-up. Please try again or contact support.",
        });
      } catch (ephemeralError) {
        logger.error(
          `Failed to send ephemeral error message to user ${slackUserId}:`,
          ephemeralError
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
