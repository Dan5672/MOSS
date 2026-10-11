CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"edited_by_user_id" uuid,
	"edited_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_note_id_knowledge_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."knowledge_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_edited_by_agent_id_agents_id_fk" FOREIGN KEY ("edited_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_revisions_note_idx" ON "knowledge_revisions" USING btree ("note_id","created_at");--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_parent_id_knowledge_notes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_notes_org_slug_idx" ON "knowledge_notes" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_notes_asset_idx" ON "knowledge_notes" USING btree ("asset_id");--> statement-breakpoint
-- Existing notes become wiki pages: a slug from the title, made unique with part of the id.
UPDATE "knowledge_notes"
SET "slug" = coalesce(nullif(trim(both '-' from lower(regexp_replace(left("title", 60), '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'page') || '-' || left("id"::text, 6)
WHERE "slug" IS NULL;
