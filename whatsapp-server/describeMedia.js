// whatsapp-server/describeMedia.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT ARRIVED, WHEN IT WAS NOT WORDS.
//
// whatsapp-web.js puts the CAPTION in msg.body, so a photo sent without one has
// body ''. wa_chats.text is NOT NULL and POST /crm/chats rejected an empty text
// with 400 — so every media-only message was answered with a 400, swallowed by
// the engine's logChat catch, and lost. Several a day since 15-08: the table
// held 170 incoming rows and NOT ONE with an empty text, not because none was
// sent but because none could be written.
//
// It is the worst possible subset to lose. A driver does not type "loaded", he
// photographs the loading slip. The messages this dropped are the ones the trip
// file is actually made of.
//
// IT LIVES IN ITS OWN FILE SO IT CAN BE ASSERTED. The bug was invisible for a
// fortnight because nothing ever looked at this decision; server.js needs a
// browser, a linked handset and a real driver to exercise one line. Here it is
// a pure function over a message shape — see describeMedia.selftest.js.
//
// The label is what gets STORED, so it is written to be read by a dispatcher in
// Trip Chat, not by a developer in a log. The caption wins whenever there is
// one — the driver's own words are always the better record — and the label
// only stands in when he sent none.
// ─────────────────────────────────────────────────────────────────────────────

const MEDIA_LABELS = {
    image: '📷 Photo', video: '🎥 Video', audio: '🎵 Audio', ptt: '🎤 Voice note',
    document: '📄 Document', sticker: '🙂 Sticker', location: '📍 Location',
    vcard: '👤 Contact card', multi_vcard: '👤 Contact cards',
};

// Mirrored in src/WhatsappDashboard.tsx, which drops the text line when it is
// only repeating the chip. If the two drift the bubble says "Photo" twice —
// chosen deliberately over a new column whose only job is to say "no caption".
const mediaLabel = (kind, filename) => {
    const label = MEDIA_LABELS[kind] || ('📎 ' + kind);
    return filename ? label + ' — ' + filename : label;
};

/**
 * @param {object} msg  a whatsapp-web.js Message (or anything shaped like one)
 * @returns {{text: string, mediaType: string|null, filename: string|null}}
 *   text is never empty for a media message, which is the whole point.
 */
const describeMedia = (msg) => {
    const kind = String((msg && msg.type) || 'chat');
    // A plain message is passed through untouched: no label, no media columns,
    // and an empty one stays empty so the API's own validation still sees it.
    if (kind === 'chat') return { text: String((msg && msg.body) || ''), mediaType: null, filename: null };

    // _data is whatsapp-web.js's raw payload; the filename lives only there and
    // only for documents. Optional all the way down because a shape we have not
    // seen must degrade to a plain label, never throw inside a message handler.
    const filename = (msg && msg._data && msg._data.filename) || null;
    const caption = String((msg && msg.body) || '').trim();
    return { text: caption || mediaLabel(kind, filename), mediaType: kind, filename };
};

module.exports = { describeMedia, mediaLabel, MEDIA_LABELS };
