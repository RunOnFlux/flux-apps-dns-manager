const { expect } = require('chai');
const { planRecord, bareAddress } = require('../src/services/recordPlanner');

const ZONE = { ttl: 300 };

const failover = (ttl = null) => ({ appName: 'app', strategy: 'failover', ttl });
const roundRobin = (ttl = null) => ({ appName: 'app', strategy: 'roundRobin', ttl });

describe('recordPlanner', () => {
  describe('failover', () => {
    it('publishes the elected instance alone', () => {
      const plan = planRecord(failover(), {
        elected: '1.2.3.4:16127',
        placed: ['1.2.3.4:16127', '5.6.7.8:16137'],
      }, ZONE);
      expect(plan.contents).to.deep.equal(['1.2.3.4']);
    });

    // Placement is where the app is installed; for an active-standby app the
    // container runs on the elected node only, so a placed-but-unelected address
    // names a container the platform deliberately stopped.
    it('does not fall back to a placed instance when none is elected', () => {
      const plan = planRecord(failover(), {
        elected: null,
        placed: ['1.2.3.4:16127', '5.6.7.8:16137'],
      }, ZONE);
      expect(plan).to.equal(null);
    });
  });

  describe('roundRobin', () => {
    it('publishes every placed instance', () => {
      const plan = planRecord(roundRobin(), {
        elected: null,
        placed: ['1.2.3.4:16127', '5.6.7.8:16137', '9.9.9.9:16187'],
      }, ZONE);
      expect(plan.contents).to.deep.equal(['1.2.3.4', '5.6.7.8', '9.9.9.9']);
    });

    it('collapses a repeated location rather than inflating the answer', () => {
      const plan = planRecord(roundRobin(), {
        elected: null,
        placed: ['1.2.3.4:16127', '1.2.3.4:16127'],
      }, ZONE);
      expect(plan.contents).to.deep.equal(['1.2.3.4']);
    });
  });

  describe('nothing to publish', () => {
    // The whole point of the null: it means "leave what is there". Withdrawing
    // hands the name to the zone wildcard, which answers with a proxy address the
    // client cannot use and caches far longer than the record would have.
    it('plans nothing rather than an empty record when no address is known', () => {
      expect(planRecord(roundRobin(), { elected: null, placed: [] }, ZONE)).to.equal(null);
      expect(planRecord(failover(), { elected: null, placed: [] }, ZONE)).to.equal(null);
    });
  });

  describe('ttl', () => {
    it('takes the zone default when the app declared none', () => {
      const plan = planRecord(failover(null), { elected: '1.2.3.4', placed: [] }, ZONE);
      expect(plan.ttl).to.equal(300);
    });

    it('takes the declared value when the app has one', () => {
      const plan = planRecord(failover(60), { elected: '1.2.3.4', placed: [] }, ZONE);
      expect(plan.ttl).to.equal(60);
    });
  });

  describe('address shapes', () => {
    it('drops the api port a location carries', () => {
      expect(bareAddress('1.2.3.4:16187')).to.equal('1.2.3.4');
    });

    it('leaves a bare address alone', () => {
      expect(bareAddress('1.2.3.4')).to.equal('1.2.3.4');
    });
  });
});
