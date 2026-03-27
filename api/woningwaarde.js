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
    result = await callAltumWOZ(pc, huisnummer, toevoeging || '');
  } catch (e) {
    console.error('Altum AI WOZ mislukt:', e.message);
    return res.status(503).json({ error: 'Waarde kon niet worden opgehaald: ' + e.message });
  }

  try {
    await saveLead({ postcode: pc, huisnummer, voornaam, email, result });
  } catch (e) {
    console.warn('Lead opslaan mislukt:', e.message);
  }

  return res.status(200).json(result);
}

async function callAltumWOZ(postcode, housenumber, houseaddition) {
  const apiKey = process.env.ALTUM_API_KEY;
  if (!apiKey) throw new Error('ALTUM_API_KEY niet ingesteld');

  const resp = await fetch('https://api.altum.ai/woz', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      postcode,
      housenumber: String(housenumber),
      addition: houseaddition || '',
      index: 1,
      cache: 1,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const output = data?.Output;

  if (!output) throw new Error('Geen output van Altum AI');

  const wozValues = output.wozvalue;
  if (!wozValues?.length) throw new Error('Geen WOZ-waarden gevonden voor dit adres');

  const latest = wozValues[0];
  const woz = parseInt(latest.IndexedValue || latest.Value, 10);
  if (!woz || woz < 50000) throw new Error('WOZ-waarde onrealistisch: ' + woz);

  // Berekening: WOZ x 1.19, dan -5% / +5%
  const midden = Math.round(woz * 1.19);
  const low    = Math.round((midden * 0.95) / 5000) * 5000;
  const high   = Math.round((midden * 1.05) / 5000) * 5000;

  return {
    low,
    high,
    woz,
    source: 'Altum AI / WOZwaardeloket',
    straat: output.Street   || null,
    stad:   output.City     || null,
    bouwjaar:  output.BuildYear        || null,
    oppervlak: output.OuterSurfaceArea || null,
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
          <tr><td style="padding:6px 16px 6px 0;color:#666">WOZ-waarde</td><td>${fmt(result.woz)}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#666">Waarde-indicatie</td><td><b>${fmt(result.low)} – ${fmt(result.high)}</b></td></tr>
          ${result.bouwjaar  ? `<tr><td style="padding:6px 16px 6px 0;color:#666">Bouwjaar</td><td>${result.bouwjaar}</td></tr>` : ''}
          ${result.oppervlak ? `<tr><td style="padding:6px 16px 6px 0;color:#666">Oppervlakte</td><td>${result.oppervlak} m²</td></tr>` : ''}
        </table>
      `,
    }),
  });
}
