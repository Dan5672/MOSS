ALTER TABLE "agents" ADD COLUMN "effort" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "hostnames" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "notes" text;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_services_port_idx" ON "asset_services" USING btree ("asset_id","protocol","port");