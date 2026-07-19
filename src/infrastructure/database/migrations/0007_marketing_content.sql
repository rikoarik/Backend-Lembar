--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_content" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "locale" text DEFAULT 'id-ID' NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "draft_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketing_content_kind_check" CHECK ("kind" in ('global','page'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_content_slug_locale_unique" ON "marketing_content" USING btree ("slug","locale");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_content_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketing_content_versions_content_id_marketing_content_id_fk"
    FOREIGN KEY ("content_id") REFERENCES "public"."marketing_content"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "marketing_content_versions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_content_versions_content_version_unique" ON "marketing_content_versions" USING btree ("content_id","version");
