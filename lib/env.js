/**
 * 로컬 개발용 .env 로더
 *
 * ⚠️ 서버 전용 모듈입니다. api/ 안에서만 import하세요.
 *
 * 왜 필요한가:
 *   `vercel dev`는 프로젝트가 링크돼 있으면 클라우드의 Development 환경변수를 쓰고
 *   로컬 .env.local을 무시하는 경우가 있습니다. 그러면 키를 넣어도 함수가 못 읽습니다.
 *   CLI 동작에 기대지 않고 직접 읽어 확실하게 만듭니다.
 *
 * 안전장치:
 *   - Vercel 클라우드(process.env.VERCEL)에서는 아무것도 하지 않습니다.
 *     배포 환경의 값은 대시보드 설정이 유일한 출처여야 합니다.
 *   - 이미 설정된 변수는 절대 덮어쓰지 않습니다.
 *   - 파일이 없거나 깨져 있어도 조용히 넘어갑니다. 데모 중에 죽으면 안 됩니다.
 *
 * 의존성 없이 직접 파싱합니다(dotenv 미사용).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 읽을 파일. 앞에 있는 것이 우선입니다. */
const ENV_FILES = [".env.local", ".env"];

let loaded = false;

/**
 * KEY=VALUE 한 줄을 해석합니다. 못 읽는 줄은 null.
 *
 * 지원: 주석(#), 앞의 `export `, 큰따옴표·작은따옴표, 값 안의 = 기호.
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf("=");
  if (eq <= 0) return null;

  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = body.slice(eq + 1).trim();

  // 따옴표로 감싼 값은 벗겨냅니다. 감싸지 않은 값의 뒤쪽 주석도 잘라냅니다.
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
    value = value.slice(1, -1);
    if (quote === '"') value = value.replace(/\\n/g, "\n");
  } else {
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();
  }

  return [key, value];
}

/**
 * .env.local → .env 순으로 읽어 아직 없는 변수만 process.env에 채웁니다.
 * 여러 번 불러도 한 번만 동작합니다.
 *
 * @param {string} [cwd] 기준 디렉터리
 * @returns {{loadedFrom: string[], added: string[]}} 진단용 — 값은 담지 않습니다
 */
export function loadLocalEnv(cwd = process.cwd()) {
  const result = { loadedFrom: [], added: [] };
  if (loaded) return result;
  loaded = true;

  // 배포 환경에서는 손대지 않습니다.
  if (process.env.VERCEL) return result;

  for (const file of ENV_FILES) {
    let text;
    try {
      text = readFileSync(resolve(cwd, file), "utf8");
    } catch {
      continue; // 파일이 없으면 그냥 넘어갑니다.
    }

    result.loadedFrom.push(file);

    // BOM이 붙어 있으면 첫 키 이름이 깨지므로 제거합니다.
    for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
      const pair = parseLine(line);
      if (!pair) continue;

      const [key, value] = pair;
      // 빈 값은 "설정하지 않은 것"으로 봅니다. 템플릿의 `KEY=` 줄이
      // 뒤에 있어도 실제 값을 지우지 않도록 하기 위함입니다.
      if (!value) continue;
      if (process.env[key]) continue; // 이미 있으면 존중합니다.

      process.env[key] = value;
      result.added.push(key);
    }
  }

  return result;
}
