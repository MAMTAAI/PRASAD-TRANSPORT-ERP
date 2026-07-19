// Proof: render a sample loading slip → send to LOCAL gemma4:12b vision → extract JSON.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SLIP_HTML = `<!doctype html><html><body style="font-family:Arial;width:720px;padding:30px;color:#000">
<h2 style="text-align:center">INDIAN OIL CORPORATION LTD</h2>
<h3 style="text-align:center">LOADING SLIP / INVOICE</h3>
<hr/>
<table style="width:100%;font-size:18px;line-height:2">
<tr><td><b>Invoice / SAP No:</b></td><td>1900456789</td></tr>
<tr><td><b>Date:</b></td><td>12-06-2026</td></tr>
<tr><td><b>Truck Number:</b></td><td>AS01CC4567</td></tr>
<tr><td><b>Driver:</b></td><td>RAMESH DAS</td></tr>
<tr><td><b>Loading Point:</b></td><td>Bongaigaon Refinery</td></tr>
<tr><td><b>Consignee / Destination:</b></td><td>AGARTALA AFS</td></tr>
<tr><td><b>Product:</b></td><td>HSD (High Speed Diesel)</td></tr>
<tr><td><b>Quantity:</b></td><td>20.000 KL (20000 Litres)</td></tr>
<tr><td><b>Billed To:</b></td><td>Indian Oil Corporation Ltd</td></tr>
</table></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 780, height: 560 } });
  await page.setContent(SLIP_HTML);
  const imgPath = path.join(__dirname, '..', 'mobile-shots', 'sample-slip.png');
  await page.screenshot({ path: imgPath });
  await browser.close();
  const b64 = fs.readFileSync(imgPath).toString('base64');
  console.log('slip image rendered, bytes:', fs.statSync(imgPath).size);

  const prompt = `You are a logistics document parser. Extract these fields from the loading slip image and reply with ONLY a JSON object (no prose, no markdown fences):
{"challan_no":"","document_date":"DD-MM-YYYY","vehicle_no":"","driver_name":"","loading_point":"","consignee_name":"","product_type":"HSD|MS|ATF|LPG","loaded_qty":"","customer":""}
Use empty string if a field is absent. loaded_qty in litres as a plain number.`;

  const t0 = Date.now();
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma4:12b',
      stream: false,
      options: { temperature: 0 },
      format: 'json',
      messages: [{ role: 'user', content: prompt, images: [b64] }],
    }),
  });
  const data = await res.json();
  console.log(`\nmodel replied in ${Date.now() - t0}ms`);
  console.log('RAW:', data.message?.content?.slice(0, 800));
  try {
    const parsed = JSON.parse(data.message.content);
    console.log('\nPARSED FIELDS:');
    Object.entries(parsed).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  } catch (e) { console.log('JSON parse failed:', e.message); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
