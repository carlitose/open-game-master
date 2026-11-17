// What each mind saw the last time it looked (look-logic): kept so the next
// look can tell what changed.
import { getDatabase, nowIso } from "@/lib/db/core";
import type { Look } from "@/lib/dm/look-logic";

export function getLastLook(campaignId: string, npcId: string): Look | null {
  const row = getDatabase().prepare(`SELECT look_json FROM npc_looks WHERE campaign_id = ? AND npc_id = ?`).get(campaignId, npcId) as { look_json: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const look = JSON.parse(row.look_json) as Look;
    return Array.isArray(look.people) && Array.isArray(look.things) ? look : null;
  } catch {
    return null;
  }
}

export function setLastLook(campaignId: string, npcId: string, look: Look) {
  getDatabase()
    .prepare(`INSERT INTO npc_looks (campaign_id, npc_id, look_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, npc_id) DO UPDATE SET look_json = excluded.look_json, updated_at = excluded.updated_at`)
    .run(campaignId, npcId, JSON.stringify(look), nowIso());
}
