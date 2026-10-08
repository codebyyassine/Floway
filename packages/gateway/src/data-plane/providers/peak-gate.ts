import type { ModelPricing } from '@floway-dev/protocols/common';
import { isDeepSeekPeak } from '@floway-dev/provider-ollama';

// A model is peak-priced when its pricing carries an `off-peak` entry: Base
// bills the peak rate and the entry bills the discounted one. This is the
// DeepSeek peak/off-peak split the Ollama, OpenCode Go, and OpenCode Zen
// tables publish; matching on the pricing shape rather than the model id
// keeps the gate working for any future peak-priced family.
export const isPeakPricedModel = (pricing: ModelPricing | undefined): boolean =>
  pricing?.entries.some(entry => entry.selector?.pricingPeriod === 'off-peak') ?? false;

export interface PeakBlock {
  retryAfterSeconds: number;
  nextOffPeak: string;
}

export const peakBlockedMessage = (failure: { readonly model: string; readonly retryAfterSeconds: number; readonly nextOffPeak: string }): string =>
  `Model ${failure.model} is blocked during DeepSeek peak pricing. Off-peak starts at ${failure.nextOffPeak} (retry in ${failure.retryAfterSeconds}s).`;

// Peak-block timing for a request arriving at `now`: null when off-peak,
// otherwise the first off-peak minute and the seconds until it. Found by
// minute scan against the same classifier billing uses; the horizon covers
// the longest statutory-holiday run plus margin, so exhausting it means the
// vendored calendar has stopped being a calendar.
export const peakBlockAfter = (now: Date): PeakBlock | null => {
  if (!isDeepSeekPeak(now)) return null;
  const at = new Date(now.getTime());
  at.setUTCSeconds(0, 0);
  for (let step = 0; step <= 8 * 24 * 60; step += 1) {
    if (!isDeepSeekPeak(at)) {
      return {
        retryAfterSeconds: Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000)),
        nextOffPeak: at.toISOString(),
      };
    }
    at.setUTCMinutes(at.getUTCMinutes() + 1);
  }
  throw new Error(`No DeepSeek off-peak minute within 8 days of ${now.toISOString()}`);
};
