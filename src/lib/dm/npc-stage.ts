// The stage, run by the server (npc-stage-logic.ts; docs/specs/ogm-npc-ego.md):
// every first-tier mind in the scene takes its turn in order, perceiving what
// the table was told and what the minds before it did; a referee judges each
// action, the server rolls and records what changed. The narrator is handed
// the facts.
import type { Campaign } from "@/lib/db/campaigns";
import { getClock } from "@/lib/db/clock";
import { listRecentDmTurns } from "@/lib/db/dm-turns";
import { getActiveEncounter } from "@/lib/db/encounters";
import { getCurrentLocation } from "@/lib/db/locations";
import { addNpcMemories, getNpcAway } from "@/lib/db/npc-minds";
import { listNpcs, setNpcState, type Npc } from "@/lib/db/npcs";
import { listSheets } from "@/lib/db/sheets";
import { rollExpression } from "@/lib/dice";
import { currentTurnId } from "@/lib/dm/job-control";
import { requestDmMessage } from "@/lib/dm/model";
import { applyDmMutation } from "@/lib/dm/mutations";
import { handleNpcSpeak, npcMindsOn, tierOfNpc } from "@/lib/dm/npc-mind";
import { ON_STAGE_SOURCE, recipientsOf } from "@/lib/dm/npc-mind-logic";
import {
  STAGE_REFEREE_SYSTEM,
  carriesAfter,
  factLine,
  heroGains,
  parseRuling,
  renderRefereePrompt,
  settleRuling,
  stageNote,
  stageOrder,
  stageSenses,
  type HeroLine,
  type StageFact,
  type StagePerson,
  type StageRuling,
} from "@/lib/dm/npc-stage-logic";
import { needsWords, npcSilencedBy, npcStateWords } from "@/lib/dm/npc-state-logic";
import { withoutLeadingStopWords } from "@/lib/language/language";
import { textKey } from "@/lib/language/text-logic";
import { resolveTextTimeoutMs } from "@/lib/model-client";
import { stripReasoningArtifacts } from "@/lib/story-prompt";

export function npcStageOn(campaign: Pick<Campaign, "gameSettings">): boolean {
  return npcMindsOn(campaign) && Boolean(campaign.gameSettings.npcStage);
}

// The first-tier minds standing in the party's scene, able to act.
function onStage(campaign: Campaign): Npc[] {
  const here = getCurrentLocation(campaign.id)?.name ?? "";
  return listNpcs(campaign.id).filter(
    (npc) =>
      tierOfNpc(npc) === "primary" &&
      !npc.archived &&
      !getNpcAway(npc.id) &&
      !npcSilencedBy(npc.state) &&
      (Boolean(npc.companionSheetId) || npc.state.withParty || (Boolean(here) && npc.location === here)),
  );
}

async function referee(campaign: Campaign, prompt: string): Promise<StageRuling | null> {
  try {
    const result = await requestDmMessage(
      campaign.settings,
      [
        { role: "system", content: STAGE_REFEREE_SYSTEM },
        { role: "user", content: prompt },
      ],
      { meta: { task: "npc_stage_referee" }, timeoutMs: resolveTextTimeoutMs(undefined, "NPC_MIND_TIMEOUT_MS", 120_000) },
    );
    if (result.error) {
      return null;
    }
    const parsed = parseRuling(stripReasoningArtifacts(String(result.message?.content ?? "")));
    return parsed.ok ? parsed.ruling : null;
  } catch {
    return null;
  }
}

function handToHero(campaign: Campaign, turnId: string, hero: string, thing: string, giver: string): boolean {
  const sheets = listSheets(campaign.id);
  const sheet = sheets.find((entry) => textKey(entry.name) === textKey(hero));
  if (!sheet) {
    return false;
  }
  const outcome = applyDmMutation(
    campaign,
    turnId,
    "grant_item",
    JSON.stringify({ characterId: sheet.id, item: thing, qty: 1, reason: `${giver} handed it over on the stage.` }),
    sheets,
    new Map(sheets.map((entry) => [entry.id, entry])),
  );
  const result = (outcome as { result?: { error?: string } }).result;
  if (result?.error) {
    console.warn(`[npc-stage] ${giver} handed ${hero} "${thing}", but the sheet refused it: ${result.error}`);
    return false;
  }
  return true;
}

// One turn of the stage. Null when nobody on stage is owed a turn (a fight
// owns the floor, or the narrator already asked them all).
export async function runStage(
  campaign: Campaign,
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  narration: string,
  heroLines: readonly HeroLine[] = [],
): Promise<{ note: string; heroFacts: number } | null> {
  if (!npcStageOn(campaign) || getActiveEncounter(campaign.id)) {
    return null;
  }
  const present = onStage(campaign);
  const touched = new Set(
    calls
      .filter((call) => call.name === "npc_speak" || call.name === "npc_inform")
      .flatMap((call) => recipientsOf(String(call.args.name ?? ""), [], listNpcs(campaign.id)).ids),
  );
  const order = stageOrder(present.filter((npc) => !touched.has(npc.id)), listRecentDmTurns(campaign.id, 200).length);
  if (!order.length) {
    return null;
  }
  const turnId = currentTurnId() ?? "";
  const heroSheets = () => listSheets(campaign.id).filter((sheet) => !sheet.isCompanion);
  const heroes = heroSheets().map((sheet) => sheet.name);
  const facts: StageFact[] = [];
  const silent: string[] = [];
  const handed: { hero: string; thing: string; giver: string }[] = [];
  const thingKey = (thing: string) => withoutLeadingStopWords(textKey(thing), campaign.gameSettings.tableLanguage);
  const waiting = new Set(order.map((npc) => npc.id));
  // Every mind reacts to the same moment at once (a local model serves them
  // side by side); only the referee goes in order, so each outcome stands on
  // the ones before it. What the others did reaches a mind next turn.
  const answers = await Promise.all(
    order.map(async (actor) => (await handleNpcSpeak(campaign, JSON.stringify({ name: actor.name, perceives: stageSenses(narration, [], heroLines) || "Nothing new." }))) as Record<string, unknown>),
  );
  for (const [index, actor] of order.entries()) {
    waiting.delete(actor.id);
    const lines = facts.map(factLine);
    const said = answers[index];
    if (said.ok !== true) {
      silent.push(actor.name);
      continue;
    }
    const speech = String(said.says ?? "");
    const intent = String(said.intends ?? "");
    const now = getClock(campaign.id).instant;
    const cast = listNpcs(campaign.id);
    const people: StagePerson[] = [
      ...heroSheets().map((sheet) => ({ name: sheet.name, state: "", carries: sheet.equipment.map((item) => item.name), hero: true })),
      ...cast
        .filter((npc) => present.some((entry) => entry.id === npc.id))
        .map((npc) => ({ name: npc.name, state: [npcStateWords({ ...npc.state, carries: [] }), needsWords(npc.state, now)].filter(Boolean).join(", "), carries: npc.state.carries })),
    ];
    const ruling = intent ? await referee(campaign, renderRefereePrompt({ actor: actor.name, intent, speech, people, scene: narration, facts: lines, heroLines })) : null;
    let fact: StageFact = { actor: actor.name, speech, outcome: intent, roll: "", hero: "" };
    if (ruling) {
      const settled = settleRuling(ruling, ruling.uncertain ? rollExpression("1d20").total : 0);
      fact = { actor: actor.name, speech, outcome: settled.branch.outcome, roll: settled.roll, hero: heroes.find((name) => textKey(name) === textKey(ruling.hero)) ?? "" };
      for (const change of settled.branch.changes) {
        const target = cast.find((npc) => textKey(npc.name) === textKey(change.name) && present.some((entry) => entry.id === npc.id));
        if (!target) {
          continue;
        }
        setNpcState(target.id, {
          ...target.state,
          carries: carriesAfter(target.state.carries, change, thingKey),
          ...(change.drank ? { drankAt: now } : {}),
          ...(change.ate ? { ateAt: now } : {}),
          ...(change.condition && target.state.condition !== "dead" ? { condition: change.condition } : {}),
        });
      }
      // What this character handed a hero goes on the hero's sheet, through
      // the same mutation as grant_item: one ledger for every thing.
      const carried = cast.find((npc) => npc.id === actor.id)?.state.carries ?? [];
      for (const gift of heroGains(settled.branch, actor.name, heroes, carried, thingKey)) {
        if (handToHero(campaign, turnId, gift.hero, gift.thing, actor.name)) {
          handed.push({ ...gift, giver: actor.name });
          continue;
        }
        // The sheet refused it (no room): it stays with the giver, not lost.
        const giver = listNpcs(campaign.id).find((npc) => npc.id === actor.id);
        if (giver) {
          setNpcState(giver.id, { ...giver.state, carries: carriesAfter(giver.state.carries, { gains: [gift.thing], loses: [] }, thingKey) });
        }
      }
    }
    facts.push(fact);
    // Everyone who already had their turn learns how it ended; those still
    // to act read it in what they perceive.
    const told = present.filter((npc) => !waiting.has(npc.id)).map((npc) => npc.id);
    addNpcMemories(campaign.id, told, { kind: "knowledge", sourceKind: "perceived", sourceName: ON_STAGE_SOURCE, content: factLine(fact), learnedAt: now }, turnId);
  }
  return { note: stageNote(facts, silent, handed), heroFacts: facts.filter((fact) => fact.hero).length };
}
