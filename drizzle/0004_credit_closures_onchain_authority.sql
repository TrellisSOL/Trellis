ALTER TABLE "credit_closures" ALTER COLUMN "signature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_closures" ADD COLUMN "authority" text;