export async function onRequestGet({ env }) {
  const host = env.PLAUSIBLE_HOST?.replace(/\/+$/, '');
  if (!host) {
    return new Response('', {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
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
