ALTER TABLE "network_fee_ledger" DROP CONSTRAINT "network_fee_status";--> statement-breakpoint
ALTER TABLE "network_fee_ledger" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "network_fee_ledger" DROP COLUMN "swap_tx";--> statement-breakpoint
ALTER TABLE "network_fee_ledger" DROP COLUMN "burn_tx";--> statement-breakpoint
ALTER TABLE "network_fee_ledger" DROP COLUMN "trls_amount";