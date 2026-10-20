const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');

puppeteer.use(StealthPlugin());

const url = process.argv[2];

if (!url) {
  console.error("Please provide a URL");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set a random modern user agent
    const userAgent = randomUseragent.getRandom(ua => {
      return ua.browserName === 'Chrome' && parseFloat(ua.browserMajor) >= 100 && ua.osName === 'Windows';
    });
    
    await page.setUserAgent(userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    });

    // Mask webdriver explicitly just in case
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['pl-PL', 'pl', 'en-US', 'en'],
      });
    });

    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    
    // Wait a random small amount before navigating
    await sleep(Math.floor(Math.random() * 1000) + 500);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Quick wait for dynamic content
    await sleep(2000);
    
    // Simulate slight scrolling to mimic human behavior and trigger lazy loading
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight / 2);
    });
    await sleep(1000);
    
    const html = await page.content();
    console.log(html);
    
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
