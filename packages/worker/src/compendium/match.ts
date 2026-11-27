/**
 * Phase 2B task 3: decide which extracted NPCs/creatures/hazards become
 * compendium-refs instead of placeholder custom actors.
 *
 * Rules (decided 2026-11-27):
 *   - The adventure's own bestiary pack is authoritative: a name hit there is
 *     always accepted.
 *   - Any other pack: accept when the levels are equal, or 1 apart (Elite/Weak
 *     range) with a review flag; when the extraction has no level, accept
 *     with a review flag. Gaps of 2+ stay custom.
 *   - Hazards follow the same rules via findHazard.
 *
 * The adventure pack is the pack whose label is the adventure title; failing
 * that, the non-core pack (tier 4) that most of the exact name hits come from,
 * when it has at least 2 hits and no tie (e.g. A Few Flowers More's stat
 * blocks live in "one-shot-bestiary", labelled "One-Shots").
 */
import type { CompendiumIndex, CompendiumMatch } from './index.js';

export interface ActorMatchDecision {
  match: CompendiumMatch;
  /** Empty when the match needs no GM review. */
  reviewReasons: string[];
  /** 0.9 adventure pack, 0.8 exact level elsewhere, 0.6 flagged. */
  confidence: number;
}

export interface ActorMatchPlan {
  adventurePack: string | null;
  adventurePackSource: 'title' | 'majority' | null;
  npcs: (ActorMatchDecision | null)[];
  hazards: (ActorMatchDecision | null)[];
}

interface Named {
  name: string;
  level: number | null;
}

export function planActorMatches(
  index: CompendiumIndex,
  extracted: { title: string; npcs: Named[]; hazards: Named[] },
): ActorMatchPlan {
  let adventurePack = index.packForAdventure(extracted.title);
  let adventurePackSource: ActorMatchPlan['adventurePackSource'] = adventurePack ? 'title' : null;

  if (!adventurePack) {
    const counts = new Map<string, number>();
    const hits = [
      ...extracted.npcs.map((n) => index.findCreature(n.name)),
      ...extracted.hazards.map((h) => index.findHazard(h.name)),
    ];
    for (const m of hits) {
      if (m && m.tier === 4) counts.set(m.pack, (counts.get(m.pack) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (top && top[1] >= 2 && (ranked[1]?.[1] ?? 0) < top[1]) {
      adventurePack = top[0];
      adventurePackSource = 'majority';
    }
  }

  const decide = (m: CompendiumMatch | null, level: number | null): ActorMatchDecision | null => {
    if (!m) return null;
    if (adventurePack && m.pack === adventurePack) {
      return { match: m, reviewReasons: [], confidence: 0.9 };
    }
    if (level === null) {
      return {
        match: m,
        reviewReasons: [`Matched "${m.name}" in ${m.packLabel} by name only (no level in the adventure text); check it is the right creature.`],
        confidence: 0.6,
      };
    }
    if (m.level === null || m.level === level) return { match: m, reviewReasons: [], confidence: 0.8 };
    if (Math.abs(m.level - level) === 1) {
      return {
        match: m,
        reviewReasons: [`Compendium "${m.name}" (${m.packLabel}) is level ${m.level}; the adventure says level ${level}. Apply Elite/Weak if needed.`],
        confidence: 0.6,
      };
    }
    return null;
  };

  return {
    adventurePack,
    adventurePackSource,
    npcs: extracted.npcs.map((n) =>
      decide(index.findCreature(n.name, { level: n.level, adventurePack }), n.level),
    ),
    hazards: extracted.hazards.map((h) =>
      decide(index.findHazard(h.name, { level: h.level, adventurePack }), h.level),
    ),
  };
}
