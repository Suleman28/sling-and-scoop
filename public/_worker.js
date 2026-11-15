export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const raw = env.PLAUSIBLE_HOST?.trim().replace(/\/+$/, '');
    const host = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw;

    if (url.pathname === '/pulse/s.js' && request.method === 'GET') {
      if (!host) {
        return new Response('', {
          headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const res = await fetch(`${host}/js/script.pageview-props.tagged-events.js`);
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    if (url.pathname === '/pulse/e' && request.method === 'POST') {
      if (!host) return new Response(null, { status: 204 });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const ua = request.headers.get('User-Agent');
      if (ua) headers.set('User-Agent', ua);
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) headers.set('X-Forwarded-For', ip);
      const res = await fetch(`${host}/api/event`, {
        method: 'POST',
        headers,
        body: await request.text(),
      });
      return new Response(res.body, { status: res.status });
    }

    if (url.pathname === '/api/online' && request.method === 'GET') {
      if (!host || !env.PLAUSIBLE_API_KEY) {
        return Response.json({ online: 0 }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const site = encodeURIComponent(env.PLAUSIBLE_SITE_ID || 'slingandscoop.xyz');
      const res = await fetch(`${host}/api/v1/stats/realtime/visitors?site_id=${site}`, {
        headers: { Authorization: `Bearer ${env.PLAUSIBLE_API_KEY}` },
      });
      const online = res.ok ? Number(await res.text()) || 0 : 0;
      return Response.json({ online }, {
        headers: { 'Cache-Control': 'public, max-age=15' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
