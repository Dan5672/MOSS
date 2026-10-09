ALTER TABLE "networks" ADD COLUMN "dns_server" "inet";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "core" boolean DEFAULT false NOT NULL;