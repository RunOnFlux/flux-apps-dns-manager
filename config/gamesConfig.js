// Game types configuration
// Games that should use direct DNS routing (bypass HAProxy for player traffic)
// ONLY applies to G mode apps (apps with g: in containerData)
// App names are matched case-insensitively with prefix matching

/**
 * Games Matched by this Configuration (based on current Flux network data):
 *
 * Minecraft-related:
 * - Minecraft, MinecraftBedrock, minecraftflux, MinecraftPurePwnage
 * - MinecraftServer* (various instances)
 *
 * Rust-related (game servers only):
 * - Rust, rustserver, rustserverNA
 * - Note: RustDesk and rustpad are excluded as they're not games
 *
 * Terraria-related:
 * - terraria, terrariaflux
 *
 * Other supported games:
 * - arksurvivalascended (ARK: Survival Ascended)
 * - Valheim
 * - palworld
 * - enshrouded
 * - satisfactory
 * - conan (Conan Exiles)
 * - sevendays (7 Days to Die)
 * - armareforger (Arma Reforger)
 * - factorio (Factorio)
 * - tmodloader (tModLoader, modded Terraria)
 * - theisle (The Isle: Evrima)
 * - eurotrucksimulator2 / americantrucksimulator (SCS convoy servers)
 * - teamfortress2 (Team Fortress 2)
 * - arksurvivalevolved (ARK: Survival Evolved)
 * - abioticfactor (Abiotic Factor)
 * - scum (SCUM)
 * - theforest (The Forest)
 * - icarus (Icarus)
 * - killingfloor2 (Killing Floor 2)
 */

const gameTypes = [
  'minecraft',
  'palworld',
  'enshrouded',
  'rustserver', // More specific than 'rust' to avoid matching rustdesk/rustpad
  'valheim',
  'terraria',
  'satisfactory',
  'sevendays',
  'teamspeak',
  '7daystodie',
  'arksurvivalascended', // The marketplace app's full name; a bare 'ark' would also match any other app starting with ark (e.g. arkor)
  'barotrauma',
  'conanexiles',
  'corekeeper',
  'counterstrike',
  'dayz',
  'dontstarvetogether',
  'garrysmod',
  'projectzomboid',
  'sonsoftheforest',
  'spaceengineers',
  'unturned',
  'vrising',
  'windrose',
  'fivem',
  'dragonwilds',
  'hytale',
  'armareforger',
  'factorio',
  'tmodloader',
  'theisle',
  'eurotrucksimulator2',
  'americantrucksimulator',
  'teamfortress2',
  'arksurvivalevolved', // Full name, like ASA: never a bare 'ark'
  'vintagestory',
  'soulmask',
  'beammp',
  'abioticfactor', // The marketplace app's full name (AbioticFactor): G-mode, so its domain needs this prefix
  'scum', // The marketplace app's name (Scum): G-mode, so its domain needs this prefix. Checked 2026-10-29: no other deployed app starts with it
  'theforest', // The marketplace app's name (TheForest): G-mode, so its domain needs this prefix. 'sonsoftheforest' above does not cover it (startsWith)
  'icarus', // The marketplace app's name (Icarus): G-mode, so its domain needs this prefix. Checked 2026-10-29: no marketplace app and no deployed app (2281 global specs) starts with it
  'killingfloor2', // The marketplace app's name (KillingFloor2): G-mode, so its domain needs this prefix. The prefix is the APP NAME ('kf2' would not match: startsWith). Checked 2026-10-29: no app named like it on the marketplace (prod and dev)
];

module.exports = {
  gameTypes,
};
