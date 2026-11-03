import { chromium } from 'playwright';
import readline from 'readline';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { BROWSER_DATA_DIR, BROWSER_OPTIONS } from './src/config.js';

dotenv.config();

async function main() {
  console.log('==================================================');
  console.log('        Facebook & Linktree Setup Assistant        ');
  console.log('==================================================\n');

  console.log('This assistant will open a headed Chrome browser window.');
  console.log('You will need to manually log in to:');
  console.log('1. Facebook (so the scraper can bypass public page login blocks)');
  console.log('2. Linktree Admin (so the automator can update your links)\n');

  console.log('All login sessions (cookies, localStorage) will be securely');
  console.log(`stored in your local folder: ${path.resolve(BROWSER_DATA_DIR)}`);
  console.log('NO passwords will be saved in code or sent anywhere.\n');

  // Ensure browser data directory exists
  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  }

  console.log('Launching browser...');
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    ...BROWSER_OPTIONS,
    headless: false
  });

  const page1 = await context.newPage();
  console.log('Opening Facebook in Tab 1...');
  await page1.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });

  const page2 = await context.newPage();
  console.log('Opening Linktree Admin in Tab 2...');
  await page2.goto('https://linktr.ee/admin', { waitUntil: 'domcontentloaded' });

  console.log('\n==================================================');
  console.log('ACTION REQUIRED:');
  console.log('1. In the browser, log in to Facebook (if not already logged in).');
  console.log('2. Log in to your Linktree account in the second tab.');
  console.log('3. Ensure you can see your Linktree Admin dashboard.');
  console.log('==================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const waitForUser = () => {
    return new Promise((resolve) => {
      rl.question('When you have successfully logged in to both websites, press [ENTER] here to save session and exit: ', () => {
        rl.close();
        resolve(true);
      });
    });
  };

  await waitForUser();

  console.log('\nClosing browser and saving persistent session...');
  await context.close();
  console.log('Setup complete! Your sessions have been saved successfully.');
  console.log('You can now run "npm run start" to scrape and update.');
  console.log('==================================================');
}

main().catch((err) => {
  console.error('Error during setup:', err);
});
