/**
 * Phase 25.11 — the deterministic tool router behind the golden suite
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §17 task 3).
 *
 * ## What this is
 *
 * The nightly gate has no model and no database, so "which tool does this prompt
 * need?" has to be answerable by *arithmetic*. This module is that arithmetic: a
 * phrase table that maps an intent (English or Vietnamese) to the tool that serves
 * it, and a scoring rule that picks exactly one tool out of the tools an agent
 * actually holds.
 *
 * ## Why a phrase table and not the model
 *
 * The product routes a prompt to a tool with the **model**; the fake provider
 * proves that plumbing, not the routing. A golden suite that only ever exercised
 * the fake provider would measure the fake. This router is the deterministic
 * stand-in that makes the *dataset* meaningful: the dataset says "this prompt
 * needs `crm_aggregate`", and the router has to agree — in both languages, with
 * the tool's real effect class, and with only the granted tools in reach.
 *
 * The router is deliberately conservative:
 *
 *  - it only considers tools the caller holds (a grant that is gone is a grant
 *    that cannot be routed to — the failure the gate must catch);
 *  - a longer phrase outranks a shorter one, so "list the emails" beats "email";
 *  - a tie is **ambiguous**, not a guess: an ambiguous prompt fails its case
 *    instead of being quietly routed somewhere.
 *
 * ## Why the effect class matters here
 *
 * A read-only prompt that routes to a write tool is a regression the gate must
 * fail on (§17 task 3). The catalogue carries each tool's real effect class, so
 * the dataset can say "this prompt must not reach a write tool" and the runner
 * can hold the code to it — including the day someone reclassifies a tool.
 */

import type { EffectClass } from '../ai-agents-module.js';

/**
 * The effect classes a tool can have (§7.5). The product's own enumeration, so
 * the golden suite cannot invent a class the rest of the platform does not know.
 */
export type GoldenToolEffect = EffectClass;

/** One tool as the golden suite sees it: the key, its effect class and its approval rule. */
export interface ToolCatalogueEntry {
  readonly key: string;
  readonly effectClass: GoldenToolEffect;
  readonly requiresApproval: boolean;
}

/**
 * One intent: the tool that serves it and the phrases that express it.
 *
 * The phrases are written in both languages of the installation (English and
 * Vietnamese) and are matched after diacritics are folded away, so "Tóm tắt"
 * and "tom tat" are the same phrase.
 */
export interface ToolIntent {
  readonly toolKey: string;
  readonly phrases: readonly string[];
}

/**
 * The intent table.
 *
 * Phrases are deliberately *specific*: a generic verb that several tools could
 * serve ("find", "email", "task") belongs to exactly one tool, and the
 * disambiguating words live in the phrase ("list the emails", "draft an email").
 */
export const TOOL_INTENTS: readonly ToolIntent[] = [
  {
    toolKey: 'crm_search_records',
    phrases: ['search for', 'search the', 'find all', 'find the', 'search records', 'tim', 'tim kiem', 'tim lai'],
  },
  {
    toolKey: 'crm_read_record',
    phrases: ['read the record', 'open the record', 'record details', 'details of the record', 'doc ban ghi', 'mo ban ghi'],
  },
  {
    toolKey: 'crm_list_related',
    phrases: ['related records', 'related opportunities', 'related contacts', 'associated with', 'lien quan', 'lien ket'],
  },
  {
    toolKey: 'crm_record_summary',
    phrases: ['summarize', 'summarise', 'summary of', 'tom tat', 'tom tat lai'],
  },
  {
    toolKey: 'crm_actor_context',
    phrases: ['who is responsible', 'who owns', 'assigned to', 'responsible for', 'phu trach', 'ai phu trach'],
  },
  {
    toolKey: 'crm_aggregate',
    phrases: ['how many', 'total revenue', 'revenue report', 'average', 'aggregate', 'bao cao doanh thu', 'tong so', 'bao nhieu'],
  },
  {
    toolKey: 'crm_run_report',
    phrases: ['run the stored report', 'stored report', 'run report', 'chay bao cao luu'],
  },
  {
    toolKey: 'crm_cross_module',
    phrases: ['across modules', 'account overview', 'cross module', 'tong hop cac module'],
  },
  {
    toolKey: 'crm_list_activities',
    phrases: ['activity history', 'list activities', 'past calls', 'danh sach hoat dong', 'cac cuoc goi'],
  },
  {
    toolKey: 'crm_list_emails',
    phrases: ['emails sent', 'list emails', 'email history', 'danh sach thu', 'thu da gui'],
  },
  {
    toolKey: 'docs_search',
    phrases: ['search the handbook', 'search the documentation', 'handbook page', 'tai lieu huong dan', 'tra cuu tai lieu'],
  },
  {
    toolKey: 'docs_read_page',
    phrases: ['open the page', 'read the page', 'page content', 'mo trang', 'noi dung trang'],
  },
  {
    toolKey: 'web_search',
    phrases: ['on the web', 'tren internet', 'tren web', 'internet search', 'search the internet'],
  },
  {
    toolKey: 'crm_post_note',
    phrases: ['post a note', 'add a note', 'write a note', 'ghi chu len', 'them ghi chu'],
  },
  {
    toolKey: 'crm_log_activity',
    phrases: ['log a call', 'log a meeting', 'record a call', 'ghi lai cuoc goi', 'ghi nhat cuoc hop'],
  },
  {
    toolKey: 'crm_draft_email',
    phrases: ['draft an email', 'draft email', 'write an email', 'nhat thu', 'soan thu'],
  },
  {
    toolKey: 'crm_create_task',
    phrases: ['create a task', 'add a task', 'new task', 'tao task', 'them cong viec'],
  },
  {
    toolKey: 'crm_update_record_fields',
    phrases: ['update the field', 'update the record', 'change the field', 'cap nhat truong', 'thay doi truong'],
  },
];

/** One tool's score in a routing decision. */
export interface ToolRoutingCandidate {
  readonly toolKey: string;
  readonly score: number;
}

export interface ToolRoutingResult {
  /** The tool the prompt routes to; `null` when nothing matched or the match was ambiguous. */
  readonly toolKey: string | null;
  /** The winning score; `0` when nothing matched. */
  readonly score: number;
  /** Every tool that matched, best first. */
  readonly candidates: readonly ToolRoutingCandidate[];
  /** Two tools tied for the best score: the router refuses to guess. */
  readonly ambiguous: boolean;
}

/**
 * Route one prompt to one tool.
 *
 * `availableToolKeys` is the agent's **granted** set: a tool that is not granted
 * cannot be routed to, however well the prompt matches it. That is what makes a
 * broken grant visible to the gate instead of silently routing around it.
 */
export function routeTool(prompt: string, availableToolKeys: readonly string[]): ToolRoutingResult {
  const tokens = tokenize(prompt);
  const available = new Set(availableToolKeys);
  const scores = new Map<string, number>();
  for (const intent of TOOL_INTENTS) {
    if (!available.has(intent.toolKey)) continue;
    let score = 0;
    for (const phrase of intent.phrases) {
      score += phraseScore(tokens, phrase);
    }
    if (score > 0) scores.set(intent.toolKey, score);
  }
  const candidates: ToolRoutingCandidate[] = [...scores.entries()]
    .map(([toolKey, score]) => ({ toolKey, score }))
    .sort((left, right) => right.score - left.score || left.toolKey.localeCompare(right.toolKey));
  const best = candidates[0];
  if (best === undefined) {
    return { toolKey: null, score: 0, candidates: [], ambiguous: false };
  }
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  if (tied.length > 1) {
    return { toolKey: null, score: best.score, candidates, ambiguous: true };
  }
  return { toolKey: best.toolKey, score: best.score, candidates, ambiguous: false };
}

/**
 * The score one phrase earns in a prompt: every occurrence, weighted by the
 * phrase's own length, so "list the emails" (three words) outranks "email"
 * (one word) wherever both appear.
 */
function phraseScore(tokens: readonly string[], phrase: string): number {
  const words = tokenize(phrase);
  if (words.length === 0) return 0;
  let occurrences = 0;
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (tokens[start + offset] !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) occurrences += 1;
  }
  return occurrences * words.length;
}

/**
 * Fold a phrase or a prompt into comparable words: lower case, no diacritics,
 * no punctuation. "Tóm tắt" and "tom tat" become the same two words, which is
 * what lets one table serve both languages of the installation.
 *
 * The stroked "đ" is folded to "d" first: it carries no combining mark, so the
 * diacritic strip alone would split "đọc" into "c" and lose the word.
 */
export function tokenize(value: string): string[] {
  return value
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
}

/** Whether a catalogue entry is a write (anything that changes state). */
export function isWriteEffect(effectClass: GoldenToolEffect): boolean {
  return effectClass !== 'read';
}
