export const SOURCE_CATALOG = Object.freeze([
  {
    id: "bunjang",
    name: "번개장터",
    hostnames: ["bunjang.co.kr", "www.bunjang.co.kr", "m.bunjang.co.kr"],
    route: "partner_api",
    blocker: "파트너 계약, API 계정, SCC 검색·이력 보관 범위 확인 필요",
  },
  {
    id: "break",
    name: "BREAK",
    hostnames: ["break.co.kr", "www.break.co.kr", "app.break.market"],
    route: "permissioned_snapshot",
    blocker: "가격 데이터의 수집·보관·표시 허가 확인 필요",
  },
  {
    id: "wyyyes",
    name: "WYYYES",
    hostnames: ["wyyyes.com", "www.wyyyes.com"],
    route: "permissioned_snapshot",
    blocker: "공유 가능한 매물 URL과 데이터 보관 허가 확인 필요",
  },
  {
    id: "community",
    name: "수집가 카페",
    hostnames: ["cafe.naver.com"],
    route: "permissioned_snapshot",
    blocker: "대상 카페·게시판 범위와 작성자/운영자 허가 확인 필요",
  },
  {
    id: "kream",
    name: "KREAM",
    hostnames: ["kream.co.kr", "www.kream.co.kr"],
    route: "permissioned_snapshot",
    blocker: "가격 데이터의 수집·보관·표시 허가 확인 필요",
  },
  {
    id: "daewon",
    name: "대원샵",
    hostnames: ["daewonshop.com", "www.daewonshop.com"],
    route: "permissioned_snapshot",
    blocker: "상품 데이터의 수집·보관·표시 허가 확인 필요",
  },
]);

export const SOURCE_BY_ID = new Map(SOURCE_CATALOG.map((source) => [source.id, source]));

export const OBSERVATION_KINDS = new Set([
  "asking",
  "auction",
  "auction_current_bid",
  "auction_final_bid",
  "sold_badge_only",
  "sold_verified",
  "official_retail",
  "reference",
]);

export const OBSERVATION_STATES = new Set([
  "active_asking",
  "active_at_check",
  "unavailable_on_recheck",
  "sold_badge_sale_price_unverified",
  "sold_badge_only",
  "sold_verified",
  "unknown",
]);

export const MATCH_LEVELS = new Set(["candidate", "exact", "generic"]);

export const ITEM_TYPES = new Set(["single_card", "sealed_box", "sealed_pack", "general_reference"]);
