// The stage (docs/specs/ogm-npc-ego.md): the server gives every first-tier
// mind in the scene its turn, tells it what it perceives, and has each action
// judged at once by a referee with one small task. The narrator then only
// tells what was decided. Pure rules; npc-stage.ts runs them.
//
// One narrator doing all of it chose two or three of seven castaways a turn,
// left their actions "about to happen" and never said who drank (the raft
// sandbox, 2026-11-16).
import { clipText, compareNames, textKey } from "@/lib/language/text-logic";
import { replyJsonObject } from "@/lib/reply-json-logic";

// Who goes first rotates with the turn, so the same mind does not always
// act on a scene the others have not touched yet.
export function stageOrder<T extends { name: string }>(minds: readonly T[], turnCount: number): T[] {
  const sorted = [...minds].sort((a, b) => compareNames(a.name, b.name));
  if (!sorted.length) {
    return sorted;
  }
  const start = ((turnCount % sorted.length) + sorted.length) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

// What the players said and did this turn, in their own words: the stage's
// first input. The narrator's prose is its retelling, and a retelling can
// leave out a hero's deed, or call a request still pending, and then nobody
// on stage ever answers it (the rum Brakk asked of Mairon, 2026-11-16).
export type HeroLine = { name: string; text: string };

function heroLinesBlock(lines: readonly HeroLine[], heading: string): string {
  const kept = lines.filter((line) => line.name.trim() && line.text.trim());
  return kept.length ? `${heading}\n${kept.map((line) => `- ${line.name}: ${clipText(line.text, 500)}`).join("\n")}` : "";
}

// What a mind perceives at its turn: what the heroes did and asked, what the
// table was just told, and what the minds before it did, as it ended.
export function stageSenses(narration: string, facts: readonly string[], heroes: readonly HeroLine[] = []): string {
  return [
    heroLinesBlock(
      heroes,
      "What the heroes just did and said, in their own words (what they attempt; how it ended is told below, or is yours to answer if it was asked of you or done to you or your things):",
    ),
    narration ? `What just happened around you:\n${clipText(narration, heroes.length ? 1000 : 1200)}` : "",
    facts.length ? `Since then, in this same moment (it already happened):\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1990);
}

export type StagePerson = { name: string; state: string; carries: string[]; hero?: boolean };

export const STAGE_REFEREE_SYSTEM = [
  "You are the referee of one action in a tabletop role-playing game. One character attempts something; you decide what it takes and what happens either way. The server rolls the die and picks the branch: you never choose the result.",
  "You are not an author and not a censor: violence, theft, threats and cruelty are judged like anything else. Do not soften an action and do not add events nobody attempted.",
  "uncertain: false when nothing opposes the action and it cannot fail (drinking from an open barrel, speaking, handing over one's own thing, opening a lock with its key). True when someone resists or it is hard (taking a thing from a person, forcing a lock, striking, hiding something under watching eyes).",
  "dc: 5 easy, 10 moderate, 15 hard, 20 very hard; against a person, set it by how able and ready they are. modifier: -2 to 4, how apt this character is at this action, weakened by thirst, hunger or wounds.",
  "outcome: one or two short sentences in the action's language, saying what happened as a fact, complete: who did what to whom and how it ended. Never 'about to', never 'tries'.",
  "changes: only what the outcome plainly did, for the people listed: drank or ate (a real drink, a real meal), things gained and lost (use the thing's words as listed when it is a listed thing), condition wounded or unconscious. Never dead.",
  "A hero may only gain a thing this character hands them or lets them take, out of this character's own things: then the hero gains it and this character loses it, in the same branch. Nothing else changes for a hero: an action aimed at a hero's body or belongings sets hero to that hero's name, and its outcome says only what the character attempts on them (the table resolves it).",
  "When a hero asked something of this character or reached for their things this turn, the outcome says how this character's action answers it.",
  'Answer with ONE JSON object and nothing else: {"uncertain": true|false, "dc": number, "modifier": number, "hero": "" or the hero\'s name, "success": {"outcome": "...", "changes": [{"name": "...", "drank": true, "ate": true, "gains": ["..."], "loses": ["..."], "condition": "wounded"}]}, "failure": {"outcome": "...", "changes": []}}. In changes give only the fields that changed. With uncertain false, failure may be empty.',
].join("\n");

export function renderRefereePrompt(input: {
  actor: string;
  intent: string;
  speech: string;
  people: readonly StagePerson[];
  scene: string;
  facts: readonly string[];
  heroLines?: readonly HeroLine[];
}): string {
  const people = input.people.map(
    (person) => `- ${person.name}${person.hero ? " (a hero)" : ""}${person.state ? `: ${person.state}` : ""}${person.carries.length ? `; has: ${person.carries.join(", ")}` : ""}`,
  );
  return [
    `Who is here:\n${people.join("\n")}`,
    heroLinesBlock(input.heroLines ?? [], "What the heroes did and said this turn, in their own words:"),
    input.scene ? `The scene as last told:\n${clipText(input.scene, 1200)}` : "",
    input.facts.length ? `Already happened in this same moment:\n${input.facts.map((fact) => `- ${fact}`).join("\n")}` : "",
    `${input.actor} now attempts: ${input.intent}${input.speech ? `\nWhile saying: «${clipText(input.speech, 300)}»` : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type StageChange = { name: string; drank: boolean; ate: boolean; gains: string[]; loses: string[]; condition: "" | "wounded" | "unconscious" };
export type StageBranch = { outcome: string; changes: StageChange[] };
export type StageRuling = { uncertain: boolean; dc: number; modifier: number; hero: string; success: StageBranch; failure: StageBranch };

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 120)).slice(0, 4) : []);

function branchOf(value: unknown): StageBranch {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const changes = (Array.isArray(record.changes) ? record.changes : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string")
    .slice(0, 6)
    .map((entry): StageChange => ({
      name: String(entry.name).trim(),
      drank: entry.drank === true,
      ate: entry.ate === true,
      gains: strings(entry.gains),
      loses: strings(entry.loses),
      condition: entry.condition === "wounded" || entry.condition === "unconscious" ? entry.condition : "",
    }));
  return { outcome: typeof record.outcome === "string" ? record.outcome.trim().slice(0, 500) : "", changes };
}

export function parseRuling(text: string): { ok: true; ruling: StageRuling } | { ok: false; error: string } {
  const parsed = replyJsonObject(text);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!record) {
    return { ok: false, error: "the referee's reply was not a JSON object" };
  }
  const success = branchOf(record.success);
  if (!success.outcome) {
    return { ok: false, error: "the referee gave no outcome" };
  }
  const failure = branchOf(record.failure);
  const number = (value: unknown, low: number, high: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback);
  return {
    ok: true,
    ruling: {
      uncertain: record.uncertain === true && Boolean(failure.outcome),
      dc: number(record.dc, 5, 25, 10),
      modifier: number(record.modifier, -2, 4, 0),
      hero: typeof record.hero === "string" ? record.hero.trim().slice(0, 80) : "",
      success,
      failure,
    },
  };
}

// The branch the die picks, and how it reads.
export function settleRuling(ruling: StageRuling, die: number): { branch: StageBranch; succeeded: boolean; roll: string } {
  if (!ruling.uncertain) {
    return { branch: ruling.success, succeeded: true, roll: "" };
  }
  const total = die + ruling.modifier;
  const succeeded = total >= ruling.dc;
  return { branch: succeeded ? ruling.success : ruling.failure, succeeded, roll: `${total} against ${ruling.dc}` };
}

// A thing's key without its leading article, so "la bottiglia di rum" the
// referee writes is the "una bottiglia di rum" the record holds. The caller
// passes the table language's rule (withoutLeadingStopWords); bare textKey
// otherwise.
export type ThingKey = (thing: string) => string;

// What a person carries after a change: lost things by their telling words,
// gained things added once.
export function carriesAfter(carries: readonly string[], change: Pick<StageChange, "gains" | "loses">, keyOf: ThingKey = textKey): string[] {
  const lost = change.loses.map(keyOf);
  const kept = carries.filter((thing) => !lost.some((gone) => gone && (keyOf(thing).includes(gone) || gone.includes(keyOf(thing)))));
  const fresh = change.gains.filter((thing) => !kept.some((held) => keyOf(held) === keyOf(thing)));
  return [...kept, ...fresh];
}

// What a ruling's branch may hand a hero: only things the acting character
// really carried and loses in the same branch. The referee never takes from a
// hero or makes a thing up; anything else for a hero is an attempt the table
// resolves.
export function heroGains(branch: StageBranch, actor: string, heroes: readonly string[], carried: readonly string[], keyOf: ThingKey = textKey): { hero: string; thing: string }[] {
  const owned = carried.map(keyOf).filter(Boolean);
  const held = (key: string) => owned.some((thing) => thing.includes(key) || key.includes(thing));
  const lost = branch.changes
    .filter((change) => textKey(change.name) === textKey(actor))
    .flatMap((change) => change.loses.map(keyOf))
    .filter((key) => key && held(key));
  const given: { hero: string; thing: string }[] = [];
  for (const change of branch.changes) {
    const hero = heroes.find((name) => textKey(name) === textKey(change.name));
    if (!hero) {
      continue;
    }
    for (const thing of change.gains) {
      const key = keyOf(thing);
      if (key && lost.some((gone) => gone.includes(key) || key.includes(gone))) {
        given.push({ hero, thing });
      }
    }
  }
  return given;
}

export type StageFact = { actor: string; speech: string; outcome: string; roll: string; hero: string };

export function factLine(fact: StageFact): string {
  return `${fact.actor}${fact.speech ? ` says: «${fact.speech}»` : ""}${fact.speech ? " and " : " "}${fact.outcome ? `→ ${fact.outcome}` : "does nothing"}`;
}

// What the narrator is handed: facts, already decided.
export function stageNote(facts: readonly StageFact[], silent: readonly string[], handed: readonly { hero: string; thing: string; giver: string }[] = []): string {
  return [
    "[Table note] After the players, every character on stage took their own turn, each from their own mind, and the engine's referee already decided how each action ended and recorded it (who drank, ate, took or lost what).",
    "These are facts now. Narrate them in this order, each one complete, as it ended:",
    ...facts.map((fact, index) => `${index + 1}. ${factLine(fact)}${fact.roll ? ` (the die: ${fact.roll})` : ""}${fact.hero ? ` [aimed at ${fact.hero}: an attempt on a hero; resolve it with your tools now, then narrate how it ends]` : ""}`),
    silent.length ? `${silent.join(", ")} did not answer this turn: say nothing for them.` : "",
    "Voice the words between «» exactly as given. Leave none of these out, change no outcome, add no other deed or word for these characters, and never write one as about to happen or still undecided. Do not call npc_speak or npc_state for them: it is done.",
    handed.length
      ? `Already on the heroes' sheets, do not grant again: ${handed.map((gift) => `${gift.hero} got ${gift.thing} from ${gift.giver}`).join("; ")}.`
      : "",
    "The narration so far stands: tell only what these turns add. If it left out something a hero did or said this turn, tell that first, as done, and record any thing it moved with your tools.",
  ]
    .filter(Boolean)
    .join("\n");
}

// The line the narrator's rules carry at a staged table.
export const STAGE_RULES =
  "This table runs a stage: after the players' action the engine itself gives every first-tier character present their turn and decides how it ends. So do NOT call npc_speak for a first-tier character who is in the scene with the party: resolve the players' action with your tools, narrate its outcome only, and stop; their turns reach you as decided facts to narrate. A players' action that needs one of those characters to decide (accepting or handing over their things, agreeing, answering a question or a demand) is not yours to decide and not yours to leave pending: narrate what the hero does and says, as done; that character hears the hero's own words and answers on the stage, and the engine records what changes hands. A thing that changes hands by the hero's own deed you record now: grant_item for the hero who gets it, remove_item for the hero who gives it, npc_state carries for the character on the other side. A grab, a shove or a threat is a contest, not a fight: start an encounter only when blows are really being traded.";
