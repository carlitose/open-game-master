// The change a mind notices (docs/specs/ogm-npc-perception.md §7): beside
// what it sees now, what is different from the last time it looked. Someone
// gone, someone come, someone standing elsewhere, someone now tied or down, a
// thing now in other hands or gone. The Zattera, 2026-11-18: Brakk turned
// invisible between two turns, nobody saw it happen, and the castaways went
// on talking to the spot where he had sat, because nothing in their state
// said "he is no longer there". Pure: same looks, same lines.
import { textKey } from "@/lib/language/text-logic";

export type LookPerson = { name: string; zone: string; looks: string };
export type LookThing = { name: string; owner: string };
export type Look = { people: LookPerson[]; things: LookThing[] };

const thingKey = (thing: LookThing) => `${textKey(thing.name)}|${textKey(thing.owner)}`;

// The lines, in the observer's terms ("you" for itself). The first look of
// all (no earlier one) says nothing: there is nothing to compare it with.
export function lookChanges(before: Look | null, now: Look, self: string): string[] {
  if (!before) {
    return [];
  }
  const lines: string[] = [];
  const was = new Map(before.people.map((person) => [textKey(person.name), person]));
  const is = new Map(now.people.map((person) => [textKey(person.name), person]));
  for (const [key, person] of was) {
    if (!is.has(key)) {
      lines.push(`${person.name} is no longer here${person.zone ? ` (they were at ${person.zone})` : ""}.`);
    }
  }
  for (const [key, person] of is) {
    const old = was.get(key);
    if (!old) {
      lines.push(`${person.name} is here now${person.zone ? `, at ${person.zone}` : ""}, and was not before.`);
      continue;
    }
    if (person.zone && old.zone && textKey(person.zone) !== textKey(old.zone)) {
      lines.push(`${person.name} now stands at ${person.zone} (before: ${old.zone}).`);
    }
    if (textKey(person.looks) !== textKey(old.looks)) {
      lines.push(person.looks ? `${person.name} is now ${person.looks}${old.looks ? ` (before: ${old.looks})` : ""}.` : `${person.name} is no longer ${old.looks}.`);
    }
  }
  const owner = (name: string) => (textKey(name) === textKey(self) ? "you" : name || "nobody (lying loose)");
  const had = new Map(before.things.map((thing) => [thingKey(thing), thing]));
  const has = new Map(now.things.map((thing) => [thingKey(thing), thing]));
  const named = (list: Map<string, LookThing>, thing: LookThing) => [...list.values()].filter((other) => textKey(other.name) === textKey(thing.name));
  for (const [key, thing] of had) {
    if (has.has(key)) {
      continue;
    }
    const elsewhere = named(has, thing).filter((other) => !had.has(thingKey(other)));
    lines.push(
      elsewhere.length
        ? `${thing.name}: held before by ${owner(thing.owner)}, now by ${elsewhere.map((other) => owner(other.owner)).join(", ")}.`
        : textKey(thing.owner) === textKey(self)
          ? `You no longer have ${thing.name}.`
          : `${thing.name} (${owner(thing.owner)}) is no longer in sight.`,
    );
  }
  for (const [key, thing] of has) {
    if (had.has(key) || named(had, thing).some((other) => !has.has(thingKey(other)))) {
      continue;
    }
    lines.push(textKey(thing.owner) === textKey(self) ? `You now have ${thing.name}.` : `${thing.owner ? `${thing.owner} now has` : "Now lying loose:"} ${thing.name}.`);
  }
  return lines;
}

// Someone gone or a thing of one's own gone weighs more than a step aside.
export function changeImportance(line: string): number {
  return /is no longer here|You no longer have|is now (tied|bound|down|dead|unconscious)/i.test(line) ? 2 : 1;
}
