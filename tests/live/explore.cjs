// Live exploration of the isolated DSH web UI (towertest profile, port 59001).
// Not part of the offline suite: needs a booted server and Playwright.
const { chromium } = require('playwright')

const URL = process.env.DSH_TEST_URL
if (!URL) {
  console.error('Set DSH_TEST_URL to the URL printed when booting the isolated test server.')
  process.exit(1)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.DSH_TEST_CHROME,
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('console', (message) => console.log(`[console:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${__dirname}/explore.png`, fullPage: true })

  const info = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')].map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'),
      contenteditable: el.getAttribute('contenteditable'),
      className: String(el.className).slice(0, 120),
    }))
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 4000),
      inputs,
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await browser.close()
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
