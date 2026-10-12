-- Each service signs in to Postgres as its own role (packages/db/src/roles.ts). Table grants keep the worker and the
-- chat bridge away from what the gate trusts (secrets, grants, networks, roles, budgets); these triggers cover the
-- few writes they must still make to those records, so a compromised worker or bridge can't approve its own work.

CREATE OR REPLACE FUNCTION moss_guard_change_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user NOT IN ('moss_worker', 'moss_bridge') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Only a standard change from an enabled template, or an emergency change while they're allowed, starts approved.
    IF NEW.status <> 'submitted' AND NOT (
      NEW.status = 'approved' AND (
        -- The same tools, in the same order, as the template (only its parameters fill in the arguments).
        (NEW.type = 'standard' AND EXISTS (
          SELECT 1 FROM standard_change_templates t
          WHERE t.org_id = NEW.org_id AND t.key = NEW.standard_template_key AND t.enabled
            AND (SELECT coalesce(jsonb_agg(c->'tool'), '[]') FROM jsonb_array_elements(t.calls) c)
              = (SELECT coalesce(jsonb_agg(c->'tool'), '[]') FROM jsonb_array_elements(NEW.planned_calls) c)))
        OR (NEW.type = 'emergency' AND NEW.post_review_required AND EXISTS (
          SELECT 1 FROM settings s
          WHERE s.org_id = NEW.org_id AND s.key = 'changes.allow_emergency' AND s.value = 'true'::jsonb))
      )
    ) THEN
      RAISE EXCEPTION 'moss: % may not create a change that is %', current_user, NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  -- Nothing but the status moves: what was approved (the plan, its window, its risk, who asked) is what runs.
  IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'moss: % may only change a change''s status', current_user;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- The worker carries out approved changes and cancels ones the power came back for; it never approves.
    IF current_user = 'moss_worker' AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'cancelled'), ('submitted', 'cancelled'), ('approved', 'cancelled'), ('approved', 'in_progress'),
      ('in_progress', 'verifying'), ('in_progress', 'failed'), ('in_progress', 'rolled_back'),
      ('verifying', 'succeeded'), ('verifying', 'failed'), ('verifying', 'rolled_back'), ('failed', 'rolled_back')) THEN
      RAISE EXCEPTION 'moss: the worker may not move a change from % to %', OLD.status, NEW.status;
    END IF;
    -- A person's chat button: approve or reject a submitted change, never one that must be approved in MOSS.
    IF current_user = 'moss_bridge' AND NOT (
      OLD.status = 'submitted' AND (NEW.status = 'rejected'
        OR (NEW.status = 'approved' AND NEW.risk <> 'high' AND NEW.type <> 'emergency' AND NEW.access_grant IS NULL))) THEN
      RAISE EXCEPTION 'moss: a chat app may not move a change from % to %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_requests_guard BEFORE INSERT OR UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION moss_guard_change_requests();
--> statement-breakpoint

-- The worker keeps a few bookkeeping settings; the kill switch, emergency changes and everything else are people's.
CREATE OR REPLACE FUNCTION moss_guard_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Both the row as it was and as it will be: renaming the kill switch's row away would switch it off.
  IF current_user = 'moss_bridge'
    OR (current_user = 'moss_worker' AND (
      (TG_OP <> 'INSERT' AND OLD.key NOT IN ('backups.last_scheduled', 'https.certificate', 'moss.announced_version', 'ups.shutdown_run', 'licence.reminded'))
      OR (TG_OP <> 'DELETE' AND NEW.key NOT IN ('backups.last_scheduled', 'https.certificate', 'moss.announced_version', 'ups.shutdown_run', 'licence.reminded')))) THEN
    RAISE EXCEPTION 'moss: % may not change the setting %', current_user, COALESCE(NEW.key, OLD.key);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settings_guard BEFORE INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION moss_guard_settings();
--> statement-breakpoint

-- The worker may pause an agent (its hard budget ran out), never bring one back.
CREATE OR REPLACE FUNCTION moss_guard_agents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'moss_worker' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'paused' THEN
    RAISE EXCEPTION 'moss: the worker may not set an agent %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agents_guard BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION moss_guard_agents();
--> statement-breakpoint

-- Agents report networks they find; only a person decides whether one is allowed.
CREATE OR REPLACE FUNCTION moss_guard_networks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'moss_worker' AND NEW.status <> 'unknown' THEN
    RAISE EXCEPTION 'moss: the worker may only report a network, not set it %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER networks_guard BEFORE INSERT ON networks FOR EACH ROW EXECUTE FUNCTION moss_guard_networks();
