ALTER TABLE "receipt_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "credit_note_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "debit_note_allocations" ADD COLUMN "applied_on" date;
