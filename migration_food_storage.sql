-- Add food as a stored resource on countries
ALTER TABLE public.countries ADD COLUMN IF NOT EXISTS food FLOAT DEFAULT 0;
