import { nextOffPeakAfter, pricingScheduleById, pricingScheduleLabel, type ModelPricing } from '@floway-dev/protocols/common';
import { peakScheduleIdOfCandidate, providerModelOf, type ModelCandidate } from '@floway-dev/provider';

// A model is peak-priced when its pricing carries an `off-peak` entry: Base
// bills the peak rate and the entry bills the discounted one. Matching on
// the pricing shape rather than the model id keeps the gate working for any
// peak-priced family on any schedule.
export const isPeakPricedModel = (pricing: ModelPricing | undefined): boolean =>
  pricing?.entries.some(entry => entry.selector?.pricingPeriod === 'off-peak') ?? false;

export interface PeakBlock {
  retryAfterSeconds: number;
  nextOffPeak: string;
  scheduleId: string;
}

export const peakBlockedMessage = (failure: { readonly model: string; readonly retryAfterSeconds: number; readonly nextOffPeak: string; readonly scheduleId: string }): string =>
  `Model ${failure.model} is blocked during ${pricingScheduleLabel(failure.scheduleId)} peak pricing. Off-peak starts at ${failure.nextOffPeak} (retry in ${failure.retryAfterSeconds}s).`;

// Peak-block timing for one candidate's effective schedule at `now`: null
// when off-peak (or flat), otherwise the first off-peak minute and the
// seconds until it.
export const peakBlockForSchedule = (scheduleId: string | null, now: Date): PeakBlock | null => {
  if (scheduleId === null) return null;
  const def = pricingScheduleById(scheduleId);
  if (def === undefined) throw new Error(`Unknown peak schedule ${JSON.stringify(scheduleId)}`);
  const next = nextOffPeakAfter(def, now);
  if (next === null) return null;
  return { ...next, scheduleId };
};

export const peakBlockForCandidate = (candidate: ModelCandidate, now: Date): PeakBlock | null =>
  peakBlockForSchedule(peakScheduleIdOfCandidate(candidate), now);

// Whether this candidate survives the peak gate at `now`: peak-priced
// models on upstreams that opted into blocking are dropped while their own
// effective schedule says peak. ProviderModel is read off the candidate so
// the caller's row (merged or per-candidate) decides.
export const candidatePassesPeakGate = (candidate: ModelCandidate, now: Date): boolean => {
  if (!(candidate.provider.blockPeakPricedModels ?? false)) return true;
  if (!isPeakPricedModel(providerModelOf(candidate).pricing)) return true;
  return peakBlockForCandidate(candidate, now) === null;
};
