/**
 * 열차 공간 계산과 배정 결과 파생
 *
 * 순수 함수만 있습니다 (validator.js의 상수만 가져다 씁니다).
 * 잔여 공간 계산은 전부 여기서 코드로 처리합니다 — LLM에게 시키지 않습니다.
 */

import {
  DEFAULT_DWELL_LIMIT_SECONDS,
  DEFAULT_SECONDS_PER_UNLOAD,
  slotLabel,
} from "./validator.js";

/**
 * 수하물을 실을 수 있는 호차. 전량이 아니라 보관대가 있는 4량뿐입니다.
 */
export const LUGGAGE_CARS = [7, 9, 12, 14];

/** 호차당 보관대는 하나이고, 이름은 앞쪽 호차부터 A·B·C·D입니다. */
export const CAR_RACK = { 7: "A", 9: "B", 12: "C", 14: "D" };

/** 보관대 하나의 칸 수 (상단 1 + 하단 2) */
export const SLOTS_PER_RACK = 6;
/** 상단 칸 용적 (L) — 대형까지 */
export const UPPER_SLOT_L = 55;
/** 하단 칸 용적 (L) — 특대형까지 */
export const LOWER_SLOT_L = 120;

/** 안전여유 기본 비율 — 전체 용적의 10%는 비워 둡니다. */
export const DEFAULT_SAFETY_MARGIN_RATIO = 0.1;

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function round1(value) {
  return Number((value ?? 0).toFixed(1));
}

// ─────────────────────────────────────────────────────────────
// 보관대 생성
// ─────────────────────────────────────────────────────────────

/**
 * 호차 목록으로 기본 보관대 배치를 만듭니다.
 * 각 호차에 A·B 보관대, 보관대마다 상단 3칸·하단 3칸.
 */
export function createSlots(cars, options = {}) {
  const {
    perRack = SLOTS_PER_RACK,
    upperCapacityL = UPPER_SLOT_L,
    lowerCapacityL = LOWER_SLOT_L,
  } = options;

  const slots = [];
  for (const car of toArray(cars)) {
    // 호차마다 보관대 하나. 이름은 CAR_RACK에서 가져옵니다.
    const rack = CAR_RACK[car] ?? String.fromCharCode(65 + toArray(cars).indexOf(car));
    for (let index = 1; index <= perRack; index += 1) {
      const tier = index <= perRack / 2 ? "upper" : "lower";
      slots.push({
        id: `${car}-${rack}-${String(index).padStart(2, "0")}`,
        car,
        rack,
        index,
        tier,
        capacityL: tier === "upper" ? upperCapacityL : lowerCapacityL,
        available: true,
        reservedFor: null,
      });
    }
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────
// 잔여 공간 — 전부 코드로 계산합니다
// ─────────────────────────────────────────────────────────────

/**
 * 총 용적 − 사용 − 안전여유.
 *
 * 단순 산술이라 LLM에게 맡기지 않고 여기서 계산해 프롬프트에 값으로 넣습니다.
 *
 * @returns {{totalL:number, usedL:number, safetyMarginL:number, remainingL:number,
 *            totalSlots:number, usedSlots:number, freeSlots:number,
 *            utilizationPct:number, byCar:Object[]}}
 */
export function computeCapacity(train, allocations, items, options = {}) {
  const safetyMarginRatio = options.safetyMarginRatio ?? DEFAULT_SAFETY_MARGIN_RATIO;

  const slots = toArray(train?.slots).filter((slot) => slot.available !== false);
  const itemById = new Map(toArray(items).map((item) => [item.id, item]));
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));

  const used = toArray(allocations).filter((a) => slotById.has(a.slotId));
  const usedSlotIds = new Set(used.map((a) => a.slotId));

  const totalL = slots.reduce((sum, slot) => sum + (slot.capacityL ?? 0), 0);
  const usedL = used.reduce(
    (sum, a) => sum + (itemById.get(a.itemId)?.volumeL ?? 0),
    0,
  );
  const safetyMarginL = totalL * safetyMarginRatio;
  const remainingL = totalL - usedL - safetyMarginL;

  // 호차별 분포 — "특정 호차 몰림 방지"를 판단할 근거로 프롬프트에 넣습니다.
  const carMap = new Map();
  for (const slot of slots) {
    const entry = carMap.get(slot.car) ?? {
      car: slot.car,
      totalL: 0,
      usedL: 0,
      totalSlots: 0,
      usedSlots: 0,
    };
    entry.totalL += slot.capacityL ?? 0;
    entry.totalSlots += 1;
    if (usedSlotIds.has(slot.id)) entry.usedSlots += 1;
    carMap.set(slot.car, entry);
  }
  for (const a of used) {
    const slot = slotById.get(a.slotId);
    const entry = carMap.get(slot.car);
    if (entry) entry.usedL += itemById.get(a.itemId)?.volumeL ?? 0;
  }

  const byCar = [...carMap.values()]
    .sort((a, b) => a.car - b.car)
    .map((entry) => ({
      car: entry.car,
      totalL: round1(entry.totalL),
      usedL: round1(entry.usedL),
      remainingL: round1(entry.totalL - entry.usedL),
      usedSlots: entry.usedSlots,
      freeSlots: entry.totalSlots - entry.usedSlots,
      utilizationPct: entry.totalL > 0 ? round1((entry.usedL / entry.totalL) * 100) : 0,
    }));

  return {
    totalL: round1(totalL),
    usedL: round1(usedL),
    safetyMarginL: round1(safetyMarginL),
    remainingL: round1(remainingL),
    safetyMarginRatio,
    totalSlots: slots.length,
    usedSlots: usedSlotIds.size,
    freeSlots: slots.length - usedSlotIds.size,
    utilizationPct: totalL > 0 ? round1((usedL / totalL) * 100) : 0,
    byCar,
  };
}

// ─────────────────────────────────────────────────────────────
// 보관대 재고 — 프롬프트에 넣을 요약
// ─────────────────────────────────────────────────────────────

/**
 * 보관대(호차 + A/B)별 남은 칸과 용적을 정리합니다.
 * AI는 이 목록에 있는 보관대 중에서만 고를 수 있습니다.
 */
export function summarizeRacks(train, allocations = []) {
  const usedSlotIds = new Set(toArray(allocations).map((a) => a.slotId));
  const byRack = new Map();

  for (const slot of toArray(train?.slots)) {
    const key = `${slot.car}-${slot.rack}`;
    const entry = byRack.get(key) ?? {
      key,
      car: slot.car,
      rack: slot.rack,
      freeSlots: 0,
      freeUpper: 0,
      freeLower: 0,
      freeCapacityL: 0,
      maxFreeSlotL: 0,
      blockedSlots: 0,
    };

    if (slot.available === false) {
      entry.blockedSlots += 1;
    } else if (!usedSlotIds.has(slot.id)) {
      entry.freeSlots += 1;
      if (slot.tier === "lower") entry.freeLower += 1;
      else entry.freeUpper += 1;
      entry.freeCapacityL += slot.capacityL ?? 0;
      entry.maxFreeSlotL = Math.max(entry.maxFreeSlotL, slot.capacityL ?? 0);
    }

    byRack.set(key, entry);
  }

  return [...byRack.values()].sort(
    (a, b) => a.car - b.car || a.rack.localeCompare(b.rack),
  );
}

// ─────────────────────────────────────────────────────────────
// 하역 계획 — 배정 결과에서 파생
// ─────────────────────────────────────────────────────────────

/**
 * 정차역별 하역 목록을 만듭니다. 배정 결과에서 그대로 파생되는 값이라
 * AI를 거치지 않습니다.
 */
/** 객차 1량 길이 (m) */
export const CAR_LENGTH_M = 18.7;
/** 좌석 열 간격 (m) */
export const ROW_PITCH_M = 0.93;
/** 일반실 1량의 좌석 열 수 */
export const ROWS_PER_CAR = 16;

/**
 * 좌석에서 배정된 칸까지의 도보 거리 (m).
 * A보관대는 앞쪽 출입문, B보관대는 뒤쪽 출입문 앞입니다.
 */
export function walkingDistanceM(item, slot) {
  if (!item || !slot || !item.seatCar) return null;
  const match = /(\d+)/.exec(String(item.seat ?? ""));
  const seatRow = match ? Number(match[1]) : Math.round(ROWS_PER_CAR / 2);
  const rackRow = slot.rack === "A" ? 0 : ROWS_PER_CAR;
  const carGap = Math.abs(slot.car - item.seatCar);
  return round1(carGap * CAR_LENGTH_M + Math.abs(rackRow - seatRow) * ROW_PITCH_M);
}

export function buildUnloadPlan(train, allocations, items) {
  const secondsPerUnload = train?.secondsPerUnload ?? DEFAULT_SECONDS_PER_UNLOAD;
  const dwellLimit = train?.dwellLimitSeconds ?? DEFAULT_DWELL_LIMIT_SECONDS;

  const itemById = new Map(toArray(items).map((item) => [item.id, item]));
  const slotById = new Map(toArray(train?.slots).map((slot) => [slot.id, slot]));

  return toArray(train?.stops).map((station, order) => {
    const rows = toArray(allocations)
      .filter((a) => itemById.get(a.itemId)?.destination === station)
      .map((a) => {
        const slot = slotById.get(a.slotId);
        const item = itemById.get(a.itemId);
        return {
          itemId: a.itemId,
          kind: item?.kind ?? "passenger",
          slotId: a.slotId,
          car: a.car ?? slot?.car,
          rack: a.rack ?? slot?.rack,
          index: a.index ?? slot?.index,
          label: a.label ?? slotLabel(slot),
          volumeL: item?.volumeL ?? 0,
        };
      })
      .sort(
        (a, b) =>
          (a.car ?? 0) - (b.car ?? 0) ||
          String(a.rack).localeCompare(String(b.rack)) ||
          (a.index ?? 0) - (b.index ?? 0),
      );

    const estimatedSeconds = rows.length * secondsPerUnload;

    return {
      station,
      order,
      count: rows.length,
      estimatedSeconds,
      dwellLimitSeconds: dwellLimit,
      withinDwellLimit: estimatedSeconds <= dwellLimit,
      passengerCount: rows.filter((r) => r.kind === "passenger").length,
      freightCount: rows.filter((r) => r.kind === "freight").length,
      items: rows,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 데모 데이터
// ─────────────────────────────────────────────────────────────

/** UI(app/page.tsx)의 KTX 123 값에 맞춘 데모 요청 본문 */
/**
 * 사전 접수된 특송 화물 — 고정값입니다.
 * 앱에서 입력하는 것이 아니라 열차에 이미 잡혀 있는 물량입니다.
 * 역무원 화면은 배정 전에도 이 건수를 보여줍니다.
 */
export const FREIGHT_MANIFEST = [
  { id: "G02", kind: "freight", volumeL: 45, isXLarge: false, destination: "광교" },
  { id: "A13", kind: "freight", volumeL: 95, isXLarge: true, destination: "대전" },
  { id: "A14", kind: "freight", volumeL: 40, isXLarge: false, destination: "대전" },
  { id: "C21", kind: "freight", volumeL: 100, isXLarge: true, destination: "동대구" },
  { id: "B07", kind: "freight", volumeL: 100, isXLarge: true, destination: "부산" },
  { id: "B08", kind: "freight", volumeL: 45, isXLarge: false, destination: "부산" },
];

export function createDemoRequest(passengers) {
  const train = {
    trainNo: "KTX 123",
    origin: "서울",
    stops: ["광교", "대전", "동대구", "부산"],
    slots: createSlots(LUGGAGE_CARS),
  };

  // 승객 수하물은 0건에서 시작하고, 앱에서 등록한 승차권만 추가됩니다.
  const items = FREIGHT_MANIFEST.map((f) => ({ ...f }));

  // 승차권마다 등록한 수하물을 개수만큼 추가합니다. id는 BAG-<승차권번호>.
  for (const p of toArray(passengers)) {
    if (!p || !p.key) continue;
    const station = train.stops.includes(p.dest) ? p.dest : "부산";
    const total = Math.max(1, Math.min(2, Number(p.count) || 1));
    for (let n = 0; n < total; n += 1) {
      items.push({
        id: n === 0 ? `BAG-${p.key}` : `BAG-${p.key}-${n + 1}`,
        ticketKey: p.key,
        kind: "passenger",
        volumeL: Number(p.volumeL) || 120,
        isXLarge: Boolean(p.isXLarge),
        destination: station,
        seatCar: Number(p.seatCar) || 7,
        seat: p.seat || "12A",
        ...(p.dimensions ? { dimensions: p.dimensions } : {}),
      });
    }
  }

  return { train, items };
}
