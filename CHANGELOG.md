# Changelog

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
