import { describe, expect, it } from 'vitest';

import { parseOpencodeGoUpstreamConfig } from '@floway-dev/provider-opencode-go';

describe('opencode-go baseUrl defaulting', () => {
  it('resolves the vendor endpoint when the operator supplies only an API key', () => {
    expect(parseOpencodeGoUpstreamConfig({ apiKey: 'k' }).baseUrl).toBe('https://opencode.ai/zen/go');
  });

  it('still honours an explicit base URL for a proxied deployment', () => {
    expect(parseOpencodeGoUpstreamConfig({ baseUrl: 'https://proxy.example/go', apiKey: 'k' }).baseUrl)
      .toBe('https://proxy.example/go');
  });

  it('rejects an empty base URL rather than silently defaulting', () => {
    expect(() => parseOpencodeGoUpstreamConfig({ baseUrl: '   ', apiKey: 'k' })).toThrow();
  });
});
