const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const url = process.argv[2];

if (!url) {
  console.error("Please provide a URL");
  process.exit(1);
}

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720']
    });
    
    const page = await browser.newPage();
    // Mask webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Quick wait for dynamic content
    await new Promise(r => setTimeout(r, 2000));
    
    const html = await page.content();
    console.log(html);
    
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
