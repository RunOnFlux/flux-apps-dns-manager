// This service's single touch-point for flux-spec. flux-spec is ESM;
// @runonflux/flux-spec-cjs bridges it for CommonJS, so only these helpers are async
// and the rest of the service stays synchronous.
//
// Specs arrive already-registered from the network API, so we `deserialize` rather
// than `fromSubmission` — the latter additionally rejects fields no longer accepted
// on new submissions, which is wrong for data that was valid when it was registered.
const { load } = require('@runonflux/flux-spec-cjs');

// Used solely for mount path resolution. This service writes DNS records and never
// runs containers, so it reads only load balancing and host ports off the resolved
// deployment, never mounts — the folder is a placeholder.
const APPS_FOLDER = '/var/lib/flux-apps-dns-manager/placeholder';

/**
 * Deserialize a wire-form spec document (any version v1-v9, cleartext or encrypted)
 * into its flux-spec instance. Callers branch on the sealed predicate below rather
 * than inspecting version fields.
 * @param {Object} doc
 * @returns {Promise<Object>}
 */
async function deserialize(doc) {
  const { deserializeSpec } = await load();
  const spec = await deserializeSpec(doc);
  return spec;
}

/**
 * Whether a wire-form spec document is sealed — encrypted and unreadable until
 * decrypted — for any version (v8 enterprise blob or v9 encrypted envelope). Uses
 * the classes' own wire predicates, so no full deserialize is needed.
 * @param {Object} doc
 * @returns {Promise<boolean>}
 */
async function isSealed(doc) {
  const { EncryptedSpecV8, EncryptedSpecV9 } = await load();
  return Boolean(EncryptedSpecV8.matchesWire(doc) || EncryptedSpecV9.matchesWire(doc));
}

/**
 * Resolve a readable spec into its runtime projection: version-normalized to one
 * shape, with ports x loadBalancing merged. Every version answers the same
 * questions through this, which is what lets the record-writing path stay free of
 * version checks.
 * @param {Object} spec a readable spec (or decrypted canonical spec)
 * @param {string|null} [replica]
 * @returns {Promise<Object>} DeploymentSpec
 */
async function resolveDeployment(spec, replica = null) {
  const { DeploymentSpec } = await load();
  const deployment = await DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica });
  return deployment;
}

module.exports = {
  load, deserialize, isSealed, resolveDeployment, APPS_FOLDER,
};
