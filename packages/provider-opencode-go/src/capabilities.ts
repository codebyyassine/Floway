// Hand-authored reasoning-effort table for the OpenCode Go provider. The
// generated snapshot records whether a model reasons, but not which effort
// presets the gateway may offer for it — that vocabulary comes from the
// vendor's own model documentation.
// https://opencode.ai/docs/go/

export interface OpencodeGoEffortConfig {
  readonly supported: readonly string[];
  readonly default: string;
}

// Supported reasoning-effort presets per model id, as documented by the
// vendor. Models absent from this table expose no effort presets.
// https://opencode.ai/docs/go/
const OPENCODE_GO_EFFORT: Readonly<Record<string, readonly string[]>> = {
  'space-bunny-free': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.5': ['low', 'medium', 'high', 'xhigh'],
  'deepseek-v4.1-flash': ['low', 'high', 'max'],
  'deepseek-v4-pro': ['high', 'max'],
  'muse-spark-1.3-contributor': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'muse-spark-1.2-contributor': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'hy4-preview': ['none', 'high'],
  'hy3': ['none', 'high'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'glm-5.3': ['low', 'high', 'max'],
  'glm-5.2': ['low', 'high', 'max'],
  'qwen3.8-flash': ['none', 'low', 'medium', 'xhigh'],
  'qwen3.8-max': ['none', 'low', 'medium', 'xhigh'],
  'qwen3.7-plus': ['none', 'high', 'max'],
  'minimax-m3': ['none', 'thinking'],
};

export const effortForOpencodeGoModelKey = (modelKey: string): OpencodeGoEffortConfig | null => {
  const supported = OPENCODE_GO_EFFORT[modelKey];
  if (supported === undefined) return null;
  return { supported, default: supported.includes('high') ? 'high' : supported[supported.length - 1]! };
};
