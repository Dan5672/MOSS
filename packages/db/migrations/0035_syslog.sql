CREATE TABLE "log_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "log_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"asset_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logged_at" timestamp with time zone,
	"source_ip" "inet" NOT NULL,
	"transport" text DEFAULT 'udp' NOT NULL,
	"hostname" text,
	"app" text,
	"severity" integer,
	"facility" text,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_source_id_monitor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."monitor_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_entries_org_received_idx" ON "log_entries" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "log_entries_asset_received_idx" ON "log_entries" USING btree ("asset_id","received_at");