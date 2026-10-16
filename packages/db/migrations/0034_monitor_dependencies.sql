ALTER TABLE "monitors" ADD COLUMN "parent_monitor_id" uuid;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_parent_monitor_id_monitors_id_fk" FOREIGN KEY ("parent_monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitors_parent_idx" ON "monitors" USING btree ("parent_monitor_id");