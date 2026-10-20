# 개발 인계 — 2026-10-21

이 문서는 공개 협업본의 코드 상태와 다음 작업을 설명합니다. 실제 운영 자료·가격·인증정보·개별 보유 카드 자료는 포함하지 않습니다.

## 시작점

- 공개 저장소: https://github.com/shsnice1000/scc-kbo-market
- 기준 `main`: `bbc1ebd054251e82aea23f5577d69791501d4997`
- 기본 환경: Node.js 24 이상, 추가 npm 의존성 없음
- 기준 커밋의 GitHub CI: [Windows/Linux 성공 기록](https://github.com/shsnice1000/scc-kbo-market/actions/runs/39435860382)
- `main`은 승인 1명과 두 운영체제 CI를 요구합니다. 변경은 작업 브랜치와 PR로 진행합니다.

```sh
git clone https://github.com/shsnice1000/scc-kbo-market.git
cd scc-kbo-market
npm run setup
npm test
npm run check
npm run check:public
npm run dev
```

개발 주소는 `http://127.0.0.1:4173`입니다. 이 checkout의 `.openai/hosting.json`은 로컬 개발용이며 실제 Sites 프로젝트를 가리키지 않습니다. GitHub push는 사이트 배포를 실행하지 않습니다.

## 구현된 코드

| 위치 | 역할과 현재 한계 |
| --- | --- |
| `scripts/market-ops/identity.mjs` | 식별 v2. 공식 카드연번·인쇄 코드·등번호를 분리하고, 동일 인쇄 종류와 동일 실물 비교 조건을 구분합니다. 명시된 제품/구단 표기만 정규화합니다. |
| `scripts/market-ops/matching.mjs` | 기존 v1 검토와 v2 진입점입니다. 규칙 일치를 제안할 뿐 공개 발행을 승인하지 않습니다. |
| `scripts/market-ops/review-queue.mjs` | 비공개 로컬 검토 대기함. 내용이 바뀌면 이전 승인을 무효화하고 변경 이력을 남깁니다. |
| `scripts/market-ops/refresh.mjs` | 출처별 실패 격리, 전체 실행 잠금, 제한 시간, Bunjang 파일 배치·watermark 처리입니다. |
| `scripts/market-ops/collectors/` | 승인 설정을 요구하는 Bunjang Search와 gzip CSV parser입니다. 실제 공급처 연동 증거는 없습니다. |
| `site-source/assets/market.js` | 검색·상세·출처 비교 화면입니다. 아래 비교 유형·날짜·호출 인자 수정이 필요합니다. |

합성 회귀 테스트는 46개입니다. 10/21에 공개 필드·중첩 가격·연락 정보·날짜 경계, UI의 전역 가격 배열 사용, Worker PNG 바이트 보존을 검사하는 5개를 추가했습니다. 실제 collector, 플랫폼 전체 수집, 실자료 exact 비교, 공식 자료 공개 권한, 정기 실행과 실호스트 검증이 완료된 상태는 아닙니다.

## 다음 수정 순서와 완료 기준

### 1. 공개 발행 경계와 importer

`site-source/scripts/import-reviewed-snapshot.mjs`는 새 가격 행을 추가한 뒤 검수 원장 생성 전에 `validateMarket()`를 호출합니다. 정상 신규 ID가 원장 누락으로 거부되는 순서 문제를 먼저 해결해야 합니다. 검증을 끄지 말고 공개 후보와 새 원장을 함께 검사하도록 구성합니다.

10/21에 최상위·카드 필드 허용목록, 중첩 가격 차단과 UI의 전역 배열 사용, 카드/사진 출처/플랫폼 라벨의 연락 정보, 미래·불가능한 날짜 차단을 보강했습니다. 한국 날짜만 있는 기록과 타임존을 가진 timestamp를 구분합니다. 다음 경계는 계속 남아 있습니다.

- `validate-review-ledger.mjs`에서 ID뿐 아니라 출처와 공개 행 전체의 결정적 지문을 연결합니다. 가격·URL·카드·종류·상태·날짜가 바뀌면 새 검토가 필요합니다.
- 수동 공개 페이지나 판매완료 배지로 `sold_verified`를 승인하지 않습니다. 검증 체결 근거는 비공개 원장 참조로 남깁니다.
- placeholder 권한 참조와 원장 내부의 검토/관찰 시각 경계도 보강합니다. 시장 JSON의 날짜 검사만으로 원장의 시각 검증까지 끝난 것은 아닙니다.

완료 기준: 격리된 합성 checkout에서 정상 dry-run은 파일을 바꾸지 않고 성공하고, 실제 import는 공개 데이터·dist·Worker·원장이 일치해야 합니다. 승인 후 행 변조, 중첩 가격, 잘못된 권한/체결 근거는 모두 실패해야 합니다. 실패 주입과 동시 실행에서도 이전 상태가 보존되거나 복구 필요 상태가 명시되어야 합니다.

### 2. Worker 바이너리 자산

10/21 수정했습니다. `build-worker.mjs`는 PNG를 base64로 보존하고 응답할 때 바이너리로 복원합니다. ETag는 원본 bytes로 계산합니다. `validate-worker.mjs`는 PNG를 포함해 10개 경로와 원본 지문의 일치 여부를 검사합니다.

격리된 Worker 빌드 회귀 테스트에서 PNG를 포함한 10개 GET/HEAD/304 경로가 통과했습니다. 실제 Sites 배포·공개 호스트 확인은 별도입니다.

### 3. 가격 비교 UI

`renderDialog()`가 `platformComparisonMarkup(records)`를 호출하면서 필터 인자를 넘기지 않습니다. 비교 함수가 요구하는 탭/출처 상태를 전달해야 합니다. 공개 validator가 허용하는 `auction_current_bid`, `auction_final_bid`, `sold_verified`, `official_retail` 유형이 현재 UI 탭과 일치하는지도 점검합니다.

날짜 문자열의 사전식 정렬을 실제 timestamp 기준으로 바꾸고, 서로 다른 UTC 오프셋을 가진 합성 기록으로 검증합니다. 배송비 미상은 총액 최저가로 표시하지 않고, 카드 일치·가격 유형·확인일·출처 링크를 유지합니다.

### 4. 예약·실패·철회

- 출시 관문은 최근 7일 안의 서로 다른 예약 성공 2회를 직접 세어야 합니다. 오래된 1회와 최근 1회로 통과하면 안 됩니다.
- `refresh`의 전체 차단/부분 실패가 프로세스 종료코드 0으로 기록되는 문제를 수정하고 정상 동일 응답과 구분합니다.
- 권한 철회 후 새 스냅샷으로 같은 매물이 재진입하지 않도록 지속되는 제외 정책과 재승인 경로가 필요합니다.

실제 공급처의 허용 주기·자료 사용 범위·키와 복구 조건을 확인하기 전 예약을 활성화하지 않습니다. `--scheduled`는 OS 예약 등록 증거가 아닙니다.

## 데이터와 검증의 구분

공개 `market.json`은 합성 선수 1명, 실제 가격 0건인 개발 fixture입니다. 테스트 호환용 ID에서 실제 선수나 보유 카드를 추론하지 않습니다. 실제 운영 DB를 복사하지 말고 테스트마다 격리된 임시 디렉터리를 사용하세요.

`npm run check:release`의 종료 코드 2는 실제 출시 증거 부족을 뜻합니다. 일반 코드 CI 통과와 정식 출시 관문 통과를 구분하며, 이를 0으로 바꾸어 우회하지 않습니다.

공급처 접근·보관/표시 승인, 공식 카탈로그 공개 조건, 두 플랫폼 실자료 비교, 사용자 과업, 정정 수신 채널, 실호스트·배포/롤백 검증이 외부 완료 조건으로 남아 있습니다. 코드 구현이나 합성 자료로 이 조건을 대신 채우지 않습니다.
