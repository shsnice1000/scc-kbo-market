# 검수한 가격 자료의 공개 경로

현재 협업 저장소의 데이터는 합성 카드 1종, 실제 가격 기록 0건이다. 이 문서는 개발한 경로의 계약이며 플랫폼 접근권이나 자료 재사용 허가를 뜻하지 않는다. 운영 DB·보유 카드·사진·검수 증빙은 Git에 추가하지 않는다.

## 입력과 검수

`site-source/scripts/import-reviewed-snapshot.mjs`는 원문 제목·본문·판매자 정보를 받지 않는다. 공개 제목은 카드 정보에서 생성한다. 입력 JSON은 1 MiB 이하, 한 번에 1–100개 신규 관찰이며 다음 구조를 사용한다.

- `review`: 비식별 역할명 `reviewer`, 시각 `reviewedAt`, 허가 유형 `publicationBasis`, 비공개 증빙 참조 `publicationEvidenceRef`, `noPersonalData: true`.
- 각 관찰의 공개 필드: `id`, `cardId`, `sourceId`, `kind`, `state`, `matchLevel`, `price`, `shippingPrice`, `checkedAt`, `url`, `matchNote`. `postedTimeAtCheck`는 선택이다. 배송비 미확인은 `null`이다.
- 각 관찰의 비공개 필드: `captureMethod`, `termsReviewedAt`, `observedAt`, 선택 `sourcePublishedAt`. 확인된 판매에는 `settlementEvidenceRef`와 `settlementEvidenceType`도 필요하다.
- 시각은 유효한 ISO 시각 또는 허용된 날짜다. 날짜만 있는 관찰은 한국 달력 날짜로 해석한다. 검수 시각은 시간대가 있는 시각이어야 한다. 미래·존재하지 않는 날짜, 관찰→확인→검수 순서 충돌, 미완성 증빙 참조는 거부한다.

허용한 방법/허가 조합:

| 수집 방법 | 공개 근거 |
|---|---|
| `authorized_api` | `partner_contract` |
| `seller_submitted` | `seller_consent` |
| `manual_public_page`, `official_retail_page` | `written_permission`, `terms_allow_metadata_display`, `official_retail_reference` |

참조 문자열은 실제 증빙 자체가 아니다. 담당자가 해당 증빙과 적용 범위를 별도로 확인해야 한다. `TODO`, `pending` 등은 통과하지 않는다. 수동 공개 페이지나 판매완료 배지만으로 실거래가를 만들 수 없다. `sold`/`sold_verified`는 승인 API 또는 판매자 제출 자료와 비공개 `completed_order`/`payment_settlement` 증빙을 요구한다. 낙찰 결과는 결제·정산 확인과 별개다.

## 실행과 복구

```powershell
node site-source/scripts/import-reviewed-snapshot.mjs .ops-private/reviewed-input.json --dry-run
node site-source/scripts/import-reviewed-snapshot.mjs .ops-private/reviewed-input.json
npm run check
```

드라이런은 파일·폴더·잠금을 생성하지 않는다. 신규 검수 기록도 기존 원장과 똑같이 검사한 뒤 예상 결과를 검증한다. 실제 가져오기는 단일 잠금과 복구 저널을 사용해 원본 JSON, dist JSON, 두 Worker 파일, 새 검수 원장을 함께 처리한다. 실패 시 이전 바이트로 복구하며, 복구에 실패하면 저널을 남기고 다음 가져오기를 차단한다.

중단 후에는 다른 가져오기 프로세스가 실행 중인지 먼저 확인한 다음 아래 명령을 쓴다. 살아 있는 프로세스의 잠금은 제거하지 않는다. 새 JSON을 덮어써서 복구 기록을 지우지 않는다.

```powershell
node site-source/scripts/import-reviewed-snapshot.mjs --recover
```

검수 원장 버전 2는 공개 관찰 전체와 연결된 카드 메타데이터의 SHA-256을 보관한다. 가격·배송비·URL·상태·카드 정보 중 하나라도 바뀌면 재검수가 필요하다. 버전 1의 ID만 연결한 원장은 재검수해야 한다. 원장 파일은 `site-source/.ops-private/`에만 남고 Worker에 포함되지 않는다.

## 운영 상태와 철회

`node scripts/market-ops.mjs health`는 운영 DB를 변경하거나 만료 자료를 정리하지 않는다. 상태 요약만 출력한다. 기존 `status`는 정리 작업이 포함된 명령이므로 읽기 전용 점검에는 `health`를 사용한다.

`refresh` 종료 코드는 정상/변경 없음/설정된 일부 출처 성공 `0`, 입력·수집 실패 `1`, 성공한 출처가 전혀 없는 차단 상태 `2`다. 부분 성공 `0`은 6개 플랫폼 전체 성공을 뜻하지 않는다. 출처별 결과도 확인한다.

`retract`는 운영 DB의 해당 매물과 가격 이벤트를 제거하고 이후 재수집도 억제한다. 처음 들어오기 전인 ID도 억제할 수 있다. 억제 기록은 가격 자료의 보관 기간이 끝나도 유지한다. 복원은 새 증빙과 역할명을 요구하며, 복원 시각보다 새로운 관찰을 다시 수집해야 한다.

```powershell
node scripts/market-ops.mjs retract bunjang 101 source_permission_withdrawn withdrawal-record-001
node scripts/market-ops.mjs restore bunjang 101 restored-permission-001 market_reviewer
```

이 명령들은 로컬 운영 DB만 바꾼다. 이미 공개한 사이트의 자료 철회·재배포는 별도 작업이다. 실제 운영 ID 대신 예시 ID를 실행하지 않는다.

## 출시 판정

`npm run check:release`는 읽기 전용이다. 최근 7일 내 서로 다른 예약 실행 2회/플랫폼, 현재 정상인 수집기 6개, 최신 동일 카드 2개 플랫폼 비교, 검수한 공식 목록 및 모든 정적 검증을 요구한다. 중복 ID/시각·미래 실행·과거 한 번과 최근 한 번의 조합은 성공 두 번으로 세지 않는다. 실제 증거가 없으면 종료 코드 `2`를 유지한다. 테스트 통과가 운영 연동을 대신하지 않는다.
