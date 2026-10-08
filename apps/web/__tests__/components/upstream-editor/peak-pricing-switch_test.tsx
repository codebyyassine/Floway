import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
import {
  createBody,
  previewRecord,
  updateBody,
  valuesFromRecord,
  type UpstreamEditorValues,
} from '../../../src/components/upstream-editor/data';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const label = (): string => i18n.t('dashboard.upstreamEditor.peakPricing.label');

const customRecord = (blockPeakPricedModels?: boolean): UpstreamRecord => upstreamRecord('up_1', {
  kind: 'custom',
  ...(blockPeakPricedModels === undefined ? {} : { block_peak_priced_models: blockPeakPricedModels }),
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'none',
    ingressHeadersRules: [],
    endpoints: { openaiChatCompletions: {} },
    modelsFetch: { enabled: false },
    models: [],
  },
  state: null,
});

const renderSidebar = (record: UpstreamRecord) => {
  const Harness = () => {
    const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
    return (
      <FormProvider {...form}>
        <UpstreamConfigSidebar
          catalogAvailable={false}
          discovered={[]}
          onPatch={vi.fn()}
          onRefreshModels={vi.fn()}
          proxies={[]}
          record={record}
          runtime={{ kind: 'node', runtimeLocation: 'TEST' }}
        />
      </FormProvider>
    );
  };
  return renderInApp(<Harness />);
};

describe('peak pricing switch', () => {
  it('opens on, off, and absent record values', () => {
    expect(valuesFromRecord(customRecord(true)).blockPeakPricedModels).toBe(true);
    expect(valuesFromRecord(customRecord(false)).blockPeakPricedModels).toBe(false);
  });

  it('carries the switch through preview, create, and update bodies', () => {
    const record = customRecord(false);
    const values = { ...valuesFromRecord(record), blockPeakPricedModels: true };
    expect(previewRecord(record, values).block_peak_priced_models).toBe(true);
    expect((createBody(record, values) as { block_peak_priced_models: boolean }).block_peak_priced_models).toBe(true);
    expect((updateBody(record, values) as { block_peak_priced_models: boolean }).block_peak_priced_models).toBe(true);
  });

  it('renders the switch checked from the stored record and toggles', () => {
    const { unmount } = renderSidebar(customRecord(true));
    const on = screen.getByRole('switch', { name: label() }) as HTMLInputElement;
    expect(on.checked).toBe(true);
    fireEvent.click(on);
    expect((screen.getByRole('switch', { name: label() }) as HTMLInputElement).checked).toBe(false);
    unmount();
  });

  it('renders the switch unchecked when the record leaves it off', () => {
    renderSidebar(customRecord(false));
    expect((screen.getByRole('switch', { name: label() }) as HTMLInputElement).checked).toBe(false);
  });

  it('hides the DeepSeek peak switch on a Codex upstream without a stored opt-in', () => {
    const codexRecord = upstreamRecord('up_codex', {
      kind: 'codex',
      config: { accounts: [] },
      state: { accounts: [] },
    } as unknown as Parameters<typeof upstreamRecord>[1]);
    renderSidebar(codexRecord);
    expect(screen.queryByRole('switch', { name: label() })).toBeNull();
  });
});
