ALTER TABLE "change_notes" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;