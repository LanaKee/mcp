# DB 변경: 지방세통계연감 coverage

마이그레이션: `009_local_tax_yearbook_coverage.sql`

`local_tax_revenue.source_grain` 허용값에
`statistical_yearbook_local_collection`을 추가한다. 새 fact table은 만들지 않는다.
연감 값은 기존 headline grain과 같은 지역·연도·세목·수납액 구조지만, 원천 범위를
구별하기 위해 별도 grain으로 저장한다.

도세+시·군세 결합 합계는 삭제하지 않는다. `metadata`에 다음을 기록한다.

- `headlineEligible=false`
- `collectionScope=combined_province_and_local_tax`
- 비교 가능한 연감 대체 source/금액

PostgreSQL repository는 `COALESCE(metadata->>'headlineEligible','true')='true'`인
행만 headline 후보로 ranking한다. 따라서 과거 행을 물리 삭제하지 않으면서 scope가
다른 합계가 trend에 들어가는 것을 막는다.

검증 SQL:

```sql
SELECT count(DISTINCT region_id)
FROM local_tax_revenue
WHERE fiscal_year = 2024
  AND tax_category = '합계'
  AND source_grain = 'statistical_yearbook_local_collection'
  AND data_status = 'official_observed';

SELECT region_id, revenue_amount_won, metadata
FROM local_tax_revenue
WHERE fiscal_year = 2024
  AND tax_category = '합계'
  AND metadata ->> 'headlineEligible' = 'false';
```

기대값은 첫 query 22, 두 번째 query 청도·봉화 2행이다.
