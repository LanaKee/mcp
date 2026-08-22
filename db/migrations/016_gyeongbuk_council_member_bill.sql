-- 016_gyeongbuk_council_member_bill.sql
-- Store 경상북도의회 members and the bills they sponsored.
--
-- This is a *legislative activity* record, not a statistical observation and
-- not a pledge register. The council publishes who led a bill (대표발의) and who
-- merely signed on (공동발의); conflating the two would badly misattribute
-- credit, so sponsorship lives in its own table with an explicit role.
--
-- Nothing here says whether a member kept an election promise. The council site
-- does not publish pledges at all. These tables provide the evidence a reader
-- needs to judge that for themselves, and the MCP tool is required to say so.
--
-- Note: the pre-existing `council_record` table holds 포항시의회 (Pohang *city*
-- council) minutes. That is a different body and the two must not be merged.

CREATE TABLE IF NOT EXISTS council_member (
  council_member_id text PRIMARY KEY,
  council_name text NOT NULL,
  -- The site's own member key, used as `search_code` in every member URL.
  -- Its leading digits encode the term in which the member first took office,
  -- so it is stable for a person but is NOT a term identifier.
  search_code text NOT NULL,
  site_member_id text,
  name text NOT NULL,
  party text,
  district text,
  -- The electoral district's city/county, when it resolves to a canonical
  -- Gyeongbuk region. Proportional-representation seats leave this null.
  region_id text REFERENCES dim_region(region_id),
  position text,
  office_phone text,
  education text,
  career text,
  photo_url text,
  homepage_url text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (council_name, search_code)
);

CREATE INDEX IF NOT EXISTS council_member_name_idx ON council_member (name);

CREATE INDEX IF NOT EXISTS council_member_name_trgm_idx
  ON council_member USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS council_member_party_idx
  ON council_member (party)
  WHERE party IS NOT NULL;

CREATE INDEX IF NOT EXISTS council_member_region_idx
  ON council_member (region_id)
  WHERE region_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS council_member_career_fts_idx
  ON council_member USING gin (to_tsvector('simple', coalesce(career, '')));

CREATE TABLE IF NOT EXISTS council_bill (
  council_bill_id text PRIMARY KEY,
  council_name text NOT NULL,
  -- 32-hex key the council site uses as the bill's primary key.
  bill_uid text NOT NULL,
  -- 의안번호 as printed. Not unique across terms, which is why bill_uid is the
  -- natural key rather than this.
  bill_number text,
  title text NOT NULL,
  -- 의안종류 inferred from the title (조례안, 결의안, 건의안 …).
  bill_kind text,
  -- 제안자 category as printed: 의원, 도지사, 교육감, 위원회 …
  proposer_kind text,
  committee text,
  session_name text,
  proposed_date date,
  decided_date date,
  -- 상태 as printed on the list row: 처리완료, 접수완료 …
  status text,
  -- 처리결과: 원안가결, 수정가결, 부결, 폐기, 철회 …
  outcome text,
  lead_sponsor_count integer NOT NULL DEFAULT 0 CHECK (lead_sponsor_count >= 0),
  co_sponsor_count integer NOT NULL DEFAULT 0 CHECK (co_sponsor_count >= 0),
  detail_url text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (council_name, bill_uid)
);

CREATE INDEX IF NOT EXISTS council_bill_proposed_date_idx
  ON council_bill (proposed_date DESC);

CREATE INDEX IF NOT EXISTS council_bill_committee_idx
  ON council_bill (committee)
  WHERE committee IS NOT NULL;

CREATE INDEX IF NOT EXISTS council_bill_kind_idx
  ON council_bill (bill_kind)
  WHERE bill_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS council_bill_title_fts_idx
  ON council_bill USING gin (to_tsvector('simple', title));

CREATE INDEX IF NOT EXISTS council_bill_title_trgm_idx
  ON council_bill USING gin (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS council_bill_sponsor (
  council_bill_id text NOT NULL REFERENCES council_bill(council_bill_id) ON DELETE CASCADE,
  -- 'lead' is 대표발의 (the member who introduced the bill); 'co' is 공동발의
  -- (a member who signed on). Aggregating the two hides who actually drove a
  -- bill, so consumers must filter on this explicitly.
  role text NOT NULL CHECK (role IN ('lead', 'co')),
  member_name text NOT NULL,
  -- Null when the sponsor is not on the current roster, e.g. a member of an
  -- earlier term. The name is kept regardless so the bill record stays honest.
  council_member_id text REFERENCES council_member(council_member_id),
  PRIMARY KEY (council_bill_id, role, member_name)
);

CREATE INDEX IF NOT EXISTS council_bill_sponsor_member_idx
  ON council_bill_sponsor (council_member_id, role)
  WHERE council_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS council_bill_sponsor_name_idx
  ON council_bill_sponsor (member_name);
