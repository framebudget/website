-- Reports accepted per UTC day, the daily budget of POST /api/report
-- (REPORT_DAILY_CAP). The Worker inserts a report and increments its day in
-- one transaction, and only while n is below the cap. Holds nothing but the
-- day and the count; retention deletes days older than the reports it counts.
CREATE TABLE report_days (
  -- UTC date, YYYY-MM-DD.
  day TEXT PRIMARY KEY,
  -- Reports stored that day.
  n INTEGER NOT NULL
);
