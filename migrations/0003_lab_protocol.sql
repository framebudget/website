-- Lab protocol the page ran. 1: steps hold frame gaps only (median, p95 and max
-- frame time, frames over 1.5 refresh intervals). 2: steps also hold the
-- main-thread work of each frame (workMeanMs, workMedianMs, workP95Ms,
-- workFrames). Rows created before this column existed read as protocol 1.
ALTER TABLE lab_runs ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1;
