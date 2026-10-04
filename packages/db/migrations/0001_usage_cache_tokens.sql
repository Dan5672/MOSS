ALTER TABLE "models" ADD COLUMN "cache_read_price_per_mtok" numeric(12, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "cache_write_price_per_mtok" numeric(12, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "served_model" text;