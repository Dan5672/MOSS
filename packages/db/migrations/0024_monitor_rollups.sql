CREATE TABLE "monitor_rollups" (
	"monitor_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"checks" integer NOT NULL,
	"ok" integer NOT NULL,
	"degraded" integer NOT NULL,
	"latency_min" double precision,
	"latency_avg" double precision,
	"latency_max" double precision,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "monitor_rollups_monitor_id_resolution_bucket_pk" PRIMARY KEY("monitor_id","resolution","bucket")
);
--> statement-breakpoint
ALTER TABLE "monitor_rollups" ADD CONSTRAINT "monitor_rollups_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_rollups_bucket_idx" ON "monitor_rollups" USING btree ("resolution","bucket");