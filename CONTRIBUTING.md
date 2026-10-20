# 함께 작업하기

```sh
git switch main
git pull --ff-only
git switch -c feature/short-description
```

변경을 구현한 뒤 필요한 테스트를 실행합니다.

```sh
npm test
npm run check
npm run check:public
git add <변경한-파일>
git commit -m "feat: describe the change"
git push -u origin feature/short-description
```

GitHub에서 `main` 대상 Pull Request를 만들고 문제, 변경 후 동작, 검증 결과를 적어 주세요. 동료가 변경을 확인하고 CI가 통과하면 squash merge합니다. `main` force push는 사용하지 않습니다.

저장소 쓰기 권한이 없는 동료는 fork에서 브랜치를 만들고 Pull Request를 보낼 수 있습니다. 직접 push가 필요하면 관리자가 GitHub Settings → Collaborators에서 해당 GitHub 사용자를 추가합니다. 이 저장소 생성만으로 동료에게 쓰기 권한이나 초대가 자동 부여되지는 않습니다.

운영 메모·실제 카드 사진·보유 카드 시리얼·판매 준비 가격·토큰·계약 원문은 이슈와 PR에도 올리지 않습니다. 데이터 관련 오류 재현에는 합성 예시를 사용합니다. 라이선스 조건은 관리자가 별도로 확정합니다.
