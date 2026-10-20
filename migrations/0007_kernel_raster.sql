-- The library's raster benchmark kernel: anti-aliased curves drawn into a 2D
-- canvas with a pixel readback, a proxy for paint cost. Measured on the warm
-- run only, so it is NULL for cold-only rows, for libraries without the
-- kernel, and for rows stored before this migration.

-- Work units per ms (reports: warm run only).
ALTER TABLE reports ADD COLUMN kernel_raster REAL;
-- Work units per ms, 3 significant digits.
ALTER TABLE lab_runs ADD COLUMN kernel_raster REAL;
