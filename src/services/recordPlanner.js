// What to publish for a selected app, given what the platform currently believes
// about where it is. Pure: no I/O, so the rules below are decidable on their own.
//
// The two strategies differ only in how many answers come back. Neither adds a
// health opinion — this service publishes what the platform believes is placed and
// does not form one of its own.

/**
 * Strip the port and any IPv6 brackets from a socket address. Locations arrive as
 * `ip:port` because the API port varies per node; a record carries the address
 * alone.
 * @param {string} address
 * @returns {string}
 */
function bareAddress(address) {
  const [host] = String(address).split(':');
  return host.replace(/\[|\]/g, '');
}

/**
 * Deduplicate while preserving order, so a repeated location cannot inflate an
 * RRset and the record content is stable between cycles that saw the same set.
 * @param {string[]} addresses
 * @returns {string[]}
 */
function distinct(addresses) {
  return [...new Set(addresses)];
}

/**
 * Plan the record for one selected app.
 *
 * Returning null means "publish nothing this cycle" and is NOT an instruction to
 * remove anything. Withdrawing a record does not make the name stop resolving —
 * the zone answers from its wildcard instead, handing clients a proxy address
 * they cannot use, at a TTL far longer than the record's own. A stale address is
 * a better answer than a confidently wrong one, and it corrects itself as soon as
 * the platform reports anywhere to point.
 *
 * @param {{ appName: string, strategy: string, ttl: (number|null) }} selection
 * @param {{ elected: (string|null), placed: string[] }} state
 *   elected — the instance the platform chose for a single-answer app
 *   placed  — every location the app is currently installed on
 * @param {{ zoneTtl: number }} zone
 * @returns {{ appName: string, contents: string[], ttl: number }|null}
 */
function planRecord(selection, state, zone) {
  const { appName, strategy } = selection;
  const ttl = selection.ttl === null || selection.ttl === undefined
    ? zone.ttl
    : selection.ttl;

  let contents;
  if (strategy === 'roundRobin') {
    contents = distinct((state.placed || []).map(bareAddress).filter(Boolean));
  } else {
    // Single answer. It must be the instance the platform elected, not merely one
    // that is placed: for an app replicating active-standby the container runs on
    // the elected node alone, so any other address names a stopped container.
    contents = state.elected ? [bareAddress(state.elected)] : [];
  }

  if (!contents.length) return null;
  return { appName, contents, ttl };
}

module.exports = { planRecord, bareAddress, distinct };
