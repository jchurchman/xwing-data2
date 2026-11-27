# XWA cards from YASB

`convert.js` adds the cards X-Wing Alliance (XWA) released that this data set lacks, such as
Evacuation of D'Qar, Legends and Relics, Armed and Dangerous, Wartime, and Epic crew cards.

```bash
node scripts/yasb/convert.js --dry-run ../yasb ../xwing-points   # report only
node scripts/yasb/convert.js ../yasb ../xwing-points             # write the cards
```

- `../yasb` is a checkout of [YASB](https://github.com/raithos/xwing) with its `node_modules`
  installed. Its card files are compiled in memory; nothing is written there.
- `../xwing-points` is a checkout of [XWA's points](https://github.com/eirikmun/xwing-points). Its
  current XWA release decides which cards exist.

**Where each field comes from:**

- **XWA's points:** XWS ID, name, caption, limited, keywords, pilot slots, and upgrade restrictions.
- **YASB:** initiative, engagement, charges, Force, ability and flavor text, ship ability,
  per-pilot ship actions and stats, standard loadouts, upgrade attacks, and the actions an upgrade
  grants.

**Rules:**

- XWA's cards are not legal in AMG play: no `cost`, and `standard`, `extended`, and `epic` false.
- Standard-loadout-only upgrades are named after their card and release, e.g.
  `determination-evacuationofdqar`. Other standard loadout cards are matched to existing upgrades by
  name and slot.
- A ship this data set has only for other factions gets a new file for the new faction, copying the
  ship from an existing file, and is added to the manifest.
- Only missing cards are added, so running it again adds nothing.

It stops on anything it cannot convert faithfully, such as an unknown YASB field, slot, text icon,
or two-sided card. It prints what it converted only partly: dial changes (kept only in the card
text), cards with no text in YASB, and slots where XWA and YASB disagree.
