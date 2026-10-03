-- One row per opt-in lab run (framebudget.dev/lab): a visitor consents, passes
-- Turnstile, and the page measures the device and then the site's effects one at
-- a time. Each measured step updates this row; steps never create rows.
-- No IP, no user agent, no cookies, no identifiers, no URL. The run id is random
-- and lives only in the page's memory and here. Client fields (engine, os,
-- mobile, country) are derived server-side from request headers; the raw headers
-- are never stored.
CREATE TABLE lab_runs (
  -- Random UUID (crypto.randomUUID), no meaning outside the run.
  id TEXT PRIMARY KEY,
  -- UTC date the run was created, YYYY-MM-DD.
  created_day TEXT NOT NULL,
  -- framebudget library version the page ran.
  lib TEXT NOT NULL,
  -- Calibration version the scores were computed against.
  cal TEXT NOT NULL,
  -- framebudget score of the device, 1 decimal.
  score REAL NOT NULL,
  -- Benchmark scores before caps, 1 decimal. NULL when that run did not happen.
  cold REAL,
  warm REAL,
  -- Clock resolution in ms, 2 significant digits.
  tick_ms REAL,
  -- Work units per ms per kernel, 3 significant digits.
  kernel_float REAL,
  kernel_typed REAL,
  kernel_alloc REAL,
  kernel_path REAL,
  -- Hardware hints.
  cores INTEGER,
  memory_gb REAL,
  -- Display refresh rate measured by the page, in Hz.
  refresh_hz INTEGER NOT NULL,
  -- devicePixelRatio, 1 decimal.
  dpr REAL NOT NULL,
  -- Viewport width in CSS pixels, rounded to the nearest 100.
  viewport_width INTEGER NOT NULL,
  -- 1 when prefers-reduced-motion: reduce.
  reduced_motion INTEGER NOT NULL,
  -- 1 when the browser asked to save data.
  save_data INTEGER NOT NULL,
  -- Engine family: blink, gecko, webkit, other.
  engine TEXT NOT NULL,
  -- Engine major version (Chromium, Firefox or Safari/iOS major).
  engine_version INTEGER,
  -- OS family: android, ios, windows, macos, linux, chromeos, other.
  os TEXT NOT NULL,
  -- 1 for phone-class devices.
  mobile INTEGER NOT NULL,
  -- Two-letter country code from Cloudflare, NULL when unknown.
  country TEXT,
  -- JSON array of measured steps, in arrival order: {name, effects, frames,
  -- durationMs, medianMs, p95Ms, maxMs, over}. At most 20.
  steps TEXT NOT NULL DEFAULT '[]',
  -- Number of entries in steps.
  step_count INTEGER NOT NULL DEFAULT 0,
  -- 1 once the page sent its last step (done: true).
  completed INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 hex of the run's write key; NULL once the run is closed.
  write_key_hash TEXT,
  -- Epoch seconds until which steps are accepted (creation + 900); NULL once closed.
  open_until INTEGER
);

CREATE INDEX lab_runs_created_day ON lab_runs (created_day);
