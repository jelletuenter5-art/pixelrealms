-- Reset food_aggression for all players.
-- Old values were stored as flat food/hr (e.g. 1.0 per capture).
-- New mechanic uses it as extra per-army-unit rate (0.05 per attack).
-- Old values are incompatible and cause absurd consumption numbers.
UPDATE public.countries SET food_aggression = 0;
