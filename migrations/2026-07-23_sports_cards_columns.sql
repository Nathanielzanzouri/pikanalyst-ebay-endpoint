-- ─── Sports-cards pipeline diagnostics ──────────────────────────────
-- Six columns added to scan_logs. All nullable — only populated on
-- Gemini-vision route when USE_SPORTS_CARDS_PIPELINE is on AND the
-- scanned category is "sports_card".
--
-- The pair (sports_lens_titles_count, sports_id_confidence) is the
-- signal that will validate whether the hybrid Lens+Gemini
-- identification architecture actually helps quality vs Gemini alone.
-- Slice scans by these two columns after ~50-100 sports scans:
--   - rows with lens_titles_count > 8 AND id_confidence >= 0.7:
--       hybrid worked, Lens context was rich enough to anchor.
--   - rows with lens_titles_count > 8 AND id_confidence < 0.5:
--       Lens returned noise, hybrid didn't help.
--   - rows with lens_titles_count <= 3 AND id_confidence < 0.5:
--       Gemini alone couldn't identify — expected failure mode.
--   - rows with lens_titles_count <= 3 AND id_confidence >= 0.7:
--       Gemini alone was enough — hybrid overkill.

ALTER TABLE scan_logs
  ADD COLUMN IF NOT EXISTS sports_query_level        integer,
  ADD COLUMN IF NOT EXISTS sports_sales_count        integer,
  ADD COLUMN IF NOT EXISTS sports_serpapi_calls      integer,
  ADD COLUMN IF NOT EXISTS sports_scope              text,
  ADD COLUMN IF NOT EXISTS sports_id_confidence      double precision,
  ADD COLUMN IF NOT EXISTS sports_lens_titles_count  integer;

-- ─── Analysis view — hybrid architecture signal ────────────────────
-- Buckets each sports_card scan by the two axes we care about.
-- Run: SELECT * FROM sports_hybrid_signal ORDER BY bucket_count DESC;

CREATE OR REPLACE VIEW sports_hybrid_signal AS
SELECT
  CASE
    WHEN sports_lens_titles_count >= 8 AND sports_id_confidence >= 0.7 THEN 'A_lens_rich_id_high'
    WHEN sports_lens_titles_count >= 8 AND sports_id_confidence <  0.5 THEN 'B_lens_rich_id_low'
    WHEN sports_lens_titles_count <= 3 AND sports_id_confidence <  0.5 THEN 'C_lens_thin_id_low'
    WHEN sports_lens_titles_count <= 3 AND sports_id_confidence >= 0.7 THEN 'D_lens_thin_id_high'
    ELSE                                                                     'E_middle'
  END AS bucket,
  count(*)                                       AS bucket_count,
  round(avg(sports_id_confidence)::numeric, 3)   AS avg_id_confidence,
  round(avg(sports_lens_titles_count)::numeric, 1) AS avg_lens_titles,
  round(avg(sports_sales_count)::numeric, 1)     AS avg_sales_count,
  count(*) FILTER (WHERE sports_scope IS NOT NULL) AS reached_pipeline_output
FROM scan_logs
WHERE product_category = 'sports_card'
  AND route = 'gemini-vision'
GROUP BY 1
ORDER BY 1;
