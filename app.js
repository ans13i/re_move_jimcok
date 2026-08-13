/**
 * app.js — DOM 후처리 레이어
 *
 * index.html에는 <script> 한 줄만 추가했고, 마크업·스타일·클래스명은 건드리지 않습니다.
 * React가 그려놓은 DOM을 찾아서 값만 채웁니다.
 *
 * ── 왜 MutationObserver가 필요한가 ──
 * 화면은 React가 그리므로, 값을 한 번 넣어도 다음 리렌더 때 React가 원래 값으로
 * 되돌립니다. 그래서 "바인딩"을 등록해두고 DOM이 바뀔 때마다 다시 적용합니다.
 * setText는 값이 같으면 아무 것도 하지 않으므로 무한 루프는 나지 않습니다.
 */

import { CAR_RACK, FREIGHT_MANIFEST, SLOTS_PER_RACK } from "./lib/train.js";

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

/** 우체국 8호 박스 부피 (L) — 특송 적재 가능 공간 환산 기준 */
const BOX_8_L = 62;

/** 정차역 하역 경고 기준 (초) */
const DWELL_WARN_SECONDS = 180;

// ─────────────────────────────────────────────────────────────
// 조회·주입 유틸
// ─────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 현재 보이는 화면 번호 ("P-05", "S-03" …) */
function screenId() {
  const el = $(".stage-label > span");
  return el ? el.textContent.trim() : null;
}

/** `<span>라벨</span><b>값</b>` 구조에서 값 요소 찾기 */
function byLabel(label, root = document) {
  const tag = $$("span", root).find((el) => el.textContent.trim() === label);
  return tag && tag.parentElement ? tag.parentElement.querySelector("b") : null;
}

function setText(el, value) {
  if (!el || value === null || value === undefined) return false;
  const next = String(value);
  if (el.textContent === next) return false;
  el.textContent = next;
  return true;
}

function setHTML(el, html) {
  if (!el || el.innerHTML === html) return false;
  el.innerHTML = html;
  return true;
}

function setAttr(el, name, value) {
  if (!el || value === null || value === undefined) return false;
  if (el.getAttribute(name) === String(value)) return false;
  el.setAttribute(name, String(value));
  return true;
}

function toggleClass(el, cls, on) {
  if (!el) return;
  el.classList.toggle(cls, Boolean(on));
}

/**
 * 화면 스크롤 영역 끝에 주입 블록을 하나 확보합니다.
 * React가 관리하지 않는 노드라 리렌더 때 사라질 수 있어, 없으면 다시 만듭니다.
 */
function slot(name, tag = "div") {
  const scroll = $(".screen-scroll");
  if (!scroll) return null;
  let el = scroll.querySelector(`[data-app="${name}"]`);
  if (!el) {
    el = document.createElement(tag);
    el.setAttribute("data-app", name);
    // 어느 화면 소유인지 새겨 둡니다. 화면이 바뀌면 sweepSlots가 이걸 보고 걷어냅니다.
    el.setAttribute("data-app-screen", screenId() || "");
    scroll.appendChild(el);
  }
  return el;
}

/** 주입 블록 제거 */
/**
 * 다른 화면 소유의 주입 요소를 걷어냅니다.
 *
 * slot()이 만든 요소는 React의 가상 트리에 없습니다. React는 화면을 바꿀 때
 * .screen-scroll 노드를 재사용하면서 자기가 아는 자식만 갈아끼우므로, 우리가
 * 붙인 요소는 그대로 남아 다음 화면 아래에 겹쳐 보입니다.
 */
/**
 * 요소를 감춥니다. 반드시 이 함수를 쓰세요 — style.display를 직접 건드리지 마세요.
 *
 * React는 화면을 바꿀 때 같은 자리·같은 태그의 DOM 노드를 재사용하고 className만
 * 갈아끼웁니다. 그래서 S-04에서 감춘 .staff-filters가 S-05에서는 .screen-scroll이
 * 되고, 인라인 display:none이 그대로 남아 본문이 통째로 사라졌습니다.
 * 표시를 남기고 매 패스 앞에서 전부 되돌린 뒤, 그 화면이 필요한 것만 다시 감춥니다.
 */
function hideEl(el) {
  if (!el) return;
  el.setAttribute("data-app-hid", "1");
  el.style.setProperty("display", "none");
}

/** 지난 패스에서 감췄던 요소를 모두 되돌립니다. */
function unhideAll() {
  for (const el of $$("[data-app-hid]")) {
    el.removeAttribute("data-app-hid");
    el.style.removeProperty("display");
  }
}

function sweepSlots() {
  const here = screenId() || "";
  for (const el of $$("[data-app-screen]")) {
    if (el.getAttribute("data-app-screen") !== here) el.remove();
  }
}

function dropSlot(name) {
  $$(`[data-app="${name}"]`).forEach((el) => el.remove());
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

// ─────────────────────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────────────────────

const state = {
  /** 적재 체크리스트에서 체크된 itemId */
  checked: new Set(),
  /** S-03 배정 목록 필터: all | bad */
  reviewFilter: "all",
  /** 요청 세대. 목록이 바뀌면 올려서, 날아가던 응답을 버립니다. */
  gen: 0,
  /** '출발 30분 전' 트리거가 눌렸는가. 이게 참일 때만 배정이 돕니다. */
  armed: false,
  /** 직전 패스의 allocated 값. 상승 에지를 잡는 데 씁니다. */
  lastAllocated: false,
  status: "idle", // idle | loading | ready | error
  plan: null,
  error: null,
  key: null, // 배치를 받을 때 쓴 입력값 서명
  confirmed: false, // 역무원이 배정안을 확정했는가
  advanced: false, // P-05에서 자동 전환을 이미 했는가
};

/** 승차권에서 고른 하차역 (page.tsx가 window.__jimkkok에 실어둡니다) */
function currentDest() {
  return (window.__jimkkok && window.__jimkkok.dest) || "부산";
}

/** P-03에서 고른 수하물 사양 */
/** 등록된 승차권 목록 */
function currentPassengers() {
  return (window.__jimkkok && window.__jimkkok.passengers) || [];
}

/** 지금 보고 있는 승차권 번호 */
function activeKey() {
  return (window.__jimkkok && window.__jimkkok.activeKey) || "";
}

/** 출발 30분 전 배정이 시작됐는가 */
function isAllocated() {
  return Boolean(window.__jimkkok && window.__jimkkok.allocated);
}

/** 지금 입력값으로 만든 요청 서명. 달라지면 배치를 다시 받습니다. */
function requestKey() {
  return JSON.stringify(currentPassengers());
}

/** 내 수하물의 배정 결과 */
/** 지금 보고 있는 승차권의 배정 결과 */
function myAllocation() {
  if (!state.plan) return null;
  const key = activeKey();
  if (!key) return null;
  return state.plan.allocations.find((a) => a.ticketKey === key) || null;
}

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

async function allocate(body) {
  const res = await fetch("/api/allocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { scenario: "demo", passengers: currentPassengers() }),
  });
  if (!res.ok) throw new Error(`/api/allocate 응답 ${res.status}`);
  return res.json();
}

async function load() {
  if (state.status === "loading") return;
  const gen = (state.gen += 1);
  state.status = "loading";
  state.error = null;
  state.advanced = false;
  state.key = requestKey();
  schedule();
  try {
    const plan = await allocate();
    // 기다리는 사이 짐 목록이 바뀌었으면 이 응답은 옛것입니다. 버립니다.
    if (gen !== state.gen) return;
    state.plan = plan;
    state.status = "ready";
  } catch (error) {
    if (gen !== state.gen) return;
    state.error = error && error.message ? error.message : String(error);
    state.status = "error";
  }
  schedule();
}

function retry() {
  state.armed = true; // 역무원/승객이 명시적으로 다시 요청한 경우입니다.
  state.status = "idle";
  state.plan = null;
  state.error = null;
  schedule();
  load();
}

// ─────────────────────────────────────────────────────────────
// 표시용 포맷
// ─────────────────────────────────────────────────────────────

/** "9-B-04" → { car: 9, rack: "B", cell: "B-04" } */
function readSlotId(a) {
  return { car: a.car, rack: a.rack, cell: `${a.rack}-${String(a.index).padStart(2, "0")}` };
}

const SOURCE_LABEL = {
  llm: "AI 1차 제안",
  "llm-retry": "AI 재제안",
  fallback: "규칙 엔진 폴백",
};

/**
 * P-05 상태 링 안에 넣는 아이콘. page.tsx의 KRL_ICONS와 같은 모양입니다.
 * 링 안에는 이제 SVG가 들어 있어서 setText로 글자를 쓰면 아이콘이 지워집니다.
 */
const RING_SVG = {
  loading:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.8 4.4v4.5h-4.5"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 4 2.4 18a1.6 1.6 0 0 0 1.4 2.4h16.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4a1.6 1.6 0 0 0-2.8 0z"/><path d="M12 9.6v4.2M12 17.3h.01"/></svg>',
  ready:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 12.4 9.7 16.5 18.4 7.3"/></svg>',
};

/** 62L 우체국 8호 박스 환산 개수 */
function boxes(liters) {
  return Math.max(0, Math.floor((liters || 0) / BOX_8_L));
}

/** 배정 정보를 담은 코드 문자열 */
function qrPayload() {
  const a = myAllocation();
  if (!a) return "";
  return [
    "JIMKKOK1",
    a.itemId,
    "KTX123",
    `${a.car}-${a.rack}-${String(a.index).padStart(2, "0")}`,
    a.destination || currentDest(),
    state.confirmed ? "OK" : "PENDING",
  ].join("|");
}

/**
 * 코드 문자열에서 결정적으로 만든 블록 아트 (외부 라이브러리 없음).
 * page.tsx의 qrCells와 같은 알고리즘·같은 size여야 화면이 흔들리지 않습니다.
 */
function qrArt(payload, size = 13) {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const next = () => {
    h ^= (h << 13) >>> 0; h >>>= 0;
    h ^= h >>> 17;
    h ^= (h << 5) >>> 0; h >>>= 0;
    return h / 4294967296;
  };
  // 모서리 세 곳은 고정 패턴(파인더), 나머지는 코드에서 파생
  const finder = (x, y) =>
    [[0, 0], [size - 3, 0], [0, size - 3]].some(([ox, oy]) => x >= ox && x < ox + 3 && y >= oy && y < oy + 3);
  let html = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      html += finder(x, y) || next() > 0.5 ? '<i class="on"></i>' : "<i></i>";
    }
  }
  return html;
}

// ─────────────────────────────────────────────────────────────
// 바인딩 등록·적용
// ─────────────────────────────────────────────────────────────

const bindings = [];
function bind(name, apply) {
  bindings.push({ name, apply });
}

let pending = false;  // 다음 패스가 예약돼 있는가
let applying = false; // 지금 칠하는 중인가
let dirty = false;    // 칠하는 도중에 또 요청이 들어왔는가

function applyAll() {
  if (applying) {
    dirty = true;
    return;
  }
  applying = true;
  try {
    // 칠하는 도중 들어온 요청(dirty)은 같은 자리에서 한 번 더 돌려 처리합니다.
    // 무한 반복을 막기 위해 3회로 끊습니다.
    for (let round = 0; round < 3; round += 1) {
      dirty = false;
      unhideAll();
      sweepSlots();
      for (const b of bindings) {
        try {
          b.apply();
        } catch (error) {
          console.warn(`[app.js] 바인딩 '${b.name}' 실패:`, error);
        }
      }
      if (!dirty) break;
    }
  } finally {
    applying = false;
    dirty = false;
  }
}

/**
 * 다음 렌더 패스를 예약합니다.
 *
 * 잠금은 실행 직전에 스스로 풀립니다. applyAll이 풀도록 두면, applyAll이
 * 예외로 빠져나가거나 재진입 가드에 걸렸을 때 잠금이 영영 남아 이후 갱신이
 * 전부 무시됩니다(실제로 그렇게 굳었습니다).
 *
 * rAF는 백그라운드 탭에서 멈추므로 타이머로도 같이 걸어둡니다.
 * 둘 중 먼저 도착한 쪽만 pending을 내리고 실행합니다.
 */
function schedule() {
  if (applying) {
    dirty = true; // 지금 칠하는 중 — 이번 패스 끝나고 한 번 더 돕니다.
    return;
  }
  if (pending) return;
  pending = true;
  const run = () => {
    if (!pending) return;
    pending = false;
    applyAll();
  };
  requestAnimationFrame(run);
  setTimeout(run, 50);
}

// ═════════════════════════════════════════════════════════════
// 승객 화면
// ═════════════════════════════════════════════════════════════

// ── P-05 배정 대기: 진입하면 호출, 성공하면 전환, 실패하면 재시도 ──
bind("P-05 배정 대기", () => {
  if (screenId() !== "P-05") return;

  // 수하물 정보나 하차역이 바뀌었으면 이전 배치는 무효입니다.
  invalidateIfChanged();
  syncArm();

  // 출발 30분 전 버튼을 누르기 전까지는 배정하지 않습니다.
  // 되돌아온 경우 잠가 뒀던 버튼을 반드시 풀어야 트리거를 다시 누를 수 있습니다.
  if (!isAllocated()) {
    const trigger = $(".sticky-action .primary");
    if (trigger) {
      trigger.disabled = false;
      setText(trigger, "출발 30분 전 · AI 배정 시작");
    }
    return;
  }

  if (state.status === "idle" && state.armed) load();

  const pill = $(".status-hero .pill");
  const title = $(".status-hero h1");
  const desc = $(".status-hero p");
  const ring = $(".clock-ring");

  if (state.status === "loading") {
    setText(pill, "AI 배정 중");
    setHTML(ring, RING_SVG.loading);
    setText(title, "AI가 자리를 찾고 있어요");
    setText(desc, "좌석 거리·하차역·잔여 공간을 함께 계산하고 있습니다.");
    dropSlot("p05-error");

    // React는 allocated가 켜지는 순간 버튼을 "배정 결과 보기"로 바꿉니다.
    // 하지만 AI 응답은 아직 오지 않았습니다. 이때 눌리면 P-06이 원본 더미값을
    // 그대로 보여주므로, 응답이 올 때까지 버튼을 잠급니다.
    const next = $(".sticky-action .primary");
    if (next) {
      next.disabled = true;
      setText(next, "AI 배정 중…");
    }
  }

  if (state.status === "error") {
    setText(pill, "배정 실패");
    setHTML(ring, RING_SVG.error);
    setText(title, "배정에 실패했어요");
    setText(desc, "네트워크 상태를 확인하고 다시 시도해주세요.");
    const next = $(".sticky-action .primary");
    if (next) {
      next.disabled = true;
      setText(next, "배정 결과 없음");
    }

    const box = slot("p05-error");
    if (box && !box.dataset.ready) {
      box.dataset.ready = "1";
      box.innerHTML =
        '<div class="notice"><b>배정 요청이 실패했습니다</b><p data-app-msg></p></div>' +
        '<button class="primary" style="margin-top:10px">다시 시도</button>';
      box.querySelector("button").addEventListener("click", retry);
    }
    if (box) setText(box.querySelector("[data-app-msg]"), state.error);
  }

  if (state.status === "ready") {
    dropSlot("p05-error");
    const next0 = $(".sticky-action .primary");
    if (next0) {
      next0.disabled = false;
      setText(next0, "배정 결과 보기");
    }
    setText(pill, "배정 완료");
    setHTML(ring, RING_SVG.ready);
    setText(title, "수하물 위치가\n배정됐어요");
    // 응답이 오면 배정 완료 화면으로 넘깁니다(기존 버튼을 눌러 React가 전환하게 함).
    if (!state.advanced) {
      state.advanced = true;
      const next = $(".sticky-action .primary");
      if (next) setTimeout(() => next.click(), 400);
    }
  }

  // 등록 정보 카드
  const a = myAllocation();
  if (a) setText(byLabel("위치 안내 예정"), "배정 완료");
});

// ── P-06 위치 배정 완료 ──
// ── P-01 승차권 상세: 등록한 수하물의 배정 위치 ──
bind("P-01 승차권 상세", () => {
  if (screenId() !== "P-01") return;
  const a = myAllocation();
  if (!a) return;
  const { car, cell } = readSlotId(a);
  const distance = a.distanceM !== undefined ? ` · 좌석에서 ${a.distanceM}m` : "";
  // 정보표의 "수하물 위치" 칸은 좁습니다. 칸 번호만 넣고 자세한 위치는 안내 박스에 씁니다.
  setText($('[data-app="p01-slot"]'), cell);
  setText($('[data-app="p01-status"]'), `${a.label || `${car}호차 ${cell}`}${distance}`);
});

/**
 * 배정 결과가 아직 없을 때 승객 화면(P-06~P-08)의 원본 더미를 지웁니다.
 *
 * page.tsx에는 시연용으로 "7호차 12A · A-03" 같은 값이 박혀 있습니다.
 * 그대로 두면 배정 전에 들어왔을 때 진짜 배정처럼 보이므로 반드시 비웁니다.
 */
function renderPassengerPending() {
  const loading = state.status === "loading";
  const head = loading ? "AI가 자리를 찾는 중이에요" : "아직 배정 전이에요";
  const body = loading
    ? "잠시만 기다려주세요. 배정이 끝나면 위치가 표시됩니다."
    : "출발 30분 전에 “AI 배정 시작”을 눌러야 위치가 정해집니다.";

  // P-06
  const banner = $(".status-banner.success");
  if (banner && banner.firstChild && banner.firstChild.nodeType === 3) {
    banner.firstChild.textContent = loading ? "배정 중 " : "배정 전 ";
  }
  setText($(".assigned-hero > span"), "KTX 123");
  setText($(".assigned-hero h1"), head);
  setText($(".assigned-hero p"), body);
  const card = $(".location-card");
  if (card) {
    setText(card.querySelector("small"), "배정 대기");
    setText(card.querySelector("b"), "—");
    setText(card.querySelector("span"), body);
  }

  // P-07
  const point = $(".car-map .rack-point");
  if (point) setHTML(point, "보관대<br><b>—</b>");
  setText($(".rack-label-photo span"), "—");
  $$(".locker-cell").forEach((btn) => {
    ["mine", "passenger", "express-wait", "express-done"].forEach((c) => btn.classList.remove(c));
    btn.classList.add("neutral");
    setText(btn.querySelector("span"), "");
  });

  // P-08
  setText($(".qr-ticket h2"), "—");
  setText($(".qr-status"), loading ? "배정 중" : "배정 전");
  $$(".qr-info p b").forEach((b, i) => setText(b, i === 1 ? `서울 → ${currentDest()}` : "—"));

  // 세 화면 공통 안내
  const box = slot("pax-pending");
  if (box) setHTML(box, `<div class="notice blue"><b>${esc(head)}</b><p>${esc(body)}</p></div>`);
}

bind("P-06 배정 완료", () => {
  if (screenId() !== "P-06") return;
  const a = myAllocation();
  if (!a) return renderPassengerPending();
  dropSlot("pax-pending");
  const { car, rack, cell } = readSlotId(a);

  const banner = $(".status-banner.success");
  if (banner) {
    const platform = banner.querySelector("span");
    // 승강장 (열차 편성값)
    setText(platform, "8번 승강장");
    // 역무원 확정 여부를 승객 화면에 반영
    const head = state.confirmed ? "✓ 위치 배정 완료 " : "역무원 확정 대기 ";
    if (banner.firstChild && banner.firstChild.nodeType === 3) {
      if (banner.firstChild.textContent !== head) banner.firstChild.textContent = head;
    }
  }

  // 하차역
  setText($(".assigned-hero > span"), `KTX 123 · ${a.seatCar ?? 7}호차 ${a.seat ?? "12A"} · ${a.destination || currentDest()} 하차`);

  // 배정 위치
  setText($(".location-card > small"), `${car}호차 · ${rack} 수하물 보관대`);
  setText($(".location-card > b"), cell);

  // 좌석에서의 거리
  const distance = a.distanceM !== undefined ? `${a.distanceM}m` : "—";
  setText($(".location-card > span"), `좌석 ${a.seat ?? "12A"}에서 ${distance}`);
});

// ── P-07 내 수하물 위치 (보관대 탭 / 객차 탭) ──
bind("P-07 수하물 위치", () => {
  if (screenId() !== "P-07") return;
  const a = myAllocation();
  if (!a) return renderPassengerPending();
  dropSlot("pax-pending");
  const { car, rack, cell } = readSlotId(a);

  const eyebrow = $(".section-copy .eyebrow");
  const h1 = $(".section-copy h1");
  const desc = $(".section-copy p");
  const isRackTab = Boolean($(".locker-map"));

  if (isRackTab) {
    // 적재 위치도: 호차 · 보관대 · 칸
    setText(eyebrow, `${car}호차 ${rack} 수하물 보관대`);
    setHTML(h1, `<strong>${esc(cell)}</strong> 칸에<br>수하물을 놓아주세요`);
    setText($(".rack-label-photo > span"), cell);

    // 사물함 격자: 배정된 보관대의 칸 번호로 다시 라벨링하고 내 칸을 표시
    $$(".locker-cell").forEach((btn, i) => {
      // 보관대 실제 칸 수보다 많은 격자는 감춥니다.
      if (i >= SLOTS_PER_RACK) { hideEl(btn); return; }
      btn.style.display = "";
      const id = `${rack}-${String(i + 1).padStart(2, "0")}`;
      setText(btn.querySelector("b"), id);
      const mine = id === cell;
      toggleClass(btn, "mine", mine);
      toggleClass(btn, "neutral", !mine);
      setText(btn.querySelector("span"), mine ? "내 수하물" : "");
    });
  } else {
    // 객차 길찾기: 좌석 → 보관대 경로 문구
    const distance = a.distanceM !== undefined ? `${a.distanceM}m` : "";
    const dir = rack === "A" ? "앞쪽" : "뒤쪽";
    setText(eyebrow, `${car}호차 내부`);
    setHTML(h1, `${esc(a.seat ?? "12A")} 좌석에서<br>${esc(dir)}으로 ${esc(distance)} 이동하세요`);
    setText(
      desc,
      car === (a.seatCar ?? 7)
        ? `${rack} 보관대는 같은 호차 ${dir} 출입문 앞에 있어요.`
        : `${a.seatCar ?? 7}호차 ${a.seat ?? "12A"}에서 ${car}호차 ${rack} 보관대까지 ${distance} 이동합니다.`,
    );
    const point = $(".rack-point");
    if (point) {
      setHTML(point, `${esc(rack)} 보관대<br><b>${esc(cell)}</b>`);
    }
    setText($(".path-arrow"), `↑ ${dir}으로 이동`);
    // 좌석 격자에서 내 좌석을 표시합니다.
    const mySeat = a.seat ?? "12A";
    $$(".seat-grid span").forEach((el) => toggleClass(el, "my-seat", el.textContent === mySeat));
  }
});

// ── P-08 QR 확인증 ──
bind("P-08 QR", () => {
  if (screenId() !== "P-08") return;
  const a = myAllocation();
  if (!a) return renderPassengerPending();
  dropSlot("pax-pending");
  const { car, cell } = readSlotId(a);

  const payload = qrPayload();

  // 배정 정보를 담은 코드 문자열 → 블록 아트
  const code = $(".qr-code");
  if (code) {
    setAttr(code, "aria-label", payload);
    setAttr(code, "title", payload);
    setHTML(code.querySelector("span"), qrArt(payload));
  }

  setText($(".qr-status"), state.confirmed ? "등록 완료 · 배정 확정" : "등록 완료 · 역무원 확정 대기");
  setText($(".qr-ticket h2"), `승차권 ${a.ticketKey ?? activeKey()} · ${a.itemId}`);
  setText(byLabel("열차"), `KTX 123 · ${a.seatCar ?? 7}호차 ${a.seat ?? "12A"}`);
  setText(byLabel("배정 위치"), `${car}호차 ${cell}`);
});

// ═════════════════════════════════════════════════════════════
// 역무원 화면
// ═════════════════════════════════════════════════════════════

/** 로딩·실패 상태를 기존 스타일로 표시하고, 채울 준비가 됐는지 알려줍니다. */
/** 입력값이 바뀌었으면 기존 배치를 무효화합니다. */
/**
 * 등록된 짐 목록이 바뀌었으면 이전 배치를 버리고 배정 전으로 되돌립니다.
 *
 * 여기서 allocated까지 끄는 것이 핵심입니다. 끄지 않으면 P-05가 곧바로
 * load()를 다시 불러 "출발 30분 전" 트리거 없이 몰래 재배정해 버립니다.
 * 시나리오상 배정은 모든 승객의 짐을 모아 30분 전에 한 번 도는 사건이므로,
 * 목록이 바뀌면 트리거를 다시 눌러야 합니다.
 */
/**
 * '출발 30분 전' 트리거가 방금 눌렸는지 판정합니다.
 *
 * allocated는 React 상태라 setAllocated(false)가 한 프레임 늦게 반영됩니다.
 * 그 틈에 "allocated가 아직 true고 status는 idle"인 순간이 생기는데, 그때
 * load()를 부르면 사용자가 트리거를 누르지도 않았는데 AI가 돌아버립니다.
 * 그래서 현재값이 아니라 false→true로 바뀌는 순간만 발동 조건으로 삼습니다.
 */
function syncArm() {
  const now = isAllocated();
  if (now && !state.lastAllocated) state.armed = true; // 방금 눌렸다
  if (!now) state.armed = false;
  state.lastAllocated = now;
}

function invalidateIfChanged() {
  if (state.key === null || state.key === requestKey()) return;
  state.gen += 1; // 진행 중이던 요청의 응답을 버립니다.
  state.armed = false; // 트리거를 다시 눌러야 합니다.
  state.status = "idle";
  state.plan = null;
  state.key = null;
  state.confirmed = false;
  state.advanced = false;
  state.checked.clear();

  const bridge = window.__jimkkok;
  if (bridge && bridge.allocated && typeof bridge.setAllocated === "function") {
    bridge.setAllocated(false);
  }
}

function staffGate() {
  invalidateIfChanged();
  syncArm();
  if (!isAllocated()) { renderNotAllocated(); return false; }
  if (state.status === "idle" && state.armed) load();

  if (state.status === "loading") {
    dropSlot("staff-error");
    // 숫자 자리에 스켈레톤
    $$(".summary-strip b, .review-stats b, .metric-card > b, .progress-card b").forEach((el) =>
      el.classList.add("js-skeleton"),
    );
    return false;
  }

  $$(".js-skeleton").forEach((el) => el.classList.remove("js-skeleton"));

  if (state.status === "error") {
    const box = slot("staff-error");
    if (box && !box.dataset.ready) {
      box.dataset.ready = "1";
      box.innerHTML =
        '<div class="warning-card"><span class="icon">!</span>' +
        '<p><b>배정 결과를 불러오지 못했습니다</b><br><span data-app-msg></span></p>' +
        "<button>다시 시도</button></div>";
      box.querySelector("button").addEventListener("click", retry);
    }
    if (box) setText(box.querySelector("[data-app-msg]"), state.error);
    return false;
  }

  dropSlot("staff-error");
  dropSlot("staff-pending");
  const unloadList = $(".unload-list");
  if (unloadList) delete unloadList.dataset.appCleared;
  return state.status === "ready" && Boolean(state.plan);
}

/** 아직 배정 전일 때 역무원 화면에 안내를 띄우고 숫자를 비웁니다. */
/** 지금 선택된 호차. 탭이 없으면 첫 적재 호차. */
function activeCar() {
  // S-04는 열차 도식에서, 그 밖의 화면은 예전 호차 탭에서 선택 호차를 읽습니다.
  const picked = $(".train-car.on") || $(".car-tabs button.active");
  const raw = picked ? picked.getAttribute("data-app-car") || picked.textContent : "";
  const n = Number(String(raw).replace(/\D/g, ""));
  return Number.isFinite(n) && CAR_RACK[n] ? n : Number(Object.keys(CAR_RACK)[0]);
}

/**
 * 위치도 머리말과 칸 번호를 칠합니다.
 *
 * 보관대 이름은 호차로 정해집니다 — 5=A · 7=B · 9=C · 12=D.
 * 배정 전에도 원본 마크업의 B-01~B-06이 남으면 안 되므로 두 상태에서 같이 씁니다.
 */
function paintRack(car) {
  const rack = CAR_RACK[car] || "A";
  setText($(".map-heading span"), `${car}호차 · ${rack} 보관대`);
  $$(".locker-cell").forEach((btn, i) => {
    setText(btn.querySelector("b"), `${rack}-${String(i + 1).padStart(2, "0")}`);
  });
  return rack;
}

/**
 * 위치도의 '확인 필요' 목록을 감춥니다.
 *
 * 원본 마크업에 박혀 있던 "9호차 B-02 사용 불가 · 특송 #A13"은 시연용 더미입니다.
 * 실제 위반은 S-03 검증 로그에서 보여주므로 여기서는 쓰지 않습니다.
 */
function hideAlertList() {
  const list = $(".alert-list");
  hideEl(list);
}

function renderNotAllocated() {
  const registered = currentPassengers().length;

  // 배정 결과에서 나오는 숫자는 전부 비웁니다. (page.tsx의 원본 더미 값이 보이지 않도록)
  const freight = FREIGHT_MANIFEST.length;

  // 배정으로 정해지는 값만 비우고, 이미 확정된 건수(등록 승차권·접수 특송)는 그대로 보여줍니다.
  $$(".review-stats b, .progress-card b").forEach((el) => setText(el, "—"));

  const strip = $$(".summary-strip b");
  setText(strip[0], 1);            // 담당 열차
  setText(strip[1], "—");          // 검토 필요 (배정 후에 나옴)
  setText(strip[2], freight);      // 특송 건수

  const sm = $$(".staff-metrics b");
  setText(sm[0], `${registered}개`);
  setText(sm[1], `${freight}건`);
  setText(sm[2], "—");

  const cards = $$(".metric-card");
  const fillPending = (card, value, note) => {
    if (!card) return;
    setText(card.querySelector("b"), value);
    setText(card.querySelector("small"), note);
  };
  fillPending(cards[0], `${registered}개`, registered ? "등록 완료 · 배정 전" : "등록된 수하물 없음");
  fillPending(cards[1], "—", "배정 전");
  fillPending(cards[2], `${freight}건`, "접수 완료 · 배정 전");
  fillPending(cards[3], "—", "배정 전");
  $$(".metric-card").forEach((el) => toggleClass(el, "warn", false));
  $$(".filter-row button").forEach((el, i) => setText(el, i === 0 ? "전체 —" : "문제 항목 —"));

  // 배정 목록·격자·하역 목록도 비웁니다.
  $$(".allocation-row").forEach(hideEl);
  $$(".prep-group").forEach(hideEl);
  const mapHead = $(".map-heading h2");
  if (mapHead) setText(mapHead, "배정 전");
  paintRack(activeCar());
  hideAlertList();
  $$(".locker-cell").forEach((btn, i) => {
    if (i >= SLOTS_PER_RACK) { hideEl(btn); return; }
    btn.style.display = "";
    ["passenger", "express-wait", "express-done", "mine", "neutral"].forEach((c) => btn.classList.remove(c));
    btn.classList.add("empty");
    setText(btn.querySelector("span"), "여유");
  });
  const unload = $(".unload-list");
  if (unload && !unload.dataset.appCleared) {
    unload.dataset.appCleared = "1";
    setHTML(unload, "");
  }

  const warn = $(".warning-card p");
  if (warn) setHTML(warn, "<b>배정 전</b><br>승객 앱에서 “출발 30분 전 · AI 배정 시작”을 눌러주세요.");
  const progressBar = $(".progress i");
  if (progressBar) progressBar.style.width = "0%";

  const box = slot("staff-pending");
  if (box && !box.dataset.ready) {
    box.dataset.ready = "1";
    box.innerHTML =
      '<div class="notice blue"><b>아직 배정 전입니다</b><p data-app-msg></p></div>';
  }
  if (box) {
    setText(
      box.querySelector("[data-app-msg]"),
      `등록된 승차권 ${registered}건 · 승객 앱에서 “출발 30분 전 · AI 배정 시작”을 누르면 여기에 결과가 채워집니다.`,
    );
  }
}

/** 배정 통계 */
function stats() {
  const p = state.plan;
  const passengers = p.allocations.filter((a) => a.kind !== "freight");
  const freight = p.allocations.filter((a) => a.kind === "freight");
  const attempts = p.attempts || [];
  return {
    total: p.allocations.length,
    passengers: passengers.length,
    freight: freight.length,
    violations: (p.violations || []).length,
    unassigned: (p.unassigned || []).length,
    attempts: attempts.length,
    cap: p.capacity || {},
    // 특송을 실을 수 있는 공간 = 승객 배정 직후 잔여
    freightCap: p.freightCapacity || p.capacity || {},
  };
}

// ── S-01 담당 열차 홈 ──
bind("S-01 담당 열차", () => {
  if (screenId() !== "S-01") return;
  if (!staffGate()) return;
  const s = stats();

  const strip = $$(".summary-strip b");
  setText(strip[0], 1); // 담당 열차 (시연은 한 편)
  setText(strip[1], s.violations + s.unassigned);
  setText(strip[2], s.freight);

  const metrics = $$(".staff-metrics b");
  setText(metrics[0], `${s.passengers}개`);
  setText(metrics[1], `${s.freight}건`);
  setText(metrics[2], `${s.violations + s.unassigned}건`);
});

// ── S-02 열차 운영 요약 ──
bind("S-02 운영 요약", () => {
  if (screenId() !== "S-02") return;

  // 경고 카드의 '재배정' 버튼은 지워진 화면(S-09)을 가리킵니다. 감춥니다.
  // 게이트보다 먼저 — 배정 전 상태에서도 보이면 안 됩니다.
  const rebtn = $(".warning-card button");
  hideEl(rebtn);
  if (!staffGate()) return;
  const s = stats();
  const cards = $$(".metric-card");

  const fill = (card, value, note) => {
    if (!card) return;
    setText(card.querySelector("b"), value);
    setText(card.querySelector("small"), note);
  };

  fill(cards[0], `${s.passengers}개`, "배정 완료");
  // 특송 적재 가능 공간 — 우체국 8호 박스(62L) 환산
  fill(
    cards[1],
    `${boxes(s.freightCap.remainingL)}박스`,
    `승객 배정 후 · 8호 62L 기준 · ${s.freightCap.remainingL}L`,
  );
  fill(cards[2], `${s.freight}건`, s.unassigned ? `${s.unassigned}건 미배정` : "배정 완료");
  fill(cards[3], `${s.violations}건`, s.violations ? "즉시 확인" : "이상 없음");

  toggleClass(cards[2], "warn", s.unassigned > 0);
  toggleClass(cards[3], "warn", s.violations > 0);

  const warn = $(".warning-card p");
  if (warn) {
    setHTML(
      warn,
      s.violations || s.unassigned
        ? `<b>확인 필요 ${s.violations + s.unassigned}건</b><br>${esc(state.plan.violations[0]?.detail || state.plan.unassigned[0]?.detail || "")}`
        : `<b>확인 필요 항목 없음</b><br>${esc(state.plan.summary)}`,
    );
  }
});

// ── S-03 AI 배정안 검토 ──
bind("S-03 배정안 검토", () => {
  if (screenId() !== "S-03") return;
  if (!staffGate()) return;
  const p = state.plan;
  const s = stats();

  // 1) 검증 결과 요약 한 줄
  setText($(".ai-review-head h1"), state.confirmed ? "배정안이 확정됐습니다" : "확정 전 마지막으로\n확인해주세요");
  setText($(".ai-review-head p"), p.summary || " ");

  // 상단 통계
  const rs = $$(".review-stats b");
  setText(rs[0], s.total + s.unassigned);
  setText(rs[1], s.total);
  setText(rs[2], s.violations + s.unassigned);

  const filters = $$(".filter-row button");
  setText(filters[0], `전체 ${s.total + s.unassigned}`);
  setText(filters[1], `문제 항목 ${s.violations + s.unassigned}`);

  // 배정 목록 — 원본 마크업에는 .allocation-row가 3개뿐이라 거기까지만 보였습니다.
  // 원본은 감추고 같은 클래스로 전체 목록을 새로 그립니다.
  $$(".allocation-row").forEach((row) => {
    if (!row.dataset.app) hideEl(row);
  });

  const problems = [
    ...(p.unassigned || []).map((u) => ({ bad: true, id: u.itemId, detail: u.detail })),
    ...(p.violations || []).map((v) => ({ bad: true, id: v.code, detail: v.detail })),
  ];
  const normals = [...p.allocations]
    .sort((x, y) => x.car - y.car || x.index - y.index)
    .map((a) => ({
      bad: false,
      id:
        a.kind === "freight"
          ? `특송 #${a.itemId} · 서울 → ${a.destination}`
          : `승객 ${a.ticketKey || a.itemId} · ${a.seatCar}호차 ${a.seat || ""}`,
      cell: `${a.rack}-${String(a.index).padStart(2, "0")}`,
      detail:
        a.kind === "freight"
          ? `${a.car}호차 ${a.rack}보관대 · ${a.destination} 하역 · ${a.volumeL}L`
          : `${a.car}호차 ${a.rack}보관대 · 좌석에서 ${a.distanceM ?? "-"}m · ${a.destination} 하차`,
    }));

  const all = [...problems, ...normals];
  const shown = state.reviewFilter === "bad" ? all.filter((r) => r.bad) : all;

  const listBox = slot("s03-list");
  if (listBox) {
    setHTML(
      listBox,
      shown.length
        ? shown
            .map(
              (r) =>
                `<div class="allocation-row${r.bad ? " alert" : ""}">` +
                `<span class="pill ${r.bad ? "red" : "blue"}">${r.bad ? "확인 필요" : "정상"}</span>` +
                `<div><b>${esc(r.id)}</b><small>${esc(r.detail)}</small></div>` +
                `<strong>${esc(r.cell || "—")}</strong></div>`,
            )
            .join("")
        : '<div class="notice blue"><b>확인 필요 항목이 없습니다</b><p>모든 배정이 검증을 통과했습니다.</p></div>',
    );
  }

  // 필터 버튼 — 원본에서는 동작하지 않던 자리입니다.
  const filterRow = $(".filter-row");
  if (filterRow) {
    filters.forEach((b, i) =>
      toggleClass(b, "active", (state.reviewFilter === "bad") === (i === 1)),
    );
    if (!filterRow.dataset.appBound) {
      filterRow.dataset.appBound = "1";
      filterRow.addEventListener("click", (event) => {
        const b = event.target.closest("button");
        if (!b) return;
        state.reviewFilter = [...filterRow.children].indexOf(b) === 1 ? "bad" : "all";
        schedule();
      });
    }
  }

  // 2) 시도별 검증 로그 (접이식)
  const log = slot("s03-log");
  if (log) {
    const rows = (p.attempts || [])
      .map((at, i) => {
        const vs = at.violations || [];
        const un = at.unassigned || [];
        const bad = vs.length + un.length;
        const failed = !at.ok;
        const open = failed ? " open" : "";
        const badge = at.ok
          ? '<span class="js-pass">검증 통과</span>'
          : `<span class="js-fail">위반 ${bad}건</span>`;
        const items = [
          ...vs.map((v) => `<div class="js-violation"><span class="js-code bad">${esc(v.code)}</span><p>${esc(v.detail)}</p></div>`),
          ...un.map((u) => `<div class="js-violation"><span class="js-code bad">UNASSIGNED</span><p>${esc(u.itemId)}: ${esc(u.detail)}</p></div>`),
        ].join("");
        const err = at.error
          ? `<div class="js-violation"><span class="js-code bad">CALL_FAILED</span><p>${esc(at.error)}</p></div>`
          : "";
        const body = items || err || '<div class="js-violation"><p>위반 없음</p></div>';
        return (
          `<details class="js-attempt"${open}><summary>시도 ${i + 1}` +
          `<span class="js-code">${esc(at.label)}</span>${badge}` +
          `<span class="js-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.4 9.4 5.6 5.6 5.6-5.6"/></svg></span></summary>` +
          `<div class="js-violations">${body}</div></details>`
        );
      })
      .join("");

    // 3) 최종 채택 경로
    const route =
      `<div class="js-route"><b>최종 채택 경로: ${esc(SOURCE_LABEL[p.source] || p.source)}</b>` +
      ` · 총 ${(p.attempts || []).length}회 시도` +
      (p.model ? ` · ${esc(p.model)}` : "") +
      (p.notice ? `<br>${esc(p.notice)}` : "") +
      "</div>";

    // 4) 확정 후 — 남은 적재 공간을 자연어로 안내합니다.
    //    역무원은 이 문장을 보고 특송 화물을 어디로 실을지 판단합니다.
    const space = state.confirmed
      ? '<div class="notice blue"><b>남은 적재 공간</b><p>' +
        esc(p.spaceSummary || "잔여 공간 정보를 가져오지 못했습니다.") +
        "</p></div>"
      : "";

    setHTML(log, `<div class="section-title"><h3>시도별 검증 로그</h3><span>펼쳐서 상세 보기</span></div>${rows}${route}${space}`);
  }

  // 4) 확정 버튼
  const confirmBtn = $(".sticky-action .primary");
  if (confirmBtn) {
    setText(confirmBtn, state.confirmed ? "확정 완료 · 승객 안내 발송됨" : "이 배정안으로 확정");
    if (!confirmBtn.dataset.appBound) {
      confirmBtn.dataset.appBound = "1";
      confirmBtn.addEventListener("click", () => {
        state.confirmed = true;
        schedule();
      });
    }
  }
});

// ── S-04 전체 적재 위치도: 호차·보관대별 배정 현황 ──
/** 적재율(%) → 표시 구간. 열차 도식의 색과 범례가 이 기준을 씁니다. */
function loadLevel(pct) {
  if (pct >= 90) return "full";
  if (pct >= 70) return "busy";
  if (pct >= 40) return "normal";
  return "free";
}

/**
 * S-04 열차 도식에 실제 적재율을 채웁니다.
 *
 * React는 배정 결과를 모르므로 칸을 비운 채 그립니다. 여기서 호차별 사용률을
 * 퍼센트·색·채운 칸 수로 바꿔 넣습니다. 배정 전에는 이 함수가 불리지 않습니다.
 */
function paintTrainMap(plan) {
  const byCar = new Map((plan.capacity?.byCar ?? []).map((c) => [c.car, c]));

  for (const el of $$(".train-car")) {
    const car = Number(el.getAttribute("data-app-car"));
    const info = byCar.get(car);
    if (!info) continue;

    const pct = Math.round(info.utilizationPct ?? 0);
    setText(el.querySelector(`[data-app="load-${car}"]`), `${pct}%`);
    setAttr(el, "data-level", loadLevel(pct));

    // 채운 칸 수는 용적 사용률이 아니라 실제로 찬 칸 수로 보여줍니다.
    const cells = $$(".tc-rack i", el);
    cells.forEach((cell, i) => toggleClass(cell, "on", i < (info.usedSlots ?? 0)));
  }
}

bind("S-04 적재 위치도", () => {
  if (screenId() !== "S-04") return;

  // 상단 필터(전체·승객·특송·여유·확인 필요)는 쓰지 않습니다.
  // 격자 한 화면에서 다 보이므로 걸러 볼 이유가 없습니다.
  // 배정 전 상태에서도 감춰야 하므로 게이트보다 먼저 처리합니다.
  const filters = $(".staff-filters");
  hideEl(filters);

  if (!staffGate()) return;
  const p = state.plan;

  paintTrainMap(p);

  const car = activeCar();

  // 보관대 이름은 호차로 정해집니다. (7→A · 9→B · 12→C · 14→D)
  const rack = paintRack(car);
  const inRack = p.allocations.filter((a) => a.car === car && a.rack === rack);

  setText($(".map-heading h2"), `${inRack.length}/${SLOTS_PER_RACK}칸 배정`);

  // 사물함 격자에 실제 배정 반영
  const byIndex = new Map(inRack.map((a) => [a.index, a]));
  $$(".locker-cell").forEach((btn, i) => {
    if (i >= SLOTS_PER_RACK) { hideEl(btn); return; }
    btn.style.display = "";
    const idx = i + 1;
    const a = byIndex.get(idx);
    const label = btn.querySelector("span");
    ["passenger", "express-wait", "express-done", "empty", "mine", "neutral"].forEach((c) =>
      btn.classList.remove(c),
    );
    if (!a) {
      btn.classList.add("empty");
      setText(label, "여유");
    } else if (a.kind === "freight") {
      btn.classList.add("express-wait");
      setText(label, `특송 #${a.itemId}`);
    } else {
      btn.classList.add("passenger");
      setText(label, `승객 · ${a.destination || ""}`);
    }
  });

  // 원본에 박혀 있던 "9호차 B-02 사용 불가" 더미는 쓰지 않습니다.
  // 실제 위반은 S-03 검증 로그가 담당합니다.
  hideAlertList();
});

// ── S-06 적재 체크리스트: AI 배치 결과를 그대로 목록으로 ──
// ── S-05 칸 상세: 없어진 화면으로 가는 버튼 정리 ──
bind("S-05 칸 상세", () => {
  if (screenId() !== "S-05") return;
  // '다른 위치로 변경'(S-09)·'현장 문제 등록'(S-08)은 삭제된 화면입니다.
  for (const label of ["다른 위치로 변경", "현장 문제 등록"]) {
    const b = $$(".sticky-action button").find((el) => el.textContent.trim() === label);
    hideEl(b);
  }

  // 선택한 칸("A-03")과 호차를 머리말에서 읽어 그 칸의 배정을 찾습니다.
  const cell = ($(".cell-detail-head h1")?.textContent ?? "").trim();
  const car = Number((($(".cell-detail-head p")?.textContent ?? "").match(/(\d+)호차/) ?? [])[1]);
  const index = Number((cell.split("-")[1] ?? "").replace(/\D/g, ""));

  const a = (state.plan?.allocations ?? []).find(
    (x) => x.car === car && x.index === index,
  );

  const kind = $('[data-app="cell-kind"]');
  const photo = $('[data-app="cell-photo"]');

  if (!a) {
    // 배정 전이거나 빈 칸입니다. 하드코딩된 값처럼 보이지 않도록 전부 비웁니다.
    setText(kind, state.plan ? "빈 칸" : "배정 전");
    setText(photo, state.plan ? "등록된 수하물 없음" : "배정 전");
    for (const label of ["좌석", "하차역", "규격", "등록번호"]) setText(byLabel(label), "—");
    return;
  }

  const freight = a.kind === "freight";
  const d = a.dimensions;

  setText(kind, freight ? "특송 화물" : "승객 수하물");
  setText(photo, freight ? "특송 화물" : "등록된 수하물");
  setText(byLabel("좌석"), freight ? "특송 · 좌석 없음" : `${a.seatCar}호차 ${a.seat ?? ""}`.trim());
  setText(byLabel("하차역"), a.destination ?? "—");
  setText(
    byLabel("규격"),
    d ? `${d.width} × ${d.height} × ${d.depth}cm · ${a.volumeL}L` : `${a.volumeL}L`,
  );
  setText(byLabel("등록번호"), a.itemId);
});

bind("S-06 적재 체크리스트", () => {
  if (screenId() !== "S-06") return;
  if (!staffGate()) return;

  // 승객 수하물과 특송 화물을 모두 싣습니다. 칸 순서대로 정렬해 동선을 맞춥니다.
  const rows = [...state.plan.allocations].sort(
    (a, b) => a.car - b.car || a.index - b.index,
  );
  const ids = rows.map((a) => a.itemId);

  // 배정이 바뀌면 사라진 항목의 체크는 버립니다.
  for (const id of [...state.checked]) if (!ids.includes(id)) state.checked.delete(id);

  const done = ids.filter((id) => state.checked.has(id)).length;
  const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;

  setText($(".progress-card span"), "적재 진행률");
  setText($(".progress-card b"), `${done} / ${rows.length}건`);
  const bar = $(".progress i");
  if (bar) bar.style.width = `${pct}%`;
  setText(
    $(".progress-card p"),
    done === rows.length && rows.length > 0
      ? "모든 항목을 실었습니다. 적재 완료 처리를 눌러주세요."
      : "AI 배치 결과입니다. 실은 항목을 체크하세요.",
  );

  // 원본 마크업은 그룹 3개·행 5개뿐이라 항목이 잘립니다.
  // 원본은 감추고 같은 클래스로 전체 목록을 새로 그립니다.
  $$(".prep-group").forEach((g) => {
    if (!g.dataset.app) hideEl(g);
  });

  const groups = new Map();
  for (const a of rows) {
    if (!groups.has(a.car)) groups.set(a.car, []);
    groups.get(a.car).push(a);
  }

  const html = [...groups.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([car, list]) => {
      const rack = CAR_RACK[car] || list[0].rack;
      const items = list
        .map((a) => {
          const cell = `${a.rack}-${String(a.index).padStart(2, "0")}`;
          const on = state.checked.has(a.itemId);
          const who =
            a.kind === "freight"
              ? `특송 #${esc(a.itemId)}`
              : `승객 ${esc(a.ticketKey || a.itemId)} · ${a.seatCar}호차 ${esc(a.seat || "")}`;
          const note =
            a.kind === "freight"
              ? `${esc(a.destination)} 하역 · ${a.volumeL}L`
              : `${esc(a.destination)} 하차 · ${a.volumeL}L · 좌석에서 ${a.distanceM ?? "-"}m`;
          return (
            `<button data-item="${esc(a.itemId)}"><i class="${on ? "checked" : ""}">${on ? "✓" : ""}</i>` +
            `<span><b>${who} → ${esc(cell)}</b><small>${note}</small></span><em>›</em></button>`
          );
        })
        .join("");
      return (
        `<div class="prep-group" data-app="prep"><h3>${car}호차 ${esc(rack)}보관대 ` +
        `<span>${list.length}건</span></h3>${items}</div>`
      );
    })
    .join("");

  const box = slot("s06-groups");
  if (!box) return;
  setHTML(box, html || '<div class="notice"><b>적재할 항목이 없습니다</b><p>배정 결과가 비어 있어요.</p></div>');

  // 목록은 매 렌더마다 새로 그려지므로 컨테이너에 한 번만 위임 바인딩합니다.
  if (!box.dataset.appBound) {
    box.dataset.appBound = "1";
    box.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-item]");
      if (!btn) return;
      const id = btn.dataset.item;
      if (state.checked.has(id)) state.checked.delete(id);
      else state.checked.add(id);
      schedule();
    });
  }
});

// ═════════════════════════════════════════════════════════════
// 시작
// ═════════════════════════════════════════════════════════════

function start() {
  const root = document.getElementById("root");
  if (!root) return console.warn("[app.js] #root를 찾지 못했습니다.");
  new MutationObserver(schedule).observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // React가 상태만 바꾸고 className만 갈아끼우는 경우(호차 탭·필터 등)에는
  // 위 옵션으로는 변화를 감지하지 못합니다. attributes를 켜면 우리가 쓰는
  // classList 조작까지 되먹임되어 무한 루프가 되므로, 대신 클릭 뒤에 한 번
  // 다시 칠합니다. 사용자 조작에만 반응하니 루프가 생기지 않습니다.
  root.addEventListener("click", () => setTimeout(schedule, 0), true);

  schedule();
  console.log(`[app.js] 준비 완료 · 바인딩 ${bindings.length}개`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

window.app = { state, load, retry, allocate, bindings, schedule, qrPayload };
