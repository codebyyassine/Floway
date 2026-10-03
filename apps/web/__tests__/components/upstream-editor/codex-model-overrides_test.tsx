import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
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
  UpstreamConfigSidebar: () => {
    const { watch } = useFormContext<UpstreamEditorValues>();
    return <output data-testid="config">{JSON.stringify(watch('config'))}</output>;
  },
}));
const defaults = {
  kind: 'chat' as const, endpoints: { openaiResponses: {} }, upstreamModelId: 'gpt-a', publicModelId: 'gpt-a',
  limits: { max_context_window_tokens: 200_000 },
  chat: { modalities: { input: ['text', 'image'] as const, output: ['text'] as const }, image_detail_original: true, reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } },
};
const record = upstreamRecord('up_codex', { kind: 'codex', config: { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }] }, state: { accounts: [] } });
const label = (key: string) => i18n.t(`dashboard.upstreamEditor.models.${key}`);
const save = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.actions.save') }));
const config = () => JSON.parse(screen.getByTestId('config').textContent!);

function renderPage(source: UpstreamRecord = record) {
  const router = createMemoryRouter([
    { path: '/editor', element: <OutcomeToastProvider><UpstreamEditorPage data={{ mode: 'edit', record: source, discovered: [{ ...defaults, codexDefaults: defaults } as typeof defaults], proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } }} /></OutcomeToastProvider> },
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
  fireEvent.change(screen.getByRole('textbox', { name: label('contextWindow') }), { target: { value: '300000' } });
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

test('field and model reset preserve other models and are only persisted on save', async () => {
  renderPage({ ...record, config: { ...record.config, modelOverrides: { 'gpt-a': { limits: { max_context_window_tokens: 300000, max_output_tokens: 32000 }, imageInput: false }, 'gpt-b': { imageInput: true } } } } as UpstreamRecord);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.overrideResetField', { field: label('contextWindow') }) }));
  expect(config().modelOverrides['gpt-a']).toEqual({ limits: { max_output_tokens: 32000 }, imageInput: false });
  expect(apiMocks.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: label('overrideResetModel') }));
  expect(config().modelOverrides).toEqual({ 'gpt-b': { imageInput: true } });
  save();
  await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledOnce());
});
