CREATE TABLE "agent_tool_overrides" (
	"agent_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"granted" boolean NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_overrides_agent_id_tool_pk" PRIMARY KEY("agent_id","tool")
);
--> statement-breakpoint
ALTER TABLE "agent_tool_overrides" ADD CONSTRAINT "agent_tool_overrides_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_overrides" ADD CONSTRAINT "agent_tool_overrides_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;