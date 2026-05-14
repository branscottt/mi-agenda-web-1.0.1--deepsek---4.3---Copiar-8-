-- Alinear CHECK constraint de subscriptions.plan con los nombres del frontend
-- Frontend usa: 'freemium', 'pro', 'premium_anual'
-- Antes era: ('freemium', 'premium', 'enterprise')

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('freemium', 'pro', 'premium_anual'));