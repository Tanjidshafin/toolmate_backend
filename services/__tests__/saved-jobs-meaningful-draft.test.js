const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { computeSaveReadiness } = require('../saved-jobs-internal');

const fixturePath = path.join(__dirname, 'fixtures', 'save-readiness-cases.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('computeSaveReadiness (fixture parity)', () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.id}: ${testCase.description}`, async () => {
      const result = await computeSaveReadiness(testCase.sessionDoc, {
        messagesJobStorage: null,
        jobNameFromRequest: testCase.jobNameFromRequest,
      });
      assert.equal(
        result.ready,
        testCase.expectReady,
        `ready mismatch for ${testCase.id}: ${JSON.stringify(result.blockers)}`,
      );
    });
  }
});
