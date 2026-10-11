ALTER TABLE "agent_runs" ADD COLUMN "task" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;