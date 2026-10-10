CREATE TABLE "custom_tool_grants" (
	"tool_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_tool_grants_tool_id_agent_id_pk" PRIMARY KEY("tool_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "custom_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"key" text NOT NULL,
	"spec" jsonb NOT NULL,
	"source" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_tool_grants" ADD CONSTRAINT "custom_tool_grants_tool_id_custom_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."custom_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_tool_grants" ADD CONSTRAINT "custom_tool_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_tool_grants" ADD CONSTRAINT "custom_tool_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD CONSTRAINT "custom_tools_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_tools_org_key_idx" ON "custom_tools" USING btree ("org_id","key");