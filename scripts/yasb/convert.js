#!/usr/bin/env node
// Adds the cards X-Wing Alliance (XWA) released that this data set lacks, converted from YASB.
//
// XWA's points (https://github.com/eirikmun/xwing-points) decide which cards exist and supply
// their names, captions, limits, keywords, slots, and upgrade restrictions. YASB
// (https://github.com/raithos/xwing), where XWA's cards are maintained, supplies everything else:
// initiative, charges, Force, ability text, ship abilities and per-pilot actions, standard
// loadouts, attacks, and the actions upgrades grant.
//
// Usage: node scripts/yasb/convert.js [--dry-run] <yasb checkout> <xwing-points checkout>
//
// The YASB checkout needs its node_modules (for YASB's CoffeeScript compiler); its card files are
// compiled in memory, so nothing is written there. Only cards missing here are added, so running
// it again adds nothing new. XWA's cards are not legal in AMG play: they get no cost and false
// standard, extended, and epic flags. It stops on anything it cannot convert faithfully, and prints
// what it converted only partly.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const prettier = require("prettier");

const DATA_ROOT = path.join(__dirname, "..", "..");

// YASB's slot names that differ from ours.
const SLOT_NAMES = { Force: "Force Power" };

// XWA's slot names that differ from ours.
const XWA_SLOT_NAMES = { Payload: "Device" };

// YASB's ship names that differ from ours.
const SHIP_NAMES = { "BTA-NR2-W Y-wing": "BTA-NR2 Y-Wing" };

// YASB's text icons and our bracketed names for them.
const ICONS = {
  BANKLEFT: "Bank Left",
  BANKRIGHT: "Bank Right",
  BARRELROLL: "Barrel Roll",
  BOOST: "Boost",
  BULLSEYEARC: "Bullseye Arc",
  CALCULATE: "Calculate",
  CANNON: "Cannon",
  CHARGE: "Charge",
  COORDINATE: "Coordinate",
  CRIT: "Critical Hit",
  DEVICE: "Device",
  ENERGY: "Energy",
  EVADE: "Evade",
  FOCUS: "Focus",
  FORCE: "Force",
  FRONTARC: "Front Arc",
  FULLFRONTARC: "Full Front Arc",
  FULLREARARC: "Full Rear Arc",
  HIT: "Hit",
  ILLICIT: "Illicit",
  JAM: "Jam",
  LEFTARC: "Left Arc",
  LOCK: "Lock",
  // XWA's Epic scenario icon; listed in the report for review.
  MISSIONPOINT: "Mission Point",
  MISSILE: "Missile",
  REARARC: "Rear Arc",
  REINFORCE: "Reinforce",
  RELOAD: "Reload",
  RIGHTARC: "Right Arc",
  ROTATEARC: "Rotate Arc",
  SHIELD: "Shield",
  SINGLETURRETARC: "Single Turret Arc",
  SLAM: "SLAM",
  SLOOPLEFT: "Segnor's Loop Left",
  SLOOPRIGHT: "Segnor's Loop Right",
  STRAIGHT: "Straight",
  TORPEDO: "Torpedo",
  TROLLLEFT: "Tallon Roll Left",
  TROLLRIGHT: "Tallon Roll Right",
  TURNLEFT: "Turn Left",
  TURNRIGHT: "Turn Right",
  TURRET: "Turret"
};

// YASB's action names that differ from ours.
const ACTION_NAMES = { Slam: "SLAM" };

// YASB's upgrade attack fields and the arc each means.
const ATTACK_ARCS = {
  attack: "Front Arc",
  attackb: "Rear Arc",
  attackbull: "Bullseye Arc",
  attackdt: "Double Turret Arc",
  attackf: "Full Front Arc",
  attackt: "Single Turret Arc"
};

// Pilot and upgrade fields this script knows how to convert or knows to ignore. Any other field on
// a card it converts stops the script, so a new YASB feature is not silently dropped.
const KNOWN_PILOT_FIELDS = new Set([
  "canonical_name", "chassis", "charge", "engagement", "faction", "force", "forcerecurring", "id",
  "keyword", "loadout", "name", "points", "recurring", "ship", "ship_override", "skill", "slots",
  "sources", "unique", "upgrades", "xws", "xwsaddon"
]);
const KNOWN_UPGRADE_FIELDS = new Set([
  "attack", "attackb", "attackbull", "attackdt", "attackf", "attackt", "canonical_name", "charge",
  "faction", "force", "forcerecurring", "id", "modifier_func", "name", "points", "range", "rangebonus", "recurring",
  "restrictions", "ship", "slot", "sources", "standard", "standardized", "unique", "xws", "xwsaddon"
]);

const report = {
  dialChanges: [],
  noForceSide: [],
  noText: [],
  partialGrants: [],
  reviewIcons: [],
  slotDifferences: []
};

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const readJSON = file => JSON.parse(fs.readFileSync(file, "utf8"));
const fail = message => {
  throw new Error(message);
};

// --- Inputs -------------------------------------------------------------------------------------

function loadYasb(yasbPath) {
  const read = file => fs.readFileSync(path.join(yasbPath, file), "utf8");
  const coffee = require(path.join(yasbPath, "node_modules", "coffeescript"));
  const compile = file => coffee.compile(read(file), { bare: true }); // as YASB's Gruntfile

  // setupCommonCardData uses this helper, which YASB defines in its browser-only xwing.coffee.
  String.prototype.getXWSBaseName = function() {
    return this.split("-")[0];
  };
  const common = {};
  vm.runInThisContext(`(function (exports) {\n${compile("coffeescripts/content/cards-common.coffee")}\n})`)(common);
  const cards = common.basicCardData();
  common.setupCommonCardData(cards);

  // The English card text, captured instead of applied to YASB's browser state.
  const english = {
    ships: {},
    renameShip() {},
    setupTranslationCardData(pilots, upgrades, conditions, chassis) {
      english.text = { chassis, pilots, upgrades };
    }
  };
  vm.runInThisContext(`(function (exportObj) {\n${compile("coffeescripts/content/cards-en.coffee")}\n})`)(english);
  english.cardLoaders.English();

  const upgradesByName = new Map();
  for (const u of cards.upgradesById.filter(u => u.skip == null)) {
    if (upgradesByName.has(u.name)) fail(`YASB has two upgrades named ${JSON.stringify(u.name)}`);
    upgradesByName.set(u.name, u);
  }
  const pilotsByXws = new Map(cards.pilotsById.filter(p => p.skip == null).map(p => [p.xws, p]));
  return { cards, pilotsByXws, text: english.text, upgradesByName };
}

function loadPoints(pointsPath) {
  const revisions = readJSON(path.join(pointsPath, "XWA", "points-revisions.json"));
  const revision = readJSON(path.join(pointsPath, revisions.current_revision));
  const pilots = [];
  let upgrades;
  for (const [faction, file] of Object.entries(revision.files)) {
    const data = readJSON(path.join(pointsPath, file));
    if (faction === "upgrades") {
      upgrades = data;
      continue;
    }
    for (const [ship, entries] of Object.entries(data)) {
      for (const [xws, entry] of Object.entries(entries)) pilots.push({ ...entry, faction, ship, xws });
    }
  }
  return { label: revision.format.trim(), pilots, upgrades };
}

function loadData() {
  const manifest = readJSON(path.join(DATA_ROOT, "data", "manifest.json"));
  const shipFiles = []; // { faction, file, json }
  const upgradeFiles = new Map(); // file -> json
  const ids = new Set();
  const upgrades = []; // existing upgrades, for matching standard loadout cards by name
  for (const { faction, ships } of manifest.pilots) {
    for (const file of ships) {
      const json = readJSON(path.join(DATA_ROOT, file));
      shipFiles.push({ faction, file, json });
      json.pilots.forEach(p => ids.add(p.xws));
    }
  }
  const fileForType = {};
  for (const file of manifest.upgrades) {
    const json = readJSON(path.join(DATA_ROOT, file));
    upgradeFiles.set(file, json);
    for (const u of json) {
      ids.add(u.xws);
      upgrades.push(u);
      fileForType[u.sides[0].type] = fileForType[u.sides[0].type] || file;
    }
  }
  return { fileForType, ids, manifest, newShipFiles: [], shipFiles, upgradeFiles, upgrades };
}

// --- Conversions --------------------------------------------------------------------------------

// Converts YASB card text to ours: icons in brackets, no HTML, line breaks as spaces. Returns the
// rules text as ability and italic flavor text as text, as this data set separates them.
function convertText(raw, card) {
  if (!raw) return {};
  // YASB writes both sides of a two-sided card in one text; this data set gives each side its own.
  if (/\bSide:/.test(raw)) fail(`${card}: two-sided card text is not converted`);
  let flavor;
  let rules = raw.replace(/<i class ?= ?flavor_text>([\s\S]*?)<\/i>/, (_, inner) => {
    flavor = inner;
    return "";
  });
  const clean = s =>
    s
      .replace(/%LINEBREAK%/g, " ")
      .replace(/%([A-Z0-9_]+)%/g, (_, icon) => {
        if (!ICONS[icon]) fail(`${card}: unknown text icon %${icon}%`);
        if (icon === "MISSIONPOINT") report.reviewIcons.push(card);
        return `[${ICONS[icon]}]`;
      })
      .replace(/<\/?(strong|b)>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  rules = clean(rules);
  if (/<[^>]+>/.test(rules)) fail(`${card}: unconverted HTML in ${JSON.stringify(rules)}`);
  const out = {};
  if (rules) out.ability = rules;
  if (flavor) out.text = clean(flavor);
  return out;
}

// Converts YASB's action list, e.g. ["Focus", "R-> Lock", "R-Boost"], where "> X" links X to the
// action before it and an "R-" prefix makes an action red.
function convertActions(list, card) {
  const actions = [];
  for (const raw of list) {
    const m = raw.match(/^(R-|W-)?(> ?)?(.+)$/);
    if (!m) fail(`${card}: unknown action ${JSON.stringify(raw)}`);
    const [, color, linked, name] = m;
    if (/[^A-Za-z ]/.test(name)) fail(`${card}: unknown action ${JSON.stringify(raw)}`);
    const action = { difficulty: color === "R-" ? "Red" : "White", type: ACTION_NAMES[name] || name };
    if (linked) {
      const previous = actions[actions.length - 1];
      if (!previous || previous.linked) fail(`${card}: linked action ${JSON.stringify(raw)} has nothing to link to`);
      previous.linked = action;
    } else {
      actions.push(action);
    }
  }
  return actions;
}

function recovers(value, card) {
  if (value == null) return 0;
  if (value === true) return 1;
  if (Number.isInteger(value) && value >= -1 && value <= 2) return value;
  return fail(`${card}: unknown recurring value ${JSON.stringify(value)}`);
}

function convertSlot(slot, card) {
  const name = SLOT_NAMES[slot] || slot;
  if (!/^[A-Z][A-Za-z ]+$/.test(name)) fail(`${card}: unknown slot ${JSON.stringify(slot)}`);
  return name;
}

// A pilot's Force side: from YASB's "Light Side" and "Dark Side" keywords, else from an existing
// pilot of the same name (on the same ship, if names alone disagree). Undefined when neither says,
// e.g. Force that comes from a crew card like The Child, which has no side here either.
function forceSide(y, name, shipFile, data) {
  const keywords = y.keyword || [];
  const fromKeywords = [["Dark Side", "dark"], ["Light Side", "light"]].filter(([k]) => keywords.includes(k)).map(([, s]) => s);
  if (fromKeywords.length) return fromKeywords;
  const sides = ships => {
    const found = new Set();
    for (const { json } of ships) {
      for (const p of json.pilots) if (norm(p.name) === norm(name) && p.force && p.force.side) found.add(JSON.stringify(p.force.side));
    }
    return [...found];
  };
  for (const found of [sides(data.shipFiles), sides(data.shipFiles.filter(s => s.json.xws === shipFile.json.xws))]) {
    if (found.length === 1) return JSON.parse(found[0]);
  }
  return undefined;
}

// The actions an upgrade's modifier_func adds. Only `stats.actions.push('...')` (optionally
// guarded by an "already has it" check) is understood; anything else is reported, not converted.
function convertGrants(fn, card) {
  const source = fn.toString();
  const pushes = [...source.matchAll(/stats\.actions\.push\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const rest = source
    .replace(/(return )?stats\.actions\.push\(['"][^'"]+['"]\);/g, "")
    // what is left of an "if it does not have the action already" guard around a push
    .replace(/if \(indexOf\.call\(stats\.actions,\s*['"][^'"]+['"]\) < 0\) \{\s*\}/g, "")
    .replace(/^function\s*\(stats\)\s*\{|\}\s*$/g, "")
    .trim();
  if (rest) report.partialGrants.push(`${card}: ${rest.replace(/\s+/g, " ").slice(0, 120)}`);
  if (/maneuvers/.test(source)) report.dialChanges.push(card);
  // YASB writes some granted actions as "*Lock" (an action the card adds alongside a linked one).
  return convertActions(pushes.map(a => a.replace(/^\*/, "")), card).map(value => ({ type: "action", value }));
}

function convertAttack(u, card) {
  const arcs = Object.keys(ATTACK_ARCS).filter(k => u[k] != null);
  if (arcs.length === 0) return undefined;
  if (arcs.length > 1) fail(`${card}: more than one attack`);
  const attack = { arc: ATTACK_ARCS[arcs[0]], value: u[arcs[0]] };
  const m = String(u.range).match(/^(\d)(?:-(\d))?$/);
  if (!m) fail(`${card}: unknown attack range ${JSON.stringify(u.range)}`);
  attack.minrange = Number(m[1]);
  attack.maxrange = Number(m[2] || m[1]);
  // YASB's rangebonus flag is this data set's ordnance flag: they agree on every existing card.
  attack.ordnance = Boolean(u.rangebonus);
  return attack;
}

function checkFields(card, known, label) {
  for (const key of Object.keys(card)) {
    if (!known.has(key)) fail(`${label}: YASB field ${JSON.stringify(key)} is not converted`);
  }
}

// --- Cards --------------------------------------------------------------------------------------

// The faction's file for a ship. A ship this data set has only for other factions gets a new file
// for this faction, copying the ship itself (stats, actions, dial) from an existing one, as each
// faction's ships live in their own files.
function findShipFile(data, faction, shipName, card) {
  const wanted = norm(SHIP_NAMES[shipName] || shipName);
  const same = data.shipFiles.filter(s => norm(s.json.name) === wanted);
  const found = same.filter(s => s.faction === faction);
  if (found.length === 1) return found[0];
  if (found.length > 1 || same.length === 0) fail(`${card}: no single ship file for ${JSON.stringify(shipName)}`);

  const sibling = data.shipFiles.find(s => s.faction === faction);
  const template = same[0];
  const json = {};
  for (const [key, value] of Object.entries(template.json)) {
    if (key === "faction") json.faction = sibling.json.faction;
    else if (key === "pilots") json.pilots = [];
    else json[key] = value;
  }
  const file = path.posix.join(path.posix.dirname(sibling.file), path.posix.basename(template.file));
  if (fs.existsSync(path.join(DATA_ROOT, file))) fail(`${card}: ${file} exists but is not in the manifest`);
  const entry = { faction, file, json };
  data.shipFiles.push(entry);
  data.newShipFiles.push(entry);
  return entry;
}

// The ID a standard-loadout-only upgrade gets here: its name and release, e.g.
// "determination-evacuationofdqar", like the existing "r2a3-battleofyavin".
function loadoutUpgradeId(u, pilot, assigned, data) {
  const release = pilot.xwsaddon.split("-")[0];
  let id = `${u.canonical_name}-${release}`;
  const taken = assigned.get(id);
  if (taken && taken.id !== u.id) id = `${id}-${pilot.faction.toLowerCase().replace(/[^a-z]/g, "")}`;
  if (data.ids.has(id)) fail(`${pilot.name}: standard loadout upgrade ID ${id} is already used`);
  const again = assigned.get(id);
  if (again && again.id !== u.id) fail(`${pilot.name}: standard loadout upgrade ID ${id} is ambiguous`);
  assigned.set(id, u);
  return id;
}

// An existing upgrade for a standard loadout card YASB does not mark standard-only: same name and
// slot, and YASB's ID when the name and slot match more than one.
function existingUpgradeId(u, data, card) {
  const name = norm(u.name.replace(/\s*\([^)]*\)$/, ""));
  const type = convertSlot(u.slot, card);
  const matches = data.upgrades.filter(e => norm(e.name).startsWith(name) && e.sides[0].type === type);
  const exact = matches.length === 1 ? matches : matches.filter(e => e.xws === u.xws);
  if (exact.length !== 1) {
    fail(`${card}: standard loadout card ${JSON.stringify(u.name)} matches ${matches.map(e => e.xws).join(", ") || "no"} existing upgrade`);
  }
  return exact[0].xws;
}

// YASB's pilot for an XWA pilot: the one with the same XWS ID, else the one XWA's yasb_id names,
// whichever has XWA's name. Neither is reliable alone: YASB's numeric IDs have shifted since XWA
// recorded some, and a few of XWA's XWS IDs are spelled differently from YASB's.
function findYasbPilot(xwa, yasb) {
  const sameName = p => p && norm(p.name.replace(/\s*\([^)]*\)/g, "")) === norm(xwa.name);
  const candidates = [yasb.pilotsByXws.get(xwa.xws), yasb.cards.pilotsById[xwa.yasb_id]];
  return candidates.find(sameName) || fail(`pilot ${xwa.xws}: no YASB pilot named ${JSON.stringify(xwa.name)} by XWS ID or yasb_id ${xwa.yasb_id}`);
}

function convertPilot(xwa, yasb, data, loadout) {
  const y = findYasbPilot(xwa, yasb);
  const card = `pilot ${xwa.xws}`;
  checkFields(y, KNOWN_PILOT_FIELDS, card);
  const shipFile = findShipFile(data, xwa.faction, y.ship, card);

  const pilot = { name: xwa.name };
  if (xwa.subtitle) pilot.caption = xwa.subtitle;
  Object.assign(pilot, { xws: xwa.xws, initiative: y.skill, limited: xwa.limited });
  if (y.engagement != null) pilot.engagement = y.engagement;

  const text = convertText(yasb.text.pilots[y.name] && yasb.text.pilots[y.name].text, card);
  if (!text.ability && !text.text) report.noText.push(xwa.xws);
  Object.assign(pilot, text);

  const chassis = y.chassis || yasb.cards.ships[y.ship].chassis;
  if (chassis) {
    const ability = yasb.text.chassis[chassis];
    if (!ability) fail(`${card}: no text for ship ability ${JSON.stringify(chassis)}`);
    pilot.shipAbility = { name: ability.display_name || chassis, text: convertText(ability.text, card).ability };
  }
  if (y.charge) pilot.charges = { value: y.charge, recovers: recovers(y.recurring, card) };
  if (y.force) {
    pilot.force = { value: y.force, recovers: recovers(y.forcerecurring ?? 1, card) };
    const side = forceSide(y, xwa.name, shipFile, data);
    if (side) pilot.force.side = side;
    else report.noForceSide.push(xwa.xws);
  }

  const override = y.ship_override || {};
  for (const key of Object.keys(override)) {
    if (!["actions", "hull", "shields", "maneuvers"].includes(key)) fail(`${card}: ship_override.${key} is not converted`);
  }
  if (override.actions) pilot.shipActions = convertActions(override.actions, card);
  const stats = ["hull", "shields"].filter(k => override[k] != null).map(type => ({ type, value: override[type] }));
  if (stats.length) pilot.shipStats = stats;
  if (override.maneuvers) report.dialChanges.push(card);

  if (y.upgrades) {
    pilot.standardLoadout = y.upgrades.map(name => {
      const u = yasb.upgradesByName.get(name);
      if (!u) fail(`${card}: unknown standard loadout card ${JSON.stringify(name)}`);
      if (!u.standard) return existingUpgradeId(u, data, card);
      const id = loadoutUpgradeId(u, y, loadout.ids, data);
      loadout.cards.set(id, u);
      return id;
    });
  }
  if (xwa.keywords && xwa.keywords.length) pilot.keywords = xwa.keywords;
  if (!y.upgrades) {
    pilot.slots = xwa.slots.map(s => XWA_SLOT_NAMES[s] || s);
    const yasbSlots = (y.slots || []).map(s => convertSlot(s, card));
    if (yasbSlots.slice().sort().join() !== pilot.slots.slice().sort().join()) {
      report.slotDifferences.push(`${xwa.xws}: XWA ${pilot.slots.join(", ")}; YASB ${yasbSlots.join(", ")}`);
    }
  }
  Object.assign(pilot, { standard: false, extended: false, epic: false });
  return { shipFile, pilot };
}

function convertUpgrade(id, u, yasb, xwa) {
  const card = `upgrade ${id}`;
  checkFields(u, KNOWN_UPGRADE_FIELDS, card);
  const type = convertSlot(u.slot, card);
  const name = xwa ? xwa.name : u.name.replace(/\s*\([^)]*\)$/, "");

  const side = { title: name, type };
  Object.assign(side, convertText(yasb.text.upgrades[u.name] && yasb.text.upgrades[u.name].text, card));
  if (!side.ability && !side.text) report.noText.push(id);
  side.slots = [type];
  if (u.charge) side.charges = { value: u.charge, recovers: recovers(u.recurring, card) };
  const attack = convertAttack(u, card);
  if (attack) side.attack = attack;
  // Force on an upgrade belongs to the upgrade, as with The Child.
  if (u.force) side.force = { value: u.force, recovers: recovers(u.forcerecurring ?? 1, card) };
  const grants = u.modifier_func ? convertGrants(u.modifier_func, card) : [];
  if (grants.length) side.grants = grants;

  const upgrade = { name, limited: xwa ? xwa.limited : u.unique ? 1 : 0, xws: id, sides: [side] };
  if (xwa && xwa.restrictions && xwa.restrictions.length) upgrade.restrictions = xwa.restrictions;
  Object.assign(upgrade, { standard: false, extended: false, epic: false });
  if (!xwa) upgrade.standardLoadoutOnly = true;
  return upgrade;
}

// --- Writing ------------------------------------------------------------------------------------

// The index of the "]" closing the array that starts at text[open], skipping strings.
function closingBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return fail("unbalanced JSON");
}

// Adds items to the end of an array in a file's text and leaves every other character as it is,
// so existing entries keep their formatting. Each item is formatted with Prettier on its own and
// indented one level deeper than the line the array starts on. `open` is the index of its "[".
function appendToArray(text, open, items, options) {
  const close = closingBracket(text, open);
  const lineStart = text.lastIndexOf("\n", open) + 1;
  const indent = `${text.slice(lineStart).match(/^ */)[0]}  `;
  const format = item =>
    prettier
      .format(JSON.stringify(item), { ...options, parser: "json", printWidth: options.printWidth - indent.length })
      .trim()
      .split("\n")
      .map(line => indent + line)
      .join("\n");
  const before = text.slice(0, close).replace(/\s*$/, "");
  const empty = before.endsWith("[");
  const closingIndent = text.slice(text.lastIndexOf("\n", close) + 1, close);
  if (/\S/.test(closingIndent)) fail("an array to append to must end with ] on its own line");
  return `${before}${empty ? "" : ","}\n${items.map(format).join(",\n")}\n${closingIndent}${text.slice(close)}`;
}

// The index of the "[" starting the array under key in a file's text; the key must be unique.
function arrayAt(text, key, after = 0) {
  const i = text.indexOf(`"${key}"`, after);
  if (i === -1 || text.indexOf(`"${key}"`, i + 1) !== -1 && after === 0) fail(`no single "${key}" array`);
  return text.indexOf("[", i);
}

// --- Main ---------------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [yasbPath, pointsPath] = args.filter(a => a !== "--dry-run").map(p => path.resolve(p));
  if (!yasbPath || !pointsPath) fail("usage: node scripts/yasb/convert.js [--dry-run] <yasb checkout> <xwing-points checkout>");
  const yasb = loadYasb(yasbPath);
  const points = loadPoints(pointsPath);
  const data = loadData();
  // Entries added to each existing file, and the whole file's intended contents.
  const added = new Map();
  const intended = new Map();
  const add = (file, json, item) => {
    if (!added.has(file)) added.set(file, []);
    added.get(file).push(item);
    intended.set(file, json);
  };

  // Pilots XWA prices that are missing here.
  const loadout = { cards: new Map(), ids: new Map() };
  const newPilots = points.pilots.filter(p => !data.ids.has(p.xws));
  for (const xwa of newPilots) {
    const { shipFile, pilot } = convertPilot(xwa, yasb, data, loadout);
    shipFile.json.pilots.push(pilot);
    add(shipFile.file, shipFile.json, pilot);
  }

  // Upgrades XWA prices that are missing here and that YASB has under the same ID. Upgrades XWA
  // lists under a different ID than ours (e.g. "bobafett-crew") are existing cards, not new ones.
  const yasbByXws = new Map(yasb.cards.upgradesById.filter(u => u.skip == null && !u.standard).map(u => [u.xws, u]));
  const newUpgrades = [];
  const otherIds = [];
  for (const [xws, xwa] of Object.entries(points.upgrades)) {
    if (data.ids.has(xws)) continue;
    const u = yasbByXws.get(xws);
    if (!u) {
      otherIds.push(xws);
      continue;
    }
    newUpgrades.push(convertUpgrade(xws, u, yasb, xwa));
  }
  for (const [id, u] of loadout.cards) newUpgrades.push(convertUpgrade(id, u, yasb, null));
  for (const upgrade of newUpgrades) {
    const file = data.fileForType[upgrade.sides[0].type] || fail(`${upgrade.xws}: no upgrade file for ${upgrade.sides[0].type}`);
    data.upgradeFiles.get(file).push(upgrade);
    add(file, data.upgradeFiles.get(file), upgrade);
  }

  // New ship files go in the manifest, after the faction's existing ships.
  const newFiles = new Set(data.newShipFiles.map(s => s.file));
  const optionsFor = file => prettier.resolveConfig.sync(path.join(DATA_ROOT, file));
  const manifestFile = "data/manifest.json";
  let manifestText = fs.readFileSync(path.join(DATA_ROOT, manifestFile), "utf8");
  for (const { faction, file } of data.newShipFiles) {
    data.manifest.pilots.find(p => p.faction === faction).ships.push(file);
    const at = manifestText.indexOf(`"faction": "${faction}"`);
    if (at === -1) fail(`no ${faction} entry in the manifest`);
    manifestText = appendToArray(manifestText, arrayAt(manifestText, "ships", at), [file], optionsFor(manifestFile));
  }

  // Existing files keep their text and get the new entries appended, so nothing already there is
  // reformatted; new files are formatted whole. Each must parse to exactly what was intended.
  const outputs = new Map();
  for (const [file, json] of intended) {
    if (newFiles.has(file)) {
      outputs.set(file, prettier.format(JSON.stringify(json), { ...optionsFor(file), parser: "json" }));
      continue;
    }
    const text = fs.readFileSync(path.join(DATA_ROOT, file), "utf8");
    const open = file.includes("/upgrades/") ? text.indexOf("[") : arrayAt(text, "pilots");
    outputs.set(file, appendToArray(text, open, added.get(file), optionsFor(file)));
  }
  if (newFiles.size) {
    outputs.set(manifestFile, manifestText);
    intended.set(manifestFile, data.manifest);
  }

  const files = [...outputs.keys()].sort();
  for (const file of files) {
    if (JSON.stringify(JSON.parse(outputs.get(file))) !== JSON.stringify(intended.get(file))) {
      fail(`${file}: the JSON to write differs from what was intended`);
    }
  }
  for (const file of dryRun ? [] : files) fs.writeFileSync(path.join(DATA_ROOT, file), outputs.get(file));

  const list = (title, items) => items.length && console.log(`\n${title} (${items.length}):\n  ${items.join("\n  ")}`);
  console.log(`XWA points ${points.label}: ${dryRun ? "would add" : "added"} ${newPilots.length} pilots and ${newUpgrades.length} upgrades ` +
    `(${loadout.cards.size} standard-loadout-only) in ${files.length} files.`);
  list("New ship files, for ships this data set had only for other factions", data.newShipFiles.map(s => s.file));
  list("XWA upgrade IDs that are existing cards under another ID, not added", otherIds);
  list("Cards with no ability or flavor text in YASB", report.noText);
  list("Pilots with Force but no known Force side (left without one)", report.noForceSide);
  list("Pilot slots where XWA and YASB disagree (XWA's are used)", report.slotDifferences);
  list("Dial changes, kept only in the card text", report.dialChanges);
  list("Upgrade effects not converted to grants", report.partialGrants);
  list("Cards using the Mission Point icon, which no other card here uses", report.reviewIcons);
}

if (require.main === module) main();

module.exports = { convertActions, convertAttack, convertText, loadYasb };
