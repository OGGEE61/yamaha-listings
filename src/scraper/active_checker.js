/**
 * Active Listing Verification Engine
 * Checks whether an OLX or Autoplac listing is still active or has ended.
 */

const cheerio = require('cheerio');
const { execSync } = require('child_process');
const path = require('path');

function checkListingActive(url) {
  if (!url) return { isActive: false, reason: 'Brak URL' };

  try {
    const scriptPath = path.join(__dirname, 'puppeteer_fetcher.js');
    const html = execSync(`node "${scriptPath}" "${url}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25000
    });

    if (!html) {
      return { isActive: false, reason: 'Pusta odpowiedź z portalu' };
    }

    const $ = cheerio.load(html);
    const pageTitle = $('title').text().trim();

    // 1. OLX generic title check: When an ad is deleted/ended, OLX displays generic homepage title
    if (
      pageTitle.startsWith('Ogłoszenia - Sprzedam, kupię na OLX.pl') ||
      pageTitle === 'OLX.pl' ||
      pageTitle.toLowerCase().includes('błąd 404')
    ) {
      return { isActive: false, reason: 'Ogłoszenie wygasło lub zostało usunięte z OLX' };
    }

    // 2. Check for explicit ended / inactive markers in HTML
    const isEndedText =
      html.includes('Sprzedający zakończył ogłoszenie') ||
      html.includes('To ogłoszenie nie jest już dostępne') ||
      html.includes('To ogłoszenie wygasło') ||
      html.includes('To ogłoszenie jest nieaktywne') ||
      $('[data-testid="ad-inactive-message"]').length > 0;

    if (isEndedText) {
      return { isActive: false, reason: 'Ogłoszenie zostało zakończone przez sprzedającego' };
    }

    // 3. Check JSON-LD Product schema
    let foundProduct = false;
    let isDiscontinued = false;
    let productName = '';
    let freshImage = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'Product') {
          foundProduct = true;
          productName = data.name || '';
          const avail = data.offers?.availability || '';
          if (avail.includes('Discontinued') || avail.includes('OutOfStock')) {
            isDiscontinued = true;
          }
          if (data.image) {
            freshImage = Array.isArray(data.image) ? data.image[0] : data.image;
          }
        }
      } catch (_) {}
    });

    if (isDiscontinued) {
      return { isActive: false, reason: 'Status w schema: Zakończone' };
    }

    // Fallback image from og:image
    if (!freshImage) {
      const og = $('meta[property="og:image"]').attr('content');
      if (og && !og.includes('fb-image') && !og.includes('placeholder')) freshImage = og;
    }

    if (foundProduct && pageTitle.length > 5) {
      return { isActive: true, reason: 'Ogłoszenie aktywne', productName, freshImage };
    }

    // Fallback: Check if description and price exist
    const hasPrice = $('[data-testid="ad-price"]').length > 0 || $('[class*="price"]').length > 0;
    if (hasPrice) {
      return { isActive: true, reason: 'Ogłoszenie aktywne (wykryto cenę)', freshImage };
    }

    return { isActive: false, reason: 'Brak cech aktywnej oferty' };
  } catch (err) {
    console.error(`[ActiveChecker] Błąd sprawdzania ${url}:`, err.message);
    return { isActive: false, reason: `Błąd weryfikacji: ${err.message}` };
  }
}

module.exports = { checkListingActive };
