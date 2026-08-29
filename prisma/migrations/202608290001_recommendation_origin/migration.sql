CREATE TYPE "RecommendationOrigin" AS ENUM (
  'AI_GENERATED',
  'DEMO_SEEDED',
  'MANUAL',
  'IMPORTED',
  'LEGACY_UNKNOWN'
);

ALTER TABLE "recommendations"
  ADD COLUMN "origin" "RecommendationOrigin" NOT NULL DEFAULT 'LEGACY_UNKNOWN';
