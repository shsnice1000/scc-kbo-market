export function editorialTitleFor(observation, cardsById) {
  if (observation.matchLevel === "generic") {
    return observation.kind === "reference"
      ? "참고 기록 · 개별 카드 가격과는 별도로 봐 주세요."
      : "선수·카드 정보 확인 전";
  }
  const card = cardsById.get(observation.cardId);
  const player = card?.player;
  if (typeof player !== "string" || !player.trim()) {
    throw new Error("matched record has no catalog player");
  }
  if (observation.matchLevel === "exact") return player + " · 같은 카드 확인";
  if (observation.matchLevel === "candidate") return player + " · 후보 매물 · 카드 확인 전";
  throw new Error("unsupported matchLevel for editorial title");
}
