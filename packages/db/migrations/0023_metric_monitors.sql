ALTER TYPE "public"."monitor_kind" ADD VALUE 'snmp';--> statement-breakpoint
ALTER TYPE "public"."monitor_kind" ADD VALUE 'host';--> statement-breakpoint
ALTER TYPE "public"."monitor_kind" ADD VALUE 'ha_sensor';--> statement-breakpoint
ALTER TABLE "monitor_results" ADD COLUMN "value" double precision;--> statement-breakpoint
ALTER TABLE "monitor_results" ADD COLUMN "values" jsonb;