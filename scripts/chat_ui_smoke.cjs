// Run against scripts.mock_chat_server, never a production AI endpoint.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:8014/')
    await page.getByRole('button', { name: 'Continue without location' }).click()
    await page.getByRole('button', { name: 'Ask SafeLink' }).click()
    await page.getByRole('textbox', { name: 'Message SafeLink' }).fill('Offline history check')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByText('Offline test answer:', { exact: false }).waitFor({ timeout: 30000 })
    await page.locator('.safelink-answer table').waitFor()
    assert.equal(await page.locator('.safelink-answer strong').innerText(), 'Fixture summary')
    await page.getByRole('button', { name: 'New conversation', exact: true }).click()
    await page.getByRole('button', { name: 'View history', exact: true }).click()
    await page.getByRole('button', { name: /Offline history check.*turns/ }).click()
    await page.getByText('Offline test answer:', { exact: false }).waitFor()
    await page.locator('.safelink-answer table').waitFor()
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH })
    await page.reload()
    await page.getByRole('button', { name: 'Continue without location' }).click()
    await page.getByRole('button', { name: 'Ask SafeLink' }).click()
    await page.getByRole('button', { name: 'View history', exact: true }).click()
    await page.getByRole('button', { name: /Offline history check.*turns/ }).click()
    await page.getByText('Offline test answer:', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'View history', exact: true }).click()
    await page.getByRole('button', { name: 'Delete Offline history check', exact: true }).click()
    await page.getByText('No saved conversations.', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log('PASS: startup skip, send, new chat, reopen, reload recovery, delete; no page exceptions')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
