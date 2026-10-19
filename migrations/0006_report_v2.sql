-- Library TelemetryReport v2: which effects the page used, the effect a page
-- view explored below its threshold, and late-frame fractions per source.
-- v1 rows keep v = 1 and NULL in every v2-only column.

-- Report version (report.v): 1 or 2.
ALTER TABLE reports ADD COLUMN v INTEGER NOT NULL DEFAULT 1;
-- JSON array of effect names the page used (asked, reported frames for, or declared). NULL for v1.
ALTER TABLE reports ADD COLUMN used TEXT;
-- Effect name this page view turned on below its threshold. NULL when none, or for v1.
ALTER TABLE reports ADD COLUMN explored TEXT;
-- JSON object of the fraction of late frames per source, 0..1. NULL for v1.
ALTER TABLE reports ADD COLUMN late TEXT;
-- Copy of late.main for direct queries. NULL when absent.
ALTER TABLE reports ADD COLUMN late_main REAL;
