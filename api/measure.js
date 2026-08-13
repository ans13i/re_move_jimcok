/**
 * POST /api/measure — 수하물 사진에서 치수 추정 (Vercel 서버리스 함수)
 *
 * 요청  { image: "data:image/jpeg;base64,..." }
 * 응답  { widthCm, depthCm, heightCm, volumeL, sizeClass, source, confidence, note }
 *
 * 절대 죽지 않습니다. 키가 없든 호출이 실패하든 항상 200과 쓸 수 있는 치수를
 * 돌려줍니다. 그때는 source가 "fallback"이 되어 화면에서 구분할 수 있습니다.
 *
 * 등급 판정은 코드가 합니다. AI에게는 "몇 cm인가"만 묻습니다.
 */

import { loadLocalEnv } from "../lib/env.js";
import { FALLBACK_DIMS, measureLuggage } from "../lib/measure.js";

/** 보관대 한 칸의 최대 용적 (L) — app/page.tsx의 MAX_SLOT_L과 같아야 합니다. */
const MAX_SLOT_L = 105;

/** 특대형 기준 최장변 (cm) */
const XLARGE_LONGEST_CM = 75;

export default async function handler(req, res) {
  loadLocalEnv();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 지원합니다." });
  }

  const body = await readBody(req);
  const image = body && typeof body === "object" ? body.image : null;

  try {
    const r = await measureLuggage({ image, mediaType: body?.mediaType });
    return res.status(200).json({ ...shape(r), source: "llm", model: r.model });
  } catch (error) {
    // 사진을 못 읽었든 키가 없든, 시연이 멈추지 않도록 표준 규격으로 넘어갑니다.
    return res.status(200).json({
      ...shape({ ...FALLBACK_DIMS, confidence: "low", note: "24인치 캐리어 표준 규격을 적용했습니다." }),
      source: "fallback",
      error: String(error?.message ?? error),
    });
  }
}

/** 치수 → 부피·등급까지 붙인 응답 형태 */
function shape({ widthCm, depthCm, heightCm, confidence, note }) {
  const volumeL = Math.max(1, Math.round((widthCm * depthCm * heightCm) / 1000));
  const longestCm = Math.max(widthCm, depthCm, heightCm);

  return {
    widthCm,
    depthCm,
    heightCm,
    volumeL,
    longestCm,
    // 한 칸을 넘으면 일반 보관대를 쓸 수 없습니다(특송 안내로 이어집니다).
    oversize: volumeL > MAX_SLOT_L,
    sizeClass: volumeL > MAX_SLOT_L ? "oversize" : longestCm > XLARGE_LONGEST_CM ? "xlarge" : "large",
    confidence: confidence ?? "low",
    note: note ?? "",
  };
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    return typeof req.body === "string" ? safeJsonParse(req.body) : req.body;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return null;
    return safeJsonParse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
