// POST /api/generate
// Body: { accessCode, form: {orgName, vertical, contacts, incumbentTool, fiscalYearEnd, aeName, aeNotes}, transcript }
// Flow: 1) Haiku extracts a structured prospect brief from the transcript
//       2) Assets are matched from Supabase by vertical + pain points
//       3) Sonnet generates the full single-file HTML page (template cached)
// Returns: { brief, assetsUsed, html }

import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';
const GENERATE_MODEL = 'claude-sonnet-4-6';

const PAIN_POINT_KEYS = [
  'no-pg-program', 'incumbent-tool', 'aging-donors', 'it-concerns',
  'staff-capacity', 'board-buy-in', 'fiscal-year', 'donor-experience'
];

// ---------------------------------------------------------------
// The page template spec. This is the distillation of the Jesuit /
// TBN / 1517 / CBN pattern. It is STATIC so it sits in a cached
// system block — you pay full input price once, then 10% on reuse.
// ---------------------------------------------------------------
const PAGE_TEMPLATE_SPEC = `
You generate single-file HTML prospect pages for FreeWill, a planned giving platform.
These pages are sent to a nonprofit/church prospect after a discovery call and get
FORWARDED INTERNALLY at their organization — so write to the ORGANIZATION, not to the
individual contact. Never open with "Hi [name]". The page is a direct pitch to the org.

## Hard rules
- ONE self-contained HTML file. All CSS and JS inline. No external build steps.
- Only external resources allowed: Google Fonts (Fraunces, Inter Tight, JetBrains Mono) and asset URLs provided in the brief.
- NEVER invent statistics, case study results, dollar figures, or organization facts. Only use facts from the prospect brief and the provided FreeWill assets. If you lack a number, write qualitatively.
- NEVER invent video URLs, logos, or links. Only link to URLs explicitly provided.
- Include <meta name="robots" content="noindex, nofollow"> in <head>.
- Obfuscate any email addresses via JavaScript assembly (Cloudflare-safe pattern), never plain mailto in HTML source.
- Mobile responsive. Tabs collapse to an accordion or stacked sections under 720px.

## Design system (exact)
- Colors: deep navy #14223A (primary bg / text on cream), warm cream #F4ECE0 (page bg), coral #E04F3E (accent, CTAs, active tab). Use navy sections on cream page; coral sparingly.
- Type: Fraunces (serif) for display/headlines; Inter Tight for body; JetBrains Mono for labels, eyebrows, metadata, tab labels.
- Feel: warm, editorial, confident. Generous whitespace. No stock-photo hero. The hero is typography: org name as eyebrow (JetBrains Mono, letterspaced), then a Fraunces headline that names the opportunity in THEIR language from the call.

## Structure: tabbed page with these 7 tabs (vanilla JS tabs, no framework)
1. INTRO — Typographic hero. Eyebrow: "Prepared for [Org Name]". Headline reframes the conversation as an opportunity. 2-3 sentences of context that prove we listened (reference specifics from the call). One coral CTA anchor to Path Forward.
2. THE OPPORTUNITY — Celebratory problem reframe. NEVER accusatory ("you're missing out") — always celebratory ("your annual giving is strong; legacy giving is the natural next chapter"). Weave in their actual pain points from the brief, in their own words where the transcript gives them.
3. PEER MINISTRIES — Featured case study (from provided assets) with a short narrative, video embed IF a video URL was provided, and a simple logo/name grid of peer organizations. Only use provided assets.
4. ALONGSIDE YOUR TOOLS — Only meaningful if they have an incumbent (PG Calc, Crescendo, etc.): FreeWill complements, doesn't replace. If no incumbent, retitle "How It Fits Your Stack" and cover the no-integration deployment story.
5. WHY THIS, WHY NOW — Executive summary + FAQ (5-7 questions drawn from objections raised in the call, answered honestly). Include wealth-transfer framing only if the stat asset was provided.
6. FOR YOUR IT TEAM — Written to an IT director: what deployment actually requires, security posture, from the IT asset if provided. Plain, unhyped.
7. PATH FORWARD — Three concrete steps, fiscal-year flexibility (use their fiscal year end from the brief if known), and the AE's contact (email obfuscated). This is the only hard-sell moment; keep it calm.

## Voice
Direct, warm, specific. Short sentences. No SaaS jargon ("leverage", "unlock", "empower").
Sound like a thoughtful colleague who took great notes, not a marketing department.
`;

async function anthropic(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function textOf(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function stripFences(s) {
  return s.replace(/^```(json|html)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { accessCode, form = {}, transcript = '' } = req.body || {};
  if (accessCode !== process.env.TEAM_ACCESS_CODE) {
    return res.status(401).json({ error: 'Bad access code' });
  }
  if (!form.orgName || !transcript || transcript.length < 200) {
    return res.status(400).json({ error: 'orgName and a real transcript are required' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // ---------- 1. EXTRACTION (Haiku) ----------
    const extraction = await anthropic({
      model: EXTRACT_MODEL,
      max_tokens: 3000,
      system: `You extract structured prospect briefs from sales call transcripts for FreeWill (planned giving platform for nonprofits and churches). Respond with ONLY a JSON object, no markdown fences, no preamble. Schema:
{
  "contacts": [{"name": "", "role": "", "notes": ""}],
  "org_snapshot": "2-3 sentences: what this org is, size signals, donor base",
  "pain_points": [{"key": "one of: ${PAIN_POINT_KEYS.join(', ')}", "evidence": "what they actually said, paraphrased or quoted from transcript"}],
  "their_language": ["3-6 short phrases the prospect used that should appear on the page"],
  "objections": [{"objection": "", "context": ""}],
  "incumbent_tools": ["tools they mentioned using"],
  "excitement": "what got them energized on the call",
  "fiscal_year_end": "month if mentioned, else null",
  "risks": ["anything an AE should double-check before publishing"]
}
Only include what the transcript supports. Empty arrays are fine. Never invent.`,
      messages: [{
        role: 'user',
        content: `Org: ${form.orgName} (vertical: ${form.vertical || 'unknown'})\nAE notes: ${form.aeNotes || 'none'}\n\nTRANSCRIPT:\n${transcript}`
      }]
    });

    let brief;
    try {
      brief = JSON.parse(stripFences(textOf(extraction)));
    } catch {
      return res.status(502).json({ error: 'Extraction returned unparseable JSON. Try again.' });
    }

    // ---------- 2. ASSET MATCHING (Supabase, simple + deterministic) ----------
    const { data: allAssets, error: assetErr } = await supabase
      .from('assets').select('*').eq('active', true);
    if (assetErr) throw assetErr;

    const painKeys = new Set((brief.pain_points || []).map(p => p.key));
    const scored = (allAssets || []).map(a => {
      let score = 0;
      if (!a.verticals?.length || a.verticals.includes(form.vertical)) score += 2;
      score += (a.pain_points || []).filter(p => painKeys.has(p)).length * 3;
      if (a.asset_type === 'case_study') score += 1; // always want one featured story
      return { asset: a, score };
    }).sort((x, y) => y.score - x.score);

    const assetsUsed = scored.slice(0, 5).filter(s => s.score > 0).map(s => s.asset);

    // ---------- 3. GENERATION (Sonnet, template spec cached) ----------
    const generation = await anthropic({
      model: GENERATE_MODEL,
      max_tokens: 50000,
      system: [
        { type: 'text', text: PAGE_TEMPLATE_SPEC, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{
        role: 'user',
        content: `Generate the complete single-file HTML prospect page.

FORM INPUTS (from the AE):
${JSON.stringify(form, null, 2)}

PROSPECT BRIEF (extracted from the discovery call):
${JSON.stringify(brief, null, 2)}

FREEWILL ASSETS YOU MAY USE (only these — do not invent others):
${JSON.stringify(assetsUsed, null, 2)}

Respond with ONLY the HTML document, starting with <!DOCTYPE html>. No fences, no commentary.`
      }]
    });

    let html = stripFences(textOf(generation));
    const start = html.indexOf('<!DOCTYPE');
    if (start > 0) html = html.slice(start);
    if (!html.startsWith('<!DOCTYPE')) {
      return res.status(502).json({ error: 'Generation did not return an HTML document. Try again.' });
    }

    // ---------- 4. SAVE DRAFT ----------
    const { data: page, error: saveErr } = await supabase.from('pages').insert({
      org_name: form.orgName,
      vertical: form.vertical || 'other',
      status: 'draft',
      html,
      brief,
      form_inputs: form,
      created_by: form.aeName || 'unknown'
    }).select('id').single();
    if (saveErr) throw saveErr;

    return res.status(200).json({
      pageId: page.id,
      brief,
      assetsUsed: assetsUsed.map(a => ({ title: a.title, type: a.asset_type })),
      html,
      usage: {
        extraction: extraction.usage,
        generation: generation.usage
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
