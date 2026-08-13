/**
 * Claude 호출 래퍼
 *
 * ⚠️ 서버 전용 모듈입니다. 이 파일은 api/ 안에서만 import하세요.
 *    src/ 나 app/ 에서 import하면 안 됩니다 — 브라우저 번들에 SDK가 딸려 들어갑니다.
 *    (Vite는 VITE_ 접두사가 붙은 값만 클라이언트에 주입하므로 ANTHROPIC_API_KEY 자체가
 *     번들에 박히지는 않지만, 애초에 클라이언트에서 부르지 않는 것이 원칙입니다.)
 *
 * 역할은 하나입니다: "각 수하물을 어느 보관대에 둘지"를 Claude에게 물어보는 것.
 * 칸 번호 부여, 잔여 공간 계산, 검증은 전부 코드가 합니다.
 */

import Anthropic from "@anthropic-ai/sdk";

/** 기본 모델 */
export const DEFAULT_MODEL = "claude-opus-5";

/** 기본 추론 강도. 배치는 제약이 코드로 잡혀 있어 medium이면 충분합니다. */
export const DEFAULT_EFFORT = "medium";

/** 한 번 호출에 허용할 시간 (ms) */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 서버에 키가 설정돼 있는지 */
export function hasApiKey(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
}

// ─────────────────────────────────────────────────────────────
// 응답 스키마
// ─────────────────────────────────────────────────────────────

/**
 * AI가 채워야 할 JSON 형태를 만듭니다.
 *
 * rack을 enum으로 못 박아 존재하지 않는 보관대를 아예 만들 수 없게 합니다.
 * (그래도 코드가 다시 검증합니다 — 스키마는 첫 번째 방어선일 뿐입니다.)
 */
export function buildAllocationSchema(rackKeys) {
  return {
    type: "object",
    properties: {
      placements: {
        type: "array",
        description: "모든 수하물·화물 각각에 대해 정확히 하나씩",
        items: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "주어진 목록의 id 그대로" },
            rack: {
              type: "string",
              description: "보관대 키. 예: '7-A'",
              enum: rackKeys,
            },
            reason: {
              type: "string",
              description: "이 보관대를 고른 이유. 한국어 한 줄, 40자 이내",
            },
          },
          required: ["itemId", "rack", "reason"],
          additionalProperties: false,
        },
      },
      summary: {
        type: "string",
        description: "검증 결과를 역무원에게 알리는 한국어 한 문장",
      },
    },
    required: ["placements", "summary"],
    additionalProperties: false,
  };
}

// ─────────────────────────────────────────────────────────────
// 프롬프트
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "당신은 KTX 수하물·특송 화물의 적재 보관대를 정하는 운영 보조입니다.",
  "",
  "당신이 정하는 것은 '어느 보관대인가'뿐입니다. 칸 번호(01~06)는 시스템이 부여하므로",
  "절대 지정하지 마세요. 잔여 용적도 이미 계산되어 주어지므로 다시 계산하지 마세요.",
  "",
  "지켜야 할 제약:",
  "1. 각 화물은 하차역에 배정된 호차 구간 안의 보관대만 쓸 수 있습니다.",
  "2. 특대형은 하단 칸에만 들어갑니다. 하단 여유 칸이 없는 보관대는 고르지 마세요.",
  "3. 승객 전용으로 예약된 칸에는 특송 화물을 넣을 수 없습니다.",
  "4. 보관대의 남은 칸 수보다 많은 화물을 한 보관대에 몰지 마세요.",
  "",
  "보관대 이름은 호차로 정해집니다 (7호차=A · 9호차=B · 12호차=C · 14호차=D).",
  "호차마다 보관대가 하나뿐이므로 '출입구에 더 가까운 보관대'를 고르는 선택지는 없습니다.",
  "앞선 정차역 화물을 앞쪽 호차에 두는 일은 이미 호차 구간이 처리하므로 신경 쓰지 마세요.",
  "",
  "최적화 목표(우선순위 순):",
  "1. 좌석-보관대 이동거리 최소화 (가장 중요) — 승객 수하물은 좌석 호차와 같거나",
  "   가장 가까운 호차의 보관대로. 호차 번호 차이가 작을수록 좋습니다.",
  "   부피가 큰 짐일수록 먼저 가까운 칸을 차지하게 하세요.",
  "2. 하차역별 집중 — 같은 역에서 내릴 화물은 같은 보관대나 인접 보관대로 모읍니다.",
  "3. 특정 호차 몰림 방지 — 한 호차에 몰아넣지 말고 구간 안에서 고르게 폅니다.",
  "4. 자투리 공간 최소화 — 큰 화물부터 큰 칸에 채워 반쪽짜리 빈칸을 줄입니다.",
  "",
  "모든 문장은 한국어 존댓말로 짧게 씁니다. 주어진 데이터에 없는 사실을 지어내지 마세요.",
].join("\n");

/**
 * 프롬프트 본문을 만듭니다. 순수 함수 — 문자열만 조립합니다.
 *
 * @param {Object} input
 * @param {Object} input.train
 * @param {Object[]} input.items
 * @param {Object[]} input.destPlans
 * @param {Object} input.capacity     코드가 계산한 잔여 공간
 * @param {Object[]} input.rackInventory  보관대별 남은 칸
 * @param {Object[]} [input.violations]   직전 시도의 위반 목록 (재요청일 때)
 * @param {number} [input.attempt]
 */
export function buildAllocationPrompt(input) {
  const { train, items, destPlans, capacity, rackInventory, violations, attempt = 1 } = input;

  const lines = [];

  lines.push(`## 열차`);
  lines.push(
    `${train.trainNo ?? "열차"} · ${train.origin ?? "출발역"} → ${train.stops.join(" → ")}`,
  );
  lines.push("");

  lines.push(`## 하차역별 호차 구간 (확정 — 변경 불가)`);
  for (const plan of destPlans) {
    lines.push(
      `- ${plan.destination} (${plan.order + 1}번째 정차): ${plan.carFrom}~${plan.carTo}호차` +
        (plan.totalVolumeL ? ` · 총 ${plan.totalVolumeL}L` : ""),
    );
  }
  lines.push("");

  lines.push(`## 잔여 공간 (시스템 계산값 — 다시 계산하지 마세요)`);
  lines.push(
    `전체 ${capacity.totalL}L · 사용 ${capacity.usedL}L · 안전여유 ${capacity.safetyMarginL}L · 배정 가능 ${capacity.remainingL}L`,
  );
  lines.push(`빈 칸 ${capacity.freeSlots} / ${capacity.totalSlots}`);
  lines.push("호차별 사용률: " + capacity.byCar.map((c) => `${c.car}호차 ${c.utilizationPct}%`).join(" · "));
  lines.push("");

  lines.push(`## 선택 가능한 보관대`);
  for (const rack of rackInventory) {
    if (rack.freeSlots === 0) continue;
    lines.push(
      `- ${rack.key}: 빈 칸 ${rack.freeSlots}개(상단 ${rack.freeUpper} / 하단 ${rack.freeLower})` +
        ` · 가장 큰 빈 칸 ${rack.maxFreeSlotL}L` +
        (rack.blockedSlots ? ` · 사용 불가 ${rack.blockedSlots}칸` : ""),
    );
  }
  lines.push("");

  lines.push(`## 배정할 화물`);
  for (const item of items) {
    const parts = [
      `- ${item.id}`,
      item.kind === "freight" ? "[특송]" : "[승객]",
      `${item.volumeL}L`,
      item.isXLarge ? "특대형(하단만)" : "일반",
      `${item.destination} 하차`,
    ];
    if (item.kind === "passenger" && item.seatCar) {
      parts.push(`좌석 ${item.seatCar}호차${item.seat ? ` ${item.seat}` : ""}`);
    }
    lines.push(parts.join(" · "));
  }

  if (violations && violations.length > 0) {
    lines.push("");
    lines.push(`## 직전 시도(${attempt - 1}회차)에서 발견된 위반 — 반드시 고치세요`);
    for (const v of violations) {
      lines.push(`- [${v.code}] ${v.detail}`);
    }
    lines.push("");
    lines.push(
      "위 위반을 모두 해소하는 새 배치를 내놓으세요. 문제없던 배정은 그대로 두어도 됩니다.",
    );
  }

  lines.push("");
  lines.push(
    `배정할 화물 ${items.length}건 전부에 대해 placements 항목을 하나씩 만드세요. 빠뜨리면 실패로 처리됩니다.`,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 호출
// ─────────────────────────────────────────────────────────────

/** Claude 요청이 거부됐을 때 던지는 오류 */
export class ClaudeRefusalError extends Error {
  constructor(category) {
    super(`요청이 거부되었습니다${category ? ` (${category})` : ""}`);
    this.name = "ClaudeRefusalError";
    this.category = category ?? null;
  }
}

/**
 * Claude에게 보관대 배치를 요청합니다.
 *
 * 출력은 responseSchema로 강제하고, rack 값은 enum으로 막습니다.
 * 실패하면 예외를 던집니다 — 호출부(api/allocate.js)가 폴백으로 넘어갑니다.
 *
 * @returns {Promise<{placements: Object[], summary: string, model: string}>}
 */
export async function requestRackPlan(options) {
  const {
    prompt,
    rackKeys,
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    effort = process.env.CLAUDE_EFFORT || DEFAULT_EFFORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!apiKey) throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다.");

  const client = new Anthropic({
    apiKey,
    // 타임아웃은 밀리초 단위입니다. 재시도까지 포함해도 데모가 멈추지 않도록 짧게 잡습니다.
    timeout: timeoutMs,
    maxRetries: 1,
  });

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16_000,
    // 안전 분류기가 거부하면 서버가 알아서 다른 모델로 넘겨줍니다.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort,
      format: {
        type: "json_schema",
        schema: buildAllocationSchema(rackKeys),
      },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  // content를 읽기 전에 거부 여부부터 확인합니다.
  if (response.stop_reason === "refusal") {
    throw new ClaudeRefusalError(response.stop_details?.category);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("응답이 max_tokens에서 잘렸습니다.");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) throw new Error("빈 응답을 받았습니다.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("응답을 JSON으로 해석하지 못했습니다.");
  }

  if (!Array.isArray(parsed.placements)) {
    throw new Error("응답에 placements 배열이 없습니다.");
  }

  return {
    placements: parsed.placements,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    model: response.model ?? model,
  };
}
