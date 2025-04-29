/// <reference types="cypress" />

describe("Standup Slash Command E2E Mock", () => {
  const mockApiEndpoint = "/api/mock/slack/events"; // Assumes this endpoint exists and handles mock requests
  const queueName = "send_dm"; // The BullMQ queue name used by the scheduler

  beforeEach(() => {
    // Clear the relevant BullMQ queue state in Redis before each test
    cy.task("clearQueue", queueName).then((result) => {
      if (typeof result === "string" && result.startsWith("Error:")) {
        throw new Error(`Failed to clear queue: ${result}`);
      }
      // Check initial length after clearing (should be 0)
      cy.task<number | string>("getQueueLength", queueName).should("eq", 0);
    });
  });

  it("should enqueue a job when a specific mock slash command is received", () => {
    // Simulate a slash command payload (adapt as needed for your mock endpoint)
    const fakeSlashCommandPayload = {
      token: "fake-verification-token", // Mock endpoint likely ignores this
      team_id: "T_MOCK_TEAM",
      team_domain: "mock-domain",
      channel_id: "C_MOCK_CH",
      channel_name: "mock-channel",
      user_id: "U_MOCK_USER",
      user_name: "mock.user",
      command: "/standup", // The base command
      text: "test-enqueue", // Special text your mock endpoint uses to trigger enqueue
      api_app_id: "A_MOCK_APP",
      response_url: "https://hooks.slack.com/commands/T_MOCK_TEAM/123/fake",
      trigger_id: "123.456.fake",
    };

    // 1. Call the mock API endpoint
    cy.request({
      method: "POST",
      url: mockApiEndpoint,
      body: fakeSlashCommandPayload,
      headers: {
        // Set content type based on what your mock endpoint expects
        // 'Content-Type': 'application/json',
        "Content-Type": "application/x-www-form-urlencoded",
      },
      form: true, // Use if sending form data, remove/set false if JSON
      failOnStatusCode: false, // Allow checking status code manually
    }).then((response) => {
      // 2. Expect a 200 OK response (or whatever your mock endpoint returns on success)
      expect(response.status, "Mock API response status").to.eq(200);

      // Optional: Check response body if the mock endpoint provides confirmation
      // expect(response.body).to.deep.equal({ message: 'Test job enqueued' });

      // 3. Verify Bull queue length via Redis task
      // Use retry-ability inherent in Cypress commands
      cy.task<number | string>("getQueueLength", queueName, {
        timeout: 10000,
      }).should((length) => {
        // Handle potential error string from task
        if (typeof length === "string" && length.startsWith("Error:")) {
          throw new Error(`Redis task failed: ${length}`);
        }
        expect(length, "Queue length after mock command").to.eq(1);
      });
    });
  });

  // Add more tests for other scenarios if needed
});
