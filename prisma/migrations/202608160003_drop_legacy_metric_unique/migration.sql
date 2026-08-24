-- The native-statistics migration created the new uniqueness key, but Prisma
-- shortened the legacy index name in the database.  Leaving that old key in
-- place makes MIN/MAX/P95 collide with MEAN during createMany(...,
-- skipDuplicates: true).  Remove the legacy key so statistic is part of the
-- effective identity of a technical sample.
DROP INDEX IF EXISTS "resource_metric_samples_cloud_connection_id_external_resour_key";
