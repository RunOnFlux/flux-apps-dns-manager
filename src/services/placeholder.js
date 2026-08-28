// The answer a name gets before the platform has one of its own.
//
// A game app's name is public from the moment it is registered, but nothing can be
// published for it until FDM elects an instance - fifteen minutes later on the case
// this was written for. In between the name is not absent: the zone answers every
// lookup from its wildcard, a CNAME to an HAProxy director, at the zone's default TTL
// of an hour. The director carries no game traffic, so anyone who looks the name up
// early caches an address that will not work, and keeps it long after the real record
// exists.
//
// The placeholder is that same answer, republished under the app's own name at a TTL
// of a minute. It makes nothing reachable. It bounds how long a client that asked too
// early stays wrong, which is the whole defect.
//
// The director is not computed here. The zone already computes it - flux-pdns
// `scripts/app_routing.lua` maps the app name's first character, and production and
// staging divide the alphabet differently - so this asks the zone what it would answer
// and republishes that. Copying the answer instead of the rule means a change to the
// mapping, another director or a different split, is followed automatically with
// nothing here to keep in sync.
const dns = require('dns');
const log = require('../lib/log');

// One resolver per zone, built on first use. Each is pointed at the servers that are
// authoritative for that zone rather than at the box's own resolver: this is a
// question about what THIS zone answers, and the answer should not arrive by way of a
// cache we do not control.
const resolvers = new Map();

/**
 * @param {Object} zone - Zone config, including its placeholder block
 * @returns {dns.promises.Resolver}
 */
function resolverFor(zone) {
  let resolver = resolvers.get(zone.name);
  if (!resolver) {
    resolver = new dns.promises.Resolver({
      timeout: zone.placeholder.timeoutMs,
      tries: zone.placeholder.tries,
    });
    resolver.setServers(zone.placeholder.resolvers);
    resolvers.set(zone.name, resolver);
  }
  return resolver;
}

/**
 * PowerDNS refuses a CNAME target that is not fully qualified - it is rejected as
 * malformed rather than quietly read as relative to the zone - and a resolver returns
 * the target without its root label.
 * @param {string} name
 * @returns {string}
 */
function canonical(name) {
  return name.endsWith('.') ? name : `${name}.`;
}

/**
 * What the zone's wildcard would answer for this app's name.
 *
 * Only meaningful for a name that has no record of its own: an explicit record beats
 * the wildcard, so once anything is published this returns that instead. Callers
 * establish that the name is unpublished before asking.
 *
 * @param {string} appName - Application name
 * @param {Object} zone - Zone config
 * @returns {Promise<string|null>} The director, fully qualified, or null if the zone
 *   could not be asked or answered with something other than a CNAME
 */
async function wildcardAnswerFor(appName, zone) {
  const fqdn = `${appName}.${zone.name}`;
  try {
    const targets = await resolverFor(zone).resolveCname(fqdn);
    if (!targets || !targets.length) {
      log.warn(`No wildcard answer for ${fqdn}, nothing to stand in for it`);
      return null;
    }
    return canonical(targets[0]);
  } catch (error) {
    // Publishing nothing leaves today's behaviour exactly as it is, which is the right
    // way to fail: the placeholder is an improvement on the wildcard, not a repair the
    // name depends on. Warned rather than debugged because the service runs without
    // DEBUG, and this is the one line that distinguishes "the fix did nothing because
    // it had nothing to do" from "the fix could not run" - which otherwise look
    // identical from outside.
    log.warn(`Could not ask ${zone.name} what it answers for ${fqdn}, not standing in: ${error.code || error.message}`);
    return null;
  }
}

module.exports = {
  wildcardAnswerFor,
  canonical,
};
