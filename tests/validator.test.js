/**
 * lib/validator.js 단위 테스트
 *
 * 위반 코드마다 하나씩, 그 코드만 걸리는 최소 시나리오를 만듭니다.
 * 실행: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VIOLATION_CODES, validateAllocation, isValid } from "../lib/validator.js";
import { allocateFallback, buildDestPlans } from "../lib/fallback.js";

// ─────────────────────────────────────────────────────────────
// 픽스처
// ─────────────────────────────────────────────────────────────

const STOPS = ["대전", "동대구", "부산"];

/** 호차마다 A·B 보관대를 두고, 각 보관대에 상단 3칸(90L)·하단 3칸(140L)을 만듭니다. */
function makeSlots(cars, { perRack = 6 } = {}) {
  const slots = [];
  for (const car of cars) {
    for (const rack of ["A", "B"]) {
      for (let index = 1; index <= perRack; index += 1) {
        const tier = index <= perRack / 2 ? "upper" : "lower";
        slots.push({
          id: `${car}-${rack}-${String(index).padStart(2, "0")}`,
          car,
          rack,
          index,
          tier,
          capacityL: tier === "upper" ? 90 : 140,
          available: true,
          reservedFor: null,
        });
      }
    }
  }
  return slots;
}

function makeTrain(overrides = {}) {
  return {
    trainNo: "KTX 123",
    stops: STOPS,
    slots: makeSlots([4, 5, 6, 7, 8, 9]),
    ...overrides,
  };
}

/** 대전 4~5호차, 동대구 6~7호차, 부산 8~9호차 */
const DEST_PLANS = [
  { destination: "대전", order: 0, carFrom: 4, carTo: 5 },
  { destination: "동대구", order: 1, carFrom: 6, carTo: 7 },
  { destination: "부산", order: 2, carFrom: 8, carTo: 9 },
];

function item(id, overrides = {}) {
  return {
    id,
    kind: "passenger",
    volumeL: 80,
    isXLarge: false,
    destination: "대전",
    ...overrides,
  };
}

/** 특정 코드의 위반만 골라냅니다. */
function pick(violations, code) {
  return violations.filter((v) => v.code === code);
}

/** 걸린 코드 집합 */
function codesOf(violations) {
  return [...new Set(violations.map((v) => v.code))].sort();
}

/** 슬롯 하나만 바꾼 열차를 만듭니다. */
function trainWithSlot(slotId, patch) {
  const train = makeTrain();
  train.slots = train.slots.map((slot) => (slot.id === slotId ? { ...slot, ...patch } : slot));
  return train;
}

// ─────────────────────────────────────────────────────────────
// 기준선 — 위반이 하나도 없어야 합니다
// ─────────────────────────────────────────────────────────────

describe("기준선", () => {
  it("정상 배치는 위반이 없다", () => {
    const items = [
      item("P1", { destination: "대전", volumeL: 80 }),
      item("F1", { kind: "freight", destination: "부산", volumeL: 100 }),
    ];
    const allocations = [
      { itemId: "P1", slotId: "4-A-01" }, // 대전 = 첫 정차 → A보관대
      { itemId: "F1", slotId: "8-B-04" }, // 부산 = 셋째 정차 → 보관대 자유, 100L는 하단
    ];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    assert.deepEqual(violations, []);
    assert.equal(isValid(violations), true);
  });
});

// ─────────────────────────────────────────────────────────────
// 코드별 테스트
// ─────────────────────────────────────────────────────────────

describe("SLOT_NOT_FOUND", () => {
  it("존재하지 않는 칸을 참조하면 걸린다", () => {
    const items = [item("P1")];
    const allocations = [{ itemId: "P1", slotId: "9-C-99" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    const found = pick(violations, VIOLATION_CODES.SLOT_NOT_FOUND);

    assert.equal(found.length, 1);
    assert.equal(found[0].detail, "P1이(가) 존재하지 않는 칸 '9-C-99'에 배정됨");
    assert.deepEqual(found[0].relatedIds, ["P1", "9-C-99"]);
  });
});

describe("SLOT_OVERFLOW", () => {
  it("칸 용적보다 큰 부피를 넣으면 걸린다", () => {
    const items = [item("P1", { volumeL: 200 })];
    const allocations = [{ itemId: "P1", slotId: "4-A-01" }]; // 상단 90L

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.SLOT_OVERFLOW]);
    assert.equal(
      pick(violations, VIOLATION_CODES.SLOT_OVERFLOW)[0].detail,
      "4호차 A보관대 01칸 90L에 200L 배정 · 110L 초과",
    );
  });

  it("한 칸에 여러 건이면 부피를 합산해 판단한다", () => {
    const items = [item("P1", { volumeL: 60 }), item("P2", { volumeL: 50 })];
    const allocations = [
      { itemId: "P1", slotId: "4-A-01" },
      { itemId: "P2", slotId: "4-A-01" },
    ];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    const found = pick(violations, VIOLATION_CODES.SLOT_OVERFLOW);

    assert.equal(found.length, 1);
    assert.equal(found[0].detail, "4호차 A보관대 01칸 90L에 110L 배정 · 20L 초과");
  });
});

describe("SLOT_UNAVAILABLE", () => {
  it("사용 불가로 표시된 칸에 배정하면 걸린다", () => {
    const train = trainWithSlot("4-A-01", { available: false, unavailableReason: "파손" });
    const items = [item("P1")];
    const allocations = [{ itemId: "P1", slotId: "4-A-01" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, train);
    const found = pick(violations, VIOLATION_CODES.SLOT_UNAVAILABLE);

    assert.equal(found.length, 1);
    assert.equal(found[0].detail, "P1이(가) 사용 불가 칸 4호차 A보관대 01칸에 배정됨 · 사유: 파손");
  });
});

describe("UPPER_XLARGE", () => {
  it("특대형을 상단 칸에 넣으면 걸린다", () => {
    const items = [item("P1", { isXLarge: true, volumeL: 50 })];
    const allocations = [{ itemId: "P1", slotId: "4-A-01" }]; // 상단

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.UPPER_XLARGE]);
    assert.equal(
      pick(violations, VIOLATION_CODES.UPPER_XLARGE)[0].detail,
      "특대형 P1이(가) 상단 칸 4호차 A보관대 01칸에 배정됨 · 하단 칸만 가능",
    );
  });

  it("특대형이 하단 칸이면 걸리지 않는다", () => {
    const items = [item("P1", { isXLarge: true, volumeL: 50 })];
    const allocations = [{ itemId: "P1", slotId: "4-A-04" }]; // 하단

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    assert.deepEqual(violations, []);
  });
});

describe("DUPLICATE", () => {
  it("같은 칸에 둘 이상 배정하면 걸린다", () => {
    const items = [item("P1", { volumeL: 40 }), item("P2", { volumeL: 40 })];
    const allocations = [
      { itemId: "P1", slotId: "4-A-01" },
      { itemId: "P2", slotId: "4-A-01" },
    ];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());

    // 합계 80L ≤ 90L 이므로 용적 초과는 걸리지 않고 중복만 걸립니다.
    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.DUPLICATE]);
    assert.equal(
      pick(violations, VIOLATION_CODES.DUPLICATE)[0].detail,
      "4호차 A보관대 01칸에 2건 배정 · P1, P2",
    );
  });
});

describe("UNASSIGNED", () => {
  it("배정되지 않은 수하물이 있으면 걸린다", () => {
    const items = [item("P1"), item("P2", { volumeL: 120, isXLarge: true })];
    const allocations = [{ itemId: "P1", slotId: "4-A-01" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    const found = pick(violations, VIOLATION_CODES.UNASSIGNED);

    assert.equal(found.length, 1);
    assert.equal(found[0].detail, "승객 수하물 P2 특대형 120L · 배정된 칸 없음");
    assert.deepEqual(found[0].relatedIds, ["P2"]);
  });
});

describe("DEST_RACK", () => {
  it("하차역 배정 구간을 벗어나면 걸린다", () => {
    // 동대구는 6~7호차인데 9호차에 배치. 동대구는 둘째 정차라 A보관대를 써서
    // EARLY_EXIT_DOOR는 걸리지 않게 합니다.
    const items = [item("F1", { destination: "동대구", volumeL: 100 })];
    const allocations = [{ itemId: "F1", slotId: "9-A-04" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.DEST_RACK]);
    assert.equal(
      pick(violations, VIOLATION_CODES.DEST_RACK)[0].detail,
      "동대구 하차 화물이 9호차에 배치됨 · 배정 구간 6~7호차",
    );
  });

  it("하차역 구간이 아예 없으면 걸린다", () => {
    const items = [item("P1", { destination: "광주송정" })];
    const allocations = [{ itemId: "P1", slotId: "4-A-01" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    const found = pick(violations, VIOLATION_CODES.DEST_RACK);

    assert.equal(found.length, 1);
    assert.match(found[0].detail, /배정 구간이 정해지지 않음/);
  });
});

describe("EARLY_EXIT_DOOR", () => {
  it("앞선 두 정차역 화물이 A보관대 밖에 있으면 걸린다", () => {
    const items = [item("P1", { destination: "대전", volumeL: 80 })];
    const allocations = [{ itemId: "P1", slotId: "4-B-01" }]; // 구간은 맞지만 B보관대

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.EARLY_EXIT_DOOR]);
    assert.equal(
      pick(violations, VIOLATION_CODES.EARLY_EXIT_DOOR)[0].detail,
      "대전(1번째 정차) 하차 화물이 4호차 B보관대 01칸에 배치됨 · 출입구 인접 A보관대 필요",
    );
  });

  it("셋째 정차역부터는 B보관대여도 걸리지 않는다", () => {
    const items = [item("P1", { destination: "부산", volumeL: 80 })];
    const allocations = [{ itemId: "P1", slotId: "8-B-01" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, makeTrain());
    assert.deepEqual(violations, []);
  });
});

describe("DWELL_TIME", () => {
  it("한 정차역 하역이 180초를 넘으면 걸린다", () => {
    // 부산은 8~9호차 24칸. 23건 × 8초 = 184초 > 180초
    const train = makeTrain();
    const busanSlots = train.slots
      .filter((slot) => slot.car === 8 || slot.car === 9)
      .slice(0, 23);

    const items = busanSlots.map((_, i) =>
      item(`P${i + 1}`, { destination: "부산", volumeL: 10 }),
    );
    const allocations = busanSlots.map((slot, i) => ({
      itemId: `P${i + 1}`,
      slotId: slot.id,
    }));

    const violations = validateAllocation(allocations, items, DEST_PLANS, train);

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.DWELL_TIME]);
    assert.equal(
      pick(violations, VIOLATION_CODES.DWELL_TIME)[0].detail,
      "부산 하역 23건 × 8초 = 184초 · 제한 180초 · 4초 초과",
    );
  });

  it("22건(176초)까지는 걸리지 않는다", () => {
    const train = makeTrain();
    const busanSlots = train.slots
      .filter((slot) => slot.car === 8 || slot.car === 9)
      .slice(0, 22);

    const items = busanSlots.map((_, i) =>
      item(`P${i + 1}`, { destination: "부산", volumeL: 10 }),
    );
    const allocations = busanSlots.map((slot, i) => ({
      itemId: `P${i + 1}`,
      slotId: slot.id,
    }));

    const violations = validateAllocation(allocations, items, DEST_PLANS, train);
    assert.equal(pick(violations, VIOLATION_CODES.DWELL_TIME).length, 0);
  });
});

describe("FREIGHT_MIN", () => {
  it("특송용 잔여 용적이 전체의 15% 미만이면 걸린다", () => {
    // 100L짜리 2칸뿐인 작은 열차. 둘 다 쓰면 잔여 0L < 15%(30L)
    const train = {
      trainNo: "KTX 999",
      stops: STOPS,
      slots: [
        { id: "4-A-01", car: 4, rack: "A", index: 1, tier: "lower", capacityL: 100, available: true, reservedFor: null },
        { id: "4-A-02", car: 4, rack: "A", index: 2, tier: "lower", capacityL: 100, available: true, reservedFor: null },
      ],
    };
    const plans = [{ destination: "대전", order: 0, carFrom: 4, carTo: 4 }];
    const items = [item("P1", { volumeL: 50 }), item("P2", { volumeL: 50 })];
    const allocations = [
      { itemId: "P1", slotId: "4-A-01" },
      { itemId: "P2", slotId: "4-A-02" },
    ];

    const violations = validateAllocation(allocations, items, plans, train);

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.FREIGHT_MIN]);
    assert.equal(
      pick(violations, VIOLATION_CODES.FREIGHT_MIN)[0].detail,
      "특송 잔여 용적 0L · 전체 200L의 0% · 최소 15%(30L) 미달",
    );
  });
});

describe("PAX_LOCKED", () => {
  it("승객 전용 칸에 특송 화물을 넣으면 걸린다", () => {
    const train = trainWithSlot("8-B-04", { reservedFor: "passenger" });
    const items = [item("F1", { kind: "freight", destination: "부산", volumeL: 100 })];
    const allocations = [{ itemId: "F1", slotId: "8-B-04" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, train);

    assert.deepEqual(codesOf(violations), [VIOLATION_CODES.PAX_LOCKED]);
    assert.equal(
      pick(violations, VIOLATION_CODES.PAX_LOCKED)[0].detail,
      "특송 F1이(가) 승객 전용 칸 8호차 B보관대 04칸에 배정됨",
    );
  });

  it("승객 수하물은 승객 전용 칸에 넣어도 걸리지 않는다", () => {
    const train = trainWithSlot("8-B-04", { reservedFor: "passenger" });
    const items = [item("P1", { destination: "부산", volumeL: 100 })];
    const allocations = [{ itemId: "P1", slotId: "8-B-04" }];

    const violations = validateAllocation(allocations, items, DEST_PLANS, train);
    assert.deepEqual(violations, []);
  });
});

// ─────────────────────────────────────────────────────────────
// 폴백 배치기가 만든 결과는 검증을 통과해야 합니다
// ─────────────────────────────────────────────────────────────

describe("fallback ↔ validator 연동", () => {
  it("폴백이 만든 배치는 검증을 통과한다", () => {
    const train = makeTrain();
    const items = [
      item("P1", { destination: "대전", volumeL: 120, isXLarge: true }),
      item("P2", { destination: "대전", volumeL: 70 }),
      item("P3", { destination: "동대구", volumeL: 85 }),
      item("P4", { destination: "부산", volumeL: 130, isXLarge: true }),
      item("F1", { kind: "freight", destination: "부산", volumeL: 60 }),
      item("F2", { kind: "freight", destination: "동대구", volumeL: 90 }),
    ];

    const plans = buildDestPlans(train, items);
    const { allocations, unassigned } = allocateFallback(items, train, plans);

    assert.equal(unassigned.length, 0, "모두 배정돼야 한다");

    const violations = validateAllocation(allocations, items, plans, train);
    assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
  });

  it("공간이 모자라면 예외 대신 미배정 목록을 돌려준다", () => {
    const train = {
      trainNo: "KTX 999",
      stops: STOPS,
      slots: [
        { id: "4-A-01", car: 4, rack: "A", index: 1, tier: "lower", capacityL: 100, available: true, reservedFor: null },
      ],
    };
    const items = [
      item("P1", { destination: "대전", volumeL: 90 }),
      item("P2", { destination: "대전", volumeL: 80 }),
    ];

    const plans = buildDestPlans(train, items);
    const result = allocateFallback(items, train, plans);

    assert.equal(result.allocations.length, 1);
    assert.equal(result.unassigned.length, 1);
    assert.equal(result.unassigned[0].itemId, "P2");
    assert.match(result.unassigned[0].detail, /사용 중이거나 사용 불가|부족/);
  });
});
