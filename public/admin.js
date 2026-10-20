/**
 * Admin key handling. The destructive endpoints (verify-blue, reject-listing) require the
 * ADMIN_SYNC_SECRET. This wraps fetch() so those calls carry the key, asking for it once
 * and remembering it in this browser only.
 */
(function () {
  const PROTECTED = ['/api/verify-blue', '/api/reject-listing'];
  const KEY = 'adminKey';
  const nativeFetch = window.fetch.bind(window);

  const read = () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } };
  const write = v => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (_) {} };

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const isProtected = PROTECTED.some(p => url.split('?')[0].endsWith(p));
    if (!isProtected) return nativeFetch(input, init);

    let key = read() || window.prompt('Admin key required for this action:');
    if (!key) return new Response(JSON.stringify({ error: 'Admin key required' }), { status: 401 });
    const send = k => nativeFetch(input, { ...init, headers: { ...(init.headers || {}), 'x-sync-secret': k } });

    let res = await send(key);
    if (res.status === 401) {
      write(null);
      key = window.prompt('Admin key was rejected. Enter the correct key:');
      if (!key) return res;
      res = await send(key);
    }
    if (res.status !== 401) write(key);
    return res;
  };
})();
