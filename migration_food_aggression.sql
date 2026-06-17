-- Track war aggression: increases food consumption by 0.05 per pixel captured,
-- decays at 0.01/hr so aggressive nations need more farms to sustain their military
ALTER TABLE public.countries ADD COLUMN IF NOT EXISTS food_aggression FLOAT DEFAULT 0;
