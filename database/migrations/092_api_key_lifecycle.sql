-- Phase 23.2 (plans/PLAN_Phase_23_Security_Hardening.md §8, task 5) — API-key lifecycle.
--
-- Additive only (AGENTS.md §3.5): two new nullable JSONB columns on api_keys, no change to
-- existing rows' meaning. A NULL/empty value keeps the previous behaviour — unrestricted scopes
-- and no IP restriction — so every key issued before this migration keeps working unchanged.
--
-- scopes is the key's scope restriction (PLAN §17.2 "Scope restrictions"): a JSON array drawn from
-- {'read','write'} where 'write' implies 'read'. NULL or [] means unrestricted (backward
-- compatible); ['read'] limits the key to safe HTTP methods.
--
-- allowed_ips is the optional IP restriction (PLAN §17.2 "IP restrictions as optional policy"):
-- a JSON array of IP addresses or CIDR ranges the key may authenticate from. NULL or [] means any
-- source address.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes JSONB;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_ips JSONB;
