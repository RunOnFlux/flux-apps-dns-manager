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
 * - ark (Ark: Survival Evolved)
 * - Valheim
 * - palworld
 * - enshrouded
 * - satisfactory
 * - conan (Conan Exiles)
 * - sevendays (7 Days to Die)
 */

const gameTypes = [
  'minecraft',
  'palworld',
  'enshrouded',
  'rustserver', // More specific than 'rust' to avoid matching rustdesk/rustpad
  'ark',
  'valheim',
  'terraria',
  'satisfactory',
  'conan',
  'sevendays',
  'teamspeak'
];

module.exports = {
  gameTypes,
};
