-- Pro is the single paid public tier: Rp149.000/month, 300.000 tokens, GPT-5.6 Sol.
-- Keep plus as an inactive legacy key so historic payment rows remain valid.
UPDATE plan_catalog
SET display_name = 'Pro',
    price_amount = 149000,
    billing_period = 'monthly',
    token_monthly_limit = 300000,
    features = '["Menggunakan GPT-5.6 Sol terbaru untuk kualitas generasi lebih tinggi."]'::jsonb,
    active = true,
    updated_at = now()
WHERE key = 'pro';

UPDATE plan_catalog
SET active = false,
    updated_at = now()
WHERE key = 'plus';
