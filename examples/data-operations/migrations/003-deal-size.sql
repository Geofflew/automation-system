CREATE FUNCTION deal_size(amount numeric) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE WHEN amount >= 5000 THEN 'large' WHEN amount >= 1000 THEN 'mid' ELSE 'small' END $$;
