import { chromium } from 'playwright';

const BROWSER_DATA_DIR = './browser_data';

async function main() {
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await context.newPage();
  await page.goto('https://linktr.ee/admin', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const titleInputs = await page.locator('input[name="title"]').all();
  console.log(`Found ${titleInputs.length} input[name="title"] elements.`);

  const items = [];
  for (let i = 0; i < titleInputs.length; i++) {
    const titleInput = titleInputs[i];
    const title = (await titleInput.inputValue() || '').trim();

    // Find closest card container
    const container = titleInput.locator('xpath=ancestor::div[contains(@class, "Card") or contains(@data-testid, "Card") or contains(@data-testid, "Link") or contains(@class, "card")][1]');
    
    // Fallback container: 4 levels up if XPath didn't match specific class
    let parent = titleInput.locator('xpath=ancestor::div[4]');
    if (await container.count() > 0) {
      parent = container;
    }

    const urlInput = parent.locator('input[name="url"]').first();
    let url = '';
    if (await urlInput.count() > 0) {
      url = (await urlInput.inputValue() || '').trim();
    }

    const toggle = parent.locator('button[role="switch"], input[name="active"], input[type="checkbox"]').first();
    let active = true;
    if (await toggle.count() > 0) {
      const ariaChecked = await toggle.getAttribute('aria-checked');
      const checkedAttr = await toggle.getAttribute('checked');
      const isChecked = await toggle.evaluate(el => el.checked).catch(() => null);
      if (ariaChecked !== null) {
        active = ariaChecked === 'true';
      } else if (isChecked !== null) {
        active = isChecked;
      } else if (checkedAttr !== null) {
        active = true;
      }
    }

    const type = url ? 'link' : 'header';
    items.push({ i: i+1, title, url, type, active });
  }

  console.log('Scanned Items:');
  console.dir(items, { depth: null });

  await context.close();
}

main().catch(console.error);
