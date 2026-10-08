// Dashboard-side peak/off-peak schedule options. The registry owns the ids;
// this module lists the ones the dashboard translates (every entry needs a
// `dashboard.upstreamEditor.peakSchedules.*` string), so a new preset lands
// here together with its copy.

export const PEAK_SCHEDULE_PRESET_IDS = ['deepseek', 'zhipu-coding', 'qwen-night'] as const;
export type PeakSchedulePresetId = typeof PEAK_SCHEDULE_PRESET_IDS[number];

// Upstream override choices: model default, flat, then every preset.
export const UPSTREAM_PEAK_SCHEDULE_OPTIONS = ['inherit', 'none', ...PEAK_SCHEDULE_PRESET_IDS] as const;
export type UpstreamPeakScheduleOption = typeof UPSTREAM_PEAK_SCHEDULE_OPTIONS[number];

// Manual-row choices: inherit, flat, then every preset.
export const MODEL_PEAK_SCHEDULE_OPTIONS = ['inherit', 'none', ...PEAK_SCHEDULE_PRESET_IDS] as const;
export type ModelPeakScheduleOption = typeof MODEL_PEAK_SCHEDULE_OPTIONS[number];

export const peakScheduleOptionOf = (value: string | null | undefined): ModelPeakScheduleOption =>
  value === undefined ? 'inherit' : value === null ? 'none' : (value as ModelPeakScheduleOption);

export const peakScheduleValueOf = (option: ModelPeakScheduleOption): string | null | undefined =>
  option === 'inherit' ? undefined : option === 'none' ? null : option;
