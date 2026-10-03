import { fluentComponents } from '../../fluent';
import { type TFunction } from '../../i18n/translation';
import { Dropdown } from '../ui/fluent-form-controls';
import { PANE_GAP_CLASS } from '../ui/layout';
import { MultiselectCombobox, valuesAsOptions } from '../ui/multiselect-combobox';
import type { UpstreamChatModelConfig } from '@floway-dev/provider/model-config';

const { Field, Option } = fluentComponents;
const reasoningPresets = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function EffortEditor({ effort, onChange, readOnly, t }: { readOnly: boolean; effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort'] & {}; onChange: (effort: NonNullable<UpstreamChatModelConfig['reasoning']>['effort']) => void; t: TFunction }) {
  const supported = effort.supported;
  const setSupported = (values: readonly string[]) => onChange({
    supported: [...values],
    default: values.includes(effort.default) ? effort.default : values[0] ?? '',
  });
  return <div className={`grid grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)] ${PANE_GAP_CLASS} max-[760px]:grid-cols-1`}>
    <Field label={t('dashboard.upstreamEditor.models.supportedEfforts')}>
      <MultiselectCombobox
        closedLabel={supported.join(', ')}
        freeform
        normalizeValue={level => level.trim()}
        onChange={setSupported}
        options={valuesAsOptions([...new Set([...reasoningPresets, ...supported])])}
        placeholder={t('dashboard.upstreamEditor.models.effortPlaceholder')}
        readOnly={readOnly}
        value={supported}
      />
    </Field>
    <Field label={t('dashboard.upstreamEditor.models.defaultEffort')}>
      <Dropdown disabled={supported.length === 0} readOnly={readOnly} selectedOptions={[effort.default]} value={effort.default} onOptionSelect={(_, data) => data.optionValue !== undefined && onChange({ ...effort, default: data.optionValue })}>
        {supported.map(level => <Option key={level} value={level}>{level}</Option>)}
      </Dropdown>
    </Field>
  </div>;
}
