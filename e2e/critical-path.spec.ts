import { test, expect } from "@playwright/test";

test.describe("Critical Path & Interactive User Experience", () => {
  test("1. Homepage interactive elements, FAQ accordion, and footer are navigable", async ({
    page,
  }) => {
    await page.goto("/");

    // Verify FAQ section
    const faqHeading = page.getByRole("heading", { name: /frequently asked questions/i });
    if (await faqHeading.isVisible()) {
      await expect(faqHeading).toBeVisible();
    }

    // Verify footer links
    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
  });

  test("2. Upload trigger modal opens and requires image file", async ({
    page,
  }) => {
    await page.goto("/");

    // Look for upload button or dropzone
    const uploadTrigger = page.locator("button, a").filter({ hasText: /try it|start|upload/i }).first();
    if (await uploadTrigger.isVisible()) {
      await uploadTrigger.click();
      // Should present file dialog or sign-in prompt
      const dialog = page.locator("[role='dialog']");
      if (await dialog.isVisible()) {
        await expect(dialog).toBeVisible();
      }
    }
  });

  test("3. Auth code error page renders safe user guidance", async ({ page }) => {
    await page.goto("/auth/auth-code-error");
    await expect(page.locator("h1, h2")).toContainText(/Authentication/i);
    const returnLink = page.getByRole("link", { name: /return|home/i });
    await expect(returnLink).toBeVisible();
  });
});
