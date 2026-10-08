-- Per-upstream opt-in to refuse peak-priced models (pricing with an `off-peak`
-- entry) while DeepSeek peak pricing is in effect, so operators can avoid the
-- peak multiplier. Existing rows default off: no behavior changes silently.
ALTER TABLE upstreams ADD COLUMN block_peak_priced_models INTEGER NOT NULL DEFAULT 0
  CHECK (block_peak_priced_models IN (0, 1));
