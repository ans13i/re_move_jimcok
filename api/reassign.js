/**
 * POST /api/reassign — 사용할 수 없게 된 칸의 대체 위치 추천 (Vercel 서버리스 함수)
 *
 * 요청  { blockedSlotId, itemId?, allocations, passengers }
 * 응답  { current, candidates[], recommendations[{slotId, label, rank, reason}], source }
 *
 * AI 배정(/api/allocate)이 끝난 뒤 남아 있는 칸 중에서 고릅니다. 여기서 다시
 * 모델을 부르지는 않습니다. 규격·상하단·승객 전용·중복 배정·하차역 구간을
 * 코드가 걸러 실제로 넣을 수 있는 칸만 남기고, 좌석 거리와 이동 동선 기준으로
 * 순위를 매긴 뒤 그 근거를 문장으로 만들어 붙입니다.
 *
 * 절대 죽지 않습니다. 항상 200과 선택 가능한 후보 목록을 돌려줍니다.
 */

import { loadLocalEnv } from "../lib/env.js";
import { buildDestPlans } from "../lib/fallback.js";
import { createDemoRequest, walkingDistanceM } from "../lib/train.js";

export default async function handler(req, res) {
  loadLocalEnv();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 지원합니다." });
  }

  try {
    const body = (await readBody(req)) ?? {};
    return res.status(200).json(recommend(body));
  } catch (error) {
    return res.status(200).json({
      current: null,
      candidates: [],
      recommendations: [],
      source: "none",
      error: String(error?.message ?? error),
    });
  }
}

function recommend(body) {
  const { train, items } = createDemoRequest(body.passengers ?? []);
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const blockedSlotId = String(body.blockedSlotId ?? "");

  // 옮길 화물 — 요청에 없으면 막힌 칸에 배정돼 있던 것을 씁니다.
  const blockedAlloc = allocations.find((a) => a.slotId === blockedSlotId) ?? null;
  const itemId = body.itemId ?? blockedAlloc?.itemId ?? null;
  const item = items.find((i) => i.id === itemId) ?? null;

  const destPlans = buildDestPlans(train, items);
  const plan = destPlans.find((p) => p.destination === item?.destination) ?? null;

  // 자기 자신을 뺀 나머지가 실제로 차지하고 있는 칸입니다.
  const taken = new Set(allocations.filter((a) => a.itemId !== itemId).map((a) => a.slotId));

  const slotById = new Map(train.slots.map((s) => [s.id, s]));
  const current = slotById.get(blockedSlotId) ?? null;

  const candidates = train.slots.map((slot) => {
    // 앞에 오는 이유가 화면에 표시됩니다. 사람이 먼저 알아야 할 순서로 봅니다.
    const reasons = [];
    if (slot.id === blockedSlotId) reasons.push("사용 불가");
    if (taken.has(slot.id)) {
      const holder = allocations.find((a) => a.slotId === slot.id);
      reasons.push(holder?.kind === "freight" ? "특송 배정" : "승객 배정");
    }
    if (item && slot.capacityL < item.volumeL) reasons.push("규격 부족");
    if (item?.isXLarge && slot.tier !== "lower") reasons.push("상단 칸");
    if (plan && (slot.car < plan.carFrom || slot.car > plan.carTo)) reasons.push("구간 밖");

    return {
      slotId: slot.id,
      car: slot.car,
      rack: slot.rack,
      index: slot.index,
      tier: slot.tier,
      capacityL: slot.capacityL,
      label: `${slot.car}호차 ${slot.rack}-${String(slot.index).padStart(2, "0")}`,
      selectable: reasons.length === 0,
      blockedReason: reasons[0] ?? null,
      distanceM: item ? walkingDistanceM(item, slot) : null,
    };
  });

  const open = candidates.filter((c) => c.selectable);

  return {
    current: currentInfo(current, item),
    candidates,
    recommendations: rank(open, item, current),
    source: open.length ? "ranked" : "none",
  };
}

function currentInfo(slot, item) {
  if (!slot) return null;
  return {
    slotId: slot.id,
    label: `${slot.car}호차 ${slot.rack}-${String(slot.index).padStart(2, "0")}`,
    itemId: item?.id ?? null,
    kind: item?.kind ?? null,
    volumeL: item?.volumeL ?? null,
    destination: item?.destination ?? null,
  };
}

/**
 * 순위: 같은 호차 먼저 → 좌석에서 가까운 순 → 앞 칸 순.
 * 근거 문장은 실제로 계산한 값(이동 칸 수·호차 차이·용적·하차역)으로만 만듭니다.
 */
function rank(open, item, current) {
  const sorted = [...open].sort((a, b) => {
    if (current) {
      const sameA = a.car === current.car ? 0 : 1;
      const sameB = b.car === current.car ? 0 : 1;
      if (sameA !== sameB) return sameA - sameB;
    }
    if (a.distanceM !== null && b.distanceM !== null && a.distanceM !== b.distanceM) {
      return a.distanceM - b.distanceM;
    }
    return a.car - b.car || a.index - b.index;
  });

  return sorted.slice(0, 2).map((c, i) => ({
    slotId: c.slotId,
    label: c.label,
    rank: i + 1,
    reason: reasonFor(c, item, current),
  }));
}

function reasonFor(slot, item, current) {
  const parts = [];

  if (current && slot.car === current.car) {
    parts.push("같은 객차");
    parts.push(`이동 ${Math.abs(slot.index - current.index)}칸`);
  } else if (current) {
    parts.push(`이동 ${Math.abs(slot.car - current.car)}호차`);
    if (item?.destination) parts.push(`${item.destination} 하역 동선 적합`);
  } else {
    parts.push(`${slot.car}호차 ${slot.tier === "lower" ? "하단" : "상단"} 칸`);
  }

  if (item?.isXLarge) parts.push("특대형 하단 적재 가능");
  else if (item && slot.capacityL >= item.volumeL) parts.push("무게 적합");

  if (slot.distanceM !== null && parts.length < 3) parts.push(`좌석에서 ${slot.distanceM}m`);

  return parts.slice(0, 3).join(" · ");
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
