-- One row per daily auto calibration evaluation (src/calibration/), applied or
-- not. GET /api/calibration serves calibration.json merged with the patch of the
-- latest applied row; deleting applied rows rolls the thresholds back to the
-- previous applied row (or to the site's own values when none is left).
CREATE TABLE calibration_log (
  id INTEGER PRIMARY KEY,
  -- Epoch seconds of the evaluation.
  created_at INTEGER NOT NULL,
  -- Calibration version of the runs used; NULL when no run qualified.
  cal TEXT,
  -- Lab runs counted.
  runs INTEGER NOT NULL,
  -- Lab runs of that version excluded (refresh rate, missing baseline, busy baseline, thermal throttling).
  excluded INTEGER NOT NULL,
  -- The full auto patch in force after this evaluation: a CalibrationPatch JSON
  -- holding effects.<name>.threshold only.
  patch TEXT NOT NULL,
  -- JSON array of {effect, from, to, proposed, devices, limitedBy}, one per effect evaluated.
  changes TEXT NOT NULL,
  -- 1 when at least one threshold changed.
  applied INTEGER NOT NULL
);

CREATE INDEX calibration_log_created_at ON calibration_log (created_at);
