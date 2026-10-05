/**
 * Yamaha Listings - Cloudflare Worker
 * Direct SQL queries and filtering on Cloudflare D1 (env.DB)
 * Static assets served via Cloudflare Assets (env.ASSETS)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sync-secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ──────────────────────────────────────────────
      // API: /api/listings (Direct SQL filtering in Cloudflare D1)
      // ──────────────────────────────────────────────
      if (pathname === '/api/listings') {
        const source        = searchParams.get('source');
        const minPrice      = searchParams.get('minPrice') ? parseInt(searchParams.get('minPrice'), 10) : null;
        const maxPrice      = searchParams.get('maxPrice') ? parseInt(searchParams.get('maxPrice'), 10) : null;
        const search        = searchParams.get('search');
        const model         = searchParams.get('model');
        const engine        = searchParams.get('engine');
        const excludeTenere = searchParams.get('excludeTenere') === 'true';
        const activeOnly    = searchParams.get('activeOnly') !== 'false';
        const iconicBlue    = searchParams.get('iconicBlue') === 'true';
        const limit         = Math.min(parseInt(searchParams.get('limit') || '24', 10), 500);
        const offset        = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

        const where = [];
        const params = [];

        if (activeOnly) {
          where.push('is_active = 1');
        }
        if (source) {
          where.push('source = ?');
          params.push(source);
        }
        if (model) {
          where.push('model = ?');
          params.push(model);
        }
        if (iconicBlue) {
          where.push('iconic_blue = 1');
        }
        if (minPrice !== null && !isNaN(minPrice)) {
          where.push('price >= ?');
          params.push(minPrice);
        }
        if (maxPrice !== null && !isNaN(maxPrice)) {
          where.push('price <= ?');
          params.push(maxPrice);
        }
        if (search) {
          where.push('LOWER(title) LIKE ?');
          params.push(`%${search.toLowerCase()}%`);
        }

        if (engine === '2T') {
          where.push(`(model IN ('YZ 250 2T','YZ 250X') OR (model = 'Yamaha Vintage' AND (LOWER(title) LIKE '%dt%' OR LOWER(title) LIKE '% it%')) OR (model = 'Unknown' AND cc = 250))`);
        } else if (engine === '4T') {
          where.push(`(model IN ('WR 250F','WR 450F','Tenere 700') OR (model = 'Yamaha Vintage' AND (LOWER(title) LIKE '%xt%' OR LOWER(title) LIKE '% tt%')))`);
        }

        if (excludeTenere) {
          where.push(`(model != 'Tenere 700' AND model != 'XJ6 Naked' AND NOT (model = 'Yamaha Vintage' AND LOWER(title) LIKE '%tenere%'))`);
        }

        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        // Query listings for current page
        const sqlListings = `SELECT * FROM listings ${whereClause} ORDER BY cc DESC, first_seen DESC LIMIT ? OFFSET ?`;
        // Query total count
        const sqlTotal = `SELECT COUNT(*) as cnt FROM listings ${whereClause}`;
        // Query price stats for currently filtered set
        const priceWhereClause = where.length ? whereClause + ' AND price IS NOT NULL' : 'WHERE price IS NOT NULL';
        const sqlPriceStats = `SELECT AVG(price) as avg_price, MIN(price) as min_price, MAX(price) as max_price FROM listings ${priceWhereClause}`;
        // Query prices array for histogram chart
        const sqlPrices = `SELECT price FROM listings ${priceWhereClause} ORDER BY price ASC`;

        const todayPrefix = new Date().toISOString().slice(0, 10) + '%';
        const newTodayWhere = where.length ? whereClause + ' AND first_seen LIKE ?' : 'WHERE first_seen LIKE ?';
        const sqlNewToday = `SELECT COUNT(*) as cnt FROM listings ${newTodayWhere}`;

        const [listingsRes, totalRes, priceStatsRes, pricesRes, newTodayRes, lastRunRes] = await Promise.all([
          env.DB.prepare(sqlListings).bind(...params, limit, offset).all(),
          env.DB.prepare(sqlTotal).bind(...params).first(),
          env.DB.prepare(sqlPriceStats).bind(...params).first(),
          env.DB.prepare(sqlPrices).bind(...params).all(),
          env.DB.prepare(sqlNewToday).bind(...params, todayPrefix).first(),
          env.DB.prepare('SELECT finished_at, started_at FROM scrape_runs ORDER BY id DESC LIMIT 1').first(),
        ]);

        const total = totalRes ? totalRes.cnt : 0;
        const prices = (pricesRes.results || []).map(r => r.price).filter(p => p != null);

        return new Response(JSON.stringify({
          listings: listingsRes.results || [],
          total,
          stats: {
            total,
            avgPrice: priceStatsRes && priceStatsRes.avg_price ? Math.round(priceStatsRes.avg_price) : 0,
            minPrice: priceStatsRes ? priceStatsRes.min_price : null,
            maxPrice: priceStatsRes ? priceStatsRes.max_price : null,
            newToday: newTodayRes ? newTodayRes.cnt : 0,
            prices,
          },
          updatedAt: lastRunRes?.finished_at || lastRunRes?.started_at || (listingsRes.results?.[0]?.last_seen) || new Date().toISOString(),
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=15, s-maxage=30',
            ...corsHeaders,
          }
        });
      }

      // ──────────────────────────────────────────────
      // API: /api/stats
      // ──────────────────────────────────────────────
      if (pathname === '/api/stats') {
        const todayPrefix = new Date().toISOString().slice(0, 10) + '%';

        const [
          totalActiveRow,
          totalAllRow,
          priceStatsRow,
          newTodayRow,
          bySourceRows,
          byModelRows,
          lastRunRow
        ] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as cnt FROM listings WHERE is_active = 1').first(),
          env.DB.prepare('SELECT COUNT(*) as cnt FROM listings').first(),
          env.DB.prepare('SELECT AVG(price) as avg, MIN(price) as min, MAX(price) as max FROM listings WHERE is_active = 1 AND price IS NOT NULL').first(),
          env.DB.prepare('SELECT COUNT(*) as cnt FROM listings WHERE first_seen LIKE ?').bind(todayPrefix).first(),
          env.DB.prepare('SELECT source, COUNT(*) as count FROM listings WHERE is_active = 1 GROUP BY source').all(),
          env.DB.prepare('SELECT model, COUNT(*) as count FROM listings WHERE is_active = 1 GROUP BY model').all(),
          env.DB.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').first(),
        ]);

        return new Response(JSON.stringify({
          totalActive: totalActiveRow ? totalActiveRow.cnt : 0,
          totalAll: totalAllRow ? totalAllRow.cnt : 0,
          avgPrice: priceStatsRow && priceStatsRow.avg ? Math.round(priceStatsRow.avg) : 0,
          minPrice: priceStatsRow ? priceStatsRow.min : null,
          maxPrice: priceStatsRow ? priceStatsRow.max : null,
          newToday: newTodayRow ? newTodayRow.cnt : 0,
          bySource: bySourceRows.results || [],
          byModel: byModelRows.results || [],
          lastRun: lastRunRow || null,
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, s-maxage=120',
            ...corsHeaders,
          }
        });
      }

      // ──────────────────────────────────────────────
      // API: /api/price-history/:id
      // ──────────────────────────────────────────────
      if (pathname.startsWith('/api/price-history/')) {
        const id = decodeURIComponent(pathname.replace('/api/price-history/', ''));
        const { results } = await env.DB.prepare(
          'SELECT * FROM price_history WHERE listing_id = ? ORDER BY recorded_at ASC'
        ).bind(id).all();

        return new Response(JSON.stringify(results || []), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ──────────────────────────────────────────────
      // API: /api/verify-blue
      // ──────────────────────────────────────────────
      if (pathname === '/api/verify-blue' && request.method === 'POST') {
        const body = await request.json();
        const { id, isBlue } = body;
        if (!id || isBlue === undefined) {
          return new Response(JSON.stringify({ error: 'Missing id or isBlue' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        await env.DB.prepare(`
          UPDATE listings SET
            iconic_blue = ?,
            iconic_blue_verified = 1
          WHERE id = ?
        `).bind(isBlue ? 1 : 0, id).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ──────────────────────────────────────────────
      // API: /api/sync-listings (Admin batch upsert from scraper)
      // ──────────────────────────────────────────────
      if (pathname === '/api/sync-listings' && request.method === 'POST') {
        const authHeader = request.headers.get('x-sync-secret') || request.headers.get('authorization');
        const expectedSecret = env.ADMIN_SYNC_SECRET || 'yamaha-listing-tracker-secret-2026';
        
        if (authHeader !== expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const payload = await request.json();
        const { listings = [], run, inactiveUrls } = payload;
        const now = new Date().toISOString();

        const statements = [];

        // 1. Record scrape run if provided
        if (run && run.started_at) {
          statements.push(
            env.DB.prepare(
              'INSERT INTO scrape_runs (started_at, finished_at, total_found, new_listings, updated) VALUES (?, ?, ?, ?, ?)'
            ).bind(run.started_at, run.finished_at || now, run.total_found || listings.length, run.new_listings || 0, run.updated || 0)
          );
        }

        // 2. Upsert listings in batches
        for (const item of listings) {
          const id = item.id || item.url.split('/').filter(Boolean).pop();
          statements.push(
            env.DB.prepare(`
              INSERT INTO listings (
                id, title, model, price, currency, location, url, image, cc, source, first_seen, last_seen, valid_until, is_active,
                iconic_blue, iconic_blue_parts, iconic_blue_image, iconic_blue_checked_at, iconic_blue_verified, iconic_blue_title, search_url
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                model = CASE WHEN excluded.model != 'Unknown' THEN excluded.model ELSE listings.model END,
                price = CASE WHEN excluded.price IS NOT NULL THEN excluded.price ELSE listings.price END,
                location = excluded.location,
                image = CASE WHEN excluded.image IS NOT NULL THEN excluded.image ELSE listings.image END,
                cc = CASE WHEN excluded.cc > 0 THEN excluded.cc ELSE listings.cc END,
                last_seen = excluded.last_seen,
                valid_until = excluded.valid_until,
                is_active = 1,
                iconic_blue = CASE WHEN excluded.iconic_blue IS NOT NULL THEN excluded.iconic_blue ELSE listings.iconic_blue END,
                iconic_blue_parts = CASE WHEN excluded.iconic_blue_parts IS NOT NULL THEN excluded.iconic_blue_parts ELSE listings.iconic_blue_parts END,
                iconic_blue_image = CASE WHEN excluded.iconic_blue_image IS NOT NULL THEN excluded.iconic_blue_image ELSE listings.iconic_blue_image END,
                iconic_blue_checked_at = CASE WHEN excluded.iconic_blue_checked_at IS NOT NULL THEN excluded.iconic_blue_checked_at ELSE listings.iconic_blue_checked_at END,
                iconic_blue_verified = CASE WHEN excluded.iconic_blue_verified = 1 THEN 1 ELSE listings.iconic_blue_verified END
            `).bind(
              id,
              item.title,
              item.model || 'Unknown',
              item.price ?? null,
              item.currency || 'PLN',
              item.location || '',
              item.url,
              item.image || null,
              item.cc || 0,
              item.source || 'Unknown',
              item.first_seen || now,
              item.last_seen || now,
              item.valid_until || null,
              item.iconic_blue ?? null,
              item.iconic_blue_parts || null,
              item.iconic_blue_image || null,
              item.iconic_blue_checked_at || null,
              item.iconic_blue_verified ? 1 : 0,
              item.iconic_blue_title || null,
              item.search_url || null
            )
          );

          if (item.price !== null && item.price !== undefined) {
            statements.push(
              env.DB.prepare(`
                INSERT INTO price_history (listing_id, price, recorded_at)
                SELECT ?, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM price_history 
                  WHERE listing_id = ? AND price = ?
                  ORDER BY recorded_at DESC LIMIT 1
                )
              `).bind(id, item.price, now, id, item.price)
            );
          }
        }

        // 3. Deactivate missing URLs if provided
        if (inactiveUrls && Array.isArray(inactiveUrls) && inactiveUrls.length > 0) {
          const placeholders = inactiveUrls.map(() => '?').join(',');
          statements.push(
            env.DB.prepare(`
              UPDATE listings SET is_active = 0
              WHERE url IN (${placeholders})
            `).bind(...inactiveUrls)
          );
        }

        // Cloudflare D1 batch execution
        const chunkSize = 80;
        for (let i = 0; i < statements.length; i += chunkSize) {
          const chunk = statements.slice(i, i + chunkSize);
          await env.DB.batch(chunk);
        }

        return new Response(JSON.stringify({ success: true, processed: listings.length }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ──────────────────────────────────────────────
      // COMPATIBILITY: /listings.json (Dynamically generated from D1)
      // ──────────────────────────────────────────────
      if (pathname === '/listings.json') {
        const [listingsRes, lastRunRes] = await Promise.all([
          env.DB.prepare('SELECT * FROM listings ORDER BY cc DESC, first_seen DESC').all(),
          env.DB.prepare('SELECT finished_at, started_at FROM scrape_runs ORDER BY id DESC LIMIT 1').first(),
        ]);

        const listings = listingsRes.results || [];
        const updatedAt = lastRunRes?.finished_at || lastRunRes?.started_at || (listings[0]?.last_seen) || new Date().toISOString();

        return new Response(JSON.stringify({ listings, updatedAt }, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=30, s-maxage=120',
            ...corsHeaders,
          }
        });
      }

      // ──────────────────────────────────────────────
      // STATIC ASSETS: Serve HTML, CSS, client JS from public/
      // ──────────────────────────────────────────────
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response('Yamaha Listings Worker is running without static assets binding.', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', ...corsHeaders }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};
