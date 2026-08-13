/**
 * 규칙 기반 폴백 배치기
 *
 * 순수 함수만 있습니다. import·네트워크·시각·난수 등 외부 의존이 전혀 없어
 * 같은 입력이면 항상 같은 배치가 나옵니다.
 *
 * AI는 보관대(호차 + A/B)까지만 정하고, 실제 칸 번호는 이 파일이 순서대로 부여합니다.
 * allocateFallback()은 어떤 입력에도 예외를 던지지 않으며, 공간이 모자라면
 * unassigned 배열에 사유를 담아 명시적으로 돌려줍니다.
 *
 * 데이터 형태(Slot·Item·DestPlan·Train)는 lib/validator.js의 JSDoc과 같습니다.
 */

// ─────────────────────────────────────────────────────────────
// 상수 — validator.js와 값을 맞춰야 합니다
// ─────────────────────────────────────────────────────────────

/** 출입구 인접 보관대 */
export const DOOR_RACK = "A";

/** 안쪽 보관대 */
export const INNER_RACK = "B";

/** 출입구 인접 보관대를 우선 배정할 앞쪽 정차역 수 */
export const EARLY_EXIT_STOP_COUNT = 2;

// ─────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function num(value, digits = 1) {
  return String(Number((value ?? 0).toFixed(digits)));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function slotLabel(slot) {
  if (!slot) return "알 수 없는 칸";
  return `${slot.car}호차 ${slot.rack}보관대 ${pad2(slot.index)}칸`;
}

/** 열차에 실제로 존재하는 호차 번호를 오름차순으로 뽑습니다. */
export function uniqueCars(train) {
  const fromSlots = toArray(train?.slots).map((slot) => slot.car);
  const source = fromSlots.length > 0 ? fromSlots : toArray(train?.cars);
  return [...new Set(source)].filter((car) => Number.isFinite(car)).sort((a, b) => a - b);
}

/**
 * 최대 잉여법으로 total개를 weights 비율대로 나눕니다.
 * 합이 정확히 total이 되고, 같은 입력이면 결과가 항상 같습니다.
 */
function largestRemainder(weights, total) {
  const count = weights.length;
  if (count === 0 || total <= 0) return weights.map(() => 0);

  const sum = weights.reduce((acc, w) => acc + w, 0);

  // 부피 정보가 없으면 균등 분배로 되돌립니다.
  if (sum <= 0) {
    const base = Math.floor(total / count);
    const counts = weights.map(() => base);
    let leftover = total - base * count;
    for (let i = 0; leftover > 0; i = (i + 1) % count, leftover -= 1) counts[i] += 1;
    return counts;
  }

  const exact = weights.map((w) => (w / sum) * total);
  const counts = exact.map((value) => Math.floor(value));
  const leftover = total - counts.reduce((acc, c) => acc + c, 0);

  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; k < leftover; k += 1) counts[byFraction[k].index] += 1;
  return counts;
}

// ─────────────────────────────────────────────────────────────
// 1. 하차역별 호차 구간
// ─────────────────────────────────────────────────────────────

/**
 * 하차역마다 연속된 호차 구간을 배정합니다.
 *
 * - 정차 순서가 이른 역일수록 낮은 호차 번호대를 받습니다.
 * - 구간 크기는 그 역에서 내릴 화물의 총 부피에 비례합니다.
 * - 화물이 없는 역은 구간을 받지 않습니다.
 * - 역 수가 호차 수보다 많으면 구간이 겹칠 수 있습니다(호차가 모자란 경우).
 *
 * @param {Object} train
 * @param {Object[]} items
 * @returns {Object[]} DestPlan[]
 */
export function buildDestPlans(train, items) {
  const stops = toArray(train?.stops);
  const cars = uniqueCars(train);
  const itemList = toArray(items);

  if (stops.length === 0 || cars.length === 0) return [];

  // 정차역별 총 부피 — 정차 목록에 없는 하차역은 무시합니다.
  const volumeByDest = new Map();
  for (const item of itemList) {
    if (!stops.includes(item?.destination)) continue;
    const current = volumeByDest.get(item.destination) ?? 0;
    volumeByDest.set(item.destination, current + (item.volumeL ?? 0));
  }

  // 화물이 있는 역만, 정차 순서대로
  const activeStops = stops.filter((stop) => volumeByDest.has(stop));
  if (activeStops.length === 0) return [];

  // 호차가 역보다 적으면 나눠 가질 수 없으므로 비례 위치에 한 량씩 배정합니다.
  if (cars.length < activeStops.length) {
    return activeStops.map((destination, i) => {
      const car = cars[Math.floor((i * cars.length) / activeStops.length)];
      return {
        destination,
        order: stops.indexOf(destination),
        carFrom: car,
        carTo: car,
        totalVolumeL: volumeByDest.get(destination),
      };
    });
  }

  // 모든 역이 최소 1량을 갖고, 남은 량을 부피 비례로 나눕니다.
  const weights = activeStops.map((stop) => volumeByDest.get(stop));
  const extra = largestRemainder(weights, cars.length - activeStops.length);
  const counts = extra.map((value) => value + 1);

  let cursor = 0;
  return activeStops.map((destination, i) => {
    const slice = cars.slice(cursor, cursor + counts[i]);
    cursor += counts[i];
    return {
      destination,
      order: stops.indexOf(destination),
      carFrom: slice[0],
      carTo: slice[slice.length - 1],
      totalVolumeL: volumeByDest.get(destination),
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 2. 폴백 배치
// ─────────────────────────────────────────────────────────────

/**
 * 칸 후보를 고르는 순서를 정합니다.
 *
 * 특대형은 하단만 쓸 수 있고(규칙 3), 일반 수하물은 상단을 먼저 씁니다.
 * 상단을 먼저 채워야 하단이 뒤에 올 특대형 몫으로 남습니다.
 * 같은 단 안에서는 칸 번호 오름차순 — 번호를 순서대로 부여한다는 규칙 그대로입니다.
 */
function sortCandidates(slots, item) {
  const preferUpper = !item.isXLarge;
  return [...slots].sort((a, b) => {
    if (preferUpper) {
      const rankA = a.tier === "upper" ? 0 : 1;
      const rankB = b.tier === "upper" ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
    }
    // 승객 수하물은 특송 전용 칸을 되도록 비워 둡니다.
    const reservedA = a.reservedFor === "freight" ? 1 : 0;
    const reservedB = b.reservedFor === "freight" ? 1 : 0;
    if (reservedA !== reservedB) return reservedA - reservedB;

    return a.index - b.index;
  });
}

/** 이 칸에 이 화물을 넣을 수 있는지 (하드 제약만) */
function canPlace(slot, item, usedSlotIds) {
  if (slot.available === false) return false; // 규칙 5
  if (usedSlotIds.has(slot.id)) return false;
  if ((slot.capacityL ?? 0) < (item.volumeL ?? 0)) return false;
  if (item.isXLarge && slot.tier !== "lower") return false; // 규칙 3
  if (item.kind === "freight" && slot.reservedFor === "passenger") return false; // 규칙 6
  return true;
}

/** 배정 실패 사유를 구체적인 수치와 함께 적습니다. */
function explainFailure(item, plan, train, usedSlotIds) {
  const inRange = toArray(train?.slots).filter(
    (slot) => slot.car >= plan.carFrom && slot.car <= plan.carTo,
  );
  const free = inRange.filter((slot) => slot.available !== false && !usedSlotIds.has(slot.id));
  const size = item.isXLarge ? "특대형 " : "";

  if (free.length === 0) {
    return `${size}${num(item.volumeL)}L · ${plan.carFrom}~${plan.carTo}호차 ${inRange.length}칸이 모두 사용 중이거나 사용 불가`;
  }

  if (item.isXLarge) {
    const lowerFree = free.filter((slot) => slot.tier === "lower");
    if (lowerFree.length === 0) {
      return `특대형 ${num(item.volumeL)}L · ${plan.carFrom}~${plan.carTo}호차에 남은 하단 칸 없음 · 잔여 상단 ${free.length}칸`;
    }
  }

  const largest = free.reduce((max, slot) => Math.max(max, slot.capacityL ?? 0), 0);
  return `${size}${num(item.volumeL)}L · ${plan.carFrom}~${plan.carTo}호차 잔여 ${free.length}칸의 최대 용적 ${num(largest)}L 부족`;
}

/**
 * 적재 순서를 정합니다.
 *
 * 규칙 6 — 승객이 먼저, 그 다음 특송.
 * 규칙 2 — 각 그룹 안에서 부피가 큰 것부터. 부피가 같으면 id 순으로 고정합니다.
 */
function orderForPacking(items) {
  const kindRank = (item) => (item?.kind === "freight" ? 1 : 0);
  return [...toArray(items)].sort((a, b) => {
    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
    if ((b.volumeL ?? 0) !== (a.volumeL ?? 0)) return (b.volumeL ?? 0) - (a.volumeL ?? 0);
    return String(a.id).localeCompare(String(b.id));
  });
}

/** 배정 결과를 칸 순서로 정렬합니다. 화면·로그에서 읽기 편하고 비교도 쉽습니다. */
function sortResult(allocations, unassigned) {
  allocations.sort(
    (a, b) => a.car - b.car || a.rack.localeCompare(b.rack) || a.index - b.index,
  );
  unassigned.sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  return { allocations, unassigned };
}

/** "7-B" → { car: 7, rack: "B" }. 형식이 아니면 null. */
export function parseRackKey(key) {
  const match = /^(\d+)\s*-\s*([A-Za-z])$/.exec(String(key ?? "").trim());
  if (!match) return null;
  return { car: Number(match[1]), rack: match[2].toUpperCase() };
}

/** { car, rack } → "7-B" */
export function toRackKey(car, rack) {
  return `${car}-${rack}`;
}

/**
 * 이미 정해진 보관대 안에서만 칸 번호를 부여합니다.
 *
 * AI는 보관대(호차 + A/B)까지만 정하고, 실제 칸 번호는 이 함수가 부여합니다.
 * allocateFallback과 같은 칸 선택 규칙(특대형은 하단만, 일반은 상단부터,
 * 같은 단에서는 번호 오름차순)을 그대로 씁니다.
 *
 * AI가 고른 보관대에 자리가 없으면 다른 보관대로 옮기지 않고 미배정으로 남깁니다.
 * 그래야 검증기가 UNASSIGNED로 잡아내고 재요청 루프가 AI에게 사실을 알려줄 수 있습니다.
 *
 * @param {Object[]} items
 * @param {Object} train
 * @param {Object|Map} rackByItemId itemId → "7-B"
 * @returns {{allocations: Object[], unassigned: Object[]}}
 */
export function assignSlotsInRacks(items, train, rackByItemId) {
  const slotList = toArray(train?.slots);
  const lookup =
    rackByItemId instanceof Map ? rackByItemId : new Map(Object.entries(rackByItemId ?? {}));

  const allocations = [];
  const unassigned = [];
  const usedSlotIds = new Set();

  const byRack = new Map();
  for (const slot of slotList) {
    const key = toRackKey(slot.car, slot.rack);
    const list = byRack.get(key);
    if (list) list.push(slot);
    else byRack.set(key, [slot]);
  }

  for (const item of orderForPacking(items)) {
    const rackKey = lookup.get(item?.id);

    if (!rackKey) {
      unassigned.push({
        itemId: item?.id,
        reason: "NO_RACK_CHOICE",
        detail: `${item?.id}에 대한 보관대 지정이 없음`,
      });
      continue;
    }

    const parsed = parseRackKey(rackKey);
    const slots = parsed ? byRack.get(toRackKey(parsed.car, parsed.rack)) : null;

    if (!slots) {
      unassigned.push({
        itemId: item.id,
        reason: "RACK_NOT_FOUND",
        detail: `존재하지 않는 보관대 '${rackKey}' 지정됨`,
      });
      continue;
    }

    const candidate = sortCandidates(slots, item).find((slot) =>
      canPlace(slot, item, usedSlotIds),
    );

    if (!candidate) {
      const free = slots.filter(
        (slot) => slot.available !== false && !usedSlotIds.has(slot.id),
      );
      const largest = free.reduce((max, slot) => Math.max(max, slot.capacityL ?? 0), 0);
      const size = item.isXLarge ? "특대형 " : "";
      unassigned.push({
        itemId: item.id,
        reason: "RACK_FULL",
        detail:
          free.length === 0
            ? `${size}${num(item.volumeL)}L · 지정된 보관대 ${rackKey}에 남은 칸 없음`
            : `${size}${num(item.volumeL)}L · 지정된 보관대 ${rackKey} 잔여 ${free.length}칸의 최대 용적 ${num(largest)}L 부족`,
      });
      continue;
    }

    usedSlotIds.add(candidate.id);
    allocations.push({
      itemId: item.id,
      slotId: candidate.id,
      car: candidate.car,
      rack: candidate.rack,
      index: candidate.index,
      label: slotLabel(candidate),
    });
  }

  return sortResult(allocations, unassigned);
}

/**
 * 규칙 순서대로 배치합니다. 절대 예외를 던지지 않습니다.
 *
 * 1. 하차역별 호차 구간 안에서만 배정
 * 2. 부피 큰 것부터
 * 3. 특대형은 하단 칸만
 * 4. 앞선 두 정차역 화물은 출입구 인접 A보관대 우선
 * 5. 사용 불가 칸 제외
 * 6. 승객 수하물을 먼저 전부 배정하고, 남은 칸에만 특송 배정
 * 7. 공간이 모자라면 unassigned에 사유를 담아 반환
 *
 * @param {Object[]} items
 * @param {Object} train
 * @param {Object[]} destPlans
 * @returns {{allocations: Object[], unassigned: Object[]}}
 */
export function allocateFallback(items, train, destPlans) {
  const itemList = toArray(items);
  const slotList = toArray(train?.slots);
  const stops = toArray(train?.stops);
  const planByDest = new Map(toArray(destPlans).map((plan) => [plan.destination, plan]));

  const allocations = [];
  const unassigned = [];
  const usedSlotIds = new Set();

  // 보관대(호차 + A/B)별로 칸을 묶어 둡니다.
  const byRack = new Map();
  for (const slot of slotList) {
    const key = `${slot.car}|${slot.rack}`;
    const list = byRack.get(key);
    if (list) list.push(slot);
    else byRack.set(key, [slot]);
  }

  // 규칙 6 — 승객이 먼저, 그 다음 특송.
  // 규칙 2 — 각 그룹 안에서 부피가 큰 것부터. 부피가 같으면 id 순으로 고정합니다.
  const ordered = [...itemList].sort((a, b) => {
    const kindRank = (item) => (item.kind === "freight" ? 1 : 0);
    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
    if ((b.volumeL ?? 0) !== (a.volumeL ?? 0)) return (b.volumeL ?? 0) - (a.volumeL ?? 0);
    return String(a.id).localeCompare(String(b.id));
  });

  for (const item of ordered) {
    const plan = planByDest.get(item?.destination);

    if (!plan) {
      unassigned.push({
        itemId: item?.id,
        reason: "NO_DEST_PLAN",
        detail: `${item?.destination ?? "하차역 미상"} 하차 화물의 호차 구간이 정해지지 않음`,
      });
      continue;
    }

    // 규칙 1 — 구간 안의 호차만
    const carsInRange = uniqueCars(train).filter(
      (car) => car >= plan.carFrom && car <= plan.carTo,
    );

    // 구간 안에 실제로 존재하는 보관대를 모읍니다.
    // 호차마다 보관대가 하나일 수도(A·B·C·D), 한 호차에 둘일 수도(A/B) 있습니다.
    const candidateRacks = [];
    for (const car of carsInRange) {
      const racks = [...new Set(slotList.filter((s) => s.car === car).map((s) => s.rack))].sort();
      for (const rack of racks) candidateRacks.push({ car, rack });
    }

    // 규칙 4 — 한 호차에 보관대가 둘 이상일 때만 "출입구 인접(A)" 우선순위가 뜻이 있습니다.
    //          앞선 두 정차역 화물은 A보관대부터, 나머지는 A를 남겨두고 안쪽부터 봅니다.
    const order = stops.indexOf(item.destination);
    const isEarlyExit = order >= 0 && order < EARLY_EXIT_STOP_COUNT;
    if (candidateRacks.length > carsInRange.length) {
      const rank = (r) => (r.rack === DOOR_RACK ? 0 : 1);
      candidateRacks.sort(
        (a, b) => (isEarlyExit ? rank(a) - rank(b) : rank(b) - rank(a)) || a.car - b.car,
      );
    }

    let placed = null;
    for (const { car, rack } of candidateRacks) {
      const slots = byRack.get(`${car}|${rack}`);
      if (!slots) continue;
      const candidate = sortCandidates(slots, item).find((slot) =>
        canPlace(slot, item, usedSlotIds),
      );
      if (candidate) {
        placed = candidate;
        break;
      }
    }

    if (!placed) {
      unassigned.push({
        itemId: item.id,
        reason: "NO_SPACE",
        detail: explainFailure(item, plan, train, usedSlotIds),
      });
      continue;
    }

    usedSlotIds.add(placed.id);
    allocations.push({
      itemId: item.id,
      slotId: placed.id,
      car: placed.car,
      rack: placed.rack,
      index: placed.index,
      label: slotLabel(placed),
    });
  }

  // 출력 순서를 칸 순서로 고정합니다. 화면·로그에서 읽기 편하고 비교도 쉽습니다.
  allocations.sort(
    (a, b) => a.car - b.car || a.rack.localeCompare(b.rack) || a.index - b.index,
  );
  unassigned.sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));

  return { allocations, unassigned };
}
