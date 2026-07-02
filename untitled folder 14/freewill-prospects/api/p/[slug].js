// GET /p/:slug  (rewritten here by vercel.json)
// Serves the published HTML for a prospect page and logs the view.
// Prospect-facing: no auth, but noindex + unguessable-enough slugs.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const slug = String(req.query.slug || '').toLowerCase();
  if (!slug) return res.status(404).send('Not found');

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: page } = await db.from('pages')
    .select('id, html, status')
    .eq('slug', slug).eq('status', 'published').maybeSingle();

  if (!page || !page.html) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:4rem;text-align:center"><h1>Page not found</h1></body></html>');
  }

  // Fire-and-forget view logging (skip obvious bots)
  const ua = req.headers['user-agent'] || '';
  if (!/bot|crawl|spider|preview|slack|facebookexternalhit/i.test(ua)) {
    try {
      await db.from('page_views').insert({
        page_id: page.id,
        referrer: req.headers['referer'] || null,
        user_agent: ua.slice(0, 300)
      });
      await db.rpc('increment_view_count', { p_id: page.id }).then(() => {}, () => {});
      // If you skip creating the RPC, fall back silently:
    } catch { /* never block the page on analytics */ }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.status(200).send(page.html);
}
