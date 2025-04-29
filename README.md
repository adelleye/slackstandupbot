# AsyncStandup Bot

A Slack bot to automate daily stand-ups asynchronously, inspired by Geekbot.

## Local Dev Quick-Start

Follow these steps to get the bot running on your local machine for development and testing:

1.  **Create Slack App & Get Credentials:**

    - Go to <https://api.slack.com/apps> and create a new app.
    - Under "Features", navigate to "OAuth & Permissions". Add the following **Bot Token Scopes**:
      - `chat:write` (send messages)
      - `commands` (register slash commands)
      - `users:read` (get user info like timezone - potentially optional depending on setup)
      - `channels:read` (needed for channel selection in setup)
      - `groups:read` (if using private channels for summary)
      - `im:read` (read direct messages - _careful with this scope_)
      - `im:write` (send direct messages)
      - `im:history` (read DM history - needed if using threaded replies)
    - Install the app to your workspace.
    - Copy the **Bot User OAuth Token** (starts with `xoxb-`).
    - Under "Settings", navigate to "Basic Information". Scroll down to "App Credentials" and copy the **Signing Secret**.
    - Create a `.env` file in the project root and add your secrets:
      ```env
      SLACK_BOT_TOKEN=xoxb-...
      SLACK_SIGNING_SECRET=...
      DATABASE_URL=postgresql://devuser:devpassword@localhost:5433/asyncstandup_dev
      # REDIS_URL=redis://localhost:6379 # Optional, defaults used if absent
      PORT=3000
      ```

2.  **Install Dependencies:**

    - Make sure you have Node.js (v20+) and pnpm installed.
    - Run `pnpm install` in the project root.

3.  **Start Background Services (Postgres & Redis):**

    - Make sure you have Docker installed and running.
    - Run `docker-compose up -d` in the project root. This will start Postgres (accessible at `localhost:5433`) and Redis (accessible at `localhost:6379`) in the background.
    - The first time you run this (or after resetting the database), apply the database schema by running:
      ```bash
      pnpm db:migrate:dev
      ```
      _Note: This requires `psql` (the PostgreSQL command-line client) to be installed and available in your PATH._

4.  **Start the Application Servers:**

    - Run `pnpm dev` in the project root. This command builds the TypeScript code and starts the web server, scheduler, and DM worker processes concurrently using `ts-node-dev` for automatic reloading on changes.
    - You should see output indicating the Bolt app, scheduler, and worker are running.

5.  **Expose Localhost with Ngrok:**

    - Slack needs a public URL to send events (like slash commands and button clicks) to your local machine.
    - Install ngrok (<https://ngrok.com/>).
    - Run `ngrok http 3000` (or whatever port your app runs on, defined by `PORT` in `.env`).
    - Copy the `https://` forwarding URL provided by ngrok (e.g., `https://abcd-1234.ngrok-free.app`).

6.  **Configure Slack Event URLs:**

    - Go back to your Slack app settings page.
    - Navigate to "Features" -> "Interactivity & Shortcuts". Turn it **On**.
    - In the "Request URL" field, paste your ngrok `https` URL followed by `/slack/events` (e.g., `https://abcd-1234.ngrok-free.app/slack/events`). Save changes.
    - Navigate to "Features" -> "Slash Commands". Create a new command:
      - Command: `/standup`
      - Request URL: Use the same ngrok URL + `/slack/events`.
      - Short Description: Manage your async stand-up.
      - Save.
    - Navigate to "Features" -> "Event Subscriptions". Turn it **On**.
    - Request URL: Use the same ngrok URL + `/slack/events`.
    - Expand "Subscribe to bot events". Add the `message.im` event type (so the bot can potentially receive replies in DMs, needed for certain answer collection methods). Save changes.
    - _Note: You might need to reinstall your app to the workspace after changing scopes or event subscriptions._

7.  **Trigger Setup in Slack:**

    - Go to your Slack workspace.
    - Type `/standup setup` in any channel or DM.
    - This should trigger the bot's command handler and (if implemented) open a modal asking for your preferences (timezone, stand-up time, summary channel).
    - Follow the prompts in the modal.

8.  **Observe & Develop!**
    - The scheduler should now start enqueuing jobs based on the schedule you set up.
    - The worker should pick up these jobs and send DMs.
    - You can interact with the DM (e.g., click the submit button).
    - The web server handles the interactive components (button clicks) and saves answers.
    - The summary logic should eventually post a summary to your chosen channel.

## Running Tests

This project uses Cypress for end-to-end (E2E) testing, particularly for flows involving external services like Redis.

- **Cypress Setup:** Cypress and required plugins (`ioredis`) are included in dev dependencies (`pnpm install`). The configuration is in `cypress.config.ts`, which includes tasks to interact with Redis.
- **Happy Path Test (`cypress/e2e/standup.cy.ts`):**
  - This test verifies a core interaction: simulating a specific slash command (`/standup test-enqueue`) hitting a _mock_ API endpoint (`/api/mock/slack/events`) should result in a job being added to the BullMQ queue.
  - **Why Mocking?** It avoids needing real Slack interaction or valid signatures for this specific test, focusing solely on whether the command _handler logic_ correctly triggers the _queueing mechanism_.
  - **How it Works:**
    1.  `beforeEach`: Clears the `send_dm` queue in Redis using a Cypress task (`clearQueue`) to ensure a clean state.
    2.  It sends a fake payload representing the slash command to the `/api/mock/slack/events` endpoint using `cy.request()`.
    3.  It asserts that the mock endpoint returns a `200 OK` status.
    4.  It uses another Cypress task (`getQueueLength`) to check the length of the `send_dm` queue in Redis and asserts it is now `1`.
  - **To Run:**
    1.  Ensure the app server (`pnpm dev` or at least `pnpm dev:web`) and Redis (`docker-compose up -d redis`) are running.
    2.  Make sure you have implemented the `/api/mock/slack/events` endpoint in `src/server.ts` as described in the test file comments.
    3.  Run `pnpm cy:run` (headless) or `pnpm cy:open` (interactive runner).
