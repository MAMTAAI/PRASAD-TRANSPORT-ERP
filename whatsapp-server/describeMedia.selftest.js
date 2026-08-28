// whatsapp-server/describeMedia.selftest.js
// ─────────────────────────────────────────────────────────────────────────────
//   node whatsapp-server/describeMedia.selftest.js
//
// The rule under test is one line long and it silently deleted a fortnight of
// driver photographs. Nothing here needs a browser, a linked handset or a real
// driver — which is exactly why the bug survived: the only way anyone could
// have seen it was to send a picture to the company number and then go looking
// for a row that was never written.
//
// THE ONE INVARIANT: a media message must never produce an empty text.
// wa_chats.text is NOT NULL and POST /crm/chats rejects an empty one with 400,
// so an empty text here is not a cosmetic defect — it is a message that does
// not get stored at all.
// ─────────────────────────────────────────────────────────────────────────────
const { describeMedia, mediaLabel } = require('./describeMedia');

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// Every type whatsapp-web.js sets on a message that carries something. If a
// future version adds one, the fallback branch below is what catches it.
const MEDIA_TYPES = ['image', 'video', 'audio', 'ptt', 'document', 'sticker',
                     'location', 'vcard', 'multi_vcard'];

console.log('\nTHE INVARIANT — no media message may produce an empty text');
for (const type of MEDIA_TYPES) {
  // body '' is the shape that caused the loss: a photo sent with no caption.
  const r = describeMedia({ type, body: '' });
  check(`${type} with no caption`, r.text.length > 0 && r.mediaType === type, true);
}
// A type nobody has seen yet must still be recorded, not dropped.
check('unknown type still yields text', describeMedia({ type: 'newthing', body: '' }).text, '📎 newthing');
// Whitespace is not a caption. This is the near miss: `body || label` would
// have kept ' ' and written a blank-looking row.
check('whitespace-only caption is not a caption', describeMedia({ type: 'image', body: '   ' }).text, '📷 Photo');

console.log('\nTHE CAPTION WINS — the driver\'s own words are the better record');
check('photo with caption', describeMedia({ type: 'image', body: 'Loaded 12KL' }),
      { text: 'Loaded 12KL', mediaType: 'image', filename: null });
check('document keeps its filename', describeMedia({ type: 'document', body: '', _data: { filename: 'slip.pdf' } }),
      { text: '📄 Document — slip.pdf', mediaType: 'document', filename: 'slip.pdf' });
check('caption beats filename in the text, filename still recorded',
      describeMedia({ type: 'document', body: 'POD attached', _data: { filename: 'pod.pdf' } }),
      { text: 'POD attached', mediaType: 'document', filename: 'pod.pdf' });

console.log('\nPLAIN TEXT IS LEFT ALONE — no label, no media columns');
check('ordinary message', describeMedia({ type: 'chat', body: 'gadi nikal gayi' }),
      { text: 'gadi nikal gayi', mediaType: null, filename: null });
// An EMPTY chat message stays empty on purpose: it is genuinely nothing, and
// the API's own MISSING_FIELDS check must still be the thing that sees it.
check('empty chat stays empty', describeMedia({ type: 'chat', body: '' }),
      { text: '', mediaType: null, filename: null });

console.log('\nIT RUNS INSIDE A MESSAGE HANDLER — it may never throw');
// Every one of these has been a real shape at some point in whatsapp-web.js's
// life. A throw here kills the handler and takes the auto-reply with it.
check('no argument', describeMedia(), { text: '', mediaType: null, filename: null });
check('null', describeMedia(null), { text: '', mediaType: null, filename: null });
check('no type', describeMedia({ body: 'hi' }), { text: 'hi', mediaType: null, filename: null });
check('no body', describeMedia({ type: 'image' }).text, '📷 Photo');
check('_data present but empty', describeMedia({ type: 'document', body: '', _data: {} }).text, '📄 Document');

console.log('\nTHE UI MIRROR — src/WhatsappDashboard.tsx drops a text line equal to this');
// The dashboard hides the text when it only repeats the chip, by rebuilding the
// label with its own copy of this function. Asserted so the two stay readable
// as one rule: if this changes, that bubble starts saying "Photo" twice.
check('label with filename', mediaLabel('document', 'slip.pdf'), '📄 Document — slip.pdf');
check('label without filename', mediaLabel('image', null), '📷 Photo');

console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
process.exit(failures ? 1 : 0);
