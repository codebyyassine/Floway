import { useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { EffortEditor } from './effort-editor';
import { EditorSection } from './section';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import type { UpstreamModelConfig } from '@floway-dev/provider/model-config';
import { CODEX_OVERRIDE_MAX_TOKENS, type CodexModelOverride } from '@floway-dev/provider-codex/model-overrides';

const { Button, Field, Option, Text } = fluentComponents;
type CodexConfig = Extract<UpstreamRecord, { kind: 'codex' }>['config'];

export function CodexModelOverridesEditor({ defaults, modelId }: { defaults: UpstreamModelConfig; modelId: string }) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const config = useWatch({ control, name: 'config' }) as CodexConfig;
  const override = config.modelOverrides && Object.hasOwn(config.modelOverrides, modelId) ? config.modelOverrides[modelId]! : {};
  const change = (next: CodexModelOverride) => {
    if (Object.keys(next.limits ?? {}).length === 0) delete next.limits;
    const entries = Object.entries(config.modelOverrides ?? {}).filter(([id]) => id !== modelId);
    const modelOverrides = Object.fromEntries(Object.keys(next).length === 0 ? entries : [...entries, [modelId, next]]);
    setValue('config', { ...config, modelOverrides }, { shouldDirty: true, shouldTouch: true, shouldValidate: true });
  };
  const resetField = (key: keyof CodexModelOverride) => {
    const next = { ...override };
    delete next[key];
    change(next);
  };
  const inheritedLabel = (value: string) => t('dashboard.upstreamEditor.models.overrideInherited', { value });
  const unknown = t('dashboard.upstreamEditor.models.overrideUnspecified');
  const booleanLabel = (value: boolean) => t(value ? 'common.on' : 'common.off');
  const numericFields = [
    ['max_context_window_tokens', 'contextWindow'],
    ['max_prompt_tokens', 'promptTokens'],
    ['max_output_tokens', 'outputTokens'],
  ] as const;
  const boolFields = [
    ['imageInput', 'imageInput', defaults.chat?.modalities?.input.includes('image') === true],
    ['imageDetailOriginal', 'imageDetailOriginal', defaults.chat?.image_detail_original === true],
  ] as const;
  const inheritedEffort = defaults.chat?.reasoning?.effort;
  const effort = override.reasoningEffort ?? inheritedEffort;
  const invalidEffort = override.reasoningEffort !== undefined && (override.reasoningEffort.supported.length === 0 || !override.reasoningEffort.supported.includes(override.reasoningEffort.default));
  return <EditorSection error={invalidEffort ? t('dashboard.upstreamEditor.models.overrideEffortInvalid') : undefined} level={3} title={t('dashboard.upstreamEditor.models.capabilities')} description={t('dashboard.upstreamEditor.models.overrideHint')}>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
      {numericFields.map(([key, label]) => <OverrideNumber
        key={key}
        inherited={defaults.limits?.[key]}
        label={t(`dashboard.upstreamEditor.models.${label}`)}
        value={override.limits?.[key]}
        onChange={value => {
          const limits = { ...override.limits };
          if (value === undefined) delete limits[key]; else limits[key] = value;
          change({ ...override, limits });
        }}
      />)}
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
      {boolFields.map(([key, label, inherited]) => <Field key={key} label={t(`dashboard.upstreamEditor.models.${label}`)}>
        <Dropdown
          className="!min-h-11"
          selectedOptions={[override[key] === undefined ? 'inherit' : String(override[key])]}
          value={override[key] === undefined ? inheritedLabel(booleanLabel(inherited)) : booleanLabel(override[key])}
          onOptionSelect={(_, data) => {
            if (data.optionValue === 'inherit') resetField(key);
            else if (data.optionValue !== undefined) change({ ...override, [key]: data.optionValue === 'true' });
          }}
        >
          <Option value="inherit">{inheritedLabel(booleanLabel(inherited))}</Option>
          <Option value="true">{booleanLabel(true)}</Option>
          <Option value="false">{booleanLabel(false)}</Option>
        </Dropdown>
      </Field>)}
    </div>
    <div className="grid gap-3">
      <Text weight="semibold">{t('dashboard.upstreamEditor.models.reasoning')}</Text>
      <Text className="text-fui-fg2" size={200}>{override.reasoningEffort === undefined ? inheritedLabel(inheritedEffort?.supported.join(', ') ?? unknown) : t('dashboard.upstreamEditor.models.overrideActive')}</Text>
      <div className="[&_button]:!min-h-11 [&_input]:!min-h-11">
        <EffortEditor effort={effort ?? { supported: [], default: '' }} readOnly={false} t={t} onChange={reasoningEffort => change({ ...override, reasoningEffort })} />
      </div>
      <Button className="!min-h-11 justify-self-start" disabled={override.reasoningEffort === undefined} onClick={() => resetField('reasoningEffort')}>{t('dashboard.upstreamEditor.models.overrideResetReasoning')}</Button>
    </div>
    <Button className="!min-h-11 justify-self-start" disabled={Object.keys(override).length === 0} onClick={() => change({})}>{t('dashboard.upstreamEditor.models.overrideResetModel')}</Button>
  </EditorSection>;
}

function OverrideNumber({ inherited, label, onChange, value }: { inherited?: number; label: string; onChange: (value: number | undefined) => void; value?: number }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({ value, raw: value === undefined || Number.isNaN(value) ? '' : String(value) });
  if (!Object.is(draft.value, value)) setDraft({ value, raw: value === undefined || Number.isNaN(value) ? '' : String(value) });
  const invalid = value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > CODEX_OVERRIDE_MAX_TOKENS);
  const status = value === undefined
    ? t('dashboard.upstreamEditor.models.overrideInherited', { value: inherited === undefined ? t('dashboard.upstreamEditor.models.overrideUnspecified') : String(inherited) })
    : t('dashboard.upstreamEditor.models.overrideActive');
  return <div className="grid gap-2">
    <Field label={label} hint={status} validationMessage={invalid ? t('dashboard.upstreamEditor.models.overrideNumberInvalid', { max: CODEX_OVERRIDE_MAX_TOKENS }) : undefined} validationState={invalid ? 'error' : undefined}>
      <Input className="!w-full !min-h-11" inputMode="numeric" placeholder={inherited === undefined ? '' : String(inherited)} value={draft.raw} onChange={(_, data) => {
        const nextValue = data.value.trim() === '' ? undefined : /^\d+$/.test(data.value) ? Number(data.value) : Number.NaN;
        setDraft({ raw: data.value, value: nextValue });
        onChange(nextValue);
      }} />
    </Field>
    <Button className="!min-h-11 justify-self-start" disabled={value === undefined} onClick={() => onChange(undefined)}>{t('dashboard.upstreamEditor.models.overrideResetField', { field: label })}</Button>
  </div>;
}
