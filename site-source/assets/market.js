const DATA_URL = "data/market.json";
const PRICE_LABELS = { asking: "판매 희망가", auction: "경매 낙찰 결과", auction_current_bid: "경매 진행 호가", auction_final_bid: "경매 낙찰 결과", sold: "확인된 실거래가", sold_verified: "확인된 실거래가", official_retail: "공식 판매가", reference: "참고 기록" };
const PRICE_GROUPS = ["asking", "auction_current_bid", "auction_final_bid", "sold_verified", "official_retail", "reference"];
const priceGroup = (kind) => ({ auction: "auction_final_bid", sold: "sold_verified" })[kind] || kind;
const matchesKind = (record, kind) => priceGroup(record.kind) === priceGroup(kind);
const activeAsk = (record) => record.kind === "asking" && ["active_asking", "active_at_check"].includes(record.state);
const TYPE_ORDER = ["전체", "베이스", "패럴렐", "오토", "렐릭", "묶음", "미분류"];
const KBO_TEAMS = ["두산 베어스", "한화 이글스", "KIA 타이거즈", "키움 히어로즈", "KT 위즈", "LG 트윈스", "롯데 자이언츠", "NC 다이노스", "삼성 라이온즈", "SSG 랜더스"];
const RECORD_FILTERS = [
  { id: "all", label: "전체 공개 기록" },
  { id: "asking", label: "매물 희망가" },
  { id: "auction_current_bid", label: "경매 진행 호가" },
  { id: "auction_final_bid", label: "경매 낙찰 결과" },
  { id: "sold_verified", label: "확인된 실거래가" },
  { id: "official_retail", label: "공식 판매가" },
  { id: "reference", label: "참고 기록" }
];
const won = new Intl.NumberFormat("ko-KR");
const ui = {
  search: document.querySelector("#search"),
  clearSearch: document.querySelector("#clear-search"),
  team: document.querySelector("#team-filter"),
  sort: document.querySelector("#sort"),
  types: document.querySelector("#type-filters"),
  records: document.querySelector("#record-filters"),
  grid: document.querySelector("#card-grid"),
  count: document.querySelector("#result-count"),
  dialog: document.querySelector("#card-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast")
};

let marketData = null;
let selectedType = "전체";
let selectedRecord = "all";
let favoritesOnly = false;
let favorites = readFavorites();
let toastTimer = 0;
let lastFocused = null;

function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem("scc-market-favorites") || "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeExternalHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function recordsFor(card) {
  const globalRecords = marketData.observations.filter((record) => record.cardId === card.id);
  return sortRecordsNewestFirst(globalRecords);
}

function allCards() {
  const official = (marketData.officialCatalog?.cards || []).map((card) => ({ ...card, catalogStatus: "official" }));
  const candidates = marketData.candidates.map((card) => ({ ...card, catalogStatus: "candidate" }));
  return [...official, ...candidates];
}

function findCard(cardId) {
  return allCards().find((card) => card.id === cardId);
}

function allRecords() {
  return [...marketData.observations];
}

function typeClass(type) {
  return ({ 베이스: "base", 패럴렐: "parallel", 오토: "auto", 렐릭: "relic", 묶음: "lot", 미분류: "unclassified" })[type] || "unclassified";
}

function formatPrice(value) {
  return `${won.format(value)}원`;
}

function countByKind(records, kind) {
  return records.filter((record) => matchesKind(record, kind)).length;
}

function summarizeObservedPrices(records) {
  const prices = records.map((record) => record.price).filter(Number.isFinite).sort((a, b) => a - b);
  if (!prices.length) return "가격 확인 전";
  const minimum = prices[0];
  const maximum = prices[prices.length - 1];
  return minimum === maximum ? formatPrice(minimum) : formatPrice(minimum) + "–" + formatPrice(maximum);
}

function groupExactComparisons(records) {
  const groups = new Map();
  records.forEach((record, index) => {
    if (record.matchLevel !== "exact") return;
    const verified = /^[a-f0-9]{64}$/.test(record.comparisonKey || "");
    const key = verified ? record.comparisonKey : "unverified:" + (record.id || index);
    const group = groups.get(key) || { key, verified, records: [] };
    group.records.push(record);
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((group, index) => ({
    ...group,
    label: group.verified ? "동일 실물 조건 " + (index + 1) : "비교 조건 미확인 " + (index + 1),
  }));
}

function latestObservedDate(records) {
  return sortRecordsNewestFirst(records).find((record) => Number.isFinite(observationTimestamp(record.checkedAt)))?.checkedAt || "날짜 미기록";
}

function observationTimestamp(value) {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value + "T00:00:00+09:00" : value || "");
}

function formatObservationDate(value) {
  if (!Number.isFinite(observationTimestamp(value))) return "확인 전";
  if (value.length === 10) return value.replaceAll("-", ". ") + ".";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(observationTimestamp(value)) + " (한국시간)";
}

function observationAgeLabel(checkedAt) {
  const timestamp = observationTimestamp(checkedAt);
  if (!Number.isFinite(timestamp)) return "확인일 미기록 · 현재 상태 미확인";
  if (timestamp > Date.now() + 300_000) return "확인일 오류 · 현재 상태 미확인";
  const ageDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (ageDays >= 7) return `과거 관찰 ${formatObservationDate(checkedAt)} · ${ageDays}일 경과 · 현재 노출 미확인`;
  return `마지막 관찰 ${formatObservationDate(checkedAt)} · 현재 노출 재확인 전`;
}

function observationStateLabel(record) {
  if (["sold_badge_sale_price_unverified", "sold_badge_only"].includes(record.state)) return "판매완료 표시 · 실제 체결가 미확인";
  if (record.state === "unavailable_on_recheck") return "재확인 시 원문 비노출 · 판매완료 아님";
  if (record.state === "unknown") return "검색 결과에서 확인 · 상세와 현재 상태 미확인";
  if (record.kind === "reference") return "범용 참고 · 카드별 가격 비교 제외";
  if (record.kind === "asking") return record.matchLevel === "exact" ? "확인 당시 판매 희망가 · 카드 정보 일치" : "확인 당시 판매 희망가 · 카드 후보";
  if (["sold", "sold_verified"].includes(record.kind)) return "판매 상태와 체결 금액 확인";
  if (record.kind === "auction_current_bid") return "진행 중 확인한 입찰가 · 낙찰·정산 금액 아님";
  if (["auction", "auction_final_bid"].includes(record.kind)) return "경매 종료 낙찰 결과 · 결제·정산 확인과 별도";
  if (record.kind === "official_retail") return "공식 판매처 표시 가격 · 개별 재판매 거래가와 별도";
  return "확인 당시 가격 기록";
}

function postedAgeMinutes(record) {
  const label = String(record.postedTimeAtCheck || "");
  if (/방금|현재/.test(label)) return 0;
  const match = label.match(/(\d+)\s*(분|시간|일)\s*전/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * ({ 분: 1, 시간: 60, 일: 1440 }[match[2]]);
}

function sortRecordsNewestFirst(records) {
  return [...records].sort((a, b) => {
    const aTime = observationTimestamp(a.checkedAt), bTime = observationTimestamp(b.checkedAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(aTime) ? -1 : 1;
    const aAge = postedAgeMinutes(a);
    const bAge = postedAgeMinutes(b);
    if (Number.isFinite(aAge) && Number.isFinite(bAge)) return aAge - bAge;
    if (Number.isFinite(aAge)) return -1;
    if (Number.isFinite(bAge)) return 1;
    return 0;
  });
}

function priceEvidenceLine(label, records, note) {
  if (!records.length) return "";
  const checked = latestObservedDate(records);
  return "<div class=\"card-price-line\"><span class=\"card-price-label\">" + label + " <b>" + records.length + "건</b></span><strong class=\"card-price-value\">" + summarizeObservedPrices(records) + "</strong><span class=\"card-price-note\">" + note + " · 상품가 기준, 배송비 별도 · " + escapeHTML(observationAgeLabel(checked)) + "</span></div>";
}

function candidateEvidenceLine(label, records, note) {
  if (!records.length) return "";
  const checked = latestObservedDate(records);
  return "<div class=\"card-price-line\"><span class=\"card-price-label\">" + label + " <b>" + records.length + "건</b></span><strong class=\"card-price-value\">개별 기록</strong><span class=\"card-price-note\">" + note + " · 후보 기록끼리는 가격 범위를 계산하지 않습니다 · " + escapeHTML(observationAgeLabel(checked)) + "</span></div>";
}

function renderFilterOptions() {
  const types = TYPE_ORDER.map((type) => `<button class="filter-choice" type="button" data-type="${escapeHTML(type)}" aria-pressed="${type === selectedType}">${escapeHTML(type)}</button>`).join("");
  ui.types.innerHTML = types;
  ui.types.addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    selectedType = button.dataset.type;
    ui.types.querySelectorAll("[data-type]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    renderCards();
  });

  const rows = RECORD_FILTERS.map(({ id, label }) => {
    const records = allRecords();
    const count = id === "all" ? records.length : countByKind(records, id);
    return `<button class="filter-choice" type="button" data-record="${id}" aria-pressed="${id === selectedRecord}"><span>${label}</span><span class="choice-count">${count}</span></button>`;
  }).join("");
  ui.records.innerHTML = rows;
  ui.records.addEventListener("click", (event) => {
    const button = event.target.closest("[data-record]");
    if (!button) return;
    selectedRecord = button.dataset.record;
    ui.records.querySelectorAll("[data-record]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    renderCards();
  });

  ui.team.insertAdjacentHTML("beforeend", [`구단 확인 전`, ...KBO_TEAMS].map((team) => `<option value="${escapeHTML(team)}">${escapeHTML(team)}</option>`).join(""));
}

function renderSources() {
  const records = allRecords();
  const entries = marketData.sources.map((source) => {
    const sourceRecords = records.filter((record) => record.sourceId === source.id);
    const count = sourceRecords.length;
    const lastChecked = latestObservedDate(sourceRecords);
    const checked = count
      ? `공개 기록 ${count}건 · ${escapeHTML(observationAgeLabel(lastChecked))}`
      : "공개 가격 기록 0건";
    const emptyNote = count ? "" : (source.note || "아직 공개 가능한 가격 기록이 없습니다. 플랫폼에 매물이 없다는 뜻은 아닙니다.");
    const sourceHref = safeExternalHref(source.url);
    const sourceLink = sourceHref ? `<a href="${escapeHTML(sourceHref)}" target="_blank" rel="noopener noreferrer">출처 열기 ↗</a>` : "<span>출처 링크 없음</span>";
    const status = source.status;
    const description = count ? source.note : emptyNote;
    return `<article class="source-card"><div class="source-card-top"><h3>${escapeHTML(source.name)}</h3><span class="source-kind">${escapeHTML(source.kind)}</span></div><p class="source-status">${escapeHTML(status)}</p><p class="source-description">${escapeHTML(description)}</p><div class="source-meta"><span>${checked}</span>${sourceLink}</div></article>`;
  }).join("");
  document.querySelector("#source-grid").innerHTML = entries;
  renderObservationList(records);
}

function renderObservationList(records) {
  const list = document.querySelector("#observation-list");
  if (!records.length) {
    list.innerHTML = `<div class="record-empty"><strong>아직 공개 가능한 가격 기록이 없습니다.</strong>카드 정보와 거래 상태를 원문에서 확인한 뒤 추가합니다. 플랫폼에 매물이 없다는 뜻은 아닙니다.</div>`;
    return;
  }
  const sorted = sortRecordsNewestFirst(records);
  list.innerHTML = sorted.map((record) => {
    const source = marketData.sources.find((item) => item.id === record.sourceId);
    const card = findCard(record.cardId);
    const typeLabel = PRICE_LABELS[record.kind] || "가격 기록";
    const status = observationStateLabel(record);
    const shipping = record.shippingPrice === 0 ? "무료배송" : Number.isFinite(record.shippingPrice) ? "배송비 " + formatPrice(record.shippingPrice) : "배송비 확인 전";
    const matchLevel = record.matchLevel || (card ? "candidate" : "generic");
    const cardLabel = card ? [card.player, card.cardNumber, card.variant].filter(Boolean).join(" · ") : "개별 카드";
    const title = matchLevel === "generic" ? "일괄·범용 참고 기록" : cardLabel;
    const matchLabel = matchLevel === "exact" ? "카드 정보 일치" : matchLevel === "candidate" ? "카드 번호·패럴렐 확인 전" : "카드별 가격 비교에서 제외";
    const linkLabel = matchLevel === "exact" ? "카드 정보 보기" : "카드 후보 보기";
    const matchLink = card && (matchLevel === "exact" || matchLevel === "candidate") ? `<button class="observation-match" type="button" data-card="${escapeHTML(card.id)}">${linkLabel}</button>` : `<span class="observation-match-label">${matchLabel}</span>`;
    const recordHref = safeExternalHref(record.url || source?.url);
    const recordLink = recordHref ? `<a href="${escapeHTML(recordHref)}" target="_blank" rel="noopener noreferrer">매물 원문 보기 ↗</a>` : "<span>원문 링크 없음</span>";
    const posted = record.postedTimeAtCheck ? ` · 당시 등록 ${escapeHTML(record.postedTimeAtCheck)}` : "";
    return `<article class="observation-row"><div class="observation-tags"><span class="badge ${record.kind === "sold" ? "sold" : record.kind === "asking" ? "ask" : "ref"}">${escapeHTML(typeLabel)}</span><span class="observation-state">${escapeHTML(status)}</span></div><div class="observation-main"><div><h4>${escapeHTML(title)}</h4><p>${escapeHTML(record.matchNote || "카드 일치 여부 확인 전")}</p></div><div class="observation-price"><strong>${formatPrice(record.price)}</strong><span>${escapeHTML(shipping)}</span></div></div><div class="observation-foot"><span>${escapeHTML(source?.name || "출처 확인 필요")} · ${escapeHTML(observationAgeLabel(record.checkedAt))}${posted}</span><div>${matchLink}${recordLink}</div></div></article>`;
  }).join("");
}

function renderStats() {
  const records = allRecords();
  const cards = marketData.candidates.length;
  const officialCards = marketData.officialCatalog.cards.length;
  const askingRecords = records.filter(activeAsk);
  const candidateListings = askingRecords.length;
  const exactMatches = askingRecords.filter((record) => record.matchLevel === "exact").length;
  const exactSoldRecords = records.filter((record) => matchesKind(record, "sold_verified") && record.matchLevel === "exact").length;
  const genericReferences = countByKind(records, "reference");
  document.querySelector("#stat-cards").textContent = `${cards}종`;
  document.querySelector("#catalog-scope-count").textContent = `정식 체크리스트 ${officialCards}종 · 판매글 후보 ${cards}종`;
  document.querySelector("#catalog-scope-explainer").textContent = officialCards
    ? "정식 목록과 판매글 후보를 구분해 보여드려요. 카드 번호·패럴렐·시리얼이 확인되지 않으면 같은 카드 기록으로 묶지 않습니다."
    : `정식 체크리스트는 아직 확인 중이라 판매글 후보 ${cards}종만 보여드려요. 후보가 전체 카드 목록을 뜻하지는 않습니다.`;
  document.querySelector("#stat-listings").textContent = `${records.length}건`;
  document.querySelector("#stat-exact").textContent = `${exactMatches}건`;
  document.querySelector("#stat-sold").textContent = `${exactSoldRecords}건`;
  document.querySelector("#stat-observation-total").textContent = `공개 가격 기록 ${records.length}건`;
  const latestObservation = records.length ? latestObservedDate(records) : "확인 전";
  const observationRecency = records.length ? observationAgeLabel(latestObservation) : "공개 가격 기록이 아직 없습니다.";
  document.querySelector("#stat-snapshot-status").textContent = records.length
    ? observationRecency
    : "아직 공개한 가격 기록이 없습니다.";
  document.querySelector("#hero-latest-date").textContent = formatObservationDate(latestObservation);
  document.querySelector("#hero-record-status").textContent = records.length
    ? "정식 체크리스트 " + officialCards + "종 · 판매글 후보 " + cards + "종 · 매물 희망가 " + candidateListings + "건 · 같은 카드 확인 " + exactMatches + "건 · 실제 판매가 확인 " + exactSoldRecords + "건 · " + observationRecency
    : "정식 카드 목록 확인 중 · 판매글 후보 " + cards + "종 · 공개 가격 기록 0건.";
  document.querySelector("#source-coverage-summary").textContent = records.length
    ? "전체 플랫폼의 매물 희망가 " + candidateListings + "건과 범용 참고 " + genericReferences + "건을 공개합니다. 카드 정보가 일치한 매물은 " + exactMatches + "건, 확인된 실제 판매가는 " + exactSoldRecords + "건입니다. " + observationRecency + "."
    : "현재 출처와 카드 정보를 대조해 공개한 가격 기록은 없습니다. 매물이 없다는 뜻은 아니며, 원문 확인을 마친 자료부터 추가합니다.";
  renderSources();
}

function filteredCards() {
  const query = ui.search.value.trim().toLocaleLowerCase("ko");
  const team = ui.team.value;
  const list = allCards().filter((card) => {
    const values = [card.player, card.team, card.type, card.cardNumber, card.variant, card.serial].filter(Boolean).join(" ").toLocaleLowerCase("ko");
    const records = recordsFor(card);
    return (!query || values.includes(query))
      && (team === "all" || card.team === team)
      && (selectedType === "전체" || card.type === selectedType)
      && (selectedRecord === "all" || records.some((record) => matchesKind(record, selectedRecord)))
      && (!favoritesOnly || favorites.has(card.id));
  });
  const sort = ui.sort.value;
  if (sort === "name") list.sort((a, b) => a.player.localeCompare(b.player, "ko") || String(a.cardNumber || "").localeCompare(String(b.cardNumber || ""), "ko"));
  return list;
}

function cardMarkup(card) {
  const records = recordsFor(card);
  const title = `${card.player}${card.cardNumber ? ` ${card.cardNumber}` : ""}`;
  const serial = card.serial ? `<span class="serial">${escapeHTML(card.serial)}</span>` : "";
  const favorite = favorites.has(card.id);
  const candidateAsks = records.filter((record) => activeAsk(record) && record.matchLevel === "candidate");
  const exactAsks = records.filter((record) => activeAsk(record) && record.matchLevel === "exact");
  const exactAskGroups = groupExactComparisons(exactAsks);
  const exactSold = records.filter((record) => matchesKind(record, "sold_verified") && record.matchLevel === "exact");
  const exactSoldGroups = groupExactComparisons(exactSold);
  const candidateSold = records.filter((record) => matchesKind(record, "sold_verified") && record.matchLevel === "candidate");
  const priceEvidence = [
    candidateEvidenceLine("카드 후보 매물", candidateAsks, "번호·패럴렐 확인 전 · 판매 완료 아님"),
    ...exactAskGroups.slice(0, 4).map((group) => priceEvidenceLine(group.label + " 희망가", group.records, "판매 희망가 · 판매 완료 아님")),
    exactAskGroups.length > 4 ? `<p class="card-price-note">추가 실물 비교 조건 ${exactAskGroups.length - 4}개는 상세 보기에서 확인할 수 있습니다.</p>` : "",
    ...exactSoldGroups.slice(0, 4).map((group) => priceEvidenceLine(group.label + " 확인된 실거래가", group.records, "실제 판매와 카드 식별 확인")),
    exactSoldGroups.length > 4 ? `<p class="card-price-note">추가 실물 조건의 실거래는 상세 보기에서 확인할 수 있습니다.</p>` : "",
    candidateEvidenceLine("실거래 확인 · 카드 후보", candidateSold, "정산 근거 확인 · 같은 카드인지 확인 전")
  ].filter(Boolean).join("") || `<p class="card-price-empty">아직 공개한 가격 기록이 없습니다. 출처와 카드 정보를 확인한 뒤 추가합니다.</p>`;

  return `<article class="card-item">
    ${cardVisualMarkup(card)}
    <div class="card-top"><span class="type-badge type-${typeClass(card.type)}">${escapeHTML(card.type)}</span>${serial}<button class="favorite-button" type="button" data-favorite="${escapeHTML(card.id)}" aria-pressed="${favorite}" aria-label="${favorite ? "관심 카드 해제" : "관심 카드 저장"}">${favorite ? "♥" : "♡"}</button></div>
    <p class="card-team">${escapeHTML(card.team)} · ${card.catalogStatus === "official" ? "정식 체크리스트" : "판매글 후보"}</p><h3 class="card-name">${escapeHTML(title)}</h3><p class="card-subtitle">${escapeHTML(card.variant)}</p>
    <div class="card-price-evidence" aria-label="가격 기록 요약">${priceEvidence}</div>
    <div class="card-market-summary"><span class="market-count">공개 가격 기록 <strong>${records.length}건</strong></span><button class="card-detail-button" type="button" data-card="${escapeHTML(card.id)}">카드 정보 보기 <span aria-hidden="true">↗</span></button></div>
  </article>`;
}

function cardVisualMarkup(card) {
  const title = `${card.player}${card.cardNumber ? ` ${card.cardNumber}` : ""}`;
  const number = card.cardNumber || "카드 번호 확인 전";
  return `<div class="card-visual card-visual-${typeClass(card.type)}" role="img" aria-label="${escapeHTML(title)}의 실제 사진이 아닌 자체 제작 안내 그래픽. 실물 이미지는 사용 허락 확인 전입니다.">
    <span class="card-visual-orbit" aria-hidden="true"></span>
    <div class="card-visual-top"><span>2026 SCC · CARD INDEX</span><span>실물 사진 미사용</span></div>
    <div class="card-visual-main"><strong>${escapeHTML(card.player)}</strong><span>${escapeHTML(card.type)} · ${escapeHTML(number)}</span></div>
    <div class="card-visual-bottom"><span>${escapeHTML(card.team)}</span><span>이미지 사용 허락 확인 후 공개</span></div>
  </div>`;
}

function renderCards() {
  if (!marketData) return;
  const list = filteredCards();
  ui.count.textContent = `${list.length}개`;
  ui.clearSearch.hidden = ui.search.value.length === 0;
  if (list.length) {
    ui.grid.innerHTML = list.map(cardMarkup).join("");
  } else {
    if (allCards().length === 0) {
      ui.grid.innerHTML = `<div class="no-results"><strong>공개 검증을 마친 카드 목록을 준비하고 있어요.</strong><span>카드 정보와 출처를 확인한 자료부터 공개합니다. 목록에 카드가 없다고 해서 실제 카드나 매물이 없다는 뜻은 아닙니다.</span><a href="https://m.bunjang.co.kr/keywords/2026%20scc" target="_blank" rel="noopener noreferrer">번개장터에서 SCC 매물 검색 ↗</a><a href="#records">플랫폼별 확인 상태 보기 ↓</a></div>`;
    } else {
      const hasRecords = allRecords().length > 0;
      const message = selectedRecord !== "all" && !hasRecords
        ? "해당 가격 유형의 확인된 기록이 아직 없습니다."
        : favoritesOnly && favorites.size === 0
          ? "저장한 관심 카드가 아직 없습니다. 카드의 하트를 눌러 저장해 보세요."
          : "조건에 맞는 카드가 없습니다.";
      const query = ui.search.value.trim();
      const searchURL = `https://m.bunjang.co.kr/keywords/${encodeURIComponent(`2026 SCC ${query || ""}`.trim())}`;
      ui.grid.innerHTML = `<div class="no-results"><strong>${escapeHTML(message)}</strong><span>번개장터에서 같은 검색어로 공개 매물을 확인해 보세요.</span><a href="${escapeHTML(searchURL)}" target="_blank" rel="noopener noreferrer">번개장터 매물 검색 ↗</a><button type="button" class="no-results-reset" data-reset-filters>검색 조건 초기화</button></div>`;
    }
  }
  ui.grid.setAttribute("aria-busy", "false");
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), 2100);
}

function saveFavorites() {
  try {
    localStorage.setItem("scc-market-favorites", JSON.stringify([...favorites]));
  } catch {
    showToast("이 브라우저에서는 관심 카드를 저장할 수 없습니다.");
  }
}

function recordRow(record) {
  const source = marketData.sources.find((item) => item.id === record.sourceId);
  const date = record.checkedAt ? escapeHTML(record.checkedAt) : "확인일 미기록";
  const shipping = record.shippingPrice === 0 ? "무료배송" : Number.isFinite(record.shippingPrice) ? `배송비 ${formatPrice(record.shippingPrice)}` : "배송비 확인 전";
  const status = observationStateLabel(record);
  const recordHref = safeExternalHref(record.url);
  const link = recordHref ? `<a href="${escapeHTML(recordHref)}" target="_blank" rel="noopener noreferrer">매물 원문 열기 ↗</a>` : "원문 링크 없음";
  return `<article class="record-row"><div><h3>${escapeHTML(source?.name || record.sourceName || "출처 확인 필요")} · ${escapeHTML(record.platformLabel || PRICE_LABELS[record.kind] || "가격 기록")}</h3><p>${escapeHTML(record.matchNote || "카드 일치 여부 확인 전")}</p><p>${escapeHTML(status)} · ${shipping} · ${escapeHTML(observationAgeLabel(record.checkedAt || date))}</p><p class="record-source">${link}</p></div><strong class="record-price">${formatPrice(record.price)}</strong></article>`;
}

function niceChartMaximum(value) {
  if (!(value > 0)) return 10000;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * power;
}

function platformComparisonMarkup(records, activeKind = "asking", activeSource = "all", activeComparison = "all") {
  const kindLabel = PRICE_LABELS[activeKind] || "가격 기록";
  const included = records.filter((record) => matchesKind(record, activeKind)
    && record.matchLevel !== "generic"
    && (activeComparison === "all" || (record.matchLevel === "exact" && record.comparisonKey === activeComparison))
    && !["unavailable_on_recheck", "sold_badge_sale_price_unverified", "sold_badge_only"].includes(record.state)
    && Number.isFinite(record.price));
  const maximum = niceChartMaximum(Math.max(...included.map((record) => record.price), 0) * 1.08);
  const tickLabels = [0, maximum / 2, maximum].map((value) => formatPrice(Math.round(value)));
  const rows = marketData.sources.filter((source) => activeSource === "all" || source.id === activeSource).map((source) => {
    const sourceRecords = included.filter((record) => record.sourceId === source.id);
    const pointMarks = sourceRecords.map((record, index) => {
      const position = Math.max(0, Math.min(100, Math.round(record.price / maximum * 100)));
      const lane = index % 2;
      const title = source.name + " · " + formatPrice(record.price) + " · " + (record.matchLevel === "exact" ? "정보 일치" : "후보 매물") + " · " + (record.checkedAt || "확인일 미기록");
      return `<a class="price-plot-point at-${position} lane-${lane} ${record.matchLevel === "exact" ? "is-exact" : "is-candidate"}" href="${escapeHTML(safeExternalHref(record.url))}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(title)}" aria-label="${escapeHTML(title)}"><span class="visually-hidden">${escapeHTML(formatPrice(record.price))}</span></a>`;
    }).join("");
    const checked = sourceRecords.length ? escapeHTML(observationAgeLabel(latestObservedDate(sourceRecords))) : "이 카드 가격 기록 없음";
    const list = sourceRecords.length
      ? `<ul class="price-plot-records">${sourceRecords.map((record) => {
        const href = safeExternalHref(record.url);
        const marker = record.matchLevel === "exact" ? "정보 일치" : "카드 후보";
        const state = record.state === "unknown" ? " · 현재 노출 확인 전" : "";
        const link = href ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${formatPrice(record.price)} <span>${marker}${state} · ${escapeHTML(record.checkedAt || "확인일 미기록")} · 사진 원문 ↗</span></a>` : `<span>${formatPrice(record.price)} · ${marker}</span>`;
        return `<li class="${record.matchLevel === "exact" ? "is-exact" : "is-candidate"}">${link}</li>`;
      }).join("")}</ul>`
      : `<p class="platform-no-data">이 카드의 가격 기록을 아직 확인하지 못했습니다. 플랫폼에 매물이 없다는 뜻은 아닙니다.</p>`;
    const track = sourceRecords.length
      ? `<div class="price-plot-track" role="group" aria-label="${escapeHTML(source.name)} ${kindLabel}: ${sourceRecords.map((record) => formatPrice(record.price)).join(", ")}"><span class="price-plot-grid first"></span><span class="price-plot-grid middle"></span><span class="price-plot-grid last"></span>${pointMarks}</div>`
      : `<div class="price-plot-track is-empty" aria-label="가격 기록 없음"><span>기록 없음</span></div>`;
    return `<article class="price-plot-row"><header class="price-plot-source"><div><h4>${escapeHTML(source.name)}</h4><span>${escapeHTML(source.kind)}</span></div><small>${checked}</small></header><div class="price-plot-body">${track}<div class="price-plot-axis"><span>${tickLabels[0]}</span><span>${tickLabels[1]}</span><span>${tickLabels[2]}</span></div>${list}</div></article>`;
  }).join("");
  const legend = activeKind === "reference" ? "일괄·범용 참고 기록은 카드별 가격 비교에서 제외합니다." : "카드 후보 가격은 같은 카드로 확인되지 않았을 수 있습니다. 번호와 패럴렐을 원문에서 대조하세요.";
  return `<section class="platform-comparison" aria-labelledby="platform-comparison-title"><div class="platform-comparison-title"><div><span class="section-kicker">${escapeHTML(kindLabel)}</span><h3 id="platform-comparison-title">플랫폼별 가격 기록</h3></div><p>각 점은 확인 당시 ${escapeHTML(kindLabel)}입니다. 상품가 기준이며 배송비가 확인되지 않은 기록도 포함됩니다. ${escapeHTML(legend)}</p></div><div class="price-plot-axis-title"><span>낮은 가격</span><span>높은 가격</span></div><div class="price-plot-list">${rows}</div><p class="price-plot-footnote">가격 기록이 없는 플랫폼은 이번 조사에서 확인하지 못한 상태입니다. 매물이 없다는 뜻은 아니며, 현재 판매 여부는 원문에서 확인하세요.</p></section>`;
}

function renderDialog(card, activeTab = "asking", activeSource = "all", restoreControl = null, activeComparison = null) {
  const dialogScrollTop = ui.dialog.scrollTop;
  const records = recordsFor(card);
  const cardTitle = card.player + (card.cardNumber ? " " + card.cardNumber : "");
  const tabLabels = PRICE_LABELS;
  const sourceRecords = activeSource === "all" ? records : records.filter((record) => record.sourceId === activeSource);
  const filtered = sourceRecords.filter((record) => matchesKind(record, activeTab));
  const comparisonGroups = groupExactComparisons(filtered);
  const selectedComparison = activeComparison === "all" ? "all"
    : activeComparison && comparisonGroups.some((group) => group.key === activeComparison)
      ? activeComparison
      : comparisonGroups[0]?.key || "all";
  const rows = filtered.length
    ? filtered.map(recordRow).join("")
    : "<div class=\"record-empty\"><strong>" + PRICE_LABELS[activeTab] + " 기록이 아직 없어요.</strong>이 출처에 매물이 없다는 뜻은 아닙니다.</div>";
  const tabs = PRICE_GROUPS.map((kind) => {
    const amount = countByKind(sourceRecords, kind);
    return "<button class=\"record-tab\" type=\"button\" data-tab=\"" + kind + "\" aria-pressed=\"" + (kind === activeTab) + "\">" + tabLabels[kind] + " <span>" + amount + "</span></button>";
  }).join("");
  const sources = [{ id: "all", name: "전체 플랫폼" }].concat(marketData.sources);
  const selectedSourceName = sources.find((source) => source.id === activeSource)?.name || "전체 플랫폼";
  const filterStatus = selectedSourceName + " · " + tabLabels[activeTab] + " " + filtered.length + "건";
  const sourceFilters = sources.map((source) => {
    const amount = source.id === "all" ? records.length : records.filter((record) => record.sourceId === source.id).length;
    return "<button class=\"source-filter\" type=\"button\" data-source-filter=\"" + escapeHTML(source.id) + "\" aria-pressed=\"" + (source.id === activeSource) + "\">" + escapeHTML(source.name) + " <span>" + amount + "</span></button>";
  }).join("");
  const comparisonFilters = comparisonGroups.length
    ? [{ key: "all", label: "전체 조건 · 가격 범위 미계산" }, ...comparisonGroups].map((group, index) => {
      const value = index === 0 ? "all" : String(index - 1);
      return "<button class=\"source-filter\" type=\"button\" data-comparison-filter=\"" + value + "\" aria-pressed=\"" + (group.key === selectedComparison) + "\">" + escapeHTML(group.label) + "</button>";
    }).join("")
    : "";
  const searchLink = "https://m.bunjang.co.kr/keywords/" + encodeURIComponent("2026 SCC " + card.player);
  const askingRecord = records.find((record) => record.kind === "asking" && record.matchLevel === "exact" && record.url)
    || records.find((record) => record.kind === "asking" && record.matchLevel === "candidate" && record.url);
  const shareURL = new URL(window.location.href);
  shareURL.searchParams.set("card", card.id);
  const askingHref = safeExternalHref(askingRecord?.url);
  const directListing = askingHref
    ? "<a class=\"button button-primary\" href=\"" + escapeHTML(askingHref) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + (askingRecord.matchLevel === "exact" ? "일치 확인 매물 보기" : "후보 매물 원문 보기") + " <span aria-hidden=\"true\">↗</span></a>"
    : "";
  const evidenceViews = records.length
    ? "<div class=\"source-filters\" role=\"group\" aria-label=\"플랫폼별 기록 필터\">" + sourceFilters + "</div>"
      + "<div class=\"record-tabs\" role=\"group\" aria-label=\"가격 유형별 기록\">" + tabs + "</div>"
      + (comparisonFilters ? "<div class=\"source-filters comparison-filters\" role=\"group\" aria-label=\"실물 비교 조건별 기록\">" + comparisonFilters + "</div>" : "")
      + (comparisonFilters ? "<p class=\"comparison-condition-note\">그래프에는 선택한 동일 실물 조건만 표시됩니다. 전체 조건을 고르면 기록은 함께 보이지만 서로 다른 시리얼·등급·상태의 가격 범위는 계산하지 않습니다.</p>" : "")
      + platformComparisonMarkup(records, activeTab, activeSource, selectedComparison)
      + "<div class=\"record-list\">" + rows + "</div>"
    : "<div class=\"record-empty detail-record-empty\"><strong>이 카드와 연결된 공개 가격 기록이 없습니다.</strong><span>카드 정보와 가격 근거를 확인한 자료가 등록되면 이곳에 표시합니다. 현재 매물 여부는 원문에서 확인해 주세요.</span></div>";
  const catalogLabel = card.catalogStatus === "official" ? "정식 체크리스트" : "판매글 후보";
  const identityNote = card.catalogStatus === "official"
    ? "정식 체크리스트에서 확인한 카드 정보예요. 실물 카드의 패럴렐·시리얼은 별도로 대조해야 합니다."
    : "판매글 표기 기준 후보입니다. " + escapeHTML(card.identityStatus || "카드 번호와 패럴렐은 확인 전입니다.") + " 번호와 패럴렐이 확인되기 전에는 같은 카드로 묶지 않습니다.";
  ui.dialogContent.innerHTML = cardVisualMarkup(card) + "<div class=\"dialog-title-row\"><div><h2 id=\"dialog-title\">" + escapeHTML(cardTitle) + "</h2><p>" + escapeHTML(card.team) + " · " + catalogLabel + " · 2026 SCC SENSATION · " + escapeHTML(card.variant) + (card.serial ? " · " + escapeHTML(card.serial) : "") + "</p></div><span class=\"type-badge type-" + typeClass(card.type) + "\">" + escapeHTML(card.type) + "</span></div>"
    + "<p class=\"dialog-hint\">" + identityNote + "</p>"
    + evidenceViews
    + "<div class=\"visually-hidden\" id=\"dialog-filter-status\" role=\"status\" aria-live=\"polite\"></div>"
    + "<p class=\"draft-confirmation\">실시간 매물 조회는 제공하지 않습니다. 현재 판매 여부와 카드 정보는 원문에서 확인해 주세요.</p>"
    + "<div class=\"dialog-actions\">" + directListing + "<a class=\"button " + (askingRecord ? "button-quiet" : "button-primary") + "\" href=\"" + escapeHTML(searchLink) + "\" target=\"_blank\" rel=\"noopener noreferrer\">번개장터에서 검색 <span aria-hidden=\"true\">↗</span></a><button class=\"button button-quiet\" type=\"button\" data-copy-card-link=\"" + escapeHTML(shareURL.href) + "\">카드 링크 복사</button></div>";
  ui.dialogContent.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => renderDialog(card, button.dataset.tab, activeSource, { type: "tab", value: button.dataset.tab }, selectedComparison)));
  ui.dialogContent.querySelectorAll("[data-source-filter]").forEach((button) => button.addEventListener("click", () => renderDialog(card, activeTab, button.dataset.sourceFilter, { type: "source", value: button.dataset.sourceFilter }, selectedComparison)));
  ui.dialogContent.querySelectorAll("[data-comparison-filter]").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.comparisonFilter);
    const comparison = button.dataset.comparisonFilter === "all" ? "all" : comparisonGroups[index]?.key;
    if (comparison) renderDialog(card, activeTab, activeSource, { type: "comparison", value: button.dataset.comparisonFilter }, comparison);
  }));
  ui.dialogContent.querySelector("[data-copy-card-link]").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(event.currentTarget.dataset.copyCardLink);
      showToast("이 카드 상세 링크를 복사했습니다.");
    } catch {
      showToast("주소 복사는 HTTPS 페이지에서 지원합니다.");
    }
  });
  if (restoreControl) {
    const selector = restoreControl.type === "tab" ? "[data-tab]" : restoreControl.type === "comparison" ? "[data-comparison-filter]" : "[data-source-filter]";
    const dataKey = restoreControl.type === "tab" ? "tab" : restoreControl.type === "comparison" ? "comparisonFilter" : "sourceFilter";
    const focusTarget = [...ui.dialogContent.querySelectorAll(selector)].find((button) => button.dataset[dataKey] === restoreControl.value);
    focusTarget?.focus({ preventScroll: true });
    ui.dialog.scrollTop = dialogScrollTop;
    const status = ui.dialogContent.querySelector("#dialog-filter-status");
    window.requestAnimationFrame(() => { status.textContent = filterStatus; });
  }
}

function originalPhotoSourcesMarkup(card, records) {
  const rows = [];
  for (const record of records) {
    const source = marketData.sources.find((item) => item.id === record.sourceId);
    const href = safeExternalHref(record.url);
    if (!href) continue;
    rows.push({ sourceName: source?.name || "출처", title: "판매글 사진", note: record.checkedAt ? "확인 " + record.checkedAt : "원문에서 확인", href });
  }
  for (const imageSource of card.photoSources || []) {
    const source = marketData.sources.find((item) => item.id === imageSource.sourceId);
    const href = safeExternalHref(imageSource.url);
    if (!href) continue;
    rows.push({ sourceName: source?.name || "출처", title: imageSource.title || "카드 사진", note: imageSource.note || "원문 사진", href });
  }
  const unique = [...new Map(rows.map((row) => [row.href, row])).values()];
  if (!unique.length) return "";
  const links = unique.map((row) => `<a class="photo-source-link" href="${escapeHTML(row.href)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHTML(row.sourceName)} · ${escapeHTML(row.title)}</strong><span>${escapeHTML(row.note)} · 원본 페이지 ↗</span></a>`).join("");
  return `<section class="photo-sources" aria-labelledby="photo-sources-title"><div><span class="section-kicker">실물 이미지 출처</span><h3 id="photo-sources-title">원본 사진 보기</h3><p>카드 사진은 판매자·플랫폼 원문에서 확인합니다. 이미지 파일은 복사하거나 이 사이트에 저장하지 않습니다.</p></div><div class="photo-source-list">${links}</div></section>`;
}

function openCard(cardId) {
  const card = findCard(cardId);
  if (!card) return;
  lastFocused = document.activeElement;
  renderDialog(card);
  ui.dialog.showModal();
  document.querySelector("#close-dialog").focus();
}

function resetFilters() {
  ui.search.value = "";
  ui.team.value = "all";
  ui.sort.value = "featured";
  selectedType = "전체";
  selectedRecord = "all";
  favoritesOnly = false;
  ui.types.querySelectorAll("[data-type]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.type === "전체")));
  ui.records.querySelectorAll("[data-record]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.record === "all")));
  document.querySelector("#show-favorites").setAttribute("aria-pressed", "false");
  renderCards();
}

function bindControls() {
  document.querySelector("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    document.querySelector("#catalog").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  ui.search.addEventListener("input", renderCards);
  ui.clearSearch.addEventListener("click", () => { ui.search.value = ""; ui.search.focus(); renderCards(); });
  ui.team.addEventListener("change", renderCards);
  ui.sort.addEventListener("change", renderCards);
  document.querySelector("#reset-filters").addEventListener("click", resetFilters);
  document.querySelector("#show-favorites").addEventListener("click", (event) => {
    favoritesOnly = !favoritesOnly;
    event.currentTarget.setAttribute("aria-pressed", String(favoritesOnly));
    renderCards();
  });
  ui.grid.addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-filters]")) {
      resetFilters();
      return;
    }
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      const id = favoriteButton.dataset.favorite;
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      saveFavorites();
      renderCards();
      return;
    }
    const cardButton = event.target.closest("[data-card]");
    if (cardButton) openCard(cardButton.dataset.card);
  });
  document.querySelector("#observation-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-card]");
    if (button) openCard(button.dataset.card);
  });
  document.querySelector("#close-dialog").addEventListener("click", () => ui.dialog.close());
  ui.dialog.addEventListener("click", (event) => {
    if (event.target === ui.dialog) ui.dialog.close();
  });
  ui.dialog.addEventListener("close", () => lastFocused?.focus());
}

async function start() {
  const filterDetails = document.querySelector(".filter-details");
  const mobileLayout = window.matchMedia("(max-width: 680px)");
  filterDetails.open = !mobileLayout.matches;
  mobileLayout.addEventListener("change", (event) => { filterDetails.open = !event.matches; });
  bindControls();
  try {
    const response = await fetch(DATA_URL, { cache: "default" });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    marketData = await response.json();
    renderStats();
    renderFilterOptions();
    renderCards();
    const deepLinkedCard = new URLSearchParams(window.location.search).get("card");
    if (deepLinkedCard && findCard(deepLinkedCard)) openCard(deepLinkedCard);
  } catch (error) {
    console.error("SCC MARKET catalog load failed", error);
    document.querySelector("#load-error").hidden = false;
    ui.grid.setAttribute("aria-busy", "false");
  }
}

start();
