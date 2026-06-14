// 🔊 Mamta AI voice OUTPUT — 100% LOCAL, no cloud, no paid API, no downloads.
// Uses the browser SpeechSynthesis API restricted to on-device (localService)
// Hindi voices (e.g. Microsoft Hemant/Kalpana on Windows). If no local Hindi
// voice exists it falls back to any local voice, and degrades silently.

let cachedVoices: SpeechSynthesisVoice[] = [];

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve([]);
    const got = window.speechSynthesis.getVoices();
    if (got.length) { cachedVoices = got; return resolve(got); }
    // voices load asynchronously on first call
    const handler = () => { cachedVoices = window.speechSynthesis.getVoices(); resolve(cachedVoices); };
    window.speechSynthesis.onvoiceschanged = handler;
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 600);
  });
}

/** Pick the best LOCAL Hindi female voice (or any local voice as fallback). */
async function pickVoice(): Promise<SpeechSynthesisVoice | null> {
  const voices = cachedVoices.length ? cachedVoices : await loadVoices();
  if (!voices.length) return null;
  const local = voices.filter(v => v.localService); // on-device only (no cloud voices)
  const pool = local.length ? local : voices;
  // prefer hi-IN, then a female-sounding name, then first.
  const hindi = pool.filter(v => /hi[-_]?IN|hindi/i.test(v.lang) || /hindi|hemant|kalpana|swara|aditi/i.test(v.name));
  const female = hindi.find(v => /female|kalpana|swara|aditi|heera/i.test(v.name));
  return female || hindi[0] || pool[0] || null;
}

export async function voiceStatus(): Promise<{ available: boolean; voiceName: string; isLocal: boolean }> {
  const v = await pickVoice();
  return { available: !!v, voiceName: v?.name || '', isLocal: !!v?.localService };
}

/** Speak text in Mamta's voice (local). Cancels any current speech first. */
export async function speak(text: string): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const clean = String(text || '').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const voice = await pickVoice();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'hi-IN'; }
  u.rate = 1.0;
  u.pitch = 1.05; // a touch warmer
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}
