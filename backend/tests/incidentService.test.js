'use strict';

const { resolvedRunbookUrl } = require('../services/incidentService');

describe('resolvedRunbookUrl', () => {
  const originalBaseUrl = process.env.RUNBOOK_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.RUNBOOK_BASE_URL;
    } else {
      process.env.RUNBOOK_BASE_URL = originalBaseUrl;
    }
  });

  it('defaults to this repository and the SEV1 runbook filename', () => {
    delete process.env.RUNBOOK_BASE_URL;

    const url = resolvedRunbookUrl('SEV1');

    expect(url).toContain('TrustFi-Protocol/trustchain-escrow');
    expect(url).toContain('docs/incidents/runbooks');
    expect(url).toContain('sev1-critical-outage.md');
    expect(url).not.toContain('your-org');
  });

  it('maps SEV1 through SEV4 to the existing runbook filenames', () => {
    delete process.env.RUNBOOK_BASE_URL;

    expect(resolvedRunbookUrl('SEV1')).toContain('sev1-critical-outage.md');
    expect(resolvedRunbookUrl('SEV2')).toContain('sev2-major-degradation.md');
    expect(resolvedRunbookUrl('SEV3')).toContain('sev3-minor-issue.md');
    expect(resolvedRunbookUrl('SEV4')).toContain('sev4-cosmetic.md');
  });

  it('honors an explicit RUNBOOK_BASE_URL override', () => {
    process.env.RUNBOOK_BASE_URL = 'https://example.com/custom-runbooks';

    const url = resolvedRunbookUrl('SEV1');

    expect(url).toContain('https://example.com/custom-runbooks');
    expect(url).toContain('sev1-critical-outage.md');
    expect(url).not.toContain('TrustFi-Protocol/trustchain-escrow');
  });
});
