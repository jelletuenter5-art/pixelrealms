-- Repair gold for all players that have NULL or 0 gold due to the offline-accrual
-- bug (income_per_pixel was null for new players, draining gold to 0 over time).
-- Also set last_active for players that never had it set (prevents future drain).
UPDATE public.countries
SET
  gold = CASE WHEN gold IS NULL OR gold <= 0 THEN 100 ELSE gold END,
  last_active = CASE WHEN last_active IS NULL THEN now() ELSE last_active END,
  income_per_pixel = CASE WHEN income_per_pixel IS NULL THEN 2 ELSE income_per_pixel END,
  army_upkeep_per_pixel = CASE WHEN army_upkeep_per_pixel IS NULL THEN 0.3 ELSE army_upkeep_per_pixel END;
