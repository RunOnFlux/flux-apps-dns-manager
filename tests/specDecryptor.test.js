// The retry policy for fetching an app's decrypt key.
//
// Three outcomes have to stay distinct, and only one of them is visible in the happy
// path: a key ends the loop, a refusal ends it too - asking again cannot change a
// rejection - and everything else is "not available yet", which must keep trying. The
// third collapsing into the second would drop an enterprise app on one bad response.
const { expect } = require('chai');
const { requestAesKey } = require('../src/services/specDecryptor');

function clientReturning(response) {
  return { post: async () => response };
}

describe('asking the decrypt service for a key', () => {
  it('returns the key when the service answers with one', async () => {
    const outcome = await requestAesKey(clientReturning({ status: 200, data: { status: 'ok', message: 'a-key' } }), 'app', {});

    expect(outcome).to.deep.equal({ key: 'a-key', retry: false });
  });

  it('gives up when the service rejects the request', async () => {
    // A rejection is an answer. Retrying it would burn the whole budget on a decision
    // that has already been made.
    const outcome = await requestAesKey(clientReturning({ status: 200, data: { status: 'denied' } }), 'app', {});

    expect(outcome).to.deep.equal({ key: null, retry: false });
  });

  it('retries when the call itself fails', async () => {
    const outcome = await requestAesKey({ post: async () => { throw new Error('connect ECONNREFUSED'); } }, 'app', {});

    expect(outcome).to.deep.equal({ key: null, retry: true });
  });

  it('retries on a non-200', async () => {
    const outcome = await requestAesKey(clientReturning({ status: 503, data: {} }), 'app', {});

    expect(outcome).to.deep.equal({ key: null, retry: true });
  });

  it('retries when the service says ok but sends no key', async () => {
    const outcome = await requestAesKey(clientReturning({ status: 200, data: { status: 'ok', message: '' } }), 'app', {});

    expect(outcome).to.deep.equal({ key: null, retry: true });
  });
});
