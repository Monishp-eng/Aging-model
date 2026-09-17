import { test, expect } from "@playwright/test";

test.describe("Production Smoke Test Suite", () => {
  test("1. Liveness Health Check (/api/health) returns 200 OK with version metadata", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.version).toBeDefined();
    expect(data.uptime).toBeGreaterThanOrEqual(0);
    expect(data.timestamp).toBeDefined();
  });

  test("2. Readiness Health Check (/api/ready) verifies database and environment readiness", async ({
    request,
  }) => {
    const response = await request.get("/api/ready");
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("ready");
    expect(data.checks.database.status).toBe("healthy");
    expect(data.checks.environment.status).toBe("valid");
    expect(data.checks.migrations.status).toBe("applied");
  });

  test("3. Root Homepage loads cleanly with primary branding and UI components", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // Verify page title
    await expect(page).toHaveTitle(/Extrapolate/i);

    // Verify navbar presence
    const navbar = page.locator("nav");
    await expect(navbar).toBeVisible();

    // Verify main CTA or upload booth
    const mainSection = page.locator("main");
    await expect(mainSection).toBeVisible();
  });

  test("4. Security Headers are rigorously enforced on production HTTP responses", async ({
    request,
  }) => {
    const response = await request.get("/");
    const headers = response.headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("5. Unauthenticated access to /gallery redirects safely to homepage", async ({
    page,
  }) => {
    await page.goto("/gallery");
    // Verify redirection to / or login prompt
    expect(page.url()).not.toContain("/gallery");
  });

  test("6. Public products endpoint (/api/products) returns active subscription/credit tiers", async ({
    request,
  }) => {
    const response = await request.get("/api/products");
    expect(response.status()).toBe(200);

    const products = await response.json();
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    expect(products[0].name).toBeDefined();
    expect(products[0].price).toBeGreaterThan(0);
  });
});
