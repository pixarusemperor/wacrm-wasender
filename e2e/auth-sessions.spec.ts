import { test, expect } from '@playwright/test'

/**
 * Auth + WasenderApi session E2E (ECC e2e-testing skill).
 *
 * Requires a seeded test Supabase project. Uses a unique email per run
 * so repeated CI runs don't collide.
 */

const runId = Date.now()
const email = `e2e-${runId}@test.local`
const password = 'e2e-test-password-123!'

test.describe('signup + session management', () => {
  test('signs up, lands on the dashboard, creates a session, and sees the QR', async ({
    page,
  }) => {
    // 1. Sign up
    await page.goto('/signup')
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.getByRole('button', { name: /sign ?up/i }).click()

    // Signup redirects to /login with a confirmation, or straight to dashboard.
    await page.waitForURL(/\/(login|products|dashboard)/, { timeout: 20000 })
    if (page.url().includes('/login')) {
      await page.fill('#email', email)
      await page.fill('#password', password)
      await page.getByRole('button', { name: /sign ?in|log ?in/i }).click()
    }
    await page.waitForURL(/\/(products|dashboard)/, { timeout: 20000 })

    // 2. Navigate to Settings → WhatsApp (sessions panel).
    await page.goto('/settings?tab=whatsapp')
    await expect(page.getByText('WhatsApp Instances')).toBeVisible({ timeout: 15000 })

    // 3. Create a session — the mock answers with id 99, need_scan.
    await page.fill('#sess-name', 'E2E Sales Line')
    await page.fill('#sess-phone', '+15550199')
    await page.getByRole('button', { name: 'Create Instance' }).click()

    // 4. The new instance appears in the list.
    await expect(page.getByText('E2E Sales Line')).toBeVisible({ timeout: 15000 })

    // 5. Connect → mock returns NEED_SCAN → QR payload renders.
    await page.getByRole('button', { name: 'Connect' }).first().click()
    await expect(page.getByText('Scan to connect')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('2@E2E_QR_CODE_PAYLOAD')).toBeVisible()
  })

  test('isolates accounts — a second user cannot see the first user sessions', async ({
    page,
  }) => {
    const email2 = `e2e-b-${runId}@test.local`

    await page.goto('/signup')
    await page.fill('#email', email2)
    await page.fill('#password', password)
    await page.getByRole('button', { name: /sign ?up/i }).click()

    await page.waitForURL(/\/(login|products|dashboard)/, { timeout: 20000 })
    if (page.url().includes('/login')) {
      await page.fill('#email', email2)
      await page.fill('#password', password)
      await page.getByRole('button', { name: /sign ?in|log ?in/i }).click()
    }
    await page.waitForURL(/\/(products|dashboard)/, { timeout: 20000 })

    // User 2's sessions list must NOT contain user 1's session.
    await page.goto('/settings?tab=whatsapp')
    await expect(page.getByText('WhatsApp Instances')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('E2E Sales Line')).not.toBeVisible({ timeout: 10000 })
  })
})
