// api/woningwaarde.js
// Vercel Serverless Function — gebruikt Altum AI AVM voor woningwaarde

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { postcode, huisnummer, toevoeging, voornaam, email } = req.body || {};

  if (!postcode || !huisnummer || !email) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }

  const pc = postcode.replace(/\s/g, '').toUpperCase();

  let result = null;

  try {
    result = await callAltumAI(pc, huisnummer, toevoeging || '');
  } catch (e) {
    console.warn('Altum AI mislukt:', e.message);
  }

  if (!result) {
    result = fallbackEstimate(pc);
  }

  try {
    await saveLead({ postcode: pc, huisnummer, voornaam, email, result });
  } catch (e) {
    console.warn('Lead opslaan mislukt:', e.message);
  }

  return res.status(200).json(result);
}

async function callAltumAI(postcode, housenumber, houseaddition) {
  const apiKey = process.env.ALTUM_API_KEY;
  if (!apiKey) throw new Error('ALTUM_API_KEY niet ingesteld');

  const resp = await fetch('https://api.altum.ai/avm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      postcode,
      housenumber: String(housenumber),
      houseaddition: houseaddition || '',
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Altum AI HTTP ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const output = data?.Output;

  if (!output || typeof output === 'string') {
    throw new Error(`Altum AI fout: ${output || 'onbekend'}`);
  }

  const priceEstimation = parseInt(output.PriceEstimation, 10);
  if (!priceEstimation || priceEstimation < 50000) {
    throw new Error('Onrealistisch bedrag van Altum AI');
  }

  const { low, high } = parseConfidence(output.Confidence, priceEstimation);

  return {
    low,
    high,
    estimation: priceEstimation,
    source: 'Altum AI',
    address: `${output.Street || ''} ${output.HouseNumber || ''}, ${output.City || ''}`.trim(),
    houseType: output.HouseType || null,
    buildYear: output.BuildYear || null,
    surfaceArea: output.InnerSurfaceArea || null,
  };
}

function parseConfidence(confidence, estimation) {
  if (confidence) {
    const match = confidence.match(/([\d]+)-([\d]+)/);
    if (match) {
      const low  = Math.round(parseInt(match[1], 10) / 5000) * 5000;
      const high = Math.round(parseInt(match[2], 10) / 5000) * 5000;
      if (low > 0 && high > low) return { low, high };
    }
  }
  const marge = Math.round(estimation * 0.08);
  return {
    low:  Math.round((estimation - marge) / 5000) * 5000,
    high: Math.round((estimation + marge) / 5000) * 5000,
  };
}

function fallbackEstimate(pc) {
  const prefix = parseInt(pc.substring(0, 2), 10);
  let base;
  if (prefix <= 13)      base = 480000;
  else if (prefix <= 28) base = 380000;
  else if (prefix <= 37) base = 350000;
  else if (prefix <= 55) base = 310000;
  else if (prefix <= 79) base = 290000;
  else                   base = 270000;

  const marge = Math.round(base * 0.08);
  return {
    low:    Math.round((base - marge) / 5000) * 5000,
    high:   Math.round((base + marge) / 5000) * 5000,
    source: 'schatting',
  };
}

async function saveLead({ postcode, huisnummer, voornaam, email, result }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const to  = process.env.LEAD_EMAIL || 'jouw@email.nl';
  const fmt = n => '€\u00a0' + n.toLocaleString('nl-NL');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'leads@gratiswoningwaarde.nu',
      to,
      subject: `Nieuwe lead: ${voornaam || email} – ${postcode} ${huisnummer}`,
      html: `
        <h2 style="font-family:sans-serif">Nieuwe woningwaarde-aanvraag</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:6px 16px 6px 0;color:#666">Naam</td><td><b>${voornaam || '–'}</b></td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#666">E-mail</td><td><b>${email}</b></td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#666">Adres</td><td><b>${postcode} ${huisnummer}</b></td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#666">Waarde-indicatie</td><td><b>${fmt(result.low)} – ${fmt(result.high)}</b></td></tr>
          ${result.houseType   ? `<tr><td style="padding:6px 16px 6px 0;color:#666">Woningtype</td><td>${result.houseType}</td></tr>` : ''}
          ${result.buildYear   ? `<tr><td style="padding:6px 16px 6px 0;color:#666">Bouwjaar</td><td>${result.buildYear}</td></tr>` : ''}
          ${result.surfaceArea ? `<tr><td style="padding:6px 16px 6px 0;color:#666">Oppervlakte</td><td>${result.surfaceArea} m²</td></tr>` : ''}
          <tr><td style="padding:6px 16px 6px 0;color:#666">Bron</td><td>${result.source}</td></tr>
        </table>
      `,
    }),
  });
}
