import { describe, expect, it } from 'vitest';

import { parseOpencodeZenUpstreamConfig } from '@floway-dev/provider-opencode-zen';

describe('opencode baseUrl defaulting', () => {
  it('resolves the vendor endpoint when the operator supplies only an API key', () => {
    expect(parseOpencodeZenUpstreamConfig({ apiKey: 'k' }).baseUrl).toBe('https://opencode.ai/zen');
  });

  it('still honours an explicit base URL for a proxied deployment', () => {
    expect(parseOpencodeZenUpstreamConfig({ baseUrl: 'https://proxy.example/zen', apiKey: 'k' }).baseUrl)
      .toBe('https://proxy.example/zen');
  });

  it('rejects an empty base URL rather than silently defaulting', () => {
    expect(() => parseOpencodeZenUpstreamConfig({ baseUrl: '   ', apiKey: 'k' })).toThrow();
  });
});
