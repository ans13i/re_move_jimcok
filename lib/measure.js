/**
 * 수하물 사진 → 치수 추정 (Claude vision)
 *
 * ⚠️ 서버 전용 모듈입니다. api/ 안에서만 import하세요.
 *
 * 역할은 하나입니다: "사진 속 수하물의 가로·세로·높이가 대략 몇 cm인가".
 * 등급 판정(대형/특대형)과 보관 가능 여부는 코드가 치수를 받아 계산합니다.
 */

import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "./claude.js";

/** 사진 판독은 배치보다 단순합니다. 낮은 강도로 충분하고 응답도 빠릅니다. */
export const MEASURE_EFFORT = "low";

/** 사진 없이 진행할 때 쓰는 24인치 캐리어 표준 외형 (cm) */
export const FALLBACK_DIMS = { widthCm: 45, depthCm: 30, heightCm: 67 };

const SYSTEM_PROMPT = [
  "당신은 사진 한 장을 보고 여행용 수하물의 외형 치수를 추정하는 도구입니다.",
  "",
  "추정 대상은 사진에서 가장 크게 보이는 캐리어·가방 하나입니다.",
  "바퀴와 손잡이를 포함한 전체 외형을 기준으로 cm 단위 정수로 답하세요.",
  "",
  "가로(widthCm)는 정면에서 본 좌우 폭, 세로(depthCm 아님)에 주의하세요:",
  "- widthCm  : 좌우 폭",
  "- depthCm  : 앞뒤 두께",
  "- heightCm : 바닥부터 손잡이를 접은 상태의 높이",
  "",
  "참고 기준 (기내용~대형 캐리어의 통상 범위):",
  "- 20인치 기내용: 대략 35 × 22 × 55",
  "- 24인치 중형  : 대략 45 × 30 × 67",
  "- 28인치 대형  : 대략 52 × 33 × 77",
  "",
  "치수를 알 수 없거나 수하물이 보이지 않으면 confidence를 low로 두고",
  "가장 가까운 표준 규격을 답하세요. 절대 빈 값을 내지 마세요.",
  "note는 한국어 한 줄로 무엇을 보고 판단했는지 짧게 씁니다.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    widthCm: { type: "integer", description: "좌우 폭 (cm). 10~200 범위" },
    depthCm: { type: "integer", description: "앞뒤 두께 (cm). 5~200 범위" },
    heightCm: { type: "integer", description: "바닥부터 높이 (cm). 10~200 범위" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string", description: "판단 근거. 한국어 한 줄, 40자 이내" },
  },
  required: ["widthCm", "depthCm", "heightCm", "confidence", "note"],
  additionalProperties: false,
};

/** data URL이든 순수 base64든 { mediaType, data }로 정규화합니다. */
export function readImagePayload(image, mediaTypeHint) {
  if (typeof image !== "string" || !image.trim()) {
    throw new Error("이미지가 없습니다.");
  }

  const match = image.match(/^data:([^;,]+);base64,(.+)$/s);
  const mediaType = match ? match[1] : mediaTypeHint || "image/jpeg";
  const data = match ? match[2] : image.replace(/^data:[^,]*,/, "");

  if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
    throw new Error(`지원하지 않는 이미지 형식입니다: ${mediaType}`);
  }
  if (!data) throw new Error("이미지 데이터가 비어 있습니다.");

  return { mediaType, data };
}

/**
 * 사진에서 수하물 치수를 추정합니다.
 *
 * 실패하면 예외를 던집니다 — 호출부(api/measure.js)가 표준 규격으로 폴백합니다.
 *
 * @returns {Promise<{widthCm:number, depthCm:number, heightCm:number, confidence:string, note:string, model:string}>}
 */
export async function measureLuggage({ image, mediaType, apiKey = process.env.ANTHROPIC_API_KEY }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다.");

  const payload = readImagePayload(image, mediaType);

  const client = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 1 });

  const response = await client.beta.messages.create({
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    max_tokens: 2_000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: process.env.CLAUDE_MEASURE_EFFORT || MEASURE_EFFORT,
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: payload.mediaType, data: payload.data } },
          { type: "text", text: "이 수하물의 가로·앞뒤 두께·높이를 cm로 추정해주세요." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("요청이 거부되었습니다.");
  if (response.stop_reason === "max_tokens") throw new Error("응답이 max_tokens에서 잘렸습니다.");

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

  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const widthCm = num(parsed.widthCm);
  const depthCm = num(parsed.depthCm);
  const heightCm = num(parsed.heightCm);

  if (!widthCm || !depthCm || !heightCm) throw new Error("치수를 읽지 못했습니다.");

  return {
    widthCm,
    depthCm,
    heightCm,
    confidence: parsed.confidence ?? "low",
    note: typeof parsed.note === "string" ? parsed.note : "",
    model: response.model ?? DEFAULT_MODEL,
  };
}
