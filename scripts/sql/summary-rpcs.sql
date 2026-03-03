-- Ada Intelligent Drill-Down: Summary RPCs
-- Run in BMAD Supabase SQL Editor (bzhqvxknwvxhgpovrhlp)
-- These RPCs aggregate daily data into 1 row per entity for overview analysis.

-- ============================================================================
-- 1. get_campaign_summary — 1 row per campaign
-- ============================================================================
CREATE OR REPLACE FUNCTION get_campaign_summary(p_client_code TEXT, p_days INT DEFAULT 30)
RETURNS TABLE (
  campaign_id TEXT,
  campaign_name TEXT,
  status TEXT,
  objective TEXT,
  days_active INT,
  total_spend NUMERIC,
  total_impressions BIGINT,
  total_reach BIGINT,
  total_clicks BIGINT,
  total_link_clicks BIGINT,
  total_purchases BIGINT,
  total_purchase_value NUMERIC,
  total_leads BIGINT,
  total_results BIGINT,
  avg_cpm NUMERIC,
  avg_ctr_link NUMERIC,
  avg_cpc NUMERIC,
  avg_cost_per_result NUMERIC,
  overall_roas NUMERIC,
  avg_frequency NUMERIC,
  last_3d_spend NUMERIC,
  last_3d_cost_per_result NUMERIC,
  last_3d_roas NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_client_id UUID;
  v_since DATE := CURRENT_DATE - p_days;
  v_last_3d DATE := CURRENT_DATE - 3;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE code = p_client_code;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client % not found', p_client_code;
  END IF;

  RETURN QUERY
  WITH daily AS (
    SELECT * FROM campaign_daily
    WHERE client_id = v_client_id AND date >= v_since
  ),
  agg AS (
    SELECT
      d.campaign_id::TEXT AS campaign_id,
      MAX(d.campaign_name)::TEXT AS campaign_name,
      (ARRAY_AGG(d.status ORDER BY d.date DESC))[1]::TEXT AS status,
      MAX(d.objective)::TEXT AS objective,
      COUNT(DISTINCT d.date)::INT AS days_active,
      COALESCE(SUM(d.spend), 0) AS total_spend,
      COALESCE(SUM(d.impressions), 0)::BIGINT AS total_impressions,
      COALESCE(SUM(d.reach), 0)::BIGINT AS total_reach,
      COALESCE(SUM(d.clicks), 0)::BIGINT AS total_clicks,
      COALESCE(SUM(d.link_clicks), 0)::BIGINT AS total_link_clicks,
      COALESCE(SUM(d.purchases), 0)::BIGINT AS total_purchases,
      COALESCE(SUM(d.purchase_value), 0) AS total_purchase_value,
      COALESCE(SUM(d.leads), 0)::BIGINT AS total_leads,
      COALESCE(SUM(d.results), 0)::BIGINT AS total_results,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.impressions) * 1000, 2)
        ELSE NULL END AS avg_cpm,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.link_clicks)::NUMERIC / SUM(d.impressions) * 100, 2)
        ELSE NULL END AS avg_ctr_link,
      CASE WHEN SUM(d.link_clicks) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.link_clicks), 2)
        ELSE NULL END AS avg_cpc,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS avg_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS overall_roas,
      CASE WHEN SUM(d.impressions) > 0 AND SUM(d.reach) > 0
        THEN ROUND(SUM(d.impressions)::NUMERIC / NULLIF(SUM(d.reach), 0), 2)
        ELSE NULL END AS avg_frequency
    FROM daily d
    GROUP BY d.campaign_id
  ),
  last3 AS (
    SELECT
      d.campaign_id::TEXT AS campaign_id,
      COALESCE(SUM(d.spend), 0) AS last_3d_spend,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS last_3d_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS last_3d_roas
    FROM daily d
    WHERE d.date >= v_last_3d
    GROUP BY d.campaign_id
  )
  SELECT
    a.campaign_id,
    a.campaign_name,
    a.status,
    a.objective,
    a.days_active,
    a.total_spend,
    a.total_impressions,
    a.total_reach,
    a.total_clicks,
    a.total_link_clicks,
    a.total_purchases,
    a.total_purchase_value,
    a.total_leads,
    a.total_results,
    a.avg_cpm,
    a.avg_ctr_link,
    a.avg_cpc,
    a.avg_cost_per_result,
    a.overall_roas,
    a.avg_frequency,
    COALESCE(l.last_3d_spend, 0),
    l.last_3d_cost_per_result,
    l.last_3d_roas
  FROM agg a
  LEFT JOIN last3 l ON a.campaign_id = l.campaign_id
  ORDER BY a.total_spend DESC;
END;
$$;


-- ============================================================================
-- 2. get_adset_summary — 1 row per adset
-- ============================================================================
CREATE OR REPLACE FUNCTION get_adset_summary(
  p_client_code TEXT,
  p_campaign_id TEXT DEFAULT NULL,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  status TEXT,
  targeting_audience_type TEXT,
  days_active INT,
  total_spend NUMERIC,
  total_impressions BIGINT,
  total_reach BIGINT,
  total_clicks BIGINT,
  total_link_clicks BIGINT,
  total_purchases BIGINT,
  total_purchase_value NUMERIC,
  total_results BIGINT,
  avg_cpm NUMERIC,
  avg_ctr_link NUMERIC,
  avg_cpc NUMERIC,
  avg_cost_per_result NUMERIC,
  overall_roas NUMERIC,
  avg_frequency NUMERIC,
  last_3d_spend NUMERIC,
  last_3d_cost_per_result NUMERIC,
  last_3d_roas NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_client_id UUID;
  v_since DATE := CURRENT_DATE - p_days;
  v_last_3d DATE := CURRENT_DATE - 3;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE code = p_client_code;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client % not found', p_client_code;
  END IF;

  RETURN QUERY
  WITH daily AS (
    SELECT * FROM adset_daily
    WHERE client_id = v_client_id
      AND date >= v_since
      AND (p_campaign_id IS NULL OR adset_daily.campaign_id = p_campaign_id)
  ),
  agg AS (
    SELECT
      d.campaign_id::TEXT AS campaign_id,
      MAX(cd.cname)::TEXT AS campaign_name,
      d.adset_id::TEXT AS adset_id,
      MAX(d.adset_name)::TEXT AS adset_name,
      (ARRAY_AGG(d.status ORDER BY d.date DESC))[1]::TEXT AS status,
      MAX(d.targeting_audience_type)::TEXT AS targeting_audience_type,
      COUNT(DISTINCT d.date)::INT AS days_active,
      COALESCE(SUM(d.spend), 0) AS total_spend,
      COALESCE(SUM(d.impressions), 0)::BIGINT AS total_impressions,
      COALESCE(SUM(d.reach), 0)::BIGINT AS total_reach,
      COALESCE(SUM(d.clicks), 0)::BIGINT AS total_clicks,
      COALESCE(SUM(d.link_clicks), 0)::BIGINT AS total_link_clicks,
      COALESCE(SUM(d.purchases), 0)::BIGINT AS total_purchases,
      COALESCE(SUM(d.purchase_value), 0) AS total_purchase_value,
      COALESCE(SUM(d.results), 0)::BIGINT AS total_results,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.impressions) * 1000, 2)
        ELSE NULL END AS avg_cpm,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.link_clicks)::NUMERIC / SUM(d.impressions) * 100, 2)
        ELSE NULL END AS avg_ctr_link,
      CASE WHEN SUM(d.link_clicks) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.link_clicks), 2)
        ELSE NULL END AS avg_cpc,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS avg_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS overall_roas,
      CASE WHEN SUM(d.impressions) > 0 AND SUM(d.reach) > 0
        THEN ROUND(SUM(d.impressions)::NUMERIC / NULLIF(SUM(d.reach), 0), 2)
        ELSE NULL END AS avg_frequency
    FROM daily d
    LEFT JOIN LATERAL (
      SELECT cd2.campaign_name AS cname FROM campaign_daily cd2
      WHERE cd2.campaign_id = d.campaign_id AND cd2.client_id = v_client_id
      ORDER BY cd2.date DESC LIMIT 1
    ) cd ON true
    GROUP BY d.campaign_id, d.adset_id
  ),
  last3 AS (
    SELECT
      d.adset_id::TEXT AS adset_id,
      COALESCE(SUM(d.spend), 0) AS last_3d_spend,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS last_3d_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS last_3d_roas
    FROM daily d
    WHERE d.date >= v_last_3d
    GROUP BY d.adset_id
  )
  SELECT
    a.campaign_id,
    a.campaign_name,
    a.adset_id,
    a.adset_name,
    a.status,
    a.targeting_audience_type,
    a.days_active,
    a.total_spend,
    a.total_impressions,
    a.total_reach,
    a.total_clicks,
    a.total_link_clicks,
    a.total_purchases,
    a.total_purchase_value,
    a.total_results,
    a.avg_cpm,
    a.avg_ctr_link,
    a.avg_cpc,
    a.avg_cost_per_result,
    a.overall_roas,
    a.avg_frequency,
    COALESCE(l.last_3d_spend, 0),
    l.last_3d_cost_per_result,
    l.last_3d_roas
  FROM agg a
  LEFT JOIN last3 l ON a.adset_id = l.adset_id
  ORDER BY a.total_spend DESC;
END;
$$;


-- ============================================================================
-- 3. get_ad_summary — 1 row per ad
-- ============================================================================
CREATE OR REPLACE FUNCTION get_ad_summary(
  p_client_code TEXT,
  p_campaign_id TEXT DEFAULT NULL,
  p_adset_id TEXT DEFAULT NULL,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  ad_name TEXT,
  status TEXT,
  creative_id TEXT,
  days_active INT,
  total_spend NUMERIC,
  total_impressions BIGINT,
  total_reach BIGINT,
  total_clicks BIGINT,
  total_link_clicks BIGINT,
  total_purchases BIGINT,
  total_purchase_value NUMERIC,
  total_results BIGINT,
  total_thruplays BIGINT,
  total_video_plays BIGINT,
  avg_cpm NUMERIC,
  avg_ctr_link NUMERIC,
  avg_cpc NUMERIC,
  avg_cost_per_result NUMERIC,
  overall_roas NUMERIC,
  avg_frequency NUMERIC,
  avg_hook_rate NUMERIC,
  avg_hold_rate NUMERIC,
  avg_conversion_rate NUMERIC,
  last_3d_spend NUMERIC,
  last_3d_cost_per_result NUMERIC,
  last_3d_roas NUMERIC
) LANGUAGE plpgsql AS $$
DECLARE
  v_client_id UUID;
  v_since DATE := CURRENT_DATE - p_days;
  v_last_3d DATE := CURRENT_DATE - 3;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE code = p_client_code;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client % not found', p_client_code;
  END IF;

  -- Require at least one filter to avoid huge result sets
  IF p_campaign_id IS NULL AND p_adset_id IS NULL THEN
    RAISE EXCEPTION 'Must provide campaign_id or adset_id to avoid huge result sets';
  END IF;

  RETURN QUERY
  WITH daily AS (
    SELECT * FROM ad_daily
    WHERE client_id = v_client_id
      AND date >= v_since
      AND (p_campaign_id IS NULL OR ad_daily.campaign_id = p_campaign_id)
      AND (p_adset_id IS NULL OR ad_daily.adset_id = p_adset_id)
  ),
  agg AS (
    SELECT
      d.campaign_id::TEXT AS campaign_id,
      d.adset_id::TEXT AS adset_id,
      d.ad_id::TEXT AS ad_id,
      MAX(d.ad_name)::TEXT AS ad_name,
      (ARRAY_AGG(d.status ORDER BY d.date DESC))[1]::TEXT AS status,
      MAX(d.creative_id)::TEXT AS creative_id,
      COUNT(DISTINCT d.date)::INT AS days_active,
      COALESCE(SUM(d.spend), 0) AS total_spend,
      COALESCE(SUM(d.impressions), 0)::BIGINT AS total_impressions,
      COALESCE(SUM(d.reach), 0)::BIGINT AS total_reach,
      COALESCE(SUM(d.clicks), 0)::BIGINT AS total_clicks,
      COALESCE(SUM(d.link_clicks), 0)::BIGINT AS total_link_clicks,
      COALESCE(SUM(d.purchases), 0)::BIGINT AS total_purchases,
      COALESCE(SUM(d.purchase_value), 0) AS total_purchase_value,
      COALESCE(SUM(d.results), 0)::BIGINT AS total_results,
      COALESCE(SUM(d.thruplays), 0)::BIGINT AS total_thruplays,
      COALESCE(SUM(d.video_plays), 0)::BIGINT AS total_video_plays,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.impressions) * 1000, 2)
        ELSE NULL END AS avg_cpm,
      CASE WHEN SUM(d.impressions) > 0
        THEN ROUND(SUM(d.link_clicks)::NUMERIC / SUM(d.impressions) * 100, 2)
        ELSE NULL END AS avg_ctr_link,
      CASE WHEN SUM(d.link_clicks) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.link_clicks), 2)
        ELSE NULL END AS avg_cpc,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS avg_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS overall_roas,
      CASE WHEN SUM(d.impressions) > 0 AND SUM(d.reach) > 0
        THEN ROUND(SUM(d.impressions)::NUMERIC / NULLIF(SUM(d.reach), 0), 2)
        ELSE NULL END AS avg_frequency,
      -- Impression-weighted hook rate and hold rate
      CASE WHEN SUM(CASE WHEN d.hook_rate IS NOT NULL THEN d.impressions ELSE 0 END) > 0
        THEN ROUND(SUM(COALESCE(d.hook_rate, 0) * d.impressions) / SUM(CASE WHEN d.hook_rate IS NOT NULL THEN d.impressions ELSE 0 END), 4)
        ELSE NULL END AS avg_hook_rate,
      CASE WHEN SUM(CASE WHEN d.hold_rate IS NOT NULL THEN d.impressions ELSE 0 END) > 0
        THEN ROUND(SUM(COALESCE(d.hold_rate, 0) * d.impressions) / SUM(CASE WHEN d.hold_rate IS NOT NULL THEN d.impressions ELSE 0 END), 4)
        ELSE NULL END AS avg_hold_rate,
      CASE WHEN SUM(CASE WHEN d.conversion_rate IS NOT NULL THEN d.impressions ELSE 0 END) > 0
        THEN ROUND(SUM(COALESCE(d.conversion_rate, 0) * d.impressions) / SUM(CASE WHEN d.conversion_rate IS NOT NULL THEN d.impressions ELSE 0 END), 4)
        ELSE NULL END AS avg_conversion_rate
    FROM daily d
    GROUP BY d.campaign_id, d.adset_id, d.ad_id
  ),
  last3 AS (
    SELECT
      d.ad_id::TEXT AS ad_id,
      COALESCE(SUM(d.spend), 0) AS last_3d_spend,
      CASE WHEN SUM(d.results) > 0
        THEN ROUND(SUM(d.spend) / SUM(d.results), 2)
        ELSE NULL END AS last_3d_cost_per_result,
      CASE WHEN SUM(d.spend) > 0
        THEN ROUND(SUM(d.purchase_value) / SUM(d.spend), 2)
        ELSE NULL END AS last_3d_roas
    FROM daily d
    WHERE d.date >= v_last_3d
    GROUP BY d.ad_id
  )
  SELECT
    a.campaign_id,
    a.adset_id,
    a.ad_id,
    a.ad_name,
    a.status,
    a.creative_id,
    a.days_active,
    a.total_spend,
    a.total_impressions,
    a.total_reach,
    a.total_clicks,
    a.total_link_clicks,
    a.total_purchases,
    a.total_purchase_value,
    a.total_results,
    a.total_thruplays,
    a.total_video_plays,
    a.avg_cpm,
    a.avg_ctr_link,
    a.avg_cpc,
    a.avg_cost_per_result,
    a.overall_roas,
    a.avg_frequency,
    a.avg_hook_rate,
    a.avg_hold_rate,
    a.avg_conversion_rate,
    COALESCE(l.last_3d_spend, 0),
    l.last_3d_cost_per_result,
    l.last_3d_roas
  FROM agg a
  LEFT JOIN last3 l ON a.ad_id = l.ad_id
  ORDER BY a.total_spend DESC;
END;
$$;
