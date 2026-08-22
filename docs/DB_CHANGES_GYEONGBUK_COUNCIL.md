# DB 변경: 경상북도의회 의원·의안

마이그레이션: `db/migrations/016_gyeongbuk_council_member_bill.sql`
적용: 로컬 `gyeongbuk`, 원격 `193.122.116.1/mcp` 모두 반영 완료.

## 추가 테이블

### `council_member`

경상북도의회 제13대 의원 명부.

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `council_member_id` | text PK | `gb-council-member-<search_code>` |
| `council_name` | text | `경상북도의회` |
| `search_code` | text | 사이트 의원 키. 사람 단위로 안정적이나 **대수 식별자가 아님** |
| `name` / `party` / `district` / `position` | text | 명부 표기 그대로 |
| `region_id` | text FK → `dim_region` | 선거구가 시·군으로 해석될 때만. 비례대표는 null |
| `office_phone` / `education` / `career` | text | 프로필 팝업에서 추출 |
| `photo_url` / `homepage_url` | text | 원문 링크 |
| `data_status` | text | `official_observed` 고정 |

`UNIQUE (council_name, search_code)`.

이메일 주소는 공개되어 있으나 **저장하지 않는다**. 의정활동 분석에 필요하지
않은 개인정보이며, 수집 자체가 스팸 벡터가 된다. 공식 사무실 전화만 보관한다.

`region_id`가 null인 8건은 비례대표다. 임의로 지역을 배정하면 대표하지 않는
시·군을 대표하는 것처럼 집계되므로 null을 유지한다.

### `council_bill`

의안 1건 = 1행. 자연키는 `bill_uid`(사이트의 32-hex 키)다. 의안번호는 대수마다
재사용되므로 PK로 쓸 수 없다.

`bill_kind`(조례안/결의안/건의안…), `proposer_kind`(의원/도지사/교육감…),
`committee`, `proposed_date`, `decided_date`, `status`, `outcome`,
`lead_sponsor_count`, `co_sponsor_count`를 갖는다.

인덱스: `proposed_date DESC`, `committee`, `bill_kind`, 그리고 제목에 대한
`to_tsvector('simple', …)` GIN + `gin_trgm_ops` GIN(부분 문자열 검색용).

### `council_bill_sponsor`

의안 ↔ 발의자 관계. PK는 `(council_bill_id, role, member_name)`.

```sql
role text NOT NULL CHECK (role IN ('lead', 'co'))
```

**이 분리가 이 마이그레이션의 핵심이다.** `lead`는 대표발의, `co`는 공동발의다.
둘을 합치면 동료 의안 12건에 서명한 의원이 12건을 발의한 것처럼 집계된다.
어떤 소비자도 실수로 합산하지 못하도록 컬럼 수준 제약으로 못박았다.

`council_member_id`는 nullable FK다. 지난 대수 의원이 공동발의자로 남긴 기록은
현 명부에 없으므로 id가 붙지 않는다. 그래도 `member_name`은 보존한다. 삭제하면
의안의 발의자 명단이 사실과 달라지기 때문이다.

## 적재 결과 (원격 `193.122.116.1/mcp`)

| 테이블 | 행 수 |
| --- | --- |
| `council_member` | 64 |
| `council_bill` | 1,454 |
| `council_bill_sponsor` | 24,178 |

- 의원 64명 중 56명이 `region_id` 보유, 8명 비례대표(null).
- 발의자 링크 내역: `lead` 1,449 / `co` 22,729.
- 이 중 8,529건만 현 명부 의원과 연결(`council_member_id IS NOT NULL`).
- 의안 발의일 범위 2006-12-26 ~ 2026-08-14. 재선 의원이 이전 대수 이력을
  함께 갖고 있어 13대 이전 의안이 포함된다.
- 대표발의자가 없는 의안 5건은 위원회안이거나 상세 페이지에 대표발의 표가 없다.
- `source_locator`에 `council_member` 64건, `council_bill` 1,454건 등록.

## 기존 `council_record`와의 관계

**없다.** `council_record`(49,708행)는 **포항시의회** 회의록이다. 기초의회와
광역의회는 다른 기관이므로 두 테이블을 조인하거나 합산하면 안 된다.
마이그레이션 헤더 주석에 이 경고를 남겨두었다.

## 롤백

```sql
DROP TABLE IF EXISTS council_bill_sponsor;
DROP TABLE IF EXISTS council_bill;
DROP TABLE IF EXISTS council_member;
DELETE FROM source_locator WHERE entity_type IN ('council_member', 'council_bill');
```

`pipelines/src/db.ts`의 `MIGRATION_FILES`에서 016을 제거하고,
`db/schema.sql` 말미의 대응 블록도 함께 지워야 한다.
