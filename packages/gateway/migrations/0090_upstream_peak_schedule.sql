-- Per-upstream peak/off-peak schedule override, resolved per candidate as
-- manual-model choice, then this, then the model's catalog default.
-- 'inherit' follows each model; 'none' bills every model flat (mirrors that
-- ignore the vendor discount); otherwise a pricing-schedule preset id
-- (`deepseek`, `zhipu-coding`, `qwen-night`). Existing rows default to
-- 'inherit': no behavior changes silently. Values are validated at row
-- hydration rather than by CHECK so future presets need no migration.
ALTER TABLE upstreams ADD COLUMN peak_schedule_override TEXT NOT NULL DEFAULT 'inherit';
