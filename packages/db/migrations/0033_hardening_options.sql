ALTER TABLE "knowledge_notes" ADD COLUMN "draft" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The hardening options in Settings (docs/hardening.md) hold for the worker and the chat bridge too, not only in the app:
-- emergency changes keep to the owner's tool list, and chat approvals to what the owner allows.
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
          WHERE s.org_id = NEW.org_id AND s.key = 'changes.allow_emergency' AND s.value = 'true'::jsonb)
          -- Only the tools the owner listed for emergencies, when they listed any.
          AND NOT EXISTS (
            SELECT 1 FROM settings s, jsonb_array_elements(NEW.planned_calls || coalesce(NEW.rollback_calls, '[]'::jsonb)) c
            WHERE s.org_id = NEW.org_id AND s.key = 'changes.emergency_tools'
              AND jsonb_typeof(s.value) = 'array' AND jsonb_array_length(s.value) > 0 AND NOT (s.value ? (c->>'tool'))))
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
        OR (NEW.status = 'approved' AND NEW.risk <> 'high' AND NEW.type <> 'emergency' AND NEW.access_grant IS NULL
          -- The owner may allow fewer chat approvals, or none (and approving with a two-factor code rules chat out).
          AND NOT EXISTS (
            SELECT 1 FROM settings s
            WHERE s.org_id = NEW.org_id AND (
              (s.key = 'changes.chat_approvals' AND (s.value = '"off"'::jsonb OR (s.value = '"low_risk"'::jsonb AND NEW.risk <> 'low')))
              OR (s.key = 'changes.approval_totp' AND s.value = 'true'::jsonb)))))) THEN
      RAISE EXCEPTION 'moss: a chat app may not move a change from % to %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- With agent drafts on, what the worker (agents) writes in the wiki is a draft, and a published page isn't the worker's to change.
CREATE OR REPLACE FUNCTION moss_guard_knowledge_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'moss_worker' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.draft AND NOT NEW.draft THEN
    RAISE EXCEPTION 'moss: the worker may not publish a draft';
  END IF;
  IF EXISTS (SELECT 1 FROM settings s WHERE s.org_id = NEW.org_id AND s.key = 'knowledge.agent_drafts' AND s.value = 'true'::jsonb)
    AND (NOT NEW.draft OR (TG_OP = 'UPDATE' AND NOT OLD.draft)) THEN
    RAISE EXCEPTION 'moss: agents may only write drafts';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER knowledge_notes_guard BEFORE INSERT OR UPDATE ON knowledge_notes FOR EACH ROW EXECUTE FUNCTION moss_guard_knowledge_notes();
