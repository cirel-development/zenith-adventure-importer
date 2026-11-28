/**
 * Dev tool: build a bundle whose actors come ONLY from stat blocks parsed out
 * of a PDF's text (compendium matching off), to test parse -> contract ->
 * module -> PF2e end to end. No AI: the "extraction" is one NPC per full or
 * variant block found by the scanner.
 *
 *   tsx tests/parsed-bundle.ts --text <user-message.md> --title "<adventure>" --out <bundle.zip>
 *
 * Import the zip in the test world and compare each actor with PF2e's own
 * copy of the creature (see the Foundry console snippet in the commit notes).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assembleBundle, validateAndZip } from '../src/bundle/assemble.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';
import { scanStatBlocks } from '../src/statblock/scan.js';
import { CompendiumIndex } from '../src/compendium/index.js';

const args = process.argv.slice(2);
const get = (k: string) => args[args.indexOf(`--${k}`) + 1]!;
const text = readFileSync(get('text'), 'utf8');
const blocks = scanStatBlocks(text).filter((b) => b.form === 'full' || b.form === 'variant');

const seen = new Set<string>();
const npcs = blocks
  .filter((b) => (seen.has(b.name) ? false : (seen.add(b.name), true)))
  .map((b) => ({ name: b.name, role: 'Stat block test', description: `Parsed from the ${b.form} block.`, level: b.level, category: 'creature' }));

const extracted = ExtractedAdventureZ.parse({ title: get('title'), synopsis: 'Parser end-to-end test.', npcs });
const bundle = assembleBundle(extracted, { pdfBytes: new TextEncoder().encode(text), pdfText: text, spellIndex: CompendiumIndex.load() });
const { zip, warnings } = validateAndZip(bundle);
writeFileSync(get('out'), zip);
const parsed = bundle.actors.entities.filter((a) => a.ai_metadata?.prompt_version === 'statblock-regex-1').length;
console.log(`wrote ${get('out')}: ${bundle.actors.entities.length} actors, ${parsed} with parsed stats`);
for (const w of warnings) console.log(`  warning: ${w}`);
