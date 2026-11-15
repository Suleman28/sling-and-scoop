export async function onRequestGet({ env }) {
  const host = env.PLAUSIBLE_HOST?.replace(/\/+$/, '');
  if (!host || !env.PLAUSIBLE_API_KEY) {
    return Response.json({ online: 0 }, { headers: { 'Cache-Control': 'public, max-age=15' } });
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
