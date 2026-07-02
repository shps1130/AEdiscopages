// POST /api/assets — knowledge base management (marketing-facing)
// Actions (all require { accessCode }):
//   { action:'list' }
//   { action:'add', asset:{ title, asset_type, url, rawDescription, verticals, pain_points, created_by } }
//       -> if rawDescription is provided and summary is not, Haiku writes the retrieval summary
//   { action:'toggle', assetId, active }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { accessCode, action } = req.body || {};
  if (accessCode !== process.env.TEAM_ACCESS_CODE) {
    return res.status(401).json({ error: 'Bad access code' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (action === 'list') {
      const { data, error } = await db.from('assets').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ assets: data });
    }

    if (action === 'add') {
      const a = req.body.asset || {};
      if (!a.title || !a.asset_type) return res.status(400).json({ error: 'title and asset_type required' });

      let summary = (a.summary || '').trim();
      if (!summary && a.rawDescription) {
        // Haiku condenses whatever marketing pasted into a tight retrieval summary
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            system: 'Write a 2-4 sentence summary of this FreeWill marketing asset for an internal retrieval index. State what it is, who it fits (org type / donor situation), and the one claim or story it supports. Facts only from the provided text. Respond with the summary only.',
            messages: [{ role: 'user', content: `Asset: ${a.title} (${a.asset_type})\n\n${a.rawDescription}` }]
          })
        });
        if (r.ok) {
          const data = await r.json();
          summary = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        }
      }
      if (!summary) return res.status(400).json({ error: 'Provide a summary or a rawDescription' });

      const { data, error } = await db.from('assets').insert({
        title: a.title,
        asset_type: a.asset_type,
        url: a.url || null,
        summary,
        verticals: a.verticals || [],
        pain_points: a.pain_points || [],
        created_by: a.created_by || 'marketing'
      }).select().single();
      if (error) throw error;
      return res.json({ asset: data });
    }

    if (action === 'toggle') {
      const { error } = await db.from('assets').update({ active: !!req.body.active }).eq('id', req.body.assetId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
