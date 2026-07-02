// POST /api/pages — one endpoint, action-based (keeps Vercel function count low on Hobby plan)
// Actions:
//   { action:'list' }                          -> drafts + published, newest first
//   { action:'get', pageId }                   -> full page row
//   { action:'saveHtml', pageId, html }        -> AE manual edit
//   { action:'revise', pageId, feedback }      -> Sonnet revises the page per AE feedback
//   { action:'publish', pageId, slug }         -> go live at /p/:slug
//   { action:'archive', pageId }               -> take a page down
// All require { accessCode }.

import { createClient } from '@supabase/supabase-js';

const GENERATE_MODEL = 'claude-sonnet-4-6';

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { accessCode, action } = req.body || {};
  if (accessCode !== process.env.TEAM_ACCESS_CODE) {
    return res.status(401).json({ error: 'Bad access code' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (action === 'list') {
      const { data, error } = await db.from('pages')
        .select('id, slug, org_name, vertical, status, created_by, view_count, created_at, updated_at, published_at')
        .neq('status', 'archived')
        .order('updated_at', { ascending: false }).limit(200);
      if (error) throw error;
      return res.json({ pages: data });
    }

    if (action === 'get') {
      const { data, error } = await db.from('pages').select('*').eq('id', req.body.pageId).single();
      if (error) throw error;
      return res.json({ page: data });
    }

    if (action === 'saveHtml') {
      const { error } = await db.from('pages')
        .update({ html: req.body.html, updated_at: new Date().toISOString() })
        .eq('id', req.body.pageId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (action === 'revise') {
      const { data: page, error } = await db.from('pages').select('html, brief').eq('id', req.body.pageId).single();
      if (error) throw error;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: GENERATE_MODEL,
          max_tokens: 50000,
          system: 'You revise a single-file HTML prospect page per the account executive\'s feedback. Preserve the design system, structure, and all facts unless the feedback says otherwise. Never invent facts, stats, or links. Respond with ONLY the complete revised HTML document starting with <!DOCTYPE html>.',
          messages: [{
            role: 'user',
            content: `PROSPECT BRIEF (ground truth — do not contradict):\n${JSON.stringify(page.brief)}\n\nAE FEEDBACK:\n${req.body.feedback}\n\nCURRENT PAGE:\n${page.html}`
          }]
        })
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json();
      let html = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
        .replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
      const start = html.indexOf('<!DOCTYPE');
      if (start > 0) html = html.slice(start);
      if (!html.startsWith('<!DOCTYPE')) return res.status(502).json({ error: 'Revision failed to return HTML. Try again.' });

      const { error: upErr } = await db.from('pages')
        .update({ html, updated_at: new Date().toISOString() }).eq('id', req.body.pageId);
      if (upErr) throw upErr;
      return res.json({ html, usage: data.usage });
    }

    if (action === 'publish') {
      const slug = slugify(req.body.slug || '');
      if (!slug) return res.status(400).json({ error: 'A slug is required, e.g. jesuit-portland' });
      const { data: clash } = await db.from('pages').select('id').eq('slug', slug).neq('id', req.body.pageId).maybeSingle();
      if (clash) return res.status(409).json({ error: `Slug "${slug}" is already taken` });
      const { error } = await db.from('pages').update({
        slug, status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', req.body.pageId);
      if (error) throw error;
      return res.json({ ok: true, slug, url: `/p/${slug}` });
    }

    if (action === 'archive') {
      const { error } = await db.from('pages')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('id', req.body.pageId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
