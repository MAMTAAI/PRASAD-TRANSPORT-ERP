// 💡 Phase 14.3 — self-improvement PROPOSALS (human-in-the-loop). Mamta reviews
// 👎 feedback + the day's signals and SUGGESTS improvements for the admin to
// approve. It never changes its own code, rules, or RBAC. Proposals are stored
// in an additive, versioned learning log (localStorage) — admin reviews/applies.
import { llmComplete } from '../llm';
import { buildDailySummary } from './dailyReport';

export interface FeedbackItem { q: string; a: string; at: number; }
export function getFeedbackLog(): FeedbackItem[] {
  try { return JSON.parse(localStorage.getItem('mamta_feedback_log') || '[]'); } catch { return []; }
}

export interface ProposalEntry { at: number; text: string; basedOn: number; }
const LEARN_KEY = 'mamta_learning_log';
export function getLearningLog(): ProposalEntry[] {
  try { return JSON.parse(localStorage.getItem(LEARN_KEY) || '[]'); } catch { return []; }
}
function appendLearning(text: string, basedOn: number) {
  try {
    const log = getLearningLog();
    log.push({ at: Date.now(), text, basedOn });        // additive — never removes history
    localStorage.setItem(LEARN_KEY, JSON.stringify(log.slice(-50)));
  } catch { /* ignore */ }
}

/**
 * Generate improvement proposals from 👎 feedback + current signals. Returns
 * admin-facing suggestions; does NOT apply anything. Stored in the learning log.
 */
export async function generateProposals(onToken?: (t: string) => void): Promise<{ proposals: string; feedbackCount: number }> {
  const fb = getFeedbackLog();
  const signals = await buildDailySummary().catch(() => null);
  const fbText = fb.length
    ? fb.slice(-12).map((f, i) => `${i + 1}. Q: ${String(f.q).slice(0, 120)} | A: ${String(f.a).slice(0, 120)}`).join('\n')
    : '(no thumbs-down feedback recorded yet)';
  const sigText = signals
    ? `Trips ${signals.trips.total} (transit ${signals.trips.inTransit}); DL expiring ${signals.dlExpiring.length}; docs expiring ${signals.docExpiring.length}; journal ${signals.journal.count} (${signals.journal.balanced ? 'balanced' : 'flagged'}).`
    : '';

  const proposals = await llmComplete([
    { role: 'system', content: 'You are MAMTA AI proposing SAFE improvements for the admin to APPROVE. Suggest only: (a) better answer phrasing/prompt hints, (b) missing data the team should capture, (c) workflow/automation gaps. You must NOT propose changing code, security/RBAC rules, or anything that runs without human approval. Reply in Hinglish: 3-6 short, concrete, numbered proposals.' },
    { role: 'user', content: `User-disliked answers (👎):\n${fbText}\n\nToday's signals: ${sigText}\n\nImprovement proposals (admin will review):` },
  ], { temperature: 0.5 }, onToken);

  appendLearning(proposals, fb.length);
  return { proposals, feedbackCount: fb.length };
}
