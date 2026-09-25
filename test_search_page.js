const { execSync } = require('child_process');
const cheerio = require('cheerio');

const url = 'https://www.olx.pl/motoryzacja/motocykle-skutery/cross/q-yz-250/';
const scriptPath = require('path').join(__dirname, 'puppeteer_fetcher.js');
const html = execSync(`node "${scriptPath}" "${url}"`, { encoding: 'utf8' });

const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
let match;
while ((match = jsonLdRegex.exec(html)) !== null) {
  try {
    const data = JSON.parse(match[1]);
    if (data['@type'] === 'Product' && data.offers && data.offers.offers) {
      for (const offer of data.offers.offers) {
         console.log("OFFER:", offer.name, "DESC:", !!offer.description);
         if (offer.description) {
            console.log("Preview:", offer.description.substring(0, 100));
         }
      }
    }
  } catch(e) {}
}
