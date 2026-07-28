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
  //
  // The provider is asked for and passed in rather than left implicit: registering
  // one against the version's class makes it available to be built, not applied on
  // its own. The opened result is handed to the resolver as-is, which accepts it
  // directly and saves re-serializing a document only to parse it straight back.
  if (typeof spec.createProvider === 'function') {
    const provider = await spec.createProvider();
    spec = await spec.decrypt(provider);
  }

  const deployment = await specLibs.resolveDeployment(spec);
  const selection = selector.selectOne(deployment, doc.name, gameTypes);
  return selection;
}

/**
 * Read every spec document, keeping the ones this service serves.
 *
 * `unreadable` names the apps whose spec could not be read this sweep. They are
 * reported separately from the ones we simply do not serve, because the two mean
 * different things to the caller: an app we read and did not select is genuinely
 * not ours, while an app we could not read tells us nothing at all. Treating the
 * second as absent would let a decrypt outage age out every sealed app's records.
 *
 * @param {Object[]} docs
 * @param {{ gameTypes: string[] }} opts
 * @returns {Promise<{ selections: Object[], unreadable: string[] }>}
 */
async function resolveAll(docs, { gameTypes }) {
  const selections = [];
  const unreadable = [];

  // Sequential on purpose. Opening a sealed spec is a call to the decrypt service,
  // and a whole sweep of them issued at once would arrive as a burst.
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const selection = await resolveOne(doc, { gameTypes });
      if (selection) selections.push(selection);
    } catch (error) {
      if (doc && doc.name) unreadable.push(doc.name);
      log.warn(`Could not read spec for ${doc && doc.name}: ${error.message}`);
    }
  }

  return { selections, unreadable };
}

module.exports = { resolveOne, resolveAll };
