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
];

module.exports = {
  gameTypes,
};
