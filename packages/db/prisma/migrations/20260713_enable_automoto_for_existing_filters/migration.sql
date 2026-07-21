UPDATE "filters"
SET "sources" = array_append("sources", 'AUTOMOTO'::"ListingSource")
WHERE cardinality("sources") > 0
  AND "sources" && ARRAY['AUTO_RIA', 'OLX', 'RST', 'CARS_UA']::"ListingSource"[]
  AND NOT ('AUTOMOTO'::"ListingSource" = ANY("sources"));
