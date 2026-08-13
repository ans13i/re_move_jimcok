# 짐콕 — KTX 수하물·특송 AI 배치 서비스

승객의 대형 수하물과 특송 화물을 **좌석 거리·무게·하차 동선**을 고려해 자동 배치하는 프로토타입입니다.

- **승객 화면 10단계** — 승차권 → 서비스 안내 → 수하물 등록 → 등록 판정 → 배정 대기 → 배정 완료 → 위치 안내 → QR 확인증 → 등록 관리 → 문제 신고
- **역무원 화면 10단계** — 담당 열차 홈 → 운영 요약 → AI 배정안 검토 → 전체 위치도 → 칸 상세 → 사전 준비 → 적재 → 하역 → 예외 처리 → 수동 재배정

배포 구조는 **Vercel 정적 호스팅(Vite) + 서버리스 함수(`api/`)** 입니다.

---

## 1. 요구 사항

| 항목 | 버전 |
|---|---|
| Node.js | **20.19 이상** 또는 22.12 이상 (`node -v`로 확인) |
| npm | 10 이상 |
| Vercel CLI | 서버리스 함수를 로컬에서 돌릴 때만 필요 |

> Node 20을 쓴다면 **20.19 이상**이어야 합니다. Vite 8이 `^20.19.0 || >=22.12.0`을 요구합니다.
> 버전이 낮으면 `nvm install 22` 로 22 LTS를 쓰는 편이 가장 안전합니다.

---

## 2. 실행 절차

### 2-1. 클론 후 설치

```bash
git clone <저장소 주소>
cd ktx-luggage-app-v2-source
npm install
```

설치 중 `esbuild` 스크립트 승인 안내가 뜨면 아래를 한 번 실행하세요.

```bash
npm install-scripts approve esbuild
```

### 2-2. 환경 변수 설정

```bash
cp .env.example .env.local
```

`.env.local`을 열어 `ANTHROPIC_API_KEY`에 본인 키를 넣습니다.

```dotenv
ANTHROPIC_API_KEY=여기에_발급받은_키
```

키 발급: <https://console.anthropic.com/settings/keys>

> **키가 없어도 앱은 정상 동작합니다.** 키를 비워두면 `api/allocate`가 AI 호출을 건너뛰고
> 규칙 엔진(`lib/fallback.js`)의 배치 결과만 돌려줍니다. 응답의 `source`가 `"fallback"`이면 이 상태입니다.
>
> `.env.local`은 `.gitignore`에 걸려 있어 **절대 커밋되지 않습니다.** 키를 `.env.example`에 적지 마세요.
> `VITE_` 접두사도 붙이지 마세요 — 붙이면 Vite가 키를 클라이언트 번들에 넣어버립니다.

### 2-3. 개발 서버 실행

실행 방법이 두 가지이고, **서로 다릅니다.**

#### ① UI만 볼 때 — `npm run dev`

```bash
npm run dev
# → http://localhost:5173
```

Vite 개발 서버만 뜹니다. 화면 전환·클릭은 모두 동작하지만 **`/api/*` 호출은 404가 납니다.**
UI 작업만 할 때 가장 빠릅니다.

#### ② API까지 함께 돌릴 때 — `vercel dev` (권장)

```bash
npm i -g vercel     # 최초 1회
vercel login        # 최초 1회
vercel link         # 최초 1회 — 프로젝트 연결
npm start           # = vercel dev
# → http://localhost:3000
```

Vite 프런트엔드와 `api/` 서버리스 함수가 **같은 포트**에서 함께 뜹니다.
`ANTHROPIC_API_KEY`는 `lib/env.js`가 `.env.local`에서 직접 읽어 함수에 넣습니다.

> `vercel dev`는 프로젝트가 Vercel에 링크돼 있으면 클라우드의 Development 환경변수만
> 보고 로컬 `.env.local`을 건너뛰는 경우가 있습니다. 그래서 CLI 동작에 기대지 않고
> 직접 읽습니다. 배포 환경(`process.env.VERCEL`)에서는 이 로더가 아무 일도 하지
> 않으므로, 운영 값의 출처는 Vercel 대시보드 하나뿐입니다.

동작 확인:

```bash
curl -X POST http://localhost:3000/api/allocate \
  -H "Content-Type: application/json" \
  -d '{"scenario":"demo"}'
```

---

## 3. 사용할 수 있는 명령어

| 명령어 | 설명 |
|---|---|
| `npm run dev` | Vite 개발 서버 (UI만, 포트 5173) |
| `npm start` | `vercel dev` — UI + API 통합 (포트 3000) |
| `npm run build` | 프로덕션 빌드 → `dist/` |
| `npm run preview` | 빌드 결과 미리보기 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm test` | 검증기 단위 테스트 (20개) |

---

## 4. 폴더 구조

```
.
├── index.html            SPA 껍데기 (#root만 있음)
├── src/
│   └── main.tsx          app/page.tsx를 마운트하는 진입점
├── app/                  ⚠️ 팀원이 만든 UI — 수정 금지
│   ├── page.tsx          승객·역무원 20개 화면 전체
│   ├── globals.css       모바일 프레임·사물함형 위치도 디자인
│   └── layout.tsx        Next 시절 잔재 (SPA에서는 미사용)
├── api/                  Vercel 서버리스 함수 (파일 = 엔드포인트)
│   └── allocate.js       POST /api/allocate — 전체 파이프라인
├── lib/
│   ├── validator.js      배치안 검증 (순수)
│   ├── fallback.js       규칙 기반 배치·칸 번호 부여 (순수)
│   ├── train.js          잔여 공간 계산·하역 계획 파생 (순수)
│   ├── claude.js         Claude 호출 ⚠️ 서버 전용
│   └── env.js            로컬 .env 로더 ⚠️ 서버 전용
├── tests/
│   └── validator.test.js 위반 코드별 단위 테스트
├── public/               정적 파일 (favicon 등)
├── vercel.json           Vercel 빌드·라우팅 설정
├── .env.example          환경 변수 템플릿 (커밋됨)
├── .env.local            실제 키 (커밋 안 됨)
└── _legacy-cloudflare/   이전 Cloudflare 스캐폴드 백업 (사용 안 함)
```

### `app/`을 건드리지 않는 이유

UI는 이미 완성된 결과물입니다. 마크업·클래스명·스타일을 그대로 두고 AI 배치 기능만 얹는 것이 이 프로젝트의 전제입니다.
`src/main.tsx`는 `app/page.tsx`를 **import해서 마운트만** 하며, 내부를 수정하지 않습니다.

---

## 5. API 명세

### `POST /api/allocate`

수하물·특송 배치안을 만듭니다. body를 비우거나 `{"scenario":"demo"}`를 보내면 데모 데이터를 씁니다.

**요청**

```jsonc
{
  "train": {
    "trainNo": "KTX 123",
    "origin": "서울",
    "stops": ["대전", "동대구", "부산"],   // 정차 순서
    "slots": [                              // 칸 목록 (lib/train.js의 createSlots로 생성 가능)
      { "id": "7-B-03", "car": 7, "rack": "B", "index": 3,
        "tier": "lower", "capacityL": 140, "available": true, "reservedFor": null }
    ]
  },
  "items": [
    { "id": "BAG-240812-017", "kind": "passenger", "volumeL": 120,
      "isXLarge": true, "destination": "부산", "seatCar": 7, "seat": "12A" },
    { "id": "A13", "kind": "freight", "volumeL": 110,
      "isXLarge": false, "destination": "대전" }
  ]
}
```

**응답**

```jsonc
{
  "allocations": [
    { "itemId": "BAG-240812-017", "slotId": "9-B-04", "car": 9,
      "rack": "B", "index": 4, "label": "9호차 B보관대 04칸" }
  ],
  "destPlans": [
    { "destination": "대전", "order": 0, "carFrom": 4, "carTo": 6, "totalVolumeL": 375 }
  ],
  "attempts": [
    { "n": 1, "label": "llm-1", "ok": false, "violations": [ /* 위반 내역 */ ] },
    { "n": 2, "label": "llm-retry-2", "ok": true, "violations": [] }
  ],
  "source": "llm-retry",        // "llm" | "llm-retry" | "fallback"
  "summary": "…",               // AI가 생성 (폴백일 때는 코드가 생성)
  "unloadPlan": [
    { "station": "대전", "order": 0, "count": 4, "estimatedSeconds": 32,
      "dwellLimitSeconds": 180, "withinDwellLimit": true, "items": [ /* … */ ] }
  ],

  // 화면에서 쓰기 좋아 함께 실어 보내는 값
  "capacity": { "totalL": 12420, "usedL": 1000, "safetyMarginL": 1242,
                "remainingL": 10178, "byCar": [ /* 호차별 사용률 */ ] },
  "unassigned": [],
  "violations": []
}
```

`source`가 뜻하는 것:

| 값 | 의미 |
|---|---|
| `llm` | AI가 첫 시도에 검증을 통과 |
| `llm-retry` | 위반을 알려주고 재요청해서 통과 (2~3회차) |
| `fallback` | 키 없음 · 호출 실패 · 3회 모두 실패 → 규칙 엔진 결과 |

### 배치가 결정되는 방식

```
1단계  buildDestPlans        하차역별 호차 구간 확정          (코드)
2단계  Claude                각 화물을 어느 "보관대"에 둘지    (AI)
3단계  assignSlotsInRacks    그 보관대 안에서 칸 번호 부여     (코드)
4단계  validateAllocation    11가지 규칙으로 검증              (코드)
5단계  위반이 있으면 위반 내역을 프롬프트에 붙여 재요청 (최대 2회)
6단계  3회 실패 → allocateFallback으로 전환                   (코드)
```

**AI는 보관대까지만 정합니다.** 칸 번호 부여, 잔여 공간 계산(총 용적 − 사용 − 안전여유),
하역 계획 파생, 검증은 전부 코드가 합니다. 단순 산술을 LLM에 맡기지 않는 이유는 틀리기 때문입니다.

**절대 죽지 않습니다.** 키가 없든, 호출이 실패하든, AI가 3회 모두 위반을 내든
항상 HTTP 200과 유효한 배치안을 돌려줍니다. 발표 중 네트워크가 끊겨도 화면은 돕니다.

AI 호출에 쓰는 전체 시간은 45초로 제한되고(회당 20초), 넘으면 남은 시도를 포기하고 폴백합니다.

### AI에게 명시하는 제약과 목표

| 구분 | 내용 |
|---|---|
| 제약 | 하차역 호차 구간 준수 · 특대형은 하단만 · 앞선 두 정차역은 A보관대 · 승객 전용 칸 침범 금지 · 보관대 잔여 칸 초과 금지 |
| 목표 | ① 좌석-보관대 이동거리 최소화 ② 하차역별 집중 ③ 특정 호차 몰림 방지 ④ 자투리 공간 최소화 |
| 출력 강제 | `output_config.format`(JSON Schema) + `rack` 값을 실제 보관대 목록 enum으로 제한 |

---

## 6. 배포

Vercel에 저장소를 연결하면 자동 인식됩니다.

- Framework Preset: **Vite**
- Build Command: `npm run build`
- Output Directory: `dist`

**환경 변수 등록을 잊지 마세요.** Vercel 대시보드 → Settings → Environment Variables 에서
`ANTHROPIC_API_KEY`를 Production·Preview·Development 모두에 추가합니다.
`.env.local`은 커밋되지 않으므로 로컬 설정만으로는 배포 환경에 반영되지 않습니다.

```bash
vercel            # 프리뷰 배포
vercel --prod     # 프로덕션 배포
```

---

## 7. 참고 사항

- **API 키는 서버에서만 읽습니다.** `lib/claude.js`는 `api/` 안에서만 import하세요.
  `src/`나 `app/`에서 부르면 SDK가 브라우저 번들에 딸려 들어갑니다.
  (Vite는 `VITE_` 접두사가 붙은 값만 클라이언트에 주입하므로 키 자체가 번들에 박히지는 않지만,
  애초에 클라이언트에서 부르지 않는 것이 원칙입니다.)
- **모델과 추론 강도는 환경 변수로 바꿉니다** — `CLAUDE_MODEL`(기본 `claude-opus-5`),
  `CLAUDE_EFFORT`(기본 `medium`). 제약을 코드가 잡아주므로 `medium`이면 충분하고 응답도 빠릅니다.
- **`lib/validator.js`와 `lib/fallback.js`는 import가 0개인 순수 모듈입니다.** 외부 호출·시각·난수가
  없어 같은 입력이면 항상 같은 결과가 나오고, `node --test`로 바로 돌릴 수 있습니다.
- **`_legacy-cloudflare/`** 는 이전 Cloudflare Workers 스캐폴드와, Gemini 시절의 TypeScript 도메인
  모델(`superseded/`)을 옮겨둔 백업입니다. 현재 빌드에는 쓰이지 않고 `.gitignore`에 등록돼 있습니다.
  문제가 없다고 판단되면 통째로 지워도 됩니다.
- `app/layout.tsx`는 Next.js 시절 파일이라 SPA 빌드에 포함되지 않습니다. 타입 검사에서도 제외돼 있습니다
  (`tsconfig.json`의 `exclude`). 페이지 제목·favicon은 `index.html`이 담당합니다.
