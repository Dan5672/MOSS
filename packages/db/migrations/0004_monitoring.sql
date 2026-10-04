CREATE TYPE "public"."monitor_kind" AS ENUM('ping', 'tcp', 'http', 'tls', 'dns', 'external');--> statement-breakpoint
CREATE TYPE "public"."monitor_state" AS ENUM('pending', 'up', 'degraded', 'down', 'paused');--> statement-breakpoint
CREATE TABLE "monitor_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "monitor_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"monitor_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"message" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"default_priority" "priority" DEFAULT 'P3' NOT NULL,
	"default_responder_agent_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_state_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "monitor_state_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"monitor_id" uuid NOT NULL,
	"from" "monitor_state" NOT NULL,
	"to" "monitor_state" NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"kind" "monitor_kind" NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"asset_id" uuid,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_seconds" integer DEFAULT 10 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"recovery_threshold" integer DEFAULT 2 NOT NULL,
	"priority" "priority" DEFAULT 'P3' NOT NULL,
	"responder_agent_id" uuid,
	"responder_user_id" uuid,
	"auto_resolve" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" "monitor_state" DEFAULT 'pending' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_check_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_result" jsonb,
	"open_incident_id" uuid,
	"source_id" uuid,
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_results" ADD CONSTRAINT "monitor_results_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_sources" ADD CONSTRAINT "monitor_sources_default_responder_agent_id_agents_id_fk" FOREIGN KEY ("default_responder_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_state_changes" ADD CONSTRAINT "monitor_state_changes_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_responder_agent_id_agents_id_fk" FOREIGN KEY ("responder_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_responder_user_id_users_id_fk" FOREIGN KEY ("responder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_open_incident_id_incidents_id_fk" FOREIGN KEY ("open_incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_source_id_monitor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."monitor_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_results_monitor_at_idx" ON "monitor_results" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "monitor_state_changes_monitor_at_idx" ON "monitor_state_changes" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_source_key_idx" ON "monitors" USING btree ("source_id","external_key");--> statement-breakpoint
CREATE INDEX "monitors_asset_idx" ON "monitors" USING btree ("asset_id");