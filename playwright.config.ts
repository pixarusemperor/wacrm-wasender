import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E config (ECC e2e-testing skill).
 *
 * Two webServers:
 *   1. The WasenderApi mock (e2e/wasender-mock.ts) on port 3100.
 *   2. The Next app on port 3000, pointed at the mock via WASENDER_BASE_URL.
 *
 * Requires a test Supabase project (env: NEXT_PUBLIC_SUPABASE_URL etc.)
 * with migrations applied + a seeded account.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'playwright-results.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/wasender-mock.ts',
      url: 'http://localhost:3100/api/status',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: {
        WASENDER_BASE_URL: 'http://localhost:3100',
        WATSSENDER_MASTER_PAT: 'e2e-owner-pat',
      },
    },
  ],
})
