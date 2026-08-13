/**
 * 배치안 검증기
 *
 * 순수 함수만 있습니다. import·네트워크·파일·시각·난수 등 외부 의존이 전혀 없어
 * 같은 입력이면 항상 같은 위반 배열이 나옵니다.
 *
 * validateAllocation()이 위반 배열을 돌려주며, 배열이 비어 있지 않으면 실패입니다.
 * 각 위반의 detail은 화면에 그대로 붙일 수 있는 한국어 문장입니다.
 */

// ─────────────────────────────────────────────────────────────
// 데이터 형태
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Slot 보관대의 칸 하나
 * @property {string} id            고유 식별자. 예: "7-B-03"
 * @property {number} car           호차 번호
 * @property {"A"|"B"} rack         보관대. A가 출입구 인접
 * @property {number} index         보관대 안에서의 칸 번호 (1부터)
 * @property {"upper"|"lower"} tier 상단/하단
 * @property {number} capacityL     용적 (L)
 * @property {boolean} available    사용 가능 여부
 * @property {string} [unavailableReason] 사용 불가 사유
 * @property {"passenger"|"freight"|null} [reservedFor] 전용 예약 구분
 */

/**
 * @typedef {Object} Item 적재 대상 (승객 수하물 또는 특송 화물)
 * @property {string} id
 * @property {"passenger"|"freight"} kind
 * @property {number} volumeL       부피 (L)
 * @property {boolean} [isXLarge]   특대형 여부
 * @property {string} destination   하차역
 */

/**
 * @typedef {Object} Allocation 배정 한 건
 * @property {string} itemId
 * @property {string} slotId
 */

/**
 * @typedef {Object} DestPlan 하차역별 호차 구간
 * @property {string} destination
 * @property {number} order         정차 순서 (0부터)
 * @property {number} carFrom       구간 시작 호차 (포함)
 * @property {number} carTo         구간 끝 호차 (포함)
 * @property {number} [totalVolumeL]
 */

/**
 * @typedef {Object} Train
 * @property {string} [trainNo]
 * @property {string[]} stops       정차역을 하차 순서대로
 * @property {Slot[]} slots
 * @property {number} [secondsPerUnload]  기본 8
 * @property {number} [dwellLimitSeconds] 기본 180
 * @property {number} [freightMinRatio]   기본 0.15
 */

/**
 * @typedef {Object} Violation
 * @property {string} code
 * @property {string} message   위반 종류를 한 줄로
 * @property {string} detail    구체적 수치가 담긴 화면 표시용 문장
 * @property {string[]} relatedIds 관련된 item·slot id
 */

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

/** 위반 코드 목록. 화면에서 코드별 분기할 때 씁니다. */
export const VIOLATION_CODES = Object.freeze({
  SLOT_NOT_FOUND: "SLOT_NOT_FOUND",
  SLOT_OVERFLOW: "SLOT_OVERFLOW",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  UPPER_XLARGE: "UPPER_XLARGE",
  DUPLICATE: "DUPLICATE",
  UNASSIGNED: "UNASSIGNED",
  DEST_RACK: "DEST_RACK",
  EARLY_EXIT_DOOR: "EARLY_EXIT_DOOR",
  DWELL_TIME: "DWELL_TIME",
  FREIGHT_MIN: "FREIGHT_MIN",
  PAX_LOCKED: "PAX_LOCKED",
});

/** 하역 1건에 걸리는 시간 (초) */
export const DEFAULT_SECONDS_PER_UNLOAD = 8;

/** 한 정차역에서 쓸 수 있는 최대 정차 시간 (초) */
export const DEFAULT_DWELL_LIMIT_SECONDS = 180;

/** 특송용으로 남겨야 할 최소 잔여 용적 비율 */
export const DEFAULT_FREIGHT_MIN_RATIO = 0.15;

/** 출입구 인접 보관대를 강제할 앞쪽 정차역 수 */
export const EARLY_EXIT_STOP_COUNT = 2;

/** 출입구에 인접한 보관대 */
export const DOOR_RACK = "A";

// ─────────────────────────────────────────────────────────────
// 표시용 문자열
// ─────────────────────────────────────────────────────────────

/** 1 → "01" */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 칸을 "7호차 B보관대 03칸" 형태로 적습니다. */
export function slotLabel(slot) {
  if (!slot) return "알 수 없는 칸";
  return `${slot.car}호차 ${slot.rack}보관대 ${pad2(slot.index)}칸`;
}

/** 소수점이 붙지 않게 정리합니다. 123.0 → "123", 6.66 → "6.7" */
function num(value, digits = 1) {
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

/** "승객 수하물" / "특송 화물" */
function kindLabel(item) {
  return item?.kind === "freight" ? "특송 화물" : "승객 수하물";
}

/** 0 → "1번째" */
function ordinalLabel(order) {
  return `${order + 1}번째`;
}

// ─────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function violation(code, message, detail, relatedIds) {
  return { code, message, detail, relatedIds };
}

/** 정차 순서를 찾습니다. 모르는 역이면 -1. */
function stopOrderOf(train, destination) {
  return toArray(train?.stops).indexOf(destination);
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────

/**
 * 배치안을 검증해 위반 목록을 돌려줍니다.
 * 배열이 비어 있으면 통과, 하나라도 있으면 실패입니다.
 *
 * 위반은 표에 적힌 코드 순서대로 담기므로 순서가 항상 일정합니다.
 *
 * @param {Allocation[]} allocations
 * @param {Item[]} items
 * @param {DestPlan[]} destPlans
 * @param {Train} train
 * @returns {Violation[]}
 */
export function validateAllocation(allocations, items, destPlans, train) {
  const allocationList = toArray(allocations);
  const itemList = toArray(items);
  const planList = toArray(destPlans);
  const slotList = toArray(train?.slots);

  const slotById = new Map(slotList.map((slot) => [slot.id, slot]));
  const itemById = new Map(itemList.map((item) => [item.id, item]));
  const planByDest = new Map(planList.map((plan) => [plan.destination, plan]));

  const secondsPerUnload = train?.secondsPerUnload ?? DEFAULT_SECONDS_PER_UNLOAD;
  const dwellLimit = train?.dwellLimitSeconds ?? DEFAULT_DWELL_LIMIT_SECONDS;
  const freightMinRatio = train?.freightMinRatio ?? DEFAULT_FREIGHT_MIN_RATIO;

  /** 존재하는 칸에 걸린 배정만 모읍니다. 나머지 검사는 이것만 봅니다. */
  const resolved = [];
  const violations = [];

  // ── SLOT_NOT_FOUND ──────────────────────────────────────────
  for (const allocation of allocationList) {
    const slot = slotById.get(allocation.slotId);
    if (!slot) {
      violations.push(
        violation(
          VIOLATION_CODES.SLOT_NOT_FOUND,
          "존재하지 않는 칸을 참조했습니다",
          `${allocation.itemId}이(가) 존재하지 않는 칸 '${allocation.slotId}'에 배정됨`,
          [allocation.itemId, allocation.slotId],
        ),
      );
      continue;
    }
    resolved.push({ allocation, slot, item: itemById.get(allocation.itemId) });
  }

  // 칸별로 묶어 둡니다. 중복·용적 검사에 씁니다.
  const bySlot = new Map();
  for (const entry of resolved) {
    const list = bySlot.get(entry.slot.id);
    if (list) list.push(entry);
    else bySlot.set(entry.slot.id, [entry]);
  }

  // ── SLOT_OVERFLOW ───────────────────────────────────────────
  for (const [slotId, entries] of bySlot) {
    const slot = slotById.get(slotId);
    const usedL = entries.reduce((sum, e) => sum + (e.item?.volumeL ?? 0), 0);
    if (usedL > slot.capacityL) {
      const overL = usedL - slot.capacityL;
      violations.push(
        violation(
          VIOLATION_CODES.SLOT_OVERFLOW,
          "칸 용적을 초과했습니다",
          `${slotLabel(slot)} ${num(slot.capacityL)}L에 ${num(usedL)}L 배정 · ${num(overL)}L 초과`,
          [slotId, ...entries.map((e) => e.allocation.itemId)],
        ),
      );
    }
  }

  // ── SLOT_UNAVAILABLE ────────────────────────────────────────
  for (const { allocation, slot } of resolved) {
    if (slot.available === false) {
      const reason = slot.unavailableReason ? ` · 사유: ${slot.unavailableReason}` : "";
      violations.push(
        violation(
          VIOLATION_CODES.SLOT_UNAVAILABLE,
          "사용 불가 칸에 배정했습니다",
          `${allocation.itemId}이(가) 사용 불가 칸 ${slotLabel(slot)}에 배정됨${reason}`,
          [allocation.itemId, slot.id],
        ),
      );
    }
  }

  // ── UPPER_XLARGE ────────────────────────────────────────────
  for (const { allocation, slot, item } of resolved) {
    if (item?.isXLarge && slot.tier === "upper") {
      violations.push(
        violation(
          VIOLATION_CODES.UPPER_XLARGE,
          "특대형이 상단 칸에 배정됐습니다",
          `특대형 ${allocation.itemId}이(가) 상단 칸 ${slotLabel(slot)}에 배정됨 · 하단 칸만 가능`,
          [allocation.itemId, slot.id],
        ),
      );
    }
  }

  // ── DUPLICATE ───────────────────────────────────────────────
  for (const [slotId, entries] of bySlot) {
    if (entries.length > 1) {
      const ids = entries.map((e) => e.allocation.itemId);
      violations.push(
        violation(
          VIOLATION_CODES.DUPLICATE,
          "한 칸에 둘 이상 배정됐습니다",
          `${slotLabel(slotById.get(slotId))}에 ${entries.length}건 배정 · ${ids.join(", ")}`,
          [slotId, ...ids],
        ),
      );
    }
  }

  // ── UNASSIGNED ──────────────────────────────────────────────
  const assignedItemIds = new Set(allocationList.map((a) => a.itemId));
  for (const item of itemList) {
    if (!assignedItemIds.has(item.id)) {
      const size = item.isXLarge ? "특대형 " : "";
      violations.push(
        violation(
          VIOLATION_CODES.UNASSIGNED,
          "배정되지 않은 수하물이 있습니다",
          `${kindLabel(item)} ${item.id} ${size}${num(item.volumeL ?? 0)}L · 배정된 칸 없음`,
          [item.id],
        ),
      );
    }
  }

  // ── DEST_RACK ───────────────────────────────────────────────
  for (const { allocation, slot, item } of resolved) {
    if (!item) continue;
    const plan = planByDest.get(item.destination);
    if (!plan) {
      violations.push(
        violation(
          VIOLATION_CODES.DEST_RACK,
          "하차역 배정 구간을 벗어났습니다",
          `${item.destination} 하차 화물의 배정 구간이 정해지지 않음 · ${allocation.itemId}`,
          [allocation.itemId, slot.id],
        ),
      );
      continue;
    }
    if (slot.car < plan.carFrom || slot.car > plan.carTo) {
      violations.push(
        violation(
          VIOLATION_CODES.DEST_RACK,
          "하차역 배정 구간을 벗어났습니다",
          `${item.destination} 하차 화물이 ${slot.car}호차에 배치됨 · 배정 구간 ${plan.carFrom}~${plan.carTo}호차`,
          [allocation.itemId, slot.id],
        ),
      );
    }
  }

  // ── EARLY_EXIT_DOOR ─────────────────────────────────────────
  // 이 규칙은 한 호차에 보관대가 둘 이상(A: 앞쪽 출입문 / B: 뒤쪽)일 때만 뜻이 있습니다.
  // 호차마다 보관대가 하나뿐이면 "출입구 인접"을 구분할 수 없으므로 건너뜁니다.
  const racksByCar = new Map();
  for (const slot of slotList) {
    if (!racksByCar.has(slot.car)) racksByCar.set(slot.car, new Set());
    racksByCar.get(slot.car).add(slot.rack);
  }
  const hasDoorRacks = [...racksByCar.values()].some((set) => set.size > 1);

  for (const { allocation, slot, item } of hasDoorRacks ? resolved : []) {
    if (!item) continue;
    const order = stopOrderOf(train, item.destination);
    if (order < 0 || order >= EARLY_EXIT_STOP_COUNT) continue;
    if (slot.rack !== DOOR_RACK) {
      violations.push(
        violation(
          VIOLATION_CODES.EARLY_EXIT_DOOR,
          "앞선 정차역 화물이 출입구 인접 보관대에 있지 않습니다",
          `${item.destination}(${ordinalLabel(order)} 정차) 하차 화물이 ${slotLabel(slot)}에 배치됨 · 출입구 인접 ${DOOR_RACK}보관대 필요`,
          [allocation.itemId, slot.id],
        ),
      );
    }
  }

  // ── DWELL_TIME ──────────────────────────────────────────────
  const unloadCountByStop = new Map();
  for (const { item } of resolved) {
    if (!item) continue;
    unloadCountByStop.set(item.destination, (unloadCountByStop.get(item.destination) ?? 0) + 1);
  }
  // 정차 순서대로 확인해 출력 순서를 고정합니다.
  for (const stop of toArray(train?.stops)) {
    const count = unloadCountByStop.get(stop) ?? 0;
    const seconds = count * secondsPerUnload;
    if (seconds > dwellLimit) {
      violations.push(
        violation(
          VIOLATION_CODES.DWELL_TIME,
          "정차 시간 안에 하역할 수 없습니다",
          `${stop} 하역 ${count}건 × ${secondsPerUnload}초 = ${seconds}초 · 제한 ${dwellLimit}초 · ${seconds - dwellLimit}초 초과`,
          [stop],
        ),
      );
    }
  }

  // ── FREIGHT_MIN ─────────────────────────────────────────────
  // 특송이 앞으로 쓸 수 있는 잔여 용적 =
  //   사용 가능하고 · 아직 비어 있고 · 승객 전용이 아닌 칸들의 용적 합
  const usedSlotIds = new Set(resolved.map((e) => e.slot.id));
  const totalCapacityL = slotList
    .filter((slot) => slot.available !== false)
    .reduce((sum, slot) => sum + (slot.capacityL ?? 0), 0);
  const freightAvailableL = slotList
    .filter(
      (slot) =>
        slot.available !== false &&
        !usedSlotIds.has(slot.id) &&
        slot.reservedFor !== "passenger",
    )
    .reduce((sum, slot) => sum + (slot.capacityL ?? 0), 0);

  if (totalCapacityL > 0) {
    const requiredL = totalCapacityL * freightMinRatio;
    if (freightAvailableL < requiredL) {
      const ratioPct = (freightAvailableL / totalCapacityL) * 100;
      violations.push(
        violation(
          VIOLATION_CODES.FREIGHT_MIN,
          "특송용 잔여 용적이 부족합니다",
          `특송 잔여 용적 ${num(freightAvailableL)}L · 전체 ${num(totalCapacityL)}L의 ${num(ratioPct)}% · 최소 ${num(freightMinRatio * 100)}%(${num(requiredL)}L) 미달`,
          [],
        ),
      );
    }
  }

  // ── PAX_LOCKED ──────────────────────────────────────────────
  for (const { allocation, slot, item } of resolved) {
    if (item?.kind === "freight" && slot.reservedFor === "passenger") {
      violations.push(
        violation(
          VIOLATION_CODES.PAX_LOCKED,
          "승객 전용 칸에 특송 화물이 배정됐습니다",
          `특송 ${allocation.itemId}이(가) 승객 전용 칸 ${slotLabel(slot)}에 배정됨`,
          [allocation.itemId, slot.id],
        ),
      );
    }
  }

  return violations;
}

/**
 * 위반이 하나도 없으면 true.
 * @param {Violation[]} violations
 * @returns {boolean}
 */
export function isValid(violations) {
  return toArray(violations).length === 0;
}

/**
 * 위반을 코드별로 묶습니다. 화면에서 코드 단위로 접어 보여줄 때 씁니다.
 * @param {Violation[]} violations
 * @returns {Map<string, Violation[]>}
 */
export function groupByCode(violations) {
  const grouped = new Map();
  for (const item of toArray(violations)) {
    const list = grouped.get(item.code);
    if (list) list.push(item);
    else grouped.set(item.code, [item]);
  }
  return grouped;
}
