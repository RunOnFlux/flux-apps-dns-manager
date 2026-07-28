// Turn the network's raw spec documents into the set of apps this service writes
// DNS for. Deserialize, open the sealed ones, resolve, and ask the selector.
//
// One spec cannot take down the sweep. A spec that fails to deserialize, decrypt
// or resolve is logged and skipped, because the alternative is that a single
// malformed or undecryptable app stops DNS being maintained for every other one.
const log = require('../lib/log');
const specLibs = require('./specLibs');
const selector = require('./appSelector');

/**
 * Read one spec document into its selection, or null if this service does not
 * serve it.
 *
 * @param {Object} doc a wire-form spec document, any version, sealed or not
 * @param {{ gameTypes: string[] }} opts
 * @returns {Promise<Object|null>}
 */
async function resolveOne(doc, { gameTypes }) {
  let spec = await specLibs.deserialize(doc);

  // Sealed specs carry their components — and therefore any declared DNS route —
  // inside the ciphertext, so an undecrypted one cannot be classified at all.
  // flux-spec dispatches to the version's registered provider.
  if (typeof spec.decrypt === 'function') {
    spec = await spec.decrypt();
  }

  const deployment = await specLibs.resolveDeployment(spec);
  const selection = selector.selectOne(deployment, doc.name, gameTypes);
  return selection;
}

/**
 * Read every spec document, keeping the ones this service serves.
 *
 * @param {Object[]} docs
 * @param {{ gameTypes: string[] }} opts
 * @returns {Promise<{ selections: Object[], skipped: number }>}
 */
async function resolveAll(docs, { gameTypes }) {
  const selections = [];
  let skipped = 0;

  // Sequential on purpose. Opening a sealed spec is a call to the decrypt service,
  // and a whole sweep of them issued at once would arrive as a burst.
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const selection = await resolveOne(doc, { gameTypes });
      if (selection) selections.push(selection);
    } catch (error) {
      skipped += 1;
      log.warn(`Could not read spec for ${doc && doc.name}: ${error.message}`);
    }
  }

  return { selections, skipped };
}

module.exports = { resolveOne, resolveAll };
