CREATE TABLE "storefront_payment_gateways" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"store_id" text NOT NULL,
	"mode" text NOT NULL,
	"password_sealed" "bytea" NOT NULL,
	"key_version" smallint NOT NULL,
	"money_account_id" uuid NOT NULL,
	"fee_account_id" uuid NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_problem" text,
	CONSTRAINT "storefront_payment_gateways_values_check" CHECK ("storefront_payment_gateways"."provider" IN ('sslcommerz')
        AND "storefront_payment_gateways"."mode" IN ('sandbox', 'live')
        AND ("storefront_payment_gateways"."last_test_problem" IS NULL OR "storefront_payment_gateways"."last_test_problem" IN ('rejected', 'unreachable'))),
	CONSTRAINT "storefront_payment_gateways_store_id_check" CHECK ("storefront_payment_gateways"."store_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "storefront_payment_gateways_sealed_check" CHECK (octet_length("storefront_payment_gateways"."password_sealed") BETWEEN 29 AND 540
        AND "storefront_payment_gateways"."key_version" >= 1),
	CONSTRAINT "storefront_payment_gateways_accounts_check" CHECK ("storefront_payment_gateways"."money_account_id" <> "storefront_payment_gateways"."fee_account_id"),
	CONSTRAINT "storefront_payment_gateways_test_check" CHECK ("storefront_payment_gateways"."last_test_problem" IS NULL OR "storefront_payment_gateways"."last_tested_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "storefront_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"try_no" smallint NOT NULL,
	"tran_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"val_id" text,
	"card_type" text,
	"bank_tran_id" text,
	"store_amount" numeric(19, 4),
	"receipt_id" uuid,
	"receipt_error" text,
	CONSTRAINT "storefront_payments_try_key" UNIQUE("tenant_id","order_id","try_no"),
	CONSTRAINT "storefront_payments_values_check" CHECK ("storefront_payments"."status" IN ('started', 'not_opened', 'paid', 'failed', 'cancelled')
        AND "storefront_payments"."provider" IN ('sslcommerz')
        AND "storefront_payments"."mode" IN ('sandbox', 'live')),
	CONSTRAINT "storefront_payments_try_no_check" CHECK ("storefront_payments"."try_no" BETWEEN 1 AND 3),
	CONSTRAINT "storefront_payments_tran_id_check" CHECK ("storefront_payments"."tran_id" ~ '^[A-Z0-9]{20}$'),
	CONSTRAINT "storefront_payments_amounts_check" CHECK ("storefront_payments"."amount" > 0 AND "storefront_payments"."amount" = round("storefront_payments"."amount", 2)
        AND ("storefront_payments"."store_amount" IS NULL OR ("storefront_payments"."store_amount" >= 0
          AND "storefront_payments"."store_amount" <= "storefront_payments"."amount"
          AND "storefront_payments"."store_amount" = round("storefront_payments"."store_amount", 2)))),
	CONSTRAINT "storefront_payments_status_check" CHECK (("storefront_payments"."status" IN ('started', 'not_opened')) = ("storefront_payments"."settled_at" IS NULL)
        AND ("storefront_payments"."status" = 'paid') = ("storefront_payments"."val_id" IS NOT NULL AND "storefront_payments"."store_amount" IS NOT NULL)
        AND ("storefront_payments"."status" = 'paid' OR num_nonnulls("storefront_payments"."val_id", "storefront_payments"."store_amount", "storefront_payments"."card_type", "storefront_payments"."bank_tran_id", "storefront_payments"."receipt_id", "storefront_payments"."receipt_error") = 0)
        AND num_nonnulls("storefront_payments"."receipt_id", "storefront_payments"."receipt_error") <= 1),
	CONSTRAINT "storefront_payments_text_check" CHECK (("storefront_payments"."val_id" IS NULL OR char_length("storefront_payments"."val_id") BETWEEN 1 AND 64)
        AND ("storefront_payments"."card_type" IS NULL OR char_length("storefront_payments"."card_type") BETWEEN 1 AND 100)
        AND ("storefront_payments"."bank_tran_id" IS NULL OR char_length("storefront_payments"."bank_tran_id") BETWEEN 1 AND 100)),
	CONSTRAINT "storefront_payments_receipt_error_check" CHECK ("storefront_payments"."receipt_error" IS NULL OR "storefront_payments"."receipt_error" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "storefront_orders" DROP CONSTRAINT "storefront_orders_pending_check";--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_money_account_fk" FOREIGN KEY ("tenant_id","money_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_fee_account_fk" FOREIGN KEY ("tenant_id","fee_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_tran_id_idx" ON "storefront_payments" USING btree ("tenant_id","tran_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_val_id_idx" ON "storefront_payments" USING btree ("tenant_id","val_id") WHERE "storefront_payments"."val_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_receipt_idx" ON "storefront_payments" USING btree ("tenant_id","receipt_id") WHERE "storefront_payments"."receipt_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_pending_check" CHECK (("storefront_orders"."status" = 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left")
            = CASE "storefront_orders"."payment_method" WHEN 'cod' THEN 5 ELSE 0 END
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 0)
        OR ("storefront_orders"."status" <> 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 0
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 3));