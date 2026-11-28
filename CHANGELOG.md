# Changelog

## v0.2.1

Same requirements as v0.2.0: Foundry VTT v14 (verified 14.371) and the PF2e system 8.7.x. Bundles
made for v0.2.0 still import.

### Castable spells
- Spellcasting printed in a stat block (innate, prepared, spontaneous and focus) becomes a real PF2e
  spellcasting entry with its DC and attack, and the spells come from PF2e's spell compendium:
  heightened ranks, "(×2)" uses, prepared slots, spontaneous slots, Focus Points, and notes such as
  "At Will" and "Constant". Cantrips heighten automatically.
- Older books' spell names (magic missile, tongues, ...) find their Remaster spells.
- A spell that isn't in the compendium is listed on its entry, and the actor is flagged for review.
  Rituals stay as text in the Notes tab.

### Real items
- Items found in the adventure import as the PF2e compendium item when one exists, with the
  adventure's text added to the description under "In this adventure". Before, every item was a
  blank placeholder.
- Magic weapons and armor printed as "+1 striking flaming longsword" or "+1 resilient breastplate"
  get the base item with those runes, and precious materials ("low-grade silver rapier") are set
  on the item.
- Names that PF2e words differently still match: "Lesser Healing Potion", "Wolf Fang Talisman",
  "Onyx Dog Wondrous Figurine", "Studded Leather". Items printed without a grade ("Energy
  Mutagen") get the lowest grade and are flagged for review. Quest objects, keys and handouts are
  never matched.

### Gear on creatures
- The Items line of a parsed stat block becomes PF2e items on the creature, with runes, materials,
  quantities ("daggers (2)") and printed notes ("10 bolts"). "Functions as a dagger" uses the
  dagger. Weapons are held (two hands at most), the first armor is worn, bombs are carried.
  Gear that isn't in the compendium stays as text in the Notes tab.

### Creatures
- "Weak" and "Elite" creatures ("Weak Ghost Commoner") import as the compendium creature with PF2e's
  Weak or Elite adjustment applied.

### Fixes
- Property runes on runed items were stored under the wrong key and never took effect.
- Two items or creatures built from the same compendium entry could share each other's edits
  (runes, names, notes).
- If PF2e rejects a creature, the importer now drops copied spells and gear first and keeps the
  stat block's own strikes and abilities.

## v0.2.0

**Requires Foundry VTT v14 (verified 14.371) and the PF2e system 8.7.x.** Foundry v13 users: stay on
v0.1.10. Back up your worlds before moving to v14; world migrations cannot be undone.

### Real creature stats
- NPCs, creatures and hazards that exist in the PF2e compendium import as the compendium creature,
  with the adventure's own text added to its notes under "In this adventure". The adventure's own
  bestiary pack is preferred (for example, A Few Flowers More's creatures come from One-Shots).
- Creatures that are not in the compendium get their stats parsed from the PDF's stat block:
  Perception and senses, languages, skills (lore skills as lore items), attributes, AC, saves, HP,
  immunities, weaknesses, resistances, speeds, and Strikes with every damage part, persistent
  damage, effects such as Grab, ranges and traits. Special abilities and spells are kept as text in
  the Notes tab.
- Variant stat blocks ("Variant redcap ...") are built from their base creature with the variant's
  numbers applied, and flagged for review.
- Actors that still need a GM's check are flagged for review, with the reason.

### Fixes
- Hazard text was dropped (PF2e 8.x hazards have no public notes field); it now goes to the hazard's
  description, and hazards keep their real traits.
- Sizes, languages (Remaster names such as Fey and Sakvroth) and defense names now use PF2e's slugs.
- Perception now lands where PF2e 8.x reads it.

### For GMs testing locally
- `await game.modules.get('zenith-adventure-importer').api.selfTest()` imports a fixture bundle,
  checks every mapping, and undoes it.

## v0.1.10

Last release for Foundry v13.
