-- One row per anonymous framebudget report (library TelemetryReport v1).
-- No IP, no user agent, no cookies, no identifiers, no URL, no time of day.
-- Client fields (engine, os, mobile, country) are derived server-side from
-- request headers; the raw headers are never stored.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  -- UTC date the report arrived, YYYY-MM-DD.
  created_day TEXT NOT NULL,
  -- Calibration version the scores were computed against (report.cal).
  cal TEXT NOT NULL,
  -- Final score the library decided with (caps and pressure applied).
  score INTEGER NOT NULL,
  -- Benchmark scores before caps, on the scale of `cal`. NULL when that run did not happen.
  cold INTEGER,
  warm INTEGER,
  -- Clock resolution in ms.
  tick_ms REAL,
  -- Work units per ms per kernel (warm run when present, else cold).
  kernel_float REAL,
  kernel_typed REAL,
  kernel_alloc REAL,
  kernel_path REAL,
  -- Hardware hints.
  cores INTEGER,
  memory_gb REAL,
  -- Compute Pressure state: nominal, fair, serious, critical.
  pressure TEXT,
  reduced_motion INTEGER NOT NULL,
  -- Tier name: Full, High, Medium, Lite.
  tier TEXT NOT NULL,
  -- JSON array of effect names that ran.
  effects TEXT NOT NULL,
  -- JSON array of effect names the governor stepped down.
  stepped TEXT NOT NULL,
  -- JSON object of median fps per source ("main", "worker" or an effect name).
  fps TEXT NOT NULL,
  -- Copy of fps.main for direct queries.
  fps_main INTEGER,
  -- Engine family: blink, gecko, webkit, other.
  engine TEXT NOT NULL,
  -- Engine major version (Chromium, Firefox or Safari/iOS major).
  engine_version INTEGER,
  -- OS family: android, ios, windows, macos, linux, chromeos, other.
  os TEXT NOT NULL,
  -- 1 for phone-class devices.
  mobile INTEGER NOT NULL,
  -- Two-letter country code from Cloudflare, NULL when unknown.
  country TEXT
);

CREATE INDEX reports_score ON reports (score);
CREATE INDEX reports_engine ON reports (engine, engine_version);
CREATE INDEX reports_os ON reports (os, mobile);
CREATE INDEX reports_created_day ON reports (created_day);
