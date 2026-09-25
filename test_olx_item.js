const { execSync } = require('child_process');
const cheerio = require('cheerio');

const url = 'https://www.olx.pl/d/oferta/yamaha-cross-yz-250-2t-2-mth-po-kompletnym-remoncie-silnika-CID5-ID1cjy0s.html';
const scriptPath = require('path').join(__dirname, 'puppeteer_fetcher.js');
const html = execSync(`node "${scriptPath}" "${url}"`, { encoding: 'utf8' });

const $ = cheerio.load(html);

// try getting description from meta tags or json-ld
let desc = $('meta[name="description"]').attr('content');
console.log("META DESC:", desc);

const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
let match;
while ((match = jsonLdRegex.exec(html)) !== null) {
  try {
    const data = JSON.parse(match[1]);
    if (data.description) {
       console.log("JSON-LD DESC:", data.description.substring(0, 200));
    }
  } catch(e) {}
}

// look for a div with description
const divDesc = $('div[data-cy="ad_description"] > div').text().trim();
console.log("DIV DESC:", divDesc.substring(0, 200));
