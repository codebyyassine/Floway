import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

type OpencodeGoConfig = Extract<import('../../../src/api/types').UpstreamRecord, { kind: 'opencode-go' }>['config'];

// The address stands in for the gateway's: what is under test is that the field
// carries the record's own value and refuses an edit, not which address it is.
const ADDRESS = 'https://gateway.invalid/zen/go';

const record = (config: OpencodeGoConfig) =>
  upstreamRecord('', { name: 'OpenCode Go', kind: 'opencode-go', config, state: null });

const field = (key: string) => i18n.t(`dashboard.upstreamEditor.fields.${key}`);
const hint = (key: string) => i18n.t(`dashboard.upstreamEditor.opencodeGo.${key}`);

describe('OpenCode Go provider form', () => {
  it('states the gateway address itself and asks for the key alone', async () => {
    renderInApp(<ProviderConfigHarness record={record({ baseUrl: ADDRESS, models: [] })} />);
    await settle();

    const address = screen.getByRole<HTMLInputElement>('textbox', {
      name: field('baseUrl'),
      description: hint('baseUrlHint'),
    });
    expect(address.readOnly).toBe(true);
    expect(address.value).toBe(ADDRESS);

    // Nothing is left to fill in but the credential, so the label carries no
    // "optional" — that marker belongs to the kinds that work without a key.
    const key = screen.getByLabelText<HTMLInputElement>(field('apiKey'));
    expect(key.value).toBe('');
    expect(screen.queryByLabelText(`${field('apiKey')} (${i18n.t('dashboard.upstreamEditor.optional')})`)).toBeNull();
    expect(screen.getByText(hint('apiKeyHint'))).not.toBeNull();
  });

  it('keeps the stored-key advice ahead of the creation hint once a key exists', async () => {
    renderInApp(<ProviderConfigHarness record={record({ baseUrl: ADDRESS, apiKeySet: true, models: [] })} />);
    await settle();

    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.secretKeep'))).not.toBeNull();
    expect(screen.queryByText(hint('apiKeyHint'))).toBeNull();
  });
});
