import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { forwardRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { copyToClipboard } from '../../../src/components/ui/copy-to-clipboard';
import type { ModelListingFailure, UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamWorkspace, type ModelsYamlDraft } from '../../../src/components/upstream-editor/workspace';
import { MODEL_ERROR_EDITOR_LENGTH, modelErrorExcerpt } from '../../../src/components/upstreams/model-error';
import { i18n } from '../../../src/i18n';
import { winuiCheckedAttribute } from '../../../src/winui/appearance';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { UpstreamChatModelConfig, UpstreamModelConfig } from '@floway-dev/provider/model-config';

vi.mock('../../../src/components/upstream-editor/models-yaml-editor', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea aria-label="YAML models" onChange={event => onChange(event.target.value)} value={value} />
  ),
}));

vi.mock('../../../src/components/ui/scroll-area', () => ({
  ScrollArea: forwardRef<HTMLDivElement, PropsWithChildren>(({ children }, ref) => <div ref={ref}>{children}</div>),
}));

vi.mock('../../../src/components/ui/copy-to-clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

const model = (id: string, chat?: UpstreamChatModelConfig) => ({
  upstreamModelId: id,
  publicModelId: id,
  display_name: id,
  kind: 'chat' as const,
  endpoints: { openaiResponses: {} },
  ...(chat ? { chat } : {}),
});

const record = upstreamRecord('up_test', {
  name: 'Test',
  kind: 'custom',
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [model('model-a'), model('model-b')],
  },
  state: null,
});
if (record.kind !== 'custom') throw new Error('test fixture must be a custom upstream');

function Harness({ discovered = [], modelsError = null, probe = false, source = record }: { discovered?: UpstreamModelConfig[]; modelsError?: ModelListingFailure | null; probe?: boolean; source?: UpstreamRecord }) {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(source) });
  const [modelsYamlDraft, setModelsYamlDraft] = useState<ModelsYamlDraft | null>(null);
  const watchedDisabled = useWatch({ control: form.control, name: 'disabledPublicModelIds' });
  const watchedManual = useWatch({ control: form.control, name: 'manualModels' });
  return (
    // The workspace reads which tab and which model it is on out of the search,
    // so it needs a router to read one from.
    <MemoryRouter>
      <FormProvider {...form}>
        <UpstreamWorkspace
          discovered={discovered}
          modelsYamlDraft={modelsYamlDraft}
          modelsLoading={false}
          modelsError={modelsError}
          onModelsYamlDraftChange={setModelsYamlDraft}
          onRefreshModels={vi.fn()}
          record={source}
        />
        {probe && <output data-testid="form-probe">{JSON.stringify({
          dirty: form.formState.isDirty,
          disabled: watchedDisabled,
          manual: watchedManual.map(item => item.upstreamModelId),
        })}</output>}
      </FormProvider>
    </MemoryRouter>
  );
}

// The subject here is the field array, not the wording. Resolving the queries
// through the resources keeps a copy edit from failing this suite as though the
// workspace had broken.
const models = (key: string) => i18n.t(`dashboard.upstreamEditor.models.${key}`);
// A row's delete command names the model it acts on, so the count queries match
// the command by its stem rather than by a whole label they would have to build
// a name for. A just-appended model has no name yet, and an accessible name is
// trimmed, so the stem is matched without its trailing separator.
const deleteCommandStem = i18n.t('dashboard.upstreamEditor.models.deleteNamed', { name: '\u0000' }).split('\u0000')[0]!.trimEnd();
const deleteCommands = () => screen.getAllByLabelText(new RegExp(`^${deleteCommandStem}`));

const selectNamed = (name: string) => i18n.t('dashboard.upstreamEditor.models.selectNamed', { name });
const selectAllBox = () => screen.getByRole<HTMLInputElement>('checkbox', { name: models('selectAll') });
const rowBox = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name: selectNamed(name) });
const selectionCount = (selected: number, count: number) =>
  screen.getByText(i18n.t('dashboard.upstreamEditor.models.bulkSelected', { count, selected }));
const enabledSwitch = (name: string) =>
  screen.getByRole<HTMLInputElement>('switch', { name: i18n.t('dashboard.upstreamEditor.models.enabledFor', { name }) });
// The bulk actions write through the form rather than into local state, so what
// they did is read back off the form the harness holds.
const formState = () => JSON.parse(screen.getByTestId('form-probe').textContent ?? '{}') as {
  dirty: boolean;
  disabled: string[];
  manual: string[];
};

describe('upstream model workspace field-array transitions', () => {
  const detailLabel = models('imageDetailOriginal');

  it('opens a newly added model in the detail editor', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: models('add') }));

    await waitFor(() => expect(table.isConnected).toBe(false));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBe(null);
    expect(screen.queryByText('Model ID, kind, endpoints, and rerank target must form a valid model configuration.')).toBe(null);
  });

  it('keeps the same focused input while a new model ID changes', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    const input = screen.getByRole('textbox', { name: models('upstreamId') });
    input.focus();
    fireEvent.change(input, { target: { value: 'm' } });

    await waitFor(() => expect(screen.queryByRole('table', { name: models('title') })).toBe(null));
    expect(table.isConnected).toBe(false);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'model-new' } });
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('model-new');
    fireEvent.blur(input);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
  });

  it('keeps temporarily duplicate IDs attached to separate rows while swapping them', async () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    const firstInput = screen.getByRole('textbox', { name: models('upstreamId') });
    fireEvent.change(firstInput, { target: { value: 'model-b' } });
    fireEvent.blur(firstInput);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(firstInput);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    await screen.findByRole('table', { name: models('title') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-b' }) }));
    const secondInput = screen.getByRole('textbox', { name: models('upstreamId') });
    expect(secondInput).not.toBe(firstInput);
    fireEvent.change(secondInput, { target: { value: 'model-a' } });
    fireEvent.blur(secondInput);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(secondInput);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    await screen.findByRole('table', { name: models('title') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('model-b');
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-b' }) }));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('model-a');
  });

  it('reports a missing model ID only after it prevents returning to the list', async () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    expect(screen.queryByRole('alert')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    expect(screen.queryByRole('table', { name: models('title') })).toBe(null);
    expect(screen.getByText(models('upstreamIdRequired'))).toBeTruthy();
    const input = screen.getByRole('textbox', { name: models('upstreamId') });
    fireEvent.change(input, { target: { value: 'model-new' } });
    expect(screen.queryByText(models('upstreamIdRequired'))).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(screen.getByRole('table', { name: models('title') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: models('editAsYaml') }));
    const yaml = (await screen.findByLabelText('YAML models') as HTMLTextAreaElement).value;
    expect(yaml).toContain('upstreamModelId: model-new');
    expect(yaml).toContain('opaqueBlobCompatibilityScope:\n    bindToUpstream: true');
  });

  it('reports a missing endpoint at its section after a blocked return', () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    fireEvent.change(screen.getByRole('textbox', { name: models('upstreamId') }), { target: { value: 'model-new' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '/chat/completions' }));
    expect(screen.queryByRole('alert')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    expect(screen.queryByRole('table', { name: models('title') })).toBe(null);
    expect(screen.getByText(models('endpointsRequired'))).toBeTruthy();
  });

  it('returns from a model detail to the model list', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    await waitFor(() => expect(table.isConnected).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(await screen.findByRole('table', { name: models('title') })).toBeTruthy();
  });

  it('edits and serializes a manual model opaque blob compatibility scope', async () => {
    renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));

    const bindToUpstream = screen.getByRole<HTMLInputElement>('switch', { name: models('bindOpaqueBlobsToUpstream') });
    const key = screen.getByRole<HTMLInputElement>('textbox', { name: models('opaqueBlobCompatibilityKey') });
    expect(bindToUpstream.checked).toBe(true);
    expect(key.placeholder).toBe('model-a');

    const sectionHeading = screen.getByRole('heading', { name: models('opaqueBlobCompatibility') });
    const compatibilityInfo = sectionHeading.parentElement?.querySelector('button');
    expect(compatibilityInfo).toBeTruthy();
    fireEvent.click(compatibilityInfo!);
    expect(screen.getByText(/When routing history context across models/)).toBeTruthy();
    expect(screen.getByText(/Incompatible optional blobs are discarded/)).toBeTruthy();

    fireEvent.click(bindToUpstream);
    fireEvent.change(key, { target: { value: 'openai' } });
    expect(bindToUpstream.checked).toBe(false);
    expect(key.value).toBe('openai');

    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    fireEvent.click(await screen.findByRole('button', { name: models('editAsYaml') }));
    const yaml = (await screen.findByLabelText('YAML models') as HTMLTextAreaElement).value;
    expect(yaml).toContain('opaqueBlobCompatibilityScope:\n    bindToUpstream: false\n    key: openai');
  });

  it('shows an auto model opaque blob compatibility scope read-only', () => {
    const source: UpstreamRecord = {
      ...record,
      config: { ...record.config, modelsFetch: { enabled: true } },
    };
    renderInApp(<Harness
      source={source}
      discovered={[{
        ...model('auto-model'),
        opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'claude-opus' },
      }]}
    />);

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'auto-model' }) }));
    const bindToUpstream = screen.getByRole<HTMLInputElement>('switch', { name: models('bindOpaqueBlobsToUpstream') });
    const key = screen.getByRole<HTMLInputElement>('textbox', { name: models('opaqueBlobCompatibilityKey') });
    expect(bindToUpstream.checked).toBe(false);
    expect(bindToUpstream.getAttribute('aria-readonly')).toBe('true');
    expect(key.value).toBe('claude-opus');
    expect(key.readOnly).toBe(true);
  });

  it('initializes, preserves, and clears original-detail support with image input', () => {
    const withChat = (chat: UpstreamChatModelConfig): UpstreamRecord => ({
      ...record,
      config: { ...record.config, models: [model('model-a', chat)] },
    });

    const first = renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(false);
    first.unmount();

    const second = renderInApp(<Harness source={withChat({ image_detail_original: true })} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    expect(screen.queryByRole('switch', { name: detailLabel })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(true);
    second.unmount();

    renderInApp(<Harness source={withChat({ modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true })} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.queryByRole('switch', { name: detailLabel })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(false);
  });

  it('deletes a newly appended model and applies a shorter YAML catalog', async () => {
    renderInApp(<Harness />);
    expect(deleteCommands()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    fireEvent.change(screen.getByRole('textbox', { name: models('upstreamId') }), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(deleteCommands()).toHaveLength(3);
    fireEvent.click(deleteCommands()[2]!);
    fireEvent.click(await screen.findByRole('button', { name: models('deleteConfirm') }));
    await waitFor(() => expect(deleteCommands()).toHaveLength(2));

    // The confirmation dialog marks the rest of the document `aria-hidden`
    // while it is open and clears that on its way out, so the toolbar behind it
    // is unreachable by role until the exit settles. A label query does not
    // filter hidden nodes and hid the race; a role query has to wait for it.
    fireEvent.click(await screen.findByRole('button', { name: models('editAsYaml') }));
    const editor = await screen.findByLabelText('YAML models');
    fireEvent.change(editor, {
      target: {
        value: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    openaiResponses: {}\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: models('editWithUi') }));
    await waitFor(() => expect(deleteCommands()).toHaveLength(1));
  });
});

describe('upstream model bulk selection', () => {
  it('selects only the rows a search shows and reports a partial selection', () => {
    renderInApp(<Harness probe />);
    const search = screen.getByPlaceholderText(models('search'));

    fireEvent.change(search, { target: { value: 'model-a' } });
    expect(screen.queryByRole('checkbox', { name: selectNamed('model-b') })).toBe(null);

    fireEvent.click(selectAllBox());
    expect(rowBox('model-a').checked).toBe(true);
    expect(selectAllBox().checked).toBe(true);
    expect(selectionCount(1, 1)).toBeTruthy();

    fireEvent.change(search, { target: { value: '' } });
    expect(rowBox('model-a').checked).toBe(true);
    expect(rowBox('model-b').checked).toBe(false);
    expect(selectAllBox().checked).toBe(false);
    expect(selectAllBox().indeterminate).toBe(true);
    expect(selectAllBox().getAttribute(winuiCheckedAttribute)).toBe('mixed');
    expect(selectionCount(1, 2)).toBeTruthy();
  });

  it('writes a bulk enable and disable through the form', () => {
    renderInApp(<Harness probe />);

    fireEvent.click(rowBox('model-a'));
    fireEvent.click(rowBox('model-b'));
    expect(selectionCount(2, 2)).toBeTruthy();

    // Enabling rows that are already enabled is not an edit.
    fireEvent.click(screen.getByRole('button', { name: models('bulkEnable') }));
    expect(formState()).toEqual({ dirty: false, disabled: [], manual: ['model-a', 'model-b'] });

    fireEvent.click(screen.getByRole('button', { name: models('bulkDisable') }));
    expect(formState()).toEqual({ dirty: true, disabled: ['model-a', 'model-b'], manual: ['model-a', 'model-b'] });
    expect(enabledSwitch('model-a').checked).toBe(false);
    expect(enabledSwitch('model-b').checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: models('bulkEnable') }));
    expect(formState()).toEqual({ dirty: false, disabled: [], manual: ['model-a', 'model-b'] });
    expect(enabledSwitch('model-a').checked).toBe(true);
    expect(enabledSwitch('model-b').checked).toBe(true);
  });

  it('confirms before discarding manual configuration in bulk', async () => {
    const withCatalog: UpstreamRecord = { ...record, config: { ...record.config, modelsFetch: { enabled: true } } };
    renderInApp(<Harness discovered={[model('model-a'), model('model-b')]} probe source={withCatalog} />);

    fireEvent.click(rowBox('model-a'));
    fireEvent.click(screen.getByRole('button', { name: models('bulkMoveToAuto') }));
    expect(formState().manual).toEqual(['model-a', 'model-b']);
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.bulkAutoMessage', { count: 1 }))).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: models('bulkAutoConfirm') }));
    await waitFor(() => expect(formState().manual).toEqual(['model-b']));
    // The removal is destructive, so the rows it left are no longer selected.
    expect(screen.queryByText(i18n.t('dashboard.upstreamEditor.models.bulkSelected', { count: 2, selected: 1 }))).toBe(null);
  });

  it('confirms before deleting manual models in bulk', async () => {
    renderInApp(<Harness probe />);

    fireEvent.click(rowBox('model-a'));
    fireEvent.click(rowBox('model-b'));
    fireEvent.click(screen.getByRole('button', { name: models('bulkDelete') }));
    expect(formState().manual).toEqual(['model-a', 'model-b']);
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.bulkDeleteRemove', { count: 2 }))).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: models('bulkDeleteConfirm') }));
    await waitFor(() => expect(formState().manual).toEqual([]));
  });

  // A removal that skips rows proves the indices are resolved against the array
  // as it stands. Removing them one at a time in ascending order would take
  // model-c here, because deleting model-a first shifts it down to index 1.
  it('deletes exactly the selected rows when the selection has gaps', async () => {
    const four = upstreamRecord('up_test', {
      name: 'Test',
      kind: 'custom',
      config: {
        baseUrl: 'https://example.com',
        authStyle: 'bearer',
        apiKey: '',
        endpoints: { openaiResponses: {} },
        ingressHeadersRules: [],
        modelsFetch: { enabled: false },
        models: [model('model-a'), model('model-b'), model('model-c'), model('model-d')],
      },
      state: null,
    });
    renderInApp(<Harness probe source={four} />);

    fireEvent.click(rowBox('model-a'));
    fireEvent.click(rowBox('model-c'));
    expect(selectionCount(2, 4)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: models('bulkDelete') }));
    fireEvent.click(await screen.findByRole('button', { name: models('bulkDeleteConfirm') }));
    await waitFor(() => expect(formState().manual).toEqual(['model-b', 'model-d']));
  });
});

describe('upstream model listing failure wording', () => {
  it('shows the concrete failure returned by the explicit Fetch', () => {
    renderInApp(<Harness modelsError={{ message: 'HTTP 401: unauthorized', upstreamResponse: null }} />);
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: 'HTTP 401: unauthorized' }))).toBeTruthy();
  });

  it('shows the upstream HTTP status, headers, and parsed body', () => {
    renderInApp(<Harness modelsError={{
      message: 'HTTP 401: unauthorized',
      upstreamResponse: { status: 401, headers: [['content-type', 'application/json']], body: '{\n  "error": "unauthorized"\n}' },
    }} />);
    const heading = screen.getByText(models('listingFailed'));
    const banner = heading.closest<HTMLElement>('.fui-MessageBar');
    expect.assert(banner);
    const copyButton = within(banner).getByRole('button', { name: models('copyError') });
    expect(copyButton.parentElement).toBe(heading.parentElement);
    expect(heading.parentElement?.nextElementSibling?.tagName).toBe('PRE');
    expect(banner.querySelector('.fui-MessageBarActions')).toBeNull();
    expect(screen.getByText(/HTTP 401/).textContent).toContain('content-type: application/json');
    expect(screen.getByText(/HTTP 401/).textContent).toContain('"error": "unauthorized"');
  });

  it('shortens the visible error and lets the operator copy the stored full message', async () => {
    const message = 'x'.repeat(MODEL_ERROR_EDITOR_LENGTH + 100);
    const source = { ...record, modelsCache: { fetchedAt: null, modelCount: null, lastError: { message, at: 100 } } };
    renderInApp(<Harness source={source} modelsError={{ message, upstreamResponse: null }} />);

    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.listingFailedWithDetail', {
      message: modelErrorExcerpt(message, MODEL_ERROR_EDITOR_LENGTH),
    }))).toBeTruthy();
    const copyButtons = screen.getAllByRole('button', { name: models('copyError') });
    expect(copyButtons).toHaveLength(2);
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith(message));
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(vi.mocked(copyToClipboard)).toHaveBeenCalledTimes(2));
  });
});
