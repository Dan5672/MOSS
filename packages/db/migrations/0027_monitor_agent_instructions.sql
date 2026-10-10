ALTER TABLE "monitors" ADD COLUMN "agent_instructions" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "agent_instructions_by" uuid;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_agent_instructions_by_users_id_fk" FOREIGN KEY ("agent_instructions_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;