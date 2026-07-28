// Which apps this service writes DNS for, and what shape their record takes.
//
// Selection has two paths because pre-v9 apps must keep behaving exactly as they
// do now. A v9 owner declares a powerdns route and that declaration IS the
// request. Nothing older can declare one — every pre-v9 port resolves to a
// haproxy route — so those apps are recognised the way they always have been, by
// name and by replication marker.
//
// The service never asks what version a spec is. It asks whether the owner
// declared a DNS route, and failing that whether the app is one it has
// historically served. The second question has no v9 answer, so the legacy branch
// only ever shrinks and disappears with the last pre-v9 app.
const log = require('../lib/log');

// What a legacy app gets, matching what it gets today: a single address, and the
// zone's configured TTL rather than one the spec never carried.
const LEGACY_STRATEGY = 'failover';
const LEGACY_TTL = null;

/**
 * Does this app's name start with one of the historically DNS-routed prefixes?
 * Purely a product question — which apps we chose to route this way — so it lives
 * here rather than in the spec library.
 * @param {string} appName
 * @param {string[]} gameTypes
 * @returns {boolean}
 */
function nameWasHistoricallyRouted(appName, gameTypes) {
  const lower = String(appName || '').toLowerCase();
  return gameTypes.some((prefix) => lower.startsWith(String(prefix).toLowerCase()));
}

/**
 * Does any component replicate active-standby? flux-spec resolves this for every
 * version — the legacy `g:` marker included — so the marker is never parsed here.
 * @param {Object} deployment
 * @returns {boolean}
 */
function hasActiveStandby(deployment) {
  return Object.values(deployment.components || {})
    .some((component) => component.sync && component.sync.mode === 'activeStandby');
}

/**
 * Collapse an app's declared powerdns routes into the one answer a record can
 * carry.
 *
 * The record is `<app>.<zone>` — one name for the whole app — so several routes
 * describe the same name. That is fine while they agree: the addresses are the
 * app's node addresses either way, and DNS carries no port to tell the routes
 * apart. It is not fine when they disagree about how the name should resolve,
 * because there is no answer that satisfies both and picking one silently would
 * publish something the owner did not ask for.
 *
 * @param {Array} routes powerdns routes from the resolved deployment
 * @returns {{ strategy: string, ttl: number }|null} null when they conflict
 */
function collapseDeclaredRoutes(routes) {
  const distinct = new Map(routes.map(
    (route) => [`${route.strategy}:${route.ttl}`, { strategy: route.strategy, ttl: route.ttl }],
  ));
  if (distinct.size !== 1) return null;
  const [only] = distinct.values();
  return only;
}

/**
 * Decide whether one app is served, and how.
 *
 * @param {Object} deployment resolved deployment for a readable spec
 * @param {string} appName
 * @param {string[]} gameTypes historically DNS-routed name prefixes
 * @returns {{ appName: string, strategy: string, ttl: (number|null), source: string }|null}
 */
function selectOne(deployment, appName, gameTypes) {
  const declared = deployment.routes('powerdns');

  if (declared.length) {
    const collapsed = collapseDeclaredRoutes(declared);
    if (!collapsed) {
      log.error(
        `${appName} declares powerdns routes that disagree on how its name should `
        + 'resolve; one name cannot satisfy both, so it is not published',
      );
      return null;
    }
    return {
      appName, strategy: collapsed.strategy, ttl: collapsed.ttl, source: 'declared',
    };
  }

  // Nothing declared. An app is served the legacy way only if it is BOTH one of
  // the names we historically routed and actually replicated active-standby —
  // the same pair of conditions as today, so the same apps are selected.
  if (nameWasHistoricallyRouted(appName, gameTypes) && hasActiveStandby(deployment)) {
    return {
      appName, strategy: LEGACY_STRATEGY, ttl: LEGACY_TTL, source: 'legacy',
    };
  }

  return null;
}

module.exports = {
  selectOne,
  nameWasHistoricallyRouted,
  hasActiveStandby,
  collapseDeclaredRoutes,
  LEGACY_STRATEGY,
  LEGACY_TTL,
};
