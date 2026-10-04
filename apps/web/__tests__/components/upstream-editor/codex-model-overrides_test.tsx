import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { hasUnsavedCredentials, valuesFromRecord, type UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: apiMocks.patch } } } },
  callApi: (operation: () => unknown) => operation(),
}));
vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ record, onPatch }: {
    record: UpstreamRecord;
    onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  }) => {
    const { watch } = useFormContext<UpstreamEditorValues>();
    const importedConfig = { ...record.config, accounts: [{ email: 'imported@example.com', chatgptAccountId: null, chatgptUserId: null, planType: null }] };
    return <>
      <output data-testid="config">{JSON.stringify(watch('config'))}</output>
      <button type="button" onClick={() => onPatch({ config: importedConfig, state: { accounts: [] } }, true)}>Import credential</button>
      <button type="button" onClick={() => onPatch({ state: { accounts: [] } }, true)}>Probe quota</button>
    </>;
  },
}));
const defaults = {
  kind: 'chat' as const, endpoints: { openaiResponses: {} }, upstreamModelId: 'gpt-a', publicModelId: 'gpt-a',
  limits: { max_context_window_tokens: 872_000 },
  chat: { modalities: { input: ['text', 'image'] as const, output: ['text'] as const }, image_detail_original: true, reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } },
};
const record = upstreamRecord('up_codex', { kind: 'codex', config: { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }] }, state: { accounts: [] } });
const label = (key: string) => i18n.t(`dashboard.upstreamEditor.models.${key}`);
const save = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
const config = () => JSON.parse(screen.getByTestId('config').textContent!);

function renderPage(source: UpstreamRecord = record, maximum = defaults.limits.max_context_window_tokens) {
  const rawDefaults = { ...defaults, limits: { max_context_window_tokens: maximum } };
  const override = source.kind === 'codex' ? source.config.modelOverrides?.['gpt-a'] : undefined;
  const discovered = [{ ...rawDefaults, limits: { ...rawDefaults.limits, ...override?.limits }, codexDefaults: rawDefaults, codexOperationalContextWindow: 272_000 }];
  const router = createMemoryRouter([
    { path: '/editor', element: <OutcomeToastProvider><UpstreamEditorPage data={{ mode: 'edit', record: source, discovered, proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } }} /></OutcomeToastProvider> },
    { path: '/dashboard/providers/upstreams', element: <div>Upstream list</div> },
  ], { initialEntries: ['/editor?model=gpt-a'] });
  return renderInApp(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.patch.mockImplementation(async ({ json }: { json: { config: { modelOverrides: unknown } } }) => ({ data: { ...record, config: { ...record.config, ...json.config } }, error: null }));
});

test('saves only selected overrides, preserves false, and reopens with inherited defaults', async () => {
  const view = renderPage();
  fireEvent.change(screen.getByRole('textbox', { name: label('advertisedContextWindow') }), { target: { value: '300000' } });
  fireEvent.change(screen.getByRole('textbox', { name: label('outputTokens') }), { target: { value: '32000' } });
  fireEvent.click(screen.getByRole('combobox', { name: label('imageDetailOriginal') }));
  fireEvent.click(screen.getByRole('option', { name: i18n.t('common.off') }));
  save();
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledWith({ param: { id: 'up_codex' }, json: expect.objectContaining({ config: { modelOverrides: { 'gpt-a': { limits: { max_context_window_tokens: 300000, max_output_tokens: 32000 }, imageDetailOriginal: false } } } }) }));
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.unsavedCredential'))).toBeNull();
  const saved = config();
  view.unmount();
  renderPage({ ...record, config: saved } as UpstreamRecord);
  expect((screen.getByRole('textbox', { name: label('outputTokens') }) as HTMLInputElement).value).toBe('32000');
  expect(screen.getByRole('combobox', { name: label('imageDetailOriginal') }).textContent).toContain(i18n.t('common.off'));
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.overrideInherited', { value: 'Not reported' }))).toBeTruthy();
});

test.each([872_000, 1_048_576])('context inheritance uses raw advertised maximum %s, not the operational default or saved override', async maximum => {
  const source = { ...record, config: { ...record.config, modelOverrides: { 'gpt-a': { limits: { max_context_window_tokens: 999999, max_output_tokens: 32000 } }, 'gpt-b': { imageInput: false } } } } as UpstreamRecord;
  const view = renderPage(source, maximum);
  const context = screen.getByRole('textbox', { name: label('advertisedContextWindow') }) as HTMLInputElement;
  expect(context.value).toBe('999999');
  expect(context.placeholder).toBe(String(maximum));
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.codexOperationalContext', { value: 272000 }))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.overrideResetField', { field: label('advertisedContextWindow') }) }));
  expect(context.value).toBe('');
  expect(screen.getByRole('textbox', { name: label('advertisedContextWindow'), description: i18n.t('dashboard.upstreamEditor.models.overrideInherited', { value: String(maximum) }) })).toBe(context);
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(config().modelOverrides).toEqual({ 'gpt-a': { limits: { max_output_tokens: 32000 } }, 'gpt-b': { imageInput: false } });
  save();
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledOnce());
  const saved = config();
  view.unmount();
  renderPage({ ...record, config: saved } as UpstreamRecord, maximum);
  expect((screen.getByRole('textbox', { name: label('advertisedContextWindow') }) as HTMLInputElement).placeholder).toBe(String(maximum));
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.models.overrideInherited', { value: '272000' }))).toBeNull();
});

test.each(['0', '-1', '1.5', 'abc', '100000001'])('invalid numeric draft %s cannot save or corrupt prior overrides', async raw => {
  renderPage();
  fireEvent.change(screen.getByRole('textbox', { name: label('outputTokens') }), { target: { value: raw } });
  expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.overrideNumberInvalid', { max: 100_000_000 }))).toBeTruthy();
  save();
  expect(await screen.findByText(label('overrideInvalid'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.overrideResetField', { field: label('outputTokens') }) }));
  save();
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledOnce());
});

test.each(['edit', 'reset', 'clean', 'absent'] as const)('credential imports preserve %s overrides against the stored baseline', async action => {
  const storedOverrides = { 'gpt-a': { limits: { max_output_tokens: 32000 } } };
  renderPage(action === 'absent' ? record : { ...record, config: { ...record.config, modelOverrides: storedOverrides } } as UpstreamRecord);
  if (action === 'edit') fireEvent.change(screen.getByRole('textbox', { name: label('outputTokens') }), { target: { value: '64000' } });
  if (action === 'reset') fireEvent.click(screen.getByRole('button', { name: label('overrideResetModel') }));
  const expected = action === 'absent' ? undefined : action === 'clean' ? storedOverrides : action === 'reset' ? {} : { 'gpt-a': { limits: { max_output_tokens: 64000 } } };

  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: 'Probe quota' }));

  expect(config().modelOverrides).toEqual(expected);
  expect(config().accounts[0].email).toBe('imported@example.com');
  expect(apiMocks.patch).not.toHaveBeenCalled();
  await waitFor(() => expect(Boolean(screen.queryByText(i18n.t('dashboard.upstreamEditor.unsaved')))).toBe(action === 'edit' || action === 'reset'));
  if (action === 'clean' || action === 'absent') {
    expect((screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }) as HTMLButtonElement).disabled).toBe(true);
    save();
    expect(apiMocks.patch).not.toHaveBeenCalled();
  } else {
    save();
    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledWith({
      param: { id: 'up_codex' }, json: expect.objectContaining({ config: { modelOverrides: expected ?? {} } }),
    }));
  }
  expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.fetchDirty.unsavedCredential'))).toBeNull();
});

test('imported credentials with reordered account keys allow saving an override draft', () => {
  const imported = {
    ...record,
    config: { accounts: [{ chatgptAccountId: 'account', email: 'imported@example.com', chatgptUserId: 'user', planType: 'plus' }] },
  } as UpstreamRecord;
  const values = valuesFromRecord(imported);
  values.config = {
    accounts: [{ chatgptAccountId: 'account', chatgptUserId: 'user', email: 'imported@example.com', planType: 'plus' }],
    modelOverrides: { 'gpt-a': { limits: { max_output_tokens: 64000 } } },
  };
  expect(hasUnsavedCredentials(imported, values)).toBe(false);
  values.config.accounts[0]!.email = 'changed@example.com';
  expect(hasUnsavedCredentials(imported, values)).toBe(true);
});

test('field and model reset preserve other models and are only persisted on save', async () => {
  renderPage({ ...record, config: { ...record.config, modelOverrides: { 'gpt-a': { limits: { max_context_window_tokens: 300000, max_output_tokens: 32000 }, imageInput: false }, 'gpt-b': { imageInput: true } } } } as UpstreamRecord);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.overrideResetField', { field: label('advertisedContextWindow') }) }));
  expect(config().modelOverrides['gpt-a']).toEqual({ limits: { max_output_tokens: 32000 }, imageInput: false });
  expect(apiMocks.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: label('overrideResetModel') }));
  expect(config().modelOverrides).toEqual({ 'gpt-b': { imageInput: true } });
  save();
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledOnce());
});
