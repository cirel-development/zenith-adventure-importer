/**
 * Printed checks and damage -> PF2e inline rolls, in already-escaped HTML.
 *
 *   "DC 14 basic Reflex save"         -> @Check[type:reflex|dc:14|basic:true]
 *   "DC 26 Fortitude save"            -> @Check[type:fortitude|dc:26]
 *   "Thievery DC 18" / "DC 18 Thievery" -> @Check[type:thievery|dc:18]{Thievery DC 18}
 *   "3d6 bludgeoning damage"          -> @Damage[3d6[bludgeoning]] damage
 *   "1d6 persistent fire damage"      -> @Damage[1d6[persistent,fire]] damage
 *
 * Same syntax the extraction prompt asks for (pipeline/extractAdventure.ts);
 * PF2e enriches it into clickable buttons. Text already holding an @Check or
 * @Damage is left alone.
 */

const SAVES = ['fortitude', 'reflex', 'will'];
const SKILLS = [
  'acrobatics', 'arcana', 'athletics', 'crafting', 'deception', 'diplomacy', 'intimidation', 'medicine', 'nature',
  'occultism', 'performance', 'religion', 'society', 'stealth', 'survival', 'thievery', 'perception',
];
const DAMAGE = 'bludgeoning|piercing|slashing|acid|cold|electricity|fire|sonic|poison|mental|force|bleed|spirit|vitality|void|positive|negative';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function inlineRolls(html: string): string {
  if (/@(?:Check|Damage)\[/.test(html)) return html;
  let out = html;
  // Saves: "DC 14 basic Reflex save", "DC 26 Fortitude save", "(DC 27 basic Reflex save)".
  out = out.replace(new RegExp(String.raw`\bDC (\d+) (basic )?(${SAVES.join('|')})(?: save)?\b`, 'gi'), (_m, dc: string, basic: string | undefined, save: string) =>
    `@Check[type:${save.toLowerCase()}|dc:${dc}${basic ? '|basic:true' : ''}]{DC ${dc} ${basic ? 'basic ' : ''}${cap(save.toLowerCase())} save}`,
  );
  // Skill checks: "Thievery DC 18" and "DC 18 Thievery".
  const skills = SKILLS.join('|');
  out = out.replace(new RegExp(String.raw`\b(${skills}) DC (\d+)\b`, 'gi'), (_m, skill: string, dc: string) =>
    `@Check[type:${skill.toLowerCase()}|dc:${dc}]{${cap(skill.toLowerCase())} DC ${dc}}`,
  );
  out = out.replace(new RegExp(String.raw`(?<!dc:)\bDC (\d+) (${skills})\b(?! save)`, 'gi'), (_m, dc: string, skill: string) =>
    `@Check[type:${skill.toLowerCase()}|dc:${dc}]{DC ${dc} ${cap(skill.toLowerCase())}}`,
  );
  // Damage: "2d6+6 piercing damage", "1d6 persistent fire damage".
  out = out.replace(new RegExp(String.raw`\b(\d+d\d+(?:\s?[+-]\s?\d+)?) (persistent )?(${DAMAGE}) damage\b`, 'gi'), (_m, f: string, p: string | undefined, type: string) =>
    `@Damage[${f.replace(/\s/g, '')}[${p ? 'persistent,' : ''}${type.toLowerCase()}]] damage`,
  );
  return out;
}
