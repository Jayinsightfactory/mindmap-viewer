# Railway database query cost repair

Request: reduce the PostgreSQL resource bill without losing tracker/Kakao data.

Observed on production 2026-10-12: in 11 seconds events sequential scans rose
124 and sessions scans rose 60. Concurrent queries included whole-table event
counts, AI-source grouping, recent-session listing and session event retrieval.
The sessions table had no indexes; duplicate IDs exist, so a unique index or
row deduplication is deliberately not part of this change.

Changes: share global statistics for 60 seconds (single in-flight refresh),
combine four event aggregates into one scan, check the target session title
before fetching events, add nonblocking lookup/order indexes, and compare text
event timestamps with a UTC ISO text boundary in the classification query.
Dashboard statistics can lag by up to 60 seconds. Event ingestion is unchanged.

Validation: 199 tests pass with Jest --runInBand --forceExit (the existing
screen-capture test leaves a timer on Windows); frontend build and syntax checks
pass. New tests cover concurrent refresh sharing, TTL, retry, and aggregate
count/fallback compatibility. No business rows deleted or rewritten.

Deployment: migrations 0016–0020 each contain a single CREATE INDEX CONCURRENTLY
statement, run outside an explicit transaction by the existing migration runner.
Check pg_index.indisvalid and post-deploy pg_stat_user_tables scan deltas.
Do not infer immediate billing savings from one sample: cached file pages may
remain resident and should not be forcibly dropped or the DB restarted just to
make a metric smaller.
