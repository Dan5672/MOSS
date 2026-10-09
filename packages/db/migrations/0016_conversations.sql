CREATE TABLE "conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_reads" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" text NOT NULL,
	"name" text,
	"topic" text,
	"dm_key" text,
	"created_by_user_id" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_user_idx" ON "conversation_members" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_agent_idx" ON "conversation_members" USING btree ("conversation_id","agent_id");--> statement-breakpoint
CREATE INDEX "conversation_members_by_user_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_members_by_agent_idx" ON "conversation_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conv_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_dm_idx" ON "conversations" USING btree ("org_id","dm_key");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_name_idx" ON "conversations" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "conversations_org_updated_idx" ON "conversations" USING btree ("org_id","updated_at");--> statement-breakpoint
-- Copy each person-and-agent chat into a DM (several threads between the same pair become one DM).
INSERT INTO "conversations" ("id", "org_id", "kind", "dm_key", "created_at", "updated_at")
SELECT gen_random_uuid(), t."org_id", 'dm', 'a:' || t."agent_id" || '|u:' || t."user_id", min(t."created_at"), max(t."updated_at")
FROM "chat_threads" t
GROUP BY t."org_id", t."agent_id", t."user_id";
--> statement-breakpoint
INSERT INTO "conversation_members" ("id", "conversation_id", "user_id")
SELECT gen_random_uuid(), c."id", t."user_id"
FROM "chat_threads" t JOIN "conversations" c ON c."org_id" = t."org_id" AND c."dm_key" = 'a:' || t."agent_id" || '|u:' || t."user_id"
GROUP BY c."id", t."user_id";
--> statement-breakpoint
INSERT INTO "conversation_members" ("id", "conversation_id", "agent_id")
SELECT gen_random_uuid(), c."id", t."agent_id"
FROM "chat_threads" t JOIN "conversations" c ON c."org_id" = t."org_id" AND c."dm_key" = 'a:' || t."agent_id" || '|u:' || t."user_id"
GROUP BY c."id", t."agent_id";
--> statement-breakpoint
INSERT INTO "conversation_messages" ("id", "conversation_id", "author_user_id", "author_agent_id", "body", "run_id", "status", "created_at")
SELECT gen_random_uuid(), c."id",
  CASE WHEN m."role" = 'user' THEN t."user_id" END,
  CASE WHEN m."role" = 'agent' THEN t."agent_id" END,
  m."content", m."run_id", m."status", m."created_at"
FROM "chat_messages" m
JOIN "chat_threads" t ON t."id" = m."thread_id"
JOIN "conversations" c ON c."org_id" = t."org_id" AND c."dm_key" = 'a:' || t."agent_id" || '|u:' || t."user_id";
--> statement-breakpoint
INSERT INTO "conversation_reads" ("conversation_id", "user_id", "last_read_at")
SELECT c."id", t."user_id", now()
FROM "chat_threads" t JOIN "conversations" c ON c."org_id" = t."org_id" AND c."dm_key" = 'a:' || t."agent_id" || '|u:' || t."user_id"
GROUP BY c."id", t."user_id";
