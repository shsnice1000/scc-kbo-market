# SCC KBO Market

SCC KBO 카드 검색·가격 비교 기능을 함께 개발하는 저장소입니다. 카드 식별, 검토 대기함, 출처별 가격 구분과 정적 웹 UI 코드를 포함합니다.

**이 저장소의 카드와 가격 입력은 개발용 합성 예시입니다.** 실제 보유 카드·판매 준비 자료·플랫폼 인증정보·운영 문서와 과거 운영 Git 이력은 포함하지 않습니다. 자동 수집이나 6개 플랫폼 정식 출시가 완료된 상태는 아닙니다.

## 시작

Node.js 24 이상과 Git이 필요합니다. 외부 npm 의존성은 없습니다.

```sh
git clone https://github.com/shsnice1000/scc-kbo-market.git
cd scc-kbo-market
npm run setup
npm test
npm run check
npm run dev
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다. 서버는 이 PC의 루프백 주소에만 연결됩니다. 배포 자산은 `npm run build`로 생성합니다.

## 구조

- `site-source/`: 웹 화면, 합성 개발 데이터, Worker 빌드·검증 코드
- `scripts/market-ops/`: 로컬 수집 입력 검증, 카드 식별, 비공개 검토 대기함
- `docs/`: 동료용 개발 안내와 알려진 제한
- `.github/`: Pull Request 템플릿, 이슈 양식, Windows/Linux CI

공개 협업본은 기존 로컬 운영 저장소와 Sites 소스 저장소에서 검토한 코드만 옮겨 새 이력으로 시작했습니다. 기존 Sites 프로젝트·원격 설정을 변경하지 않으며 이 저장소의 push는 공개 사이트 배포를 실행하지 않습니다.

## 협업

다음 작업은 [개발 인계](docs/HANDOFF.md)의 수정 우선순위와 완료 기준을 기준으로 진행합니다.

`main`에서 작업 브랜치를 만들고 Pull Request로 합칩니다. `npm test`, `npm run check`, `npm run check:public`을 통과시켜 주세요. 비공개 설정과 실자료는 각 개발자의 `.ops-private/`에만 두고 공유하지 않습니다. [협업 절차](CONTRIBUTING.md), [개발 안내](docs/DEVELOPMENT.md), [현재 제한](docs/KNOWN_LIMITATIONS.md)을 먼저 읽어 주세요.
