CREATE TABLE "host_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"changed_to" text,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "host_pins_org_kind_host_port_idx" ON "host_pins" USING btree ("org_id","kind","host","port");