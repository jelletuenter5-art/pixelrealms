-- Add outpost and trading_post to the infrastructure type check constraint.
-- The old constraint only allowed: farm, mine, market, barracks, wall.
ALTER TABLE public.infrastructure
  DROP CONSTRAINT infrastructure_type_check;

ALTER TABLE public.infrastructure
  ADD CONSTRAINT infrastructure_type_check
  CHECK (type IN ('farm', 'mine', 'market', 'barracks', 'wall', 'outpost', 'trading_post'));
