import { test, expect } from "@playwright/test";

/**
 * Attachment download security posture (issue #16). The admin upload and
 * management flows require Firebase-authenticated sessions, which the
 * smoke suite does not provision — these specs cover what is verifiable
 * anonymously: the download route never serves bytes (or even existence
 * hints) to unauthenticated callers.
 */
test.describe("attachment downloads", () => {
  test("unauthenticated download requests are rejected", async ({
    request,
  }) => {
    const response = await request.get(
      "/api/attachments/att-nonexistent/download",
    );
    expect(response.status()).toBe(401);
  });

  test("the route exists and does not 404 as a page", async ({ request }) => {
    // A fabricated id still reaches the route (401, not 404) — the
    // endpoint is wired; authorization, not routing, gates access.
    const response = await request.get("/api/attachments/x/download");
    expect(response.status()).not.toBe(404);
  });
});
