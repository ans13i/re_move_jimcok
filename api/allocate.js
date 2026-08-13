/**
 * POST /api/allocate — 수하물·특송 배치안 생성 (Vercel 서버리스 함수)
 *
 * 처리 순서
 *   1. buildDestPlans로 하차역별 호차 구간을 먼저 확정 (코드)
 *   2. Claude에게 보관대까지만 요청 (제약·목표·destPlans·잔여공간을 프롬프트에 명시)
 *   3. AI가 정한 보관대 안에서 코드가 칸 번호를 부여 (fallback.js의 칸 배정 로직 재사용)
 *   4. validator로 검증
 *   5. 위반이 있으면 위반 내역을 붙여 재요청 (최대 2회 = 총 3회 시도)
 *   6. 3회 실패하거나 AI를 쓸 수 없으면 allocateFallback으로 전환
 *
 * 절대 죽지 않습니다. 키가 없든, 호출이 실패하든, AI가 계속 위반을 내든
 * 항상 200과 유효한 배치안을 돌려줍니다.
 *
 * 키는 서버에서만 읽습니다 (lib/claude.js). 클라이언트로는 나가지 않습니다.
 */

import { loadLocalEnv } from "../lib/env.js";
import { allocateFallback, assignSlotsInRacks, buildDestPlans } from "../lib/fallback.js";
import { validateAllocation } from "../lib/validator.js";
import {
  buildUnloadPlan,
  computeCapacity,
  createDemoRequest,
  summarizeRacks,
  walkingDistanceM,
} from "../lib/train.js";
import {
  ClaudeRefusalError,
  buildAllocationPrompt,
  hasApiKey,
  requestRackPlan,
} from "../lib/claude.js";

/** LLM 시도 횟수 (최초 1회 + 재요청 2회) */
const MAX_LLM_ATTEMPTS = 3;

/** AI에 쓸 수 있는 전체 시간 (ms). 넘으면 남은 시도를 포기하고 폴백합니다. */
const AI_BUDGET_MS = 45_000;

/** 한 번 호출에 허용할 시간 (ms) */
const PER_ATTEMPT_TIMEOUT_MS = 20_000;

export default async function handler(req, res) {
  // 로컬 개발에서 .env.local을 확실히 읽습니다. Vercel 배포 환경에서는 아무 일도 하지 않습니다.
  loadLocalEnv();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 지원합니다." });
  }

  try {
    const { train, items } = parseInput(await readBody(req));
    const result = await allocateWithAI(train, items);
    return res.status(200).json(result);
  } catch (error) {
    // 여기까지 오면 안 되지만, 데모가 멈추는 것보다는 낫습니다.
    return res.status(200).json({
      allocations: [],
      destPlans: [],
      attempts: [],
      source: "fallback",
      summary: `배치에 실패했습니다: ${error?.message ?? "알 수 없는 오류"}`,
      unloadPlan: [],
      unassigned: [],
      violations: [],
      error: String(error?.message ?? error),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 파이프라인
// ─────────────────────────────────────────────────────────────

async function allocateWithAI(train, items) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  // ── 1단계: 하차역별 호차 구간 확정 (코드) ────────────────────
  const destPlans = buildDestPlans(train, items);

  // 잔여 공간은 코드로 계산해 프롬프트에 값으로 넣습니다.
  const baseCapacity = computeCapacity(train, [], items);
  const rackInventory = summarizeRacks(train, []);
  const rackKeys = rackInventory.filter((r) => r.freeSlots > 0).map((r) => r.key);

  const attempts = [];
  let previousViolations = null;
  let aiSummary = "";
  let aiModel = null;

  const canUseAI = hasApiKey() && rackKeys.length > 0 && destPlans.length > 0;
  let skipReason = null;
  if (!hasApiKey()) skipReason = "ANTHROPIC_API_KEY가 없어 규칙 엔진만 사용했습니다.";
  else if (destPlans.length === 0) skipReason = "하차역 구간을 만들 수 없어 규칙 엔진만 사용했습니다.";
  else if (rackKeys.length === 0) skipReason = "사용 가능한 보관대가 없습니다.";

  // ── 2~5단계: AI 요청 → 칸 배정 → 검증 → 재요청 ───────────────
  if (canUseAI) {
    for (let n = 1; n <= MAX_LLM_ATTEMPTS; n += 1) {
      const remainingBudget = AI_BUDGET_MS - elapsed();
      if (remainingBudget < 3_000) {
        attempts.push({
          n,
          label: `llm-${n}`,
          ok: false,
          violations: [],
          error: `시간 예산 초과 (${Math.round(elapsed() / 1000)}초 경과)`,
        });
        break;
      }

      const prompt = buildAllocationPrompt({
        train,
        items,
        destPlans,
        capacity: baseCapacity,
        rackInventory,
        violations: previousViolations,
        attempt: n,
      });

      let plan;
      try {
        plan = await requestRackPlan({
          prompt,
          rackKeys,
          timeoutMs: Math.min(PER_ATTEMPT_TIMEOUT_MS, remainingBudget),
        });
      } catch (error) {
        // 호출 실패는 재요청하지 않고 곧바로 폴백합니다.
        attempts.push({
          n,
          label: `llm-${n}`,
          ok: false,
          violations: [],
          error:
            error instanceof ClaudeRefusalError
              ? `요청이 거부되었습니다 (${error.category ?? "사유 미상"})`
              : String(error?.message ?? error),
        });
        break;
      }

      aiModel = plan.model;

      // ── 3단계: AI가 정한 보관대 안에서 코드가 칸을 부여 ─────────
      const rackByItemId = new Map(
        plan.placements
          .filter((p) => p && typeof p.itemId === "string")
          .map((p) => [p.itemId, p.rack]),
      );
      const { allocations, unassigned } = assignSlotsInRacks(items, train, rackByItemId);

      // ── 4단계: 검증 ───────────────────────────────────────────
      const violations = validateAllocation(allocations, items, destPlans, train);
      const ok = violations.length === 0 && unassigned.length === 0;

      attempts.push({
        n,
        label: n === 1 ? "llm-1" : `llm-retry-${n}`,
        ok,
        violations,
        unassigned,
        model: plan.model,
      });

      if (ok) {
        aiSummary = plan.summary;
        return finalize({
          train,
          items,
          destPlans,
          allocations,
          unassigned,
          violations,
          attempts,
          source: n === 1 ? "llm" : "llm-retry",
          summary: aiSummary,
          model: aiModel,
        });
      }

      // ── 5단계: 위반 내역을 붙여 재요청 ──────────────────────────
      previousViolations = [
        ...violations,
        ...unassigned.map((u) => ({
          code: "UNASSIGNED",
          detail: `${u.itemId}: ${u.detail}`,
        })),
      ];
    }
  } else if (skipReason) {
    attempts.push({ n: 0, label: "llm-skipped", ok: false, violations: [], error: skipReason });
  }

  // ── 6단계: 폴백 ──────────────────────────────────────────────
  const fallbackResult = allocateFallback(items, train, destPlans);
  const fallbackViolations = validateAllocation(
    fallbackResult.allocations,
    items,
    destPlans,
    train,
  );

  attempts.push({
    n: attempts.length + 1,
    label: "fallback",
    ok: fallbackViolations.length === 0,
    violations: fallbackViolations,
    unassigned: fallbackResult.unassigned,
  });

  return finalize({
    train,
    items,
    destPlans,
    allocations: fallbackResult.allocations,
    unassigned: fallbackResult.unassigned,
    violations: fallbackViolations,
    attempts,
    source: "fallback",
    summary: "",
    model: aiModel,
    notice: skipReason ?? describeFallbackReason(attempts),
  });
}

/** 왜 폴백으로 넘어왔는지 한 줄로 설명합니다. */
function describeFallbackReason(attempts) {
  const llmAttempts = attempts.filter((a) => a.label.startsWith("llm-"));
  const failed = llmAttempts.find((a) => a.error);

  if (failed) return `AI 호출에 실패해 규칙 엔진으로 전환했습니다: ${failed.error}`;
  if (llmAttempts.length > 0) {
    return `AI 배치가 ${llmAttempts.length}회 모두 검증을 통과하지 못해 규칙 엔진으로 전환했습니다.`;
  }
  return "규칙 엔진 결과입니다.";
}

// ─────────────────────────────────────────────────────────────
// 응답 조립
// ─────────────────────────────────────────────────────────────

function finalize(ctx) {
  const {
    train,
    items,
    destPlans,
    allocations,
    unassigned,
    violations,
    attempts,
    source,
    summary,
    model,
    notice,
  } = ctx;

  // 승객 수하물에는 도보 거리를, 모든 배정에는 종류·하차역·부피를 붙입니다.
  const slotById = new Map((train.slots ?? []).map((slot) => [slot.id, slot]));
  const itemById = new Map((items ?? []).map((item) => [item.id, item]));
  for (const a of allocations) {
    const item = itemById.get(a.itemId);
    const d = walkingDistanceM(item, slotById.get(a.slotId));
    if (d !== null) a.distanceM = d;
    if (item) {
      a.kind = item.kind;
      a.destination = item.destination;
      a.volumeL = item.volumeL;
      if (item.dimensions) a.dimensions = item.dimensions;
      if (item.ticketKey) a.ticketKey = item.ticketKey;
      if (item.seat) a.seat = item.seat;
      if (item.seatCar) a.seatCar = item.seatCar;
    }
  }

  const unloadPlan = buildUnloadPlan(train, allocations, items);
  const capacity = computeCapacity(train, allocations, items);

  // 승객 수하물만 실은 시점의 잔여 공간 — 역무원이 특송을 실으러 갈 때 보는 숫자입니다.
  // (승객 선배정 → 잔여 공간 계산 → 특송 후배정)
  const freightCapacity = computeCapacity(
    train,
    allocations.filter((a) => a.kind !== "freight"),
    items,
  );

  // 보관대별 남은 공간 — 역무원이 "어디에 얼마나 남았나"를 보는 숫자입니다.
  const usedIds = new Set(allocations.map((a) => a.slotId));
  const rackSpace = summarizeRacks(train, allocations).map((r) => ({
    ...r,
    boxes: Math.floor(r.freeCapacityL / 62),
  }));
  void usedIds;

  const response = {
    allocations,
    destPlans,
    attempts,
    source,
    summary:
      summary?.trim() ||
      buildSummary(allocations, items, unassigned, violations, capacity, source),
    unloadPlan,
    // 아래는 화면에서 쓰기 좋아 함께 실어 보냅니다.
    capacity,
    freightCapacity,
    rackSpace,
    // 잔여 공간은 항상 코드가 계산합니다. AI의 summary는 "검증 결과" 한 줄이라
    // 역할이 다르고, 산술은 애초에 LLM에게 맡기지 않기로 한 부분입니다.
    spaceSummary: buildSpaceSummary(rackSpace),
    unassigned,
    violations,
  };

  if (model) response.model = model;
  if (notice) response.notice = notice;
  return response;
}

/** 남은 적재 공간을 자연어로. 역무원이 특송을 어디로 실을지 판단하는 근거입니다. */
function buildSpaceSummary(rackSpace) {
  const open = rackSpace.filter((r) => r.freeSlots > 0);
  if (open.length === 0) return "모든 보관대가 찼습니다. 추가 화물은 실을 수 없습니다.";
  const parts = open.map(
    (r) => `${r.car}호차 ${r.rack}보관대 ${r.freeSlots}칸(하단 ${r.freeLower}칸, 약 ${r.boxes}박스)`,
  );
  const totalBoxes = open.reduce((sum, r) => sum + r.boxes, 0);
  return `${parts.join(", ")}가 비어 있습니다. 합치면 8호 박스 약 ${totalBoxes}개를 더 실을 수 있습니다.`;
}

/** AI 요약이 없을 때 코드가 만드는 한 문장 */
function buildSummary(allocations, items, unassigned, violations, capacity, source) {
  const kindById = new Map((items ?? []).map((item) => [item.id, item.kind]));
  const total = allocations.length;
  const passengers = allocations.filter(
    (a) => kindById.get(a.itemId) !== "freight",
  ).length;
  const engine = source === "fallback" ? "규칙 엔진" : "AI";

  const head = `${engine}이(가) ${total}건을 배정했습니다 (승객 ${passengers}건, 특송 ${total - passengers}건) · 잔여 ${capacity.remainingL}L`;
  const tail = [];
  if (unassigned.length > 0) tail.push(`미배정 ${unassigned.length}건`);
  if (violations.length > 0) tail.push(`확인 필요 ${violations.length}건`);

  return tail.length > 0 ? `${head} · ${tail.join(" · ")}` : head;
}

// ─────────────────────────────────────────────────────────────
// 입력 파싱
// ─────────────────────────────────────────────────────────────

/**
 * 요청 본문을 읽습니다.
 * 런타임이 req.body를 채워주면 그걸 쓰고, 아니면 스트림을 직접 읽습니다.
 * (Vite 프리셋의 vercel dev에서는 req.body가 비어 있습니다.)
 */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") return req.body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return null;
    return safeJsonParse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** body가 비었거나 {"scenario":"demo"}면 데모 데이터를 씁니다. */
function parseInput(body) {
  const raw = typeof body === "string" ? safeJsonParse(body) : body;

  if (!raw || typeof raw !== "object" || raw.scenario === "demo") {
    return createDemoRequest(raw && raw.passengers);
  }

  const { train, items } = raw;

  if (!train || !Array.isArray(train.slots) || train.slots.length === 0) {
    throw new Error("train.slots가 필요합니다. 데모 데이터를 쓰려면 body를 비우세요.");
  }
  if (!Array.isArray(train.stops) || train.stops.length === 0) {
    throw new Error("train.stops가 필요합니다.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items 배열이 필요합니다.");
  }

  return { train, items };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
