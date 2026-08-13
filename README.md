# 짐콕 — KTX 수하물·특송 AI 배치 서비스

승객의 대형 수하물과 특송 화물을 **좌석 거리·무게·하차 동선**을 고려해 자동 배치하는 프로토타입입니다.

- **승객 화면 12개 (P-00 ~ P-11)** — 승차권 예매 → 승차권 상세 → 서비스 안내 → 수하물 크기 인식 → 등록 가능 판정 → 배정 대기 → 위치 배정 완료 → 내 수하물 위치 → QR 확인증 → 등록 관리 → 문제 신고 → 특송 이용 안내
- **역무원 화면 8개 (S-01 ~ S-08)** — 담당 열차 홈 → 열차 운영 요약 → AI 배정안 검토 → 전체 적재 위치도 → 칸 상세 → 특송 작업 체크리스트 → 예외 처리 → 수동 재배정

수하물을 실을 수 있는 호차는 **7·9·12·14호차** 네 량이고, 호차마다 보관대가 하나씩 있습니다
(7호차=A · 9호차=B · 12호차=C · 14호차=D). 보관대 한 대는 상단 3칸·하단 3칸입니다.

배포 구조는 **Vercel 정적 호스팅(Vite) + 서버리스 함수(`api/`)** 입니다.

- 배포: <https://ktx-luggage-app-v2-source.vercel.app>
- 저장소: <https://github.com/ans13i/re_move_jimcok>

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
| `npm test` | 검증기 단위 테스트 (20개, `node --test`) |

---

## 4. 폴더 구조

```
.
├── index.html            SPA 껍데기 (#root만 있음)
├── src/
│   └── main.tsx          app/page.tsx를 마운트하는 진입점
├── app/
│   ├── page.tsx          승객·역무원 20개 화면 전체
│   ├── globals.css       모바일 프레임·사물함형 위치도 디자인
│   └── layout.tsx        Next 시절 잔재 (SPA에서는 미사용)
├── app.js                DOM 후처리 레이어 — React가 그린 화면에 실제 배정값을 채움
├── api/                  Vercel 서버리스 함수 (파일 = 엔드포인트)
│   ├── allocate.js       POST /api/allocate — 배치 파이프라인
│   ├── reassign.js       POST /api/reassign — 막힌 칸의 대체 위치 순위 (AI 호출 없음)
│   └── measure.js        POST /api/measure  — 사진에서 치수 추정 (P-03이 호출)
├── lib/
│   ├── validator.js      배치안 검증 (순수)
│   ├── fallback.js       규칙 기반 배치·칸 번호 부여 (순수)
│   ├── train.js          호차·보관대 정의, 잔여 공간 계산, 하역 계획 파생 (순수)
│   ├── claude.js         Claude 호출 ⚠️ 서버 전용
│   ├── measure.js        사진 치수 추정 ⚠️ 서버 전용
│   └── env.js            로컬 .env 로더 ⚠️ 서버 전용
├── tests/
│   └── validator.test.js 위반 코드별 단위 테스트
├── public/               정적 파일 (favicon 등)
├── vercel.json           Vercel 빌드·라우팅 설정
├── .env.example          환경 변수 템플릿 (커밋됨)
├── .env.local            실제 키 (커밋 안 됨)
└── _legacy-cloudflare/   이전 Cloudflare 스캐폴드 백업 (사용 안 함)
```

### React와 `app.js`가 화면을 나눠 그리는 방식

`app/page.tsx`가 화면의 **구조와 상호작용**을 그리고, `app.js`가 그 위에 **실제 배정 결과**를 채웁니다.
React는 배정 결과를 모르므로 자리만 만들어 두고, `app.js`가 `data-app="…"` 훅을 찾아 값을 씁니다.

React는 리렌더 때 자기가 아는 값으로 되돌리므로, `app.js`는 MutationObserver로 DOM이 바뀔 때마다 다시 적용합니다.
`setText`·`paintHTML`은 값이 같으면 아무 것도 하지 않아 무한 루프가 나지 않습니다.

> **주의** — HTML 문자열에 인라인 `style`을 넣지 마세요. 브라우저가 `width:65%`를 `width: 65%;`로
> 정규화해 다음 패스에서 비교가 어긋나고, 매 프레임 DOM을 새로 만들어 **실제 클릭이 먹지 않습니다.**
> 폭·색 같은 값은 그린 뒤에 `style.width`로 따로 지정하세요.

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
    "stops": ["광교", "대전", "동대구", "부산"],   // 정차 순서
    "slots": [                              // 칸 목록 (lib/train.js의 createSlots로 생성 가능)
      { "id": "9-B-04", "car": 9, "rack": "B", "index": 4,
        "tier": "lower", "capacityL": 120, "available": true, "reservedFor": null }
    ]
  },
  "items": [
    { "id": "BAG-01", "kind": "passenger", "volumeL": 90,
      "isXLarge": false, "destination": "부산", "seatCar": 7, "seat": "12A" },
    { "id": "A13", "kind": "freight", "volumeL": 110,
      "isXLarge": false, "destination": "대전" }
  ]
}
```

**응답**

```jsonc
{
  "allocations": [
    { "itemId": "BAG-01", "slotId": "14-D-04", "car": 14,
      "rack": "D", "index": 4, "label": "14호차 D보관대 04칸" }
  ],
  "destPlans": [
    { "destination": "대전", "order": 1, "carFrom": 9, "carTo": 9, "totalVolumeL": 135 }
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
| 제약 | 하차역 호차 구간 준수 · 특대형은 하단 칸만 · 승객 전용 칸에 특송 금지 · 보관대 잔여 칸 초과 금지 |
| 목표 | ① 좌석-보관대 이동거리 최소화 ② 하차역별 집중 ③ 특정 호차 몰림 방지 ④ 자투리 공간 최소화 |
| 출력 강제 | `output_config.format`(JSON Schema) + `rack` 값을 실제 보관대 목록 enum으로 제한 |

### `POST /api/reassign`

문제가 생겨 쓸 수 없게 된 칸의 화물을 어디로 옮길지 후보와 순위를 돌려줍니다.
**여기서는 모델을 부르지 않습니다.** `/api/allocate`가 끝난 뒤 남아 있는 칸 중에서
규격·상하단·승객 전용·중복 배정·하차역 구간을 코드가 걸러내고, 좌석 거리와 이동
동선으로 순위를 매긴 뒤 근거 문장을 실제 계산값으로 조립합니다.

```jsonc
// 요청
{ "blockedSlotId": "9-B-02", "allocations": [ /* 현재 배정 */ ], "passengers": [ /* … */ ] }

// 응답
{
  "current": { "slotId": "9-B-02", "label": "9호차 B-02", "itemId": "A13" },
  "recommendations": [
    { "slotId": "9-B-04", "label": "9호차 B-04", "rank": 1,
      "reason": "같은 객차 · 이동 2칸 · 특대형 하단 적재 가능" }
  ],
  "candidates": [ /* 전체 칸 + selectable/blockedReason */ ],
  "source": "ranked"        // "ranked" | "none"
}
```

### `POST /api/measure`

사진에서 수하물 치수를 추정합니다(Claude vision). **P-03이 호출합니다.**
사진은 브라우저가 긴 변 768px JPEG로 줄여 보내고, 응답의 `widthCm`·`depthCm`·`heightCm`이
가로·세로·높이 입력란에 그대로 들어갑니다. 값은 승객이 그 자리에서 고칠 수 있고,
`note`("세로 줄무늬 하드케이스, 24인치 중형 비율")는 입력란 아래에 근거로 표시됩니다.

키가 없거나 호출이 실패하거나 **8초를 넘기면** 24인치 캐리어 표준 규격(45×30×67cm)으로
넘어가고 `source`가 `"fallback"`이 됩니다. 그때는 근거 문장을 띄우지 않습니다.
실측 응답 시간은 4~6초입니다.

---

## 5-1. 화면 흐름에서 알아둘 것

| 화면 | 동작 |
|---|---|
| P-02 → P-03 | **사진 첨부가 등록의 첫 단계**입니다. 사진을 붙이면 `/api/measure`가 실제로 사진을 읽어 가로·세로·높이를 채웁니다. 읽기 전용이 아니라 입력란이라 그 자리에서 고칠 수 있고, 고치면 판정도 즉시 따라갑니다. |
| P-04 | 부피가 보관대 한 칸(105L)을 넘으면 판정 화면 대신 **규격 초과 결과**가 나오고 P-11 특송 안내로 이어집니다. |
| S-04 | 상단 열차 도식에서 호차를 눌러 보관대를 고릅니다. 배정이 끝나면 호차별 적재율이 여유·보통·혼잡·거의 만석으로 칠해집니다. |
| S-05 | 승객이 등록 때 붙인 사진을 그대로 보여줍니다. 배정 전이거나 빈 칸이면 값이 전부 `—`입니다. |
| S-06 | **적재 준비 / 하역 예정** 두 탭. 하역 탭은 운행 노선에서 역을 눌러 그 역에서 내릴 목록을 봅니다. 역무원이 직접 다루는 **특송 화물만** 나옵니다. |
| S-07 → S-08 | 현장 문제를 등록하면 그 칸을 막고 수동 재배정으로 이어집니다. 확정하면 적재 체크리스트와 위치도에 실제로 반영됩니다. |

승객이 붙인 사진은 브라우저 세션 안에서만 오갑니다(`window.__jimkkok`). 서버에 저장하지 않습니다.

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
- **호차·보관대를 바꿀 때는 `lib/train.js` 한 곳만 고칩니다.** `LUGGAGE_CARS`와 `CAR_RACK`이
  유일한 출처이고 나머지는 전부 여기서 파생됩니다. 다만 `lib/claude.js`의 프롬프트 문장,
  `app/page.tsx`의 `RACK_CARS`, `app.js`의 `STOP_TIMES`는 별도로 맞춰줘야 합니다.
- **CSS 클래스 이름이 겹치지 않는지 보세요.** 새로 만든 `.route-line`이 승차권 카드의
  기존 `.route-line{height:35px}`에 눌려 역 이름과 시각이 겹친 적이 있습니다.
  화면 전용 규칙에는 접두어를 붙이는 편이 안전합니다(`.trip-*`, `.krl-*`, `.ovr-*`).
- **탭을 조건부로 갈아끼우지 마세요.** React가 같은 자리의 DOM 노드를 재사용하면서
  `app.js`가 채운 내용 위에 자기 자식을 다시 써넣습니다. S-06은 두 패널을 항상 그려 두고
  `hidden`으로만 감춥니다.
- **아이콘은 전부 인라인 SVG입니다.** `▦`·`◬` 같은 글리프 문자는 Arial·Noto Sans KR에
  자형이 없어 격자나 빈 네모로 깨집니다. 새 아이콘은 `app/page.tsx`의 `KRL_ICONS`에 추가하세요.
- `app/layout.tsx`는 Next.js 시절 파일이라 SPA 빌드에 포함되지 않습니다. 타입 검사에서도 제외돼 있습니다
  (`tsconfig.json`의 `exclude`). 페이지 제목·favicon은 `index.html`이 담당합니다.
