-- The invite token is minted and hashed by the auth provider, so the queue
-- row does not need to store one.
ALTER TABLE public.invitations ALTER COLUMN token_hash DROP NOT NULL;