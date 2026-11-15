export async function onRequestPost({ request, env }) {
  const host = env.PLAUSIBLE_HOST?.replace(/\/+$/, '');
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
