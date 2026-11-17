# PROTOTYPE: the "god" Zattera. The observer raft from the start, with Brakk
# an invisible, deathless god nobody has ever seen: no castaway's past or aim
# names him, and his sheet is invisible and immortal, carrying nothing.
# Usage: python3 seed_god.py <new_campaign> <brakk_sheet_to_copy> <db_path>
import json, sqlite3, sys, uuid, datetime, importlib.util, os

here = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("observer", os.path.join(here, "seed_observer.py"))
observer = importlib.util.module_from_spec(spec); spec.loader.exec_module(observer)
seed = observer.seed

AMBITION = {**observer.AMBITION, "Kaku": "Sfidare il più forte della zattera in un combattimento leale e, intanto, mangiare qualcosa."}
# Hours since each last drank, ate and slept, at the start: a night and a day adrift.
BODY = {"Ottone Kranz": (7, 20, 18), "Ioshua il Pescatore": (9, 24, 20), "Mairon": (5, 16, 17), "Kaku": (8, 26, 19),
        "Gruoch": (6, 22, 21), "Volodar": (7, 18, 18), "Amleth": (10, 23, 22)}

def main(new, brakk, path):
    db = sqlite3.connect(path)
    now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"
    clock = json.loads(db.execute("select clock_json from campaigns where id=?", (new,)).fetchone()[0] or "{}")
    instant = int(clock.get("instant", 0))
    by_name = {c["name"]: c for c in seed.CAST}
    for nid, name in db.execute("select id, name from npcs where campaign_id=?", (new,)).fetchall():
        c = by_name[name]
        drank, ate, slept = BODY[name]
        state = dict(custody="free", heldBy="", restraint="none", condition="up", withParty=True, disarmed=False, carries=observer.SAME,
                     drankAt=instant - drank * 60, ateAt=instant - ate * 60, sleptAt=instant - slept * 60, wet=2, cold=2, bodyAt=instant)
        db.execute("update npcs set cast_sheet_id='', location=?, state_json=?, goals_json=?, updated_at=? where id=?",
                   (observer.PLACE, json.dumps(state, ensure_ascii=False), json.dumps({"ambition": AMBITION.get(name, c["ambition"])}, ensure_ascii=False), now, nid))
        db.execute("delete from npc_memories where npc_id=?", (nid,))
        kept = [line for line in c["past"] if not any(word in line.lower() for word in observer.OWNED + ("brakk", "barbaro"))]
        kept.append("Sulla zattera niente è di nessuno: le gallette, il pesce secco e il barile d'acqua stanno sulle assi, a portata di chiunque. Addosso ho solo una coperta lacera e una ciotola di legno, come tutti gli altri. Nessuno ha armi.")
        for line in kept:
            db.execute("insert into npc_memories (id, campaign_id, npc_id, kind, source_kind, source_name, content, learned_at, turn_id, created_at) values (?,?,?,?,?,?,?,?,?,?)",
                       (str(uuid.uuid4()), new, nid, "knowledge", "background", "", line, 0, "", now))
        print(name, len(kept), "memories")
    cols = [r[1] for r in db.execute("pragma table_info(character_sheets)")]
    row = dict(zip(cols, db.execute("select * from character_sheets where id=?", (brakk,)).fetchone()))
    row.update(id=str(uuid.uuid4()), campaign_id=new, equipment_json="[]", conditions_json=json.dumps(["invisible", "immortal"]), condition_meta_json="{}",
               current_hp=row["max_hp"], death_saves_json=None, exhaustion=0, created_at=now, updated_at=now)
    db.execute(f"insert into character_sheets ({','.join(cols)}) values ({','.join('?' * len(cols))})", [row[c] for c in cols])
    print("Brakk", row["id"])
    db.execute("update locations set is_current = case when name=? then 1 else 0 end where campaign_id=?", (observer.PLACE, new))
    db.execute("delete from locations where campaign_id=? and name!=?", (new, observer.PLACE))
    for name, qty in observer.GROUND:
        db.execute("insert into dropped_items (id, campaign_id, map_id, x, y, place, item_json, dropped_by, held_by_enemy, created_at) values (?,?,?,?,?,?,?,?,?,?)",
                   (str(uuid.uuid4()), new, None, None, None, observer.PLACE, json.dumps({"name": name, "qty": qty}, ensure_ascii=False), "", None, now))
    db.commit()

if __name__ == "__main__":
    main(*sys.argv[1:4])
