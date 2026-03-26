// api/woningwaarde.js
// Vercel Serverless Function — scrapet Huispedia, valt terug op WOZwaardeloket

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { postcode, huisnummer, voornaam, email } = req.body || {};

  if (!postcode || !huisnummer || !email) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }

  // Normaliseer postcode: "1234 AB" → "1234AB"
  const pc = postcode.replace(/\s/g, '').toUpperCase();

  let result = null;

  // ── Stap 1: Huispedia ───────────────────────────────────────────────────────
  try {
    result = await scrapeHuispedia(pc, huisnummer);
  } catch (e) {
    console.warn('Huispedia mislukt:', e.message);
  }

  // ── Stap 2: WOZwaardeloket als fallback ────────────────────────────────────
  if (!result) {
    try {
      result = await scrapeWOZ(pc, huisnummer);
    } catch (e) {
      console.warn('WOZwaardeloket mislukt:', e.message);
    }
  }

  // ── Stap 3: Generieke schatting als beide falen ────────────────────────────
  if (!result) {
    result = fallbackEstimate(pc);
    result.source = 'schatting';
  }

  // ── Lead opslaan (optioneel: stuur e-mail via Resend) ─────────────────────
  try {
    await saveLead({ postcode: pc, huisnummer, voornaam, email, result });
  } catch (e) {
    console.warn('Lead opslaan mislukt:', e.message);
  }

  return res.status(200).json(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// HUISPEDIA SCRAPER
// Haalt de pagina op en parset de WOZ-waarde + omgevingsdata
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeHuispedia(pc, hn) {
  const url = `https://www.huispedia.nl/woning/${pc}-${encodeURIComponent(hn)}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WoningwaardeBot/1.0)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) throw new Error(`Huispedia HTTP ${resp.status}`);

  const html = await resp.text();

  // Zoek WOZ-waarde in de HTML (Huispedia toont dit als bijv. "€ 320.000")
  const wozMatch = html.match(/WOZ[^€]*€\s*([\d.,]+)/i);
  if (!wozMatch) throw new Error('WOZ-waarde niet gevonden in Huispedia HTML');

  const woz = parseEuroString(wozMatch[1]);
  if (!woz || woz < 50000) throw new Error('WOZ-waarde onrealistisch');

  return berekendRange(woz, 'Huispedia');
}

// ─────────────────────────────────────────────────────────────────────────────
// WOZWAARDELOKET SCRAPER (fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeWOZ(pc, hn) {
  // WOZwaardeloket heeft een publieke JSON API
  const url = `https://api.wozwaardeloket.nl/wozadressen?postcode=${pc}&huisnummer=${encodeURIComponent(hn)}`;

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) throw new Error(`WOZwaardeloket HTTP ${resp.status}`);

  const data = await resp.json();

  // Verwacht formaat: [{ wozWaarden: [{ vastgesteldeWaarde: 320000 }] }]
  const waarde = data?.[0]?.wozWaarden?.[0]?.vastgesteldeWaarde;
  if (!waarde) throw new Error('Geen WOZ-waarde in response');

  return berekendRange(waarde, 'WOZwaardeloket');
}

// ─────────────────────────────────────────────────────────────────────────────
// BEREKENING: WOZ → marktwaarde-range
// WOZ ligt gemiddeld 5-15% onder de werkelijke marktwaarde.
// We geven een range van ±7% rondom WOZ × 1.10
// ─────────────────────────────────────────────────────────────────────────────
function berekendRange(woz, source) {
  const markt = Math.round(woz * 1.10);          // WOZ → marktschatting
  const marge = Math.round(markt * 0.07);        // ±7% marge
  const low   = Math.round((markt - marge) / 5000) * 5000;
  const high  = Math.round((markt + marge) / 5000) * 5000;
  return { low, high, woz, source };
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK: generieke landelijke schatting als beide bronnen falen
// ─────────────────────────────────────────────────────────────────────────────
function fallbackEstimate(pc) {
  // Ruwe schatting op basis van postcode-prefix (eerste 2 cijfers)
  const prefix = parseInt(pc.substring(0, 2), 10);
  let base;
  if (prefix <= 13)      base = 480000; // Amsterdam
  else if (prefix <= 28) base = 380000; // Den Haag / Rotterdam
  else if (prefix <= 37) base = 350000; // Utrecht omgeving
  else if (prefix <= 55) base = 310000; // Midden-Nederland
  else if (prefix <= 79) base = 290000; // Oost / Noord
  else                   base = 270000; // Noord-Nederland

  const marge = Math.round(base * 0.08);
  return {
    low:    Math.round((base - marge) / 5000) * 5000,
    high:   Math.round((base + marge) / 5000) * 5000,
    source: 'schatting',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD OPSLAAN via Resend (optioneel — stel RESEND_API_KEY in als env var)
// ─────────────────────────────────────────────────────────────────────────────
async function saveLead({ postcode, huisnummer, voornaam, email, result }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // Geen API key → stilletjes overslaan

  const TO = process.env.LEAD_EMAIL || 'jouw@email.nl';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'leads@gratiswoningwaarde.nu',
      to: TO,
      subject: `Nieuwe lead: ${voornaam || email} – ${postcode} ${huisnummer}`,
      html: `
        <h2>Nieuwe woningwaarde-aanvraag</h2>
        <table>
          <tr><td><b>Naam</b></td><td>${voornaam || '–'}</td></tr>
          <tr><td><b>E-mail</b></td><td>${email}</td></tr>
          <tr><td><b>Adres</b></td><td>${postcode} ${huisnummer}</td></tr>
          <tr><td><b>Waarde-indicatie</b></td><td>€${result.low.toLocaleString('nl-NL')} – €${result.high.toLocaleString('nl-NL')}</td></tr>
          <tr><td><b>Bron</b></td><td>${result.source}</td></tr>
        </table>
      `,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: parse "320.000" of "320,000" naar integer
// ─────────────────────────────────────────────────────────────────────────────
function parseEuroString(str) {
  return parseInt(str.replace(/[.,]/g, '').replace(/\D/g, ''), 10) || null;
}
