# 개발 안내

`npm run setup`은 로컬에서만 사용할 `.openai/hosting.json`을 만들고, `npm run build`는 정적 source/dist와 Worker를 생성합니다. 이 설정의 `local-development-only`는 실제 Sites 프로젝트가 아닙니다. 배포 토큰이나 인증된 원격이 필요하지 않습니다.

`npm run dev`는 저장소의 정적 웹 파일만 제공합니다. `.git`, `.env`, 운영 DB와 설정 디렉터리는 HTTP로 제공하지 않습니다. `PORT` 환경변수로 기본 4173 포트를 바꿀 수 있습니다.

`npm test`는 합성 임시 저장소를 사용하는 운영 코드와 카드 식별 테스트를 실행합니다. `npm run check`는 빌드와 마켓·검수 원장·카탈로그·정적 파일·Worker 검증을 수행합니다. `npm run check:release`는 별도의 정식 출시 관문입니다. 실제 연결 증거가 없는 개발 환경에서 종료 코드 2는 예상된 데이터 차단이며 일반 CI 성공으로 바꾸지 않습니다.

공식 카드연번과 등번호는 서로 다른 값입니다. 식별 모델 v2의 `checklistCardId`, `printedCardCode`, `jerseyNumber`를 구분하고 미확인 정보는 null로 둡니다. 같은 인쇄 카드가 맞아도 개별 시리얼·등급·상태를 모르면 동일 실물 가격 그룹으로 합치지 않습니다.

`match-queue-list`는 비공개 검토 대기함을 읽으며, `match-queue-add`와 `match-queue-decide`는 각 개발자의 로컬 비공개 상태를 바꿉니다. 검토 승인만으로 공개 데이터가 발행되지는 않습니다. 운영 CLI의 `status`, `refresh`, `ingest`, `prune`, `retract`는 상태 변경을 포함할 수 있으므로 실제 운영 파일을 연결하지 않고 합성 자료로 시험하세요.

GitHub CI는 PR/일반 push에서 테스트만 수행하고, 외부 플랫폼 수집·배포·메시지 발송은 실행하지 않습니다.
