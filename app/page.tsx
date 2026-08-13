"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "passenger" | "staff";

const passengerScreens = [
  ["P-00", "승차권 예매"],
  ["P-01", "승차권 상세"], ["P-02", "서비스 안내"], ["P-03", "수하물 정보 입력"],
  ["P-04", "등록 가능 판정"], ["P-05", "배정 대기"], ["P-06", "위치 배정 완료"],
  ["P-07", "내 수하물 위치"], ["P-08", "QR 확인증"], ["P-09", "등록 관리"],
  ["P-10", "문제 신고"],
  // 규격 초과로 일반 보관대를 못 쓰는 짐의 대체 경로. P-04에서 이어집니다.
  ["P-11", "특송 이용 안내"],
] as const;

/**
 * 보관대가 있는 호차와 그 보관대 이름. lib/train.js의 LUGGAGE_CARS·CAR_RACK과 같아야 합니다.
 * 화면의 시연용 더미값도 이 표를 기준으로 씁니다.
 */
const RACK_CARS = [
  ["7호차", "A"], ["9호차", "B"], ["12호차", "C"], ["14호차", "D"],
] as const;

const rackOf = (car: string) => RACK_CARS.find(([c]) => c === car)?.[1] ?? "A";

/** 규격 초과 시 연결할 외부 특송 서비스 */
const EXPRESS_PARTNER = {
  name: "짐캐리",
  service: "KTX·SRT 특송",
  url: "https://zimcarry.net/page/zim-ktxpass.php",
} as const;

const TICKET_STOPS = [
  ["광교", "17:23", "23분"],
  ["대전", "17:58", "58분"],
  ["동대구", "18:47", "1시간 47분"],
  ["부산", "19:41", "2시간 41분"],
] as const;

const SIZE_OPTIONS = [
  ["large", "대형", "65~75cm"],
  ["xlarge", "특대형", "76~85cm"],
  ["custom", "직접 입력", "가로·세로·높이"],
] as const;

const WEIGHT_OPTIONS = [
  ["under10", "10kg 이하"],
  ["10to20", "10kg 초과~20kg 이하"],
  ["over20", "20kg 초과"],
] as const;

const DIM_FIELDS = [
  ["w", "가로"],
  ["h", "세로"],
  ["d", "높이"],
] as const;

type Dims = { w: string; h: string; d: string };
const DEFAULT_DIMS: Dims = { w: "60", h: "45", d: "30" };

/**
 * AI가 응답하지 못했을 때 쓰는 값 — 24인치 캐리어 표준 외형(45×30×67cm).
 * 부피 90L라 보관대 한 칸(105L) 안에 들어가고 최장변 67cm라 "대형"으로 판정됩니다.
 */
const AI_SCAN_RESULT: Dims = { w: "45", h: "30", d: "67" };



/** 보관대 한 칸의 최대 용적 (L) — lib/train.js의 하단 칸 용적과 같습니다. */
const MAX_SLOT_L = 105;

/** QR 블록 아트의 한 변 칸 수. app.js의 qrArt와 반드시 같아야 합니다. */
const QR_SIZE = 13;

/**
 * 시연용 QR 블록 아트. 실제 QR이 아니라 코드 문자열에서 만든 결정적 패턴입니다.
 * 글자(▦)로 그리면 폰트에 따라 깨져서, 칸마다 <i>를 놓고 CSS로 칠합니다.
 */
function qrCells(seed: string, size = QR_SIZE) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const next = () => { h ^= (h << 13) >>> 0; h >>>= 0; h ^= h >>> 17; h ^= (h << 5) >>> 0; h >>>= 0; return h / 4294967296; };
  // 모서리 세 곳은 파인더 패턴으로 고정하고 나머지만 코드에서 파생합니다.
  const finder = (x: number, y: number) =>
    [[0, 0], [size - 3, 0], [0, size - 3]].some(([ox, oy]) => x >= ox && x < ox + 3 && y >= oy && y < oy + 3);
  const cells: boolean[] = [];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) cells.push(finder(x, y) || next() > 0.5);
  return cells;
}

/** 승차권마다 돌아가며 부여하는 좌석 */
const SEAT_POOL = [
  { car: 7, seat: "12A" },
  { car: 7, seat: "8C" },
  { car: 5, seat: "3B" },
  { car: 9, seat: "11A" },
  { car: 4, seat: "6D" },
  { car: 11, seat: "9B" },
] as const;

/** 예매 순서대로 01, 02, 03 … 시연 중 입력하기 쉽게 두 자리로 부여합니다. */
function makeTicketKey(taken: string[]) {
  let n = taken.length + 1;
  while (taken.includes(String(n).padStart(2, "0"))) n += 1;
  return String(n).padStart(2, "0");
}

type Ticket = {
  key: string;
  dest: string;
  seatCar: number;
  seat: string;
  /** 등록된 수하물. null이면 아직 등록 전 */
  bag: ReturnType<typeof bagSpec> | null;
  label: ReturnType<typeof bagLabel> | null;
  /** 승객이 등록 때 붙인 사진. 역무원이 칸 상세에서 실물과 대조합니다. */
  photo: string | null;
};

/** 입력값을 cm 숫자로. 비어 있거나 이상하면 0. */
function cm(value: string) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 가로·세로·높이 → 부피(L)와 최장변(cm) */
function fromDims(dims: Dims) {
  const w = cm(dims.w), h = cm(dims.h), d = cm(dims.d);
  return { volumeL: Math.max(1, Math.round((w * h * d) / 1000)), longestCm: Math.max(w, h, d) };
}

type SizeKey = (typeof SIZE_OPTIONS)[number][0];
type WeightKey = (typeof WEIGHT_OPTIONS)[number][0];

/** 선택값 → 배치 엔진이 쓰는 단위(부피·특대형 여부) */
function bagSpec(size: SizeKey, weight: WeightKey, count: number, dims: Dims) {
  if (size === "custom") {
    const { volumeL, longestCm } = fromDims(dims);
    // 특대형 기준은 최장변 75cm 초과 (SIZE_OPTIONS의 대형 상한)
    return { volumeL, isXLarge: longestCm > 75 || weight === "over20", count, longestCm,
             dimensions: { width: cm(dims.w), height: cm(dims.h), depth: cm(dims.d) } };
  }
  const volumeL = size === "large" ? 45 : 100;
  return { volumeL, isXLarge: size === "xlarge" || weight === "over20", count };
}

/** 화면 표시용 라벨 */
function bagLabel(size: SizeKey, weight: WeightKey, count: number, dims: Dims) {
  return {
    sizeName:
      size === "custom"
        ? `${cm(dims.w)}×${cm(dims.h)}×${cm(dims.d)}cm`
        : SIZE_OPTIONS.find(([k]) => k === size)![1],
    weightName: WEIGHT_OPTIONS.find(([k]) => k === weight)![1],
    count,
  };
}

/** 도착역에 따른 도착 시각·소요시간. 열차는 한 편이고 네 역에 모두 정차합니다. */
function tripInfo(dest: string) {
  const [station, arrive, duration] =
    TICKET_STOPS.find(([name]) => name === dest) ?? TICKET_STOPS[3];
  return { station, arrive, duration };
}

const staffScreens = [
  ["S-01", "담당 열차 홈"], ["S-02", "열차 운영 요약"], ["S-03", "AI 배정안 검토"],
  ["S-04", "전체 적재 위치도"], ["S-05", "칸 상세"], ["S-06", "적재 체크리스트"],
  ["S-07", "예외 처리"], ["S-08", "수동 재배정"],
] as const;

/** /api/reassign 응답 */
type ReassignSlot = { slotId: string; label: string; index: number; selectable: boolean; blockedReason: string | null };
type ReassignPick = { slotId: string; label: string; rank: number; reason: string };
type ReassignResult = {
  current: { slotId: string; label: string; itemId: string | null } | null;
  candidates: ReassignSlot[];
  recommendations: ReassignPick[];
  source: "ranked" | "none";
};

/** 현장에서 고를 수 있는 문제 유형 */
const ISSUE_TYPES = [
  "다른 수하물이 적재되어 있음",
  "배정된 물품이 없음",
  "미등록 대형 수하물 발견",
  "보관대 파손·사용 불가",
  "화물 또는 수하물 파손",
  "QR 인식 불가",
] as const;

/** 연한 파란 칩 안에 들어가는 아이콘. 내용은 KRL_ICONS의 인라인 SVG입니다. */
function Icon({ name }: { name: IconName }) {
  return <span className="icon" aria-hidden="true"><KrlIcon name={name}/></span>;
}

function PhoneHeader({ title, sub, back, staff = false, korail = false }: { title: string; sub?: string; back?: () => void; staff?: boolean; korail?: boolean }) {
  return (
    <>
      <div className={`phone-status ${korail ? "korail-status" : ""}`}><span>9:41</span><span className="status-icons"><KrlIcon name="signal"/><KrlIcon name="wifi"/><KrlIcon name="battery"/></span></div>
      <header className={`phone-header ${staff ? "staff-header" : ""} ${korail ? "korail-header" : ""} ${sub ? "with-sub" : ""}`}>
        {back ? <button className="icon-button" onClick={back} aria-label="이전 화면">‹</button> : <span className="korail-mini">KORAIL</span>}
        <strong>{title}{sub && <small>{sub}</small>}</strong>
        <button className="icon-button" aria-label="더보기">•••</button>
      </header>
    </>
  );
}

function TrainCard({ dest, seatText, ticketKey }: { dest: string; seatText: string; ticketKey?: string }) {
  const leg = tripInfo(dest);
  return (
    <div className="ticket-card">
      <div className="ticket-top"><span className="pill blue">KTX</span><strong>KTX 123</strong>{ticketKey && <span className="ticket-key">{ticketKey}</span>}<span>8월 13일</span></div>
      <div className="route-row"><div><b>17:00</b><span>서울</span></div><div className="route-line"><i></i><span>{leg.duration}</span><i></i></div><div><b>{leg.arrive}</b><span>{leg.station}</span></div></div>
      <div className="ticket-bottom"><span>{seatText}</span><span>일반실 · 성인 1명</span></div>
    </div>
  );
}

/** 보관대 문자는 호차마다 다릅니다. 칸 id를 A로 고정하면 선택값이 다른 호차와 어긋납니다. */
function LockerMap({ staff = false, rack = "A", selected = "A-03", onSelect }: { staff?: boolean; rack?: string; selected?: string; onSelect?: (id: string) => void }) {
  const ids = Array.from({ length: SLOTS_PER_CAR }, (_, i) => `${rack}-${String(i + 1).padStart(2, "0")}`);
  const staffLabels = ["승객 · 8C","승객 · 11A","승객 · 12A","여유","특송 #A13","특송 #C21"];
  const staffTypes = ["passenger","passenger","passenger","empty","express-wait","express-done"];
  const cells = staff
    ? ids.map((id, i) => ({ id, type: staffTypes[i], label: staffLabels[i] }))
    : ids.map(id => ({id,type:id === selected ? "mine" : "neutral",label:id === selected ? "내 수하물" : ""}));
  return <div className="locker-map">{cells.map(c => <button key={c.id} className={`locker-cell ${c.type} ${selected === c.id ? "selected" : ""}`} onClick={() => onSelect?.(c.id)}><b>{c.id}</b><span>{c.label}</span></button>)}</div>;
}

const STAFF_NAV = [["home","home","홈"],["trains","train","열차"],["scan","scan","스캔"],["issues","warn","문제"]] as const;
const PASSENGER_NAV = [["book","train","승차권예매"],["discount","discount","할인·정기권"],["tour","tour","관광상품"],["ticket","ticket","승차권확인"]] as const;

/** 적재율 구간. app.js가 실제 배정 결과로 갱신하기 전에는 idle입니다. */
const LOAD_LEVELS = [
  ["free", "여유"], ["normal", "보통"], ["busy", "혼잡"], ["full", "거의 만석"],
] as const;

/**
 * S-04 상단 열차 도식. 호차를 눌러 보관대를 고릅니다.
 *
 * 적재율은 React가 모르므로 칸마다 data-app 훅만 심어두고, app.js가 배정 결과의
 * capacity.byCar를 읽어 퍼센트와 data-level을 채웁니다. 배정 전에는 "—"입니다.
 */
function TrainMap({ selected, onSelect }: { selected: string; onSelect: (car: string) => void }) {
  return (
    <div className="train-map">
      <div className="train-strip">
        {RACK_CARS.map(([car]) => {
          const no = car.replace("호차", "");
          return (
            <button key={car} className={`train-car ${selected === car ? "on" : ""}`} data-level="idle" data-app-car={no} onClick={() => onSelect(car)}>
              <span className="tc-badge"><b>{car}</b><i data-app={`load-${no}`}>—</i></span>
              <span className="tc-stem" aria-hidden="true"></span>
              <span className="tc-body">
                <span className="tc-windows" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <i key={i}/>)}</span>
                <span className="tc-rack" aria-hidden="true">{Array.from({ length: SLOTS_PER_CAR }, (_, i) => <i key={i}/>)}</span>
              </span>
              <span className="tc-wheels" aria-hidden="true"><i/><i/></span>
            </button>
          );
        })}
      </div>
      <div className="train-rail" aria-hidden="true"></div>
      <div className="train-legend">
        {LOAD_LEVELS.map(([key, label]) => <span key={key}><i data-level={key}/>{label}</span>)}
      </div>
    </div>
  );
}

/** 보관대 한 대의 칸 수. lib/train.js의 SLOTS_PER_RACK과 같아야 합니다. */
const SLOTS_PER_CAR = 6;

function BottomNav({ active = "ticket", staff = false }: { active?: string; staff?: boolean }) {
  const items = staff ? STAFF_NAV : PASSENGER_NAV;
  return <nav className="bottom-nav korail-nav">{items.map(([id,icon,label]) => <span key={id} className={active === id ? "active" : ""}><i><KrlIcon name={icon}/></i>{label}</span>)}</nav>;
}

/** P-01 수하물 위치 칸의 세 가지 상태 */
type BagState = "none" | "waiting" | "done";

/** 상태별 안내 박스 문구. 배정이 끝나면 등록 유도 대신 위치 확인으로 바뀝니다. */
const PROMO_COPY: Record<BagState, { title: string; desc: string; cta: string; note: string; go: number }> = {
  none:    { title: "큰 수하물이 있으신가요?", desc: "미리 등록하면 전용 적재 위치를 안내해 드려요.", cta: "수하물 등록하기", note: "출발 30분 전까지", go: 2 },
  waiting: { title: "수하물 등록이 완료됐어요", desc: "출발 30분 전에 AI가 적재 위치를 배정해 드려요.",  cta: "등록 정보 보기",   note: "배정 대기 중",    go: 9 },
  done:    { title: "수하물 위치가 배정됐어요",  desc: "안내된 보관대에 실어 주세요.",                  cta: "배정 위치 확인하기", note: "배정 완료",       go: 6 },
};

/**
 * 승차권 상세용 아이콘.
 *
 * ▦·◬ 같은 글리프 문자는 Arial·Noto Sans KR에 해당 자형이 없어 격자나 빈 네모로 깨집니다.
 * 폰트에 의존하지 않도록 인라인 SVG로 그립니다. 색은 currentColor를 따라갑니다.
 */
const KRL_ICONS = {
  bag: <><rect x="3.5" y="7.5" width="17" height="13" rx="2.5"/><path d="M8.5 7.5V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/><path d="M3.5 12.5h17"/></>,
  siren: <><path d="M7 16.5v-4a5 5 0 0 1 10 0v4"/><rect x="4.5" y="16.5" width="15" height="4" rx="1.2"/><path d="M12 4.5v-2M4.8 7.3 3.4 5.9M19.2 7.3l1.4-1.4"/></>,
  help: <><circle cx="14" cy="3.8" r="1.9"/><path d="M11.8 7v5.4h5l2.6 5.6"/><circle cx="10.6" cy="15.4" r="5.2"/></>,
  train: <><rect x="5.5" y="3.5" width="13" height="13" rx="3.5"/><path d="M5.5 11h13"/><circle cx="9.2" cy="13.7" r="1"/><circle cx="14.8" cy="13.7" r="1"/><path d="M9 17l-2.2 3.5M15 17l2.2 3.5"/></>,
  sms: <><path d="M20 4.5H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2.5v3.6l4.5-3.6H20a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2z"/><path d="M7.5 10.5h.01M12 10.5h.01M16.5 10.5h.01"/></>,
  ticket: <><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/></>,
  discount: <><circle cx="12" cy="12" r="9"/><path d="M15.2 8.8 8.8 15.2"/><circle cx="9.4" cy="9.4" r="1.2"/><circle cx="14.6" cy="14.6" r="1.2"/></>,
  tour: <><path d="M2.8 8 12 3.5 21.2 8"/><rect x="4.5" y="8" width="15" height="12" rx="1"/><path d="M8.5 8v12M12 8v12M15.5 8v12"/><path d="M3 20h18"/></>,
  handbag: <><path d="M3.6 8.6h16.8l-1.2 10.9a2 2 0 0 1-2 1.8H6.8a2 2 0 0 1-2-1.8z"/><path d="M8.6 8.6V6.9a3.4 3.4 0 0 1 6.8 0v1.7"/></>,
  clock: <><circle cx="12" cy="12" r="8.8"/><path d="M12 7v5.4l3.4 2"/></>,
  ruler: <><rect x="2" y="8.5" width="20" height="7" rx="1.6"/><path d="M6.5 8.5v3M10 8.5v4.4M13.5 8.5v3M17.5 8.5v4.4"/></>,
  scan: <><path d="M3 8.5v-3a2 2 0 0 1 2-2h3M16 3.5h3a2 2 0 0 1 2 2v3M21 15.5v3a2 2 0 0 1-2 2h-3M8 20.5H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3.2"/></>,
  sparkle: <><path d="M11.2 3.4 12.9 8l4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L4.9 9.7 9.5 8z"/><path d="m18.4 14.6.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></>,
  camera: <><path d="M3.2 8.6h3.2L8 6.2h8l1.6 2.4h3.2a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3.2a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="12" cy="14.1" r="3.4"/></>,
  refresh: <><path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.8 4.4v4.5h-4.5"/></>,
  check: <><path d="M5.6 12.4 9.7 16.5 18.4 7.3"/></>,
  info: <><circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v5.3M12 7.7h.01"/></>,
  bell: <><path d="M18 9.2a6 6 0 1 0-12 0c0 5.8-2.3 7.4-2.3 7.4h16.6S18 15 18 9.2z"/><path d="M13.7 20.2a2 2 0 0 1-3.4 0"/></>,
  box: <><path d="M20.4 8.5v7a1.6 1.6 0 0 1-.85 1.4l-6.75 3.7a1.6 1.6 0 0 1-1.6 0L4.45 16.9a1.6 1.6 0 0 1-.85-1.4v-7a1.6 1.6 0 0 1 .85-1.4l6.75-3.7a1.6 1.6 0 0 1 1.6 0l6.75 3.7a1.6 1.6 0 0 1 .85 1.4z"/><path d="m3.8 7.7 8.2 4.5 8.2-4.5M12 20.6v-8.4"/></>,
  slot: <><rect x="3.2" y="6.4" width="17.6" height="13.2" rx="2"/><path d="M3.2 11.2h17.6M12 11.2v8.4"/></>,
  home: <><path d="M3.4 10.4 12 3.5l8.6 6.9v9a1.4 1.4 0 0 1-1.4 1.4H4.8a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M9.5 20.8v-6.9h5v6.9"/></>,
  list: <><path d="M8.6 6.4h11.8M8.6 12h11.8M8.6 17.6h11.8"/><path d="M4 6.4h.01M4 12h.01M4 17.6h.01"/></>,
  warn: <><path d="M10.6 4 2.4 18a1.6 1.6 0 0 0 1.4 2.4h16.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4a1.6 1.6 0 0 0-2.8 0z"/><path d="M12 9.6v4.2M12 17.3h.01"/></>,
  shield: <><path d="M12 21.4s7.3-3.6 7.3-9.3V6L12 3.3 4.7 6v6.1c0 5.7 7.3 9.3 7.3 9.3z"/><path d="m9.3 11.9 2 2 3.5-3.7"/></>,
  grid: <><rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.4"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.4"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.4"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.4"/></>,
  signal: <><path d="M3.4 18.6v-2.4M8.6 18.6v-6M13.8 18.6v-9.8M19 18.6v-13.2"/></>,
  wifi: <><path d="M2.6 9.3a14.2 14.2 0 0 1 18.8 0M6 12.9a9.3 9.3 0 0 1 12 0M9.4 16.5a4.4 4.4 0 0 1 5.2 0"/><path d="M12 20h.01"/></>,
  battery: <><rect x="2" y="7.6" width="17" height="8.8" rx="2.2"/><path d="M21.3 11v2"/><rect x="4.2" y="9.8" width="12.6" height="4.4" rx="1" fill="currentColor" stroke="none"/></>,
  sun: <><circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.6M12 19v2.6M4.2 12H1.6M22.4 12h-2.6M6.5 6.5 4.7 4.7M19.3 19.3l-1.8-1.8M17.5 6.5l1.8-1.8M4.7 19.3l1.8-1.8"/></>,
  copy: <><rect x="8.6" y="8.6" width="12" height="12" rx="2"/><path d="M15.4 5.4H5.4a2 2 0 0 0-2 2v10"/></>,
  chevronDown: <><path d="m6.4 9.4 5.6 5.6 5.6-5.6"/></>,
} as const;

type IconName = keyof typeof KRL_ICONS;

function KrlIcon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{KRL_ICONS[name]}</svg>;
}

const KORAIL_SERVICES = [
  ["siren", "철도범죄신고"], ["help", "승차권 도우미"], ["train", "KTX 공공서비스"], ["sms", "보호자 안심SMS"],
] as const;

/**
 * P-01 승차권 상세 — 코레일톡 승차권 UI를 모티브로 재구성했습니다.
 *
 * 정보표의 "수하물 위치" 칸이 이 화면의 핵심입니다. 미등록 → 배정 대기 → 실제 칸으로
 * 바뀌며, 배정된 칸 번호는 app.js가 [data-app="p01-slot"]에 써넣습니다. React는
 * 배정 결과를 모르므로 그 전까지 "배정 중"을 표시합니다.
 */
function TicketDetailScreen({ ticket, tickets, dest, seatText, allocated, go }: { ticket: Ticket | null; tickets: Ticket[]; dest: string; seatText: string; allocated: boolean; go: (n: number) => void }) {
  const [copied, setCopied] = useState(false);
  const leg = tripInfo(ticket?.dest ?? dest);
  const seatCar = ticket?.seatCar ?? Number(seatText.split("호차")[0]) ?? 7;
  const seat = ticket?.seat ?? seatText.split(" ")[1] ?? "12A";
  // P-00에서 발권할 때 부여한 두 자리 조회번호를 그대로 씁니다. 승차권 확인 입력값과 같아야 합니다.
  const ticketNo = ticket?.key ?? "01";

  const state: BagState = !ticket?.bag ? "none" : allocated ? "done" : "waiting";
  // done일 때의 "배정 중"은 자리표시자입니다. app.js가 배정 결과를 받으면 칸 번호로 덮어씁니다.
  const slotText = state === "none" ? "미등록" : state === "waiting" ? "배정 대기" : "배정 중";
  const promo = PROMO_COPY[state];

  const copy = () => {
    navigator.clipboard?.writeText(ticketNo).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="phone-screen">
      <PhoneHeader title="승차권 상세" back={() => go(0)} korail/>
      <div className="korail-tabbar">
        <button className="active">승차권 ({tickets.length || 1})</button>
        <button>정기권·패스</button>
      </div>
      <div className="screen-scroll">
        <div className="krl-ticket">
          <div className="krl-ticket-head"><span>2026년 8월 13일 (목)</span><em>일반실 1매</em></div>

          <div className="krl-route">
            <div><b>서울</b><span>17:00</span></div>
            <i>→</i>
            <div><b>{leg.station}</b><span>{leg.arrive}</span></div>
          </div>

          <div className="krl-train">
            <span>KTX 123</span>
            <div><button>차내시설</button><button>열차시각</button></div>
          </div>

          <div className="krl-info">
            <div className="krl-info-head"><span>타는 곳</span><span>호차</span><span>좌석</span><span>수하물 위치</span></div>
            <div className="krl-info-body">
              {/* 승강장은 짐칸과 같은 시점(출발 30분 전)에 함께 배정·안내합니다. */}
              <div className="krl-info-cell krl-board"><b>30분 전<br/>표시</b></div>
              <div className="krl-info-cell krl-car"><b>{seatCar}</b><em>호차</em></div>
              <div className="krl-info-cell krl-seat"><b>{seat}</b></div>
              <div className="krl-info-cell krl-bag-cell" data-state={state}>
                <span className="krl-bag-pin"><KrlIcon name="bag"/></span>
                <b data-app="p01-slot">{slotText}</b>
              </div>
            </div>
          </div>

          <div className="krl-promo" data-state={state}>
            <div className="krl-promo-art"><KrlIcon name="bag"/></div>
            <div className="krl-promo-body">
              <h2>{promo.title}</h2>
              <p data-app="p01-status">{promo.desc}</p>
            </div>
            <div className="krl-promo-action">
              <button className="krl-promo-cta" onClick={() => go(promo.go)}>{promo.cta} ›</button>
              <span className="krl-promo-note">{promo.note}</span>
            </div>
          </div>

          <div className="krl-meta">
            <p>일반실 · 순방향 · 어른</p>
            <div className="krl-ticket-no">
              <span>승차권번호</span>
              <b className="ticket-key">{ticketNo}</b>
              <button onClick={copy} aria-label="승차권번호 복사"><KrlIcon name="copy"/></button>
              {copied && <em className="krl-copied">복사됨</em>}
            </div>
          </div>

          <div className="krl-services">
            {KORAIL_SERVICES.map(([icon, label]) => <span key={label}><i><KrlIcon name={icon}/></i>{label}</span>)}
          </div>
        </div>
        <button className="text-link">승차권 전달하기</button>
      </div>
      <BottomNav/>
    </div>
  );
}

function PassengerScreen({ index, go, dest, setDest, size, setSize, weight, setWeight, count, setCount, dims, setDims, registered, ticket, tickets, issueTicket, openTicket, registerBag, cancelBag, allocated, setAllocated }: { index: number; go: (n: number) => void; dest: string; setDest: (d: string) => void; size: SizeKey; setSize: (v: SizeKey) => void; weight: WeightKey; setWeight: (v: WeightKey) => void; count: number; setCount: (fn: (c: number) => number) => void; dims: Dims; setDims: (fn: (d: Dims) => Dims) => void; registered: boolean; ticket: Ticket | null; tickets: Ticket[]; issueTicket: () => string; openTicket: (k: string) => boolean; registerBag: (photo?: string | null) => void; cancelBag: () => void; allocated: boolean; setAllocated: (v: boolean) => void }) {
  const [locationTab, setLocationTab] = useState<"car"|"rack">("rack");
  const [issue, setIssue] = useState("다른 수하물이 놓여 있어요");
  const [sent, setSent] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [trip, setTrip] = useState<"one"|"round">("one");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [scan, setScan] = useState<"idle"|"analyzing"|"done">("idle");
  const fileRef = useRef<HTMLInputElement>(null);

  const openPicker = () => fileRef.current?.click();

  /**
   * 사진을 붙이면 크기 인식 단계로 넘어갑니다.
   *
   * 실제 이미지 분석은 하지 않습니다. 인식되는 것처럼 잠깐 보여준 뒤 24인치
   * 캐리어 표준 규격을 채워 넣고, 값이 틀리면 승객이 화면에서 직접 고칩니다.
   */
  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";  // 같은 파일을 다시 골라도 change가 나도록 비웁니다.
    if (!file) return;

    setPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setScan("analyzing");
    go(3);

    setTimeout(() => {
      setSize("custom");
      setDims(() => ({ ...AI_SCAN_RESULT }));
      setScan("done");
    }, 1600);
  };

  const photoInput = <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickPhoto}/>;

  const bag = bagLabel(size, weight, count, dims);
  const custom = fromDims(dims);
  const seatText = ticket ? `${ticket.seatCar}호차 ${ticket.seat}` : "7호차 12A";
  const spec = bagSpec(size, weight, count, dims);
  const tooBig = spec.volumeL > MAX_SLOT_L;
  const [picker, setPicker] = useState(false);
  const [searched, setSearched] = useState(false);
  const [lookup, setLookup] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [issued, setIssued] = useState("");
  const leg = tripInfo(dest);

  if (index === 0) return <div className="phone-screen"><PhoneHeader title="승차권 예매" staff/><div className="tabbar"><button className={trip==="one"?"active":""} onClick={()=>setTrip("one")}>편도</button><button className={trip==="round"?"active":""} onClick={()=>setTrip("round")}>왕복</button></div><div className="screen-scroll bottom-space"><div className="book-route"><div className="book-end"><span>출발</span><b>서울</b></div><button className="book-swap" aria-label="출발·도착 바꾸기">⇄</button><button className="book-end pick" onClick={()=>setPicker(true)}><span>도착</span><b>{dest}</b></button></div><button className="book-map" onClick={()=>setPicker(true)}>KTX역 선택 지도</button><div className="book-field"><span>출발일</span><b>2026년 8월 13일 (목)</b></div><div className="book-field"><span>승객 연령 및 좌석수</span><b>어른 1명</b></div><div className="book-field"><span>승차권 확인</span><div className="lookup-row"><input inputMode="numeric" maxLength={2} placeholder="00" value={lookup} onChange={(e)=>{setLookup(e.target.value.replace(/\D/g, "").slice(0,2)); setLookupError("");}}/><button onClick={()=>{ if (openTicket(lookup)) { setLookup(""); setLookupError(""); go(1); } else setLookupError("그 번호의 승차권이 없어요."); }}>조회</button></div>{lookupError && <p className="lookup-error">{lookupError}</p>}<p className="hint">예매하면 받은 두 자리 번호를 입력하세요.</p></div></div><div className="sticky-action"><button className="primary" onClick={()=>setSearched(true)}>열차 조회하기</button></div>{searched && <div className="modal-backdrop" onClick={()=>setSearched(false)}><div className="modal" onClick={(e)=>e.stopPropagation()}><h2>열차 조회 결과</h2><p>서울 → {dest} · 2026년 8월 13일 (목)</p><div className="recommend-list" style={{marginTop:12}}><button type="button" className="selected"><span className="rank">KTX</span><div><b>17:00 → {leg.arrive}</b><small>KTX-산천 123 · {leg.duration} · 일반실</small></div><i>●</i></button></div><p className="issued-note">8번 승강장 · 성인 1명 · 이 열차 한 편만 운행합니다</p><div><button className="secondary" onClick={()=>setSearched(false)}>닫기</button><button className="primary" onClick={()=>{setSearched(false);setIssued(issueTicket());}}>이 열차로 예매하기</button></div></div></div>}{issued && <div className="modal-backdrop"><div className="modal"><h2>예매가 완료됐어요</h2><p>아래 조회번호로 언제든 이 승차권을 다시 열 수 있어요.</p><div className="issued-key">{issued}</div><p className="issued-note">서울 → {ticket?.dest} · {ticket?.seatCar}호차 {ticket?.seat}</p><div><button className="secondary" onClick={()=>{setIssued("");setSearched(false);}}>승차권 더 예매</button><button className="primary" onClick={()=>{setIssued("");go(1);}}>수하물 등록하러 가기</button></div></div></div>}{picker && <div className="modal-backdrop" onClick={()=>setPicker(false)}><div className="modal book-sheet" onClick={(e)=>e.stopPropagation()}><h2>도착역을 선택하세요</h2><p>서울역에서 출발하는 KTX-산천 123이 정차하는 역이에요.</p><div className="radio-list">{TICKET_STOPS.map(([station, at])=><button key={station} className={dest===station?"selected":""} onClick={()=>{setDest(station);setPicker(false);setSearched(false);}}><span>{dest===station?"●":"○"}</span>{station} · {at} 도착</button>)}</div></div></div>}</div>;

  if (index === 1) return <TicketDetailScreen ticket={ticket} tickets={tickets} dest={dest} seatText={seatText} allocated={allocated} go={go}/>;

  if (index === 2) return (
    <div className="phone-screen">
      <PhoneHeader title="수하물 정보 입력" back={() => go(1)}/>
      <div className="screen-scroll bottom-space">
        <div className="step-chip"><b>1 / 3</b><span>등록 방법</span></div>

        <div className="reg-hero">
          <div className="reg-hero-art"><KrlIcon name="bag"/><i><KrlIcon name="sparkle"/></i></div>
          <h1>큰 짐은 미리 등록하고<br/>편하게 탑승하세요</h1>
          <p>수하물 정보를 등록하면 탑승 전 적재 가능한<br/>전용 위치를 안내해 드려요.</p>
        </div>

        <div className="reg-guide">
          <GuideRow icon="bag" title="등록이 필요한 짐" text="좌석 위 선반에 보관하기 어려운 대형 캐리어"/>
          <GuideRow icon="handbag" title="등록하지 않아도 되는 짐" text="좌석 위 선반에 안전하게 보관할 수 있는 소형 가방"/>
          <GuideRow icon="clock" title="등록 마감" text="출발 30분 전까지" tone="blue"/>
        </div>

        {/*
          사진은 선택 기능이 아니라 등록의 첫 단계입니다. 역무원이 현장에서 실물과
          대조하는 근거가 되므로, 사진을 붙이면 바로 크기 인식 단계로 넘어갑니다.
        */}
        <h3 className="reg-question">수하물 사진을 첨부해 주세요</h3>
        <button className="scan-empty" onClick={openPicker}>
          <KrlIcon name="camera"/>
          <b>수하물 사진 첨부하기</b>
          <small>정면에서 찍은 사진 한 장이면 됩니다</small>
        </button>
        <p className="ex-hint">첨부한 사진으로 크기를 인식하고, 역무원이 실물을 확인할 때 씁니다.</p>
      </div>
      <div className="sticky-action">
        <button className="primary" onClick={openPicker}>사진 첨부하고 시작하기</button>
      </div>
      {photoInput}
    </div>
  );

  if (index === 3) return (
    <div className="phone-screen">
      <PhoneHeader title="수하물 크기 인식" back={() => go(2)}/>
      <div className="screen-scroll bottom-space">
        <div className="step-chip"><b>2 / 3</b><span>사진 분석</span></div>

        {photoUrl ? (
          <div className="scan-photo">
            <img src={photoUrl} alt="등록할 수하물 사진"/>
            {scan === "done"
              ? <span className="scan-badge done"><KrlIcon name="check"/>인식 완료</span>
              : <span className="scan-badge"><i className="scan-spin"/>AI 인식 중</span>}
            {scan === "done" && (
              <svg className="scan-frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 15V0h15M85 0h15v15M100 85v15H85M15 100H0V85"/>
              </svg>
            )}
            <button className="scan-retake" onClick={openPicker}><KrlIcon name="refresh"/>다시 촬영</button>
          </div>
        ) : (
          <button className="scan-empty" onClick={openPicker}>
            <KrlIcon name="camera"/>
            <b>수하물 사진 첨부하기</b>
            <small>정면에서 찍은 사진 한 장이면 됩니다</small>
          </button>
        )}

        {scan === "done" && <>
          <div className="scan-result-head">
            <span className="scan-result-icon"><KrlIcon name="sparkle"/></span>
            <div><b>수하물 크기를 인식했어요</b><small>인식된 값이 실제와 다르면 직접 입력해 주세요.</small></div>
          </div>

          {/* 읽기 전용이 아닙니다. 값이 틀리면 승객이 이 자리에서 바로 고칩니다. */}
          <div className="dim-edit">
            {DIM_FIELDS.map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input type="number" inputMode="numeric" min="10" max="200" value={dims[key]}
                  onChange={(e)=>setDims((prev)=>({ ...prev, [key]: e.target.value }))}/>
                <em>cm</em>
              </label>
            ))}
          </div>
          <p className="dim-hint"><KrlIcon name="info"/>인식된 값이 실제와 다르면 직접 입력해 주세요.</p>

          <h3 className="reg-question">예상 무게</h3>
          <div className="choice-grid">
            {WEIGHT_OPTIONS.map(([key, name]) => (
              <button key={key} className={weight===key?"chosen":""} onClick={()=>setWeight(key)}>{name}</button>
            ))}
          </div>

          <div className="verdict-card">
            <div className="verdict-top">
              <span className="verdict-icon"><KrlIcon name="bag"/></span>
              <div>
                <small>판정 결과</small>
                <b>{spec.volumeL > MAX_SLOT_L ? "규격 초과" : spec.isXLarge ? "특대형 수하물" : "대형 수하물"}</b>
                <span>{spec.volumeL > MAX_SLOT_L ? "일반 보관대를 이용할 수 없어요." : `부피 ${spec.volumeL}L · 전용 적재 공간을 이용할 수 있어요.`}</span>
              </div>
            </div>
            <div className="verdict-scale">
              <span className={spec.volumeL > MAX_SLOT_L ? "on" : ""}>소형 · 수하물 불가</span>
              <span className={spec.volumeL <= MAX_SLOT_L && !spec.isXLarge ? "on" : ""}>대형</span>
              <span className={spec.volumeL <= MAX_SLOT_L && spec.isXLarge ? "on" : ""}>특대형</span>
            </div>
          </div>
        </>}
      </div>
      <div className="sticky-action">
        <button className="primary" disabled={scan !== "done"} style={scan !== "done" ? { opacity: .4 } : undefined} onClick={() => go(4)}>이 크기로 등록하기</button>
      </div>
      {photoInput}
    </div>
  );


  // 규격 초과 — 일반 보관대를 못 쓰므로 판정 화면 대신 특송 안내로 이어지는 결과 화면을 냅니다.
  if (index === 4 && tooBig) return (
    <div className="phone-screen">
      <PhoneHeader title="수하물 등록 결과" back={() => go(3)}/>
      <div className="screen-scroll bottom-space">
        <div className="ovr-trip"><span>KTX 123 · 서울 → {dest}</span><span>{seatText}</span></div>

        <div className="ovr-hero">
          <span className="ovr-mark warn"><KrlIcon name="warn"/></span>
          <h1>일반 수하물 보관대<br/>이용이 어려워요</h1>
          <p>입력하신 수하물은 크기 또는 무게가 커<br/><strong>열차 내 일반 수하물 보관공간에 배정할 수 없습니다.</strong></p>
        </div>

        <section className="ovr-card">
          <h3>입력한 수하물</h3>
          <div className="ovr-metrics">
            {size === "custom"
              ? DIM_FIELDS.map(([key, label]) => <div key={key}><span>{label}</span><b>{cm(dims[key])} cm</b></div>)
              : [["크기", bag.sizeName], ["개수", `${count}개`], ["부피", `${spec.volumeL} L`]].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
            <div><span>예상 무게</span><b>{bag.weightName}</b></div>
          </div>
          <p className="ovr-alert">일반 수하물 보관 기준을 초과했습니다 · 부피 {spec.volumeL}L / 보관대 한 칸 최대 {MAX_SLOT_L}L</p>
        </section>

        <section className="ovr-card blue">
          <div className="ovr-pitch">
            <span className="ovr-chip"><KrlIcon name="box"/></span>
            <div><h2>큰 짐은 특송으로 보내실 수 있어요</h2><p>직접 가지고 탑승하기 어려운 대형 수하물은 철도 특송 등 별도 운송 서비스를 이용해주세요.</p></div>
          </div>
          <ul className="ovr-bullets">
            <li>일반 보관대에 들어가지 않는 대형 수하물</li>
            <li>안전하게 적재하기 어려운 중량 수하물</li>
            <li>객실 통행이나 출입에 방해가 될 수 있는 수하물</li>
          </ul>
        </section>
      </div>
      <div className="sticky-action stacked">
        <button className="primary" onClick={() => go(11)}>특송으로 보내기</button>
        <div className="ovr-links">
          <button className="text-link" onClick={() => go(3)}>수하물 크기 다시 입력</button>
          <button className="text-link" onClick={() => go(1)}>승차권으로 돌아가기</button>
        </div>
      </div>
    </div>
  );

  // P-11 특송 이용 안내 — 규격 초과 결과에서 "특송으로 보내기"로 넘어옵니다.
  if (index === 11) return (
    <div className="phone-screen">
      <PhoneHeader title="특송 이용 안내" back={() => go(4)}/>
      <div className="screen-scroll bottom-space">
        <div className="ovr-trip"><span>KTX 123 · 서울 → {dest}</span><span>{seatText}</span></div>

        <div className="ovr-hero">
          <span className="ovr-mark box"><KrlIcon name="box"/></span>
          <h1>이 수하물을<br/>특송으로 보내시겠어요?</h1>
          <p>일반 수하물 보관대 이용이 어려운 짐은<br/><strong>{EXPRESS_PARTNER.service} 서비스로 별도 운송</strong>할 수 있어요.</p>
        </div>

        <section className="ovr-card">
          <h3>이용 정보</h3>
          <div className="ovr-rows">
            <div><span>출발역</span><b>서울역</b></div>
            <div><span>도착역</span><b>{dest}역</b></div>
            <div><span>열차</span><b>KTX 123</b></div>
            <div><span>수하물</span><b>{size === "custom" ? `${cm(dims.w)} × ${cm(dims.h)} × ${cm(dims.d)}cm` : `${bag.sizeName} · ${spec.volumeL}L`}<br/>{bag.weightName}</b></div>
          </div>
        </section>

        <section className="ovr-card">
          <div className="ovr-partner">
            <span className="ovr-logo">짐<br/>캐리</span>
            <div><b>{EXPRESS_PARTNER.service} · {EXPRESS_PARTNER.name}</b><p>출발역·도착역과 수하물 정보를 바탕으로 실제 이용 가능 여부를 확인해주세요.</p></div>
          </div>
          <p className="ovr-notice"><strong>안내</strong><br/>특송 서비스의 실제 접수 가능 여부, 요금 및 제한 규격은 연계 서비스의 운영 기준에 따라 달라질 수 있습니다.</p>
        </section>
      </div>
      <div className="sticky-action stacked">
        {/* 외부 제휴 서비스로 나가므로 새 탭에서 엽니다. */}
        <a className="primary ovr-cta" href={EXPRESS_PARTNER.url} target="_blank" rel="noopener noreferrer">{EXPRESS_PARTNER.name}에서 이용 가능 여부 확인</a>
        <div className="ovr-links">
          <button className="text-link" onClick={() => go(4)}>수하물 등록 결과로 돌아가기</button>
        </div>
      </div>
    </div>
  );

  if (index === 4) return <div className="phone-screen"><PhoneHeader title="등록 가능 여부" back={() => go(3)}/><div className="screen-scroll bottom-space center-content"><div className={tooBig?"success-mark bad":"success-mark"}>{tooBig ? "!" : "✓"}</div><span className="eyebrow">{tooBig ? "AI 규격 확인 결과" : "AI 규격 확인 완료"}</span><h1>{tooBig ? <>등록할 수 없는<br/>수하물이에요</> : <>등록할 수 있는<br/>수하물이에요</>}</h1><p>{tooBig ? `부피 ${spec.volumeL}L로 보관대 한 칸(최대 ${MAX_SLOT_L}L)을 넘어요. 치수를 다시 확인해주세요.` : "출발 30분 전에 좌석과 가까운 보관 위치를 안내해드릴게요."}</p><div className="summary-card"><div className="case-thumb"><KrlIcon name="bag"/></div><div><small>등록 수하물</small><b>{bag.sizeName} 수하물</b><span>{bag.weightName}</span></div></div><div className="ai-reason"><Icon name="sparkle"/><p>{tooBig ? <><b>등록 전에 수정이 필요해요</b><br/>가로·세로·높이를 줄이거나 크기 등급을 다시 골라주세요.</> : <><b>{spec.isXLarge ? "아래쪽 칸으로 우선 배정해요" : "위쪽 칸으로 배정해요"}</b><br/>부피 {spec.volumeL}L · 무게와 이동 안전성을 함께 고려합니다.</>}</p></div></div><div className="sticky-action dual"><button className="secondary" onClick={() => go(3)}>정보 수정</button><button className="primary" disabled={tooBig} style={tooBig?{opacity:.4}:undefined} onClick={() => { if (!tooBig) { registerBag(photoUrl); go(5); } }}>{tooBig ? "등록 불가" : "이 정보로 등록하기"}</button></div></div>;

  if (index === 5) return <div className="phone-screen"><PhoneHeader title="수하물 등록" back={() => go(1)}/><div className="screen-scroll bottom-space"><div className="status-hero waiting"><div className="clock-ring"><KrlIcon name="clock"/></div><span className="pill amber">{allocated ? "AI 배정 진행" : "배정 대기"}</span><h1>수하물 등록이<br/>완료됐어요</h1><p>좌석 위치와 전체 수하물 현황을 고려해 출발 30분 전부터 배정합니다.</p></div>{!allocated && <div className="notice blue"><b>아직 배정 전이에요</b><p>등록된 승차권 {tickets.filter((t)=>t.bag).length}건을 모아 출발 30분 전에 한 번에 배정합니다. 승차권을 더 등록하려면 예매 화면으로 돌아가세요.</p></div>}<div className="detail-card"><div><span>등록 수하물</span><b>{bag.sizeName} 수하물</b></div><div><span>승차권 번호</span><b>{ticket?.key ?? "-"}</b></div><div><span>위치 안내 예정</span><b className="blue-text">오늘 오후 4:30</b></div></div><div className="push-note"><Icon name="bell"/><p><b>앱 알림으로 알려드릴게요</b><br/>출발 30분 전까지 수정하거나 취소할 수 있어요.</p></div><button className="demo-link" onClick={() => setAllocated(true)}>{allocated ? "배정 진행 중…" : "발표 시연: 출발 30분 전으로 건너뛰기 →"}</button></div><div className="sticky-action dual"><button className="secondary" onClick={() => go(9)}>등록 정보 보기</button><button className="primary" onClick={() => { if (!allocated) setAllocated(true); else go(6); }}>{allocated ? "배정 결과 보기" : "출발 30분 전 · AI 배정 시작"}</button></div></div>;

  if (index === 6) return <div className="phone-screen"><PhoneHeader title="수하물 위치 안내" back={() => go(5)}/><div className="screen-scroll bottom-space"><div className="status-banner success">✓ 위치 배정 완료 <span>8번 승강장</span></div><div className="assigned-hero"><span>KTX 123 · 7호차 12A</span><h1>수하물 위치가<br/>배정됐어요</h1><p>탑승 후 아래 위치에 수하물을 놓아주세요.</p></div><div className="location-card"><small>7호차 · A 수하물 보관대</small><b>A-03</b><span>좌석 12A에서 뒤쪽 출입문 방향</span></div><div className="notice blue"><b>배정된 위치를 이용해주세요</b><p>다른 위치에 보관하면 하차 시 혼선이 생길 수 있어요.</p></div></div><div className="sticky-action dual"><button className="secondary" onClick={() => go(8)}>수하물 QR</button><button className="primary" onClick={() => go(7)}>배정 위치 보기</button></div></div>;

  if (index === 7) return <div className="phone-screen"><PhoneHeader title="내 수하물 위치" back={() => go(6)}/><div className="tabbar"><button className={locationTab === "car" ? "active" : ""} onClick={() => setLocationTab("car")}>객차 위치</button><button className={locationTab === "rack" ? "active" : ""} onClick={() => setLocationTab("rack")}>보관대 위치</button></div><div className="screen-scroll bottom-space">{locationTab === "car" ? <><div className="section-copy"><span className="eyebrow">7호차 내부</span><h1>12A 좌석에서<br/>뒤쪽으로 이동하세요</h1><p>A 보관대는 뒤쪽 출입문 바로 앞에 있어요.</p></div><div className="car-map"><div className="door">출입문</div><div className="rack-point">A 보관대<br/><b>A-03</b></div><div className="seat-grid">{["9A","9B","10A","10B","11A","11B","12A","12B"].map(x=><span key={x} className={x==="12A"?"my-seat":""}>{x}</span>)}</div><div className="path-arrow">↑ 이동 방향</div></div></> : <><div className="section-copy"><span className="eyebrow">A 수하물 보관대</span><h1><strong>A-03</strong> 칸에<br/>수하물을 놓아주세요</h1><p>다른 칸의 사용 여부는 표시되지 않아요.</p></div><LockerMap/><div className="rack-label-photo"><span>A-03</span><p><b>실제 보관대의 위치 번호를 확인하세요</b><br/>파란색 번호 스티커가 붙어 있어요.</p></div></>}<button className="danger-link" onClick={() => go(10)}>배정 위치를 사용할 수 없어요</button></div></div>;

  if (index === 8) return <div className="phone-screen"><PhoneHeader title="수하물 확인증" back={() => go(6)}/><div className="screen-scroll"><div className="qr-ticket"><div className="qr-status">등록 완료 · 위치 배정 완료</div><div className="qr-code" aria-label="시연용 QR 코드"><span className="qr-blocks">{qrCells(ticket?.key ?? "JIMKKOK").map((on, i) => <i key={i} className={on ? "on" : ""}/>)}</span></div><h2>—</h2><div className="qr-info"><p><span>열차</span><b>KTX 123 · 7호차 12A</b></p><p><span>구간</span><b>서울 → {dest}</b></p><p><span>수하물</span><b>{bag.sizeName}</b></p><p><span>배정 위치</span><b className="blue-text">A-03</b></p></div></div><p className="center-note">역무원의 확인 요청이 있을 때 보여주세요.<br/><b>탑승할 때마다 스캔할 필요는 없습니다.</b></p><button className="secondary full"><KrlIcon name="sun"/> 화면 밝게 보기</button></div></div>;

  if (index === 9) return <div className="phone-screen"><PhoneHeader title="수하물 등록 정보" back={() => go(5)}/><div className="screen-scroll bottom-space"><div className="status-banner waiting"><KrlIcon name="clock"/> 배정 대기 <span>오후 4:30 배정 예정</span></div><div className="registered-photo"><div><KrlIcon name="bag"/></div><span><b>{bag.sizeName} 캐리어</b><br/>{bag.weightName}</span></div><div className="detail-card"><div><span>등록번호</span><b>{ticket ? `BAG-${ticket.key}` : "—"}</b></div><div><span>승차 정보</span><b>KTX 123 · {seatText}</b></div><div><span>등록 마감</span><b>오후 4:30</b></div></div><div className="notice"><b>마감 전까지 변경할 수 있어요</b><p>위치 배정이 시작되면 앱에서 수정하거나 취소할 수 없습니다.</p></div></div><div className="sticky-action stacked"><button className="primary" onClick={() => go(3)}>수하물 정보 수정</button><button className="danger-link" onClick={() => setCancelOpen(true)}>등록 취소</button></div>{cancelOpen && <div className="modal-backdrop"><div className="modal"><h2>수하물 등록을 취소할까요?</h2><p>취소하면 배정 예정 공간이 해제됩니다.</p><div><button className="secondary" onClick={() => setCancelOpen(false)}>계속 등록</button><button className="danger-button" onClick={() => {setCancelOpen(false);cancelBag();go(1)}}>등록 취소</button></div></div></div>}</div>;

  return <div className="phone-screen"><PhoneHeader title="어떤 문제가 있나요?" back={() => {setSent(false);go(7)}}/><div className="screen-scroll bottom-space">{sent ? <div className="center-content sent-state"><div className="success-mark">✓</div><h1>도움 요청을<br/>보냈어요</h1><p>7호차 담당 승무원이 확인할 예정입니다.</p><div className="notice blue"><b>잠시 직접 보관해주세요</b><p>수하물은 통로나 출입문에 두지 마세요.</p></div></div> : <><div className="section-copy"><span className="eyebrow">7호차 · A 보관대 · A-03</span><h1>불편한 상황을<br/>선택해주세요</h1></div><div className="radio-list">{["다른 수하물이 놓여 있어요","보관대 위치를 찾기 어려워요","수하물이 배정 칸에 들어가지 않아요","보관대가 파손되어 있어요"].map(x=><button key={x} className={issue===x?"selected":""} onClick={()=>setIssue(x)}><span>{issue===x?"●":"○"}</span>{x}</button>)}</div><div className="notice"><b>가까운 승무원에게 전달돼요</b><p>선택한 내용과 배정 위치만 전달합니다.</p></div></>}</div><div className="sticky-action">{sent?<button className="primary" onClick={()=>{setSent(false);go(7)}}>내 수하물 위치로 돌아가기</button>:<button className="primary" onClick={()=>setSent(true)}>도움 요청 보내기</button>}</div></div>;
}

/** P-02 안내 카드의 한 줄. InfoRow와 달리 원형 테두리 SVG 아이콘을 씁니다. */
function GuideRow({ icon, title, text, tone }: { icon: IconName; title: string; text: string; tone?: string }) {
  return <div className="guide-row"><span className="guide-row-icon"><KrlIcon name={icon}/></span><div><b>{title}</b><p className={tone}>{text}</p></div></div>;
}

function StaffScreen({ index, go: rawGo, dest }: { index: number; go: (n: number) => void; dest: string }) {
  // S-07~S-10을 지운 뒤에도 원본 마크업에는 그 화면으로 가는 버튼이 남아 있습니다.
  // 그대로 두면 없는 인덱스를 가리켜 stage-label이 undefined를 읽고 앱이 죽습니다.
  // 범위를 벗어난 이동은 조용히 무시합니다.
  const go = (n: number) => { if (n >= 0 && n < staffScreens.length) rawGo(n); };
  const [filter, setFilter] = useState("전체");
  const [car, setCar] = useState("7호차");
  const [selectedCell, setSelectedCell] = useState("A-03");
  const [confirmed, setConfirmed] = useState(false);
  const [workTab, setWorkTab] = useState<"load"|"unload">("load");
  // S-07 예외 처리 — 발생 위치는 호차·칸 두 드롭다운으로 고릅니다.
  const [exCar, setExCar] = useState("9호차");
  const [exCell, setExCell] = useState("B-02");
  const [exType, setExType] = useState<string>(ISSUE_TYPES[0]);
  const [exMemo, setExMemo] = useState("");
  const [exPhoto, setExPhoto] = useState<string | null>(null);
  const [exSent, setExSent] = useState(false);
  const exFileRef = useRef<HTMLInputElement>(null);

  /** 호차를 바꾸면 그 호차의 보관대 칸으로 목록과 선택값을 함께 갈아끼웁니다. */
  const pickExCar = (next: string) => {
    setExCar(next);
    setExCell(`${rackOf(next)}-01`);
  };

  const onPickExPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setExPhoto((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  };

  /** S-05에서 넘어올 때 그 칸을 발생 위치 기본값으로 씁니다. */
  const reportIssue = () => {
    setExCar(car);
    setExCell(selectedCell);
    setExSent(false);
    go(6);
  };

  // S-08 수동 재배정 — 문제로 막힌 칸의 대체 위치를 AI에게 물어봅니다.
  const [reassign, setReassign] = useState<ReassignResult | null>(null);
  const [reassignBusy, setReassignBusy] = useState(false);
  const [pickedSlot, setPickedSlot] = useState("");
  const [moved, setMoved] = useState(false);

  /**
   * 문제 등록을 마치면 그 칸을 사용 불가로 두고 대체 위치를 받아 옵니다.
   * app.js가 들고 있는 배정 결과를 그대로 넘겨 서버가 같은 상태를 재구성합니다.
   */
  const openReassign = async () => {
    const blockedSlotId = `${exCar.replace("호차", "")}-${exCell}`;
    setMoved(false);
    setPickedSlot("");
    setReassign(null);
    setReassignBusy(true);
    go(7);

    const app = (window as unknown as { app?: { state?: { plan?: { allocations?: unknown[] } } } }).app;
    const jim = (window as unknown as { __jimkkok?: { passengers?: unknown[] } }).__jimkkok;

    try {
      const res = await fetch("/api/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blockedSlotId,
          allocations: app?.state?.plan?.allocations ?? [],
          passengers: jim?.passengers ?? [],
        }),
      });
      const data: ReassignResult = await res.json();
      setReassign(data);
      setPickedSlot(data.recommendations[0]?.slotId ?? "");
    } catch {
      setReassign({ current: null, candidates: [], recommendations: [], source: "none" });
    } finally {
      setReassignBusy(false);
    }
  };

  /**
   * 고른 칸으로 실제 배정을 옮깁니다.
   *
   * 적재 체크리스트(S-06)와 위치도(S-04)는 app.js가 state.plan을 보고 그리므로,
   * 그 배열을 직접 고쳐야 화면에 반영됩니다. schedule()로 다시 칠하게 합니다.
   */
  const applyMove = () => {
    const itemId = reassign?.current?.itemId;
    const app = (window as unknown as {
      app?: { state?: { plan?: { allocations?: Record<string, unknown>[] } }; schedule?: () => void };
    }).app;
    const list = app?.state?.plan?.allocations;

    if (itemId && list) {
      const [car, rack, idx] = pickedSlot.split("-");
      const target = list.find((a) => a.itemId === itemId);
      if (target) {
        target.slotId = pickedSlot;
        target.car = Number(car);
        target.rack = rack;
        target.index = Number(idx);
        target.label = `${car}호차 ${rack}보관대 ${idx}칸`;
        // 옮긴 위치는 좌석 거리를 다시 계산해야 맞습니다. 모르면 지웁니다.
        delete target.distanceM;
        app?.schedule?.();
      }
    }
    setMoved(true);
  };
  const [scanStage, setScanStage] = useState(0);

  if (index === 0) return <div className="phone-screen staff"><PhoneHeader title="오늘의 적재 업무" staff/><div className="screen-scroll"><div className="work-date"><span>8월 13일 · 서울역</span><button>필터<KrlIcon name="chevronDown"/></button></div><div className="summary-strip"><div><b>3</b><span>담당 열차</span></div><div><b>1</b><span>검토 필요</span></div><div><b>8</b><span>특송 건수</span></div></div><div className="section-title"><h3>지금 확인할 열차</h3><span>출발 순</span></div><div className="staff-train-card urgent"><div className="card-status"><span className="pill red">검토 필요</span><small>출발 24분 전</small></div><h2>KTX 123 · 서울 → 부산</h2><p>17:00 출발 · 8번 승강장</p><div className="staff-metrics"><span>승객 수하물 <b>34개</b></span><span>특송 <b>8건</b></span><span>확인 필요 <b className="red-text">1건</b></span></div><button className="primary" onClick={()=>go(1)}>운영 현황 보기</button></div><div className="staff-train-card"><div className="card-status"><span className="pill orange">특송 준비</span><small>출발 54분 전</small></div><h2>KTX 231 · 서울 → 광주송정</h2><p>17:30 출발 · 승강장 미정</p></div></div><BottomNav staff active="home"/></div>;

  if (index === 1) return <div className="phone-screen staff"><PhoneHeader title="열차 운영 요약" back={()=>go(0)} staff/><div className="screen-scroll bottom-space"><div className="staff-route"><span>KTX 123 · 서울 → 부산</span><b>열차 도착까지 <strong>14분</strong></b></div><div className="metric-grid"><Metric icon="bag" label="승객 대형 수하물" value="34개" note="배정 완료"/><Metric icon="slot" label="사용 가능 잔여 공간" value="1.42㎥" note="8칸"/><Metric icon="box" label="특송 화물" value="7건" note="1건 미배정" warn/><Metric icon="warn" label="현장 확인 필요" value="1건" note="즉시 확인" warn/></div><div className="warning-card"><Icon name="warn"/><p><b>9호차 B-02 사용 불가</b><br/>특송 1건을 다른 위치로 재배정해주세요.</p><button onClick={()=>go(9)}>재배정</button></div><div className="section-title"><h3>운영 메뉴</h3></div><div className="operation-list"><button onClick={()=>go(2)}><Icon name="sparkle"/><span><b>AI 배정안 검토</b><small>자동 배정 40건 · 확인 필요 1건</small></span><em>›</em></button><button onClick={()=>go(3)}><Icon name="grid"/><span><b>전체 적재 위치도</b><small>객차·보관대별 배정 상태 확인</small></span><em>›</em></button><button onClick={()=>go(5)}><Icon name="list"/><span><b>객차별 준비 시작</b><small>특송 7건을 적재 위치별로 분류</small></span><em>›</em></button></div></div><div className="sticky-action"><button className="primary dark" onClick={()=>go(2)}>AI 배정안 검토</button></div></div>;

  if (index === 2) return <div className="phone-screen staff"><PhoneHeader title="AI 배정안 검토" back={()=>go(1)} staff/><div className="screen-scroll bottom-space"><div className="ai-review-head"><span className="ai-badge"><KrlIcon name="sparkle"/> AI 적재 최적화</span><h1>{confirmed ? "배정안이 확정됐습니다" : "확정 전 마지막으로\n확인해주세요"}</h1><p>{confirmed ? "승객 위치 안내를 발송하고 특송 준비 목록을 만들었어요." : "좌석 거리·무게·하차 동선을 반영한 결과입니다."}</p></div><div className="review-stats"><div><b>41</b><span>배정 가능</span></div><div><b className="blue-text">40</b><span>자동 배정</span></div><div><b className="red-text">1</b><span>확인 필요</span></div></div><div className="filter-row"><button className="active">전체 41</button><button>문제 항목 1</button></div><div className="allocation-row"><span className="pill blue">정상</span><div><b>승객 · 7호차 12A</b><small>좌석과 가장 가까운 사용 가능 위치</small></div><strong>A-03</strong></div><div className="allocation-row alert"><span className="pill red">확인 필요</span><div><b>특송 #A13 · 서울 → 대전</b><small>9호차 B-02 · 사용 불가 위치</small></div><button onClick={()=>go(9)}>변경</button></div><div className="allocation-row"><span className="pill blue">정상</span><div><b>특송 #C21 · 서울 → 동대구</b><small>같은 하차역 작업 동선 최적화</small></div><strong>12-C04</strong></div></div><div className="sticky-action dual"><button className="secondary" onClick={()=>go(3)}>위치도 보기</button><button className="primary dark" onClick={()=>setConfirmed(true)}>{confirmed ? "객차별 준비로 이동" : "배정안 확정"}</button></div></div>;

  if (index === 3) return <div className="phone-screen staff"><PhoneHeader title="전체 적재 위치도" back={()=>go(1)} staff/><div className="staff-filters">{["전체","승객","특송","여유","확인 필요"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}</div><div className="screen-scroll"><TrainMap selected={car} onSelect={setCar}/><div className="map-heading"><div><span>{car} · {rackOf(car)} 보관대</span><h2>5/6칸 배정</h2></div><small>좌석 번호만 표시</small></div><LockerMap staff rack={rackOf(car)} selected={selectedCell} onSelect={(id)=>{setSelectedCell(id);go(4)}}/><div className="legend"><span><i className="passenger-dot"></i>승객</span><span><i className="express-dot"></i>특송</span><span><i className="empty-dot"></i>여유</span></div><div className="alert-list"><b>확인 필요</b><button onClick={()=>go(9)}><span>9호차 A-02</span><em>사용 불가 · 특송 #A13 ›</em></button></div><div className="privacy-note">승객 이름은 표시하지 않으며 업무에 필요한 좌석 번호만 제공합니다.</div></div><BottomNav staff active="trains"/></div>;

  if (index === 4) return <div className="phone-screen staff"><PhoneHeader title="칸 상세" back={()=>go(3)} staff/><div className="screen-scroll bottom-space">{/* 값은 전부 app.js가 선택한 칸의 배정 결과로 채웁니다. 등록 전에는 "—"입니다. */}<div className="cell-detail-head"><span className="pill blue" data-app="cell-kind">빈 칸</span><h1>{selectedCell}</h1><p>{car} · {rackOf(car)} 보관대</p></div><div className="luggage-photo">{/* 승객이 등록 때 붙인 사진을 app.js가 채웁니다. */}<img data-app="cell-img" alt="" hidden/><div className="case-big"><KrlIcon name="bag"/></div><span data-app="cell-photo">등록된 수하물 사진</span></div><div className="detail-card"><div><span>좌석</span><b>—</b></div><div><span>하차역</span><b>—</b></div><div><span>규격</span><b>—</b></div><div><span>등록번호</span><b>—</b></div></div><div className="photo-policy"><Icon name="info"/><p>정상 적재에는 현장 사진이 필요하지 않습니다. 등록 사진은 식별이 필요할 때만 확인하세요.</p></div></div><div className="sticky-action stacked"><div className="dual"><button className="secondary">QR 확인</button><button className="primary dark" onClick={()=>go(9)}>다른 위치로 변경</button></div><button className="danger-link" onClick={reportIssue}>현장 문제 등록</button></div></div>;

  // S-06 특송 작업 — 적재 준비 / 하역 예정 두 섹션. 값은 app.js가 배정 결과로 채웁니다.
  if (index === 5) return (
    <div className="phone-screen staff">
      <PhoneHeader title="특송 작업" back={()=>go(1)} staff/>
      <div className="tabbar work-tabs">
        <button className={workTab === "load" ? "active" : ""} onClick={()=>setWorkTab("load")}>적재 준비</button>
        <button className={workTab === "unload" ? "active" : ""} onClick={()=>setWorkTab("unload")}>하역 예정</button>
      </div>
      <div className="screen-scroll bottom-space">
        {workTab === "load" ? (
          <>
            <div className="progress-card"><div><span>적재 진행률</span><b>0 / 0건</b></div><div className="progress"><i style={{width:"0%"}}></i></div><p>AI 배치 결과입니다. 실은 항목을 체크하세요.</p></div>
            <div data-app="load-panel"/>
          </>
        ) : <div data-app="unload-panel"/>}
      </div>
      <div className="sticky-action">
        <button className="primary dark" onClick={()=>go(1)} data-app="work-cta">{workTab === "load" ? "적재 완료 처리" : "하역 위치 한눈에 보기"}</button>
      </div>
    </div>
  );

  // S-07 예외 처리 — 현장 문제 등록
  // 등록 완료 화면은 S-07 안의 상태입니다. S-08로 넘어간 뒤에는 걸리면 안 됩니다.
  if (index === 6 && exSent) return (
    <div className="phone-screen staff">
      <PhoneHeader title="현장 문제 등록" back={()=>setExSent(false)} staff/>
      <div className="screen-scroll bottom-space center-content sent-state">
        <div className="success-mark">✓</div>
        <h1>문제를<br/>등록했어요</h1>
        <p>담당 부서가 확인한 뒤 재배정 여부를 알려드립니다.</p>
        <div className="detail-card" style={{ textAlign: "left", marginTop: 22 }}>
          <div><span>발생 위치</span><b>{exCar} · {rackOf(exCar)} 보관대 · {exCell}</b></div>
          <div><span>문제 유형</span><b>{exType}</b></div>
          <div><span>현장 사진</span><b>{exPhoto ? "첨부 1장" : "없음"}</b></div>
        </div>
      </div>
      <div className="sticky-action dual">
        <button className="secondary" onClick={()=>{ setExSent(false); go(3); }}>위치도로</button>
        <button className="primary dark" onClick={openReassign}>수동 재배정</button>
      </div>
    </div>
  );

  // S-08 수동 재배정 — 문제 등록 완료에서 이어집니다.
  if (index === 7) return (
    <div className="phone-screen staff">
      <PhoneHeader title={reassign?.current?.itemId ? `#${reassign.current.itemId} 위치 변경` : "위치 변경"} back={()=>go(6)} staff/>
      <div className="screen-scroll bottom-space">
        <div className="ra-current">
          <div><span>현재 위치</span><b>{reassign?.current?.label ?? `${exCar} ${exCell}`}</b></div>
          <em>사용 불가</em>
        </div>

        {moved ? (
          <div className="notice blue" style={{ marginTop: 14 }}>
            <b>위치를 변경했습니다</b>
            <p>{reassign?.candidates.find((c)=>c.slotId===pickedSlot)?.label ?? pickedSlot}로 옮기도록 기록했습니다. 적재 체크리스트에서 확인하세요.</p>
          </div>
        ) : <>
          <div className="ra-head">
            <h3>AI 추천 위치</h3>
            <small>{reassignBusy ? "확인 중…" : "안전 조건 충족"}</small>
          </div>

          {reassignBusy && <div className="ra-skeleton"><i/><i/></div>}

          {!reassignBusy && (reassign?.recommendations.length
            ? reassign.recommendations.map((r) => (
                <button key={r.slotId} className={`ra-pick ${pickedSlot === r.slotId ? "on" : ""}`} onClick={()=>setPickedSlot(r.slotId)}>
                  <span className="ra-rank">{r.rank}순위</span>
                  <span className="ra-copy"><b>{r.label}</b><small>{r.reason}</small></span>
                  <i>{pickedSlot === r.slotId ? "●" : "○"}</i>
                </button>
              ))
            : <div className="notice"><b>옮길 수 있는 칸이 없습니다</b><p>같은 하차역 구간에 조건을 만족하는 빈 칸이 없어요. 다른 열차편이나 특송으로 처리해주세요.</p></div>)}

          {!reassignBusy && reassign && reassign.candidates.length > 0 && (
            <div className="ra-grid">
              {reassign.candidates
                .filter((c) => c.slotId.startsWith(`${exCar.replace("호차","")}-`))
                .map((c) => (
                  <button key={c.slotId} className={`ra-cell ${c.selectable ? "open" : "shut"} ${pickedSlot === c.slotId ? "on" : ""}`}
                    disabled={!c.selectable} onClick={()=>setPickedSlot(c.slotId)}>
                    <b>{c.slotId.split("-").slice(1).join("-")}</b>
                    <span>{c.selectable ? "선택 가능" : c.blockedReason}</span>
                  </button>
                ))}
            </div>
          )}

          <p className="ra-note">승객 배정 칸과 규격·무게가 맞지 않는 칸은 선택할 수 없습니다.</p>
        </>}
      </div>
      <div className="sticky-action">
        {moved
          ? <button className="primary dark" onClick={()=>go(5)}>적재 체크리스트로</button>
          : <button className="primary dark" disabled={!pickedSlot} style={!pickedSlot ? { opacity: .4 } : undefined} onClick={applyMove}>선택한 위치로 변경</button>}
      </div>
    </div>
  );

  return (
    <div className="phone-screen staff">
      <PhoneHeader title="현장 문제 등록" back={()=>go(4)} staff/>
      <div className="screen-scroll bottom-space">
        <section className="ex-loc">
          <div className="ex-loc-head"><span>발생 위치</span><b>{exCar} · {rackOf(exCar)} 보관대 · {exCell}</b></div>
          <div className="ex-selects">
            <label>
              <span>호차</span>
              <select value={exCar} onChange={(e)=>pickExCar(e.target.value)}>
                {RACK_CARS.map(([c]) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>
              <span>칸 번호</span>
              <select value={exCell} onChange={(e)=>setExCell(e.target.value)}>
                {Array.from({ length: SLOTS_PER_CAR }, (_, i) => `${rackOf(exCar)}-${String(i + 1).padStart(2, "0")}`)
                  .map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          </div>
        </section>

        <h3 className="ex-title">문제 유형</h3>
        <div className="radio-list">
          {ISSUE_TYPES.map((t) => (
            <button key={t} className={exType === t ? "selected" : ""} onClick={()=>setExType(t)}>
              <span>{exType === t ? "●" : "○"}</span>{t}
            </button>
          ))}
        </div>

        <h3 className="ex-title">현장 사진 <em>선택</em></h3>
        {exPhoto
          ? <div className="ex-photo"><img src={exPhoto} alt="현장 사진"/><button onClick={()=>exFileRef.current?.click()}>다시 첨부</button></div>
          : <button className="ex-drop" onClick={()=>exFileRef.current?.click()}><i>+</i><b>문제 상황 사진 첨부</b></button>}
        <p className="ex-hint">정상 적재 확인 사진은 필요하지 않습니다.</p>

        <h3 className="ex-title">메모</h3>
        <textarea value={exMemo} onChange={(e)=>setExMemo(e.target.value)} placeholder={`${exCell}에 미등록 검은색 캐리어가 있음`}/>
        <input ref={exFileRef} type="file" accept="image/*" hidden onChange={onPickExPhoto}/>
      </div>
      <div className="sticky-action">
        <button className="primary dark" onClick={()=>setExSent(true)}>문제 등록하기</button>
      </div>
    </div>
  );
}
function Metric({ icon,label,value,note,warn }: {icon:IconName;label:string;value:string;note:string;warn?:boolean}) { return <div className={`metric-card ${warn?"warn":""}`}><Icon name={icon}/><span>{label}</span><b>{value}</b><small>{note}</small></div>; }

export default function Home() {
  const [mode, setMode] = useState<Mode>("passenger");
  const [screen, setScreen] = useState(0);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeKey, setActiveKey] = useState("");
  /** 출발 30분 전 배정이 시작됐는가 (시연 트리거) */
  const [allocated, setAllocated] = useState(false);
  // P-03 입력 폼 — 현재 보고 있는 승차권의 초안입니다.
  const [dest, setDest] = useState("부산");
  const [size, setSize] = useState<SizeKey>("xlarge");
  const [weight, setWeight] = useState<WeightKey>("10to20");
  const [count, setCount] = useState(1);
  const [dims, setDims] = useState<Dims>(DEFAULT_DIMS);

  const ticket = tickets.find((t) => t.key === activeKey) ?? null;
  const registered = Boolean(ticket && ticket.bag);

  /** 새 승차권 발권 — key와 좌석을 부여하고 폼을 초기화합니다. */
  const issueTicket = () => {
    const key = makeTicketKey(tickets.map((t) => t.key));
    const seat = SEAT_POOL[tickets.length % SEAT_POOL.length];
    setTickets((prev) => [...prev, { key, dest, seatCar: seat.car, seat: seat.seat, bag: null, label: null, photo: null }]);
    setActiveKey(key);
    setSize("xlarge"); setWeight("10to20"); setCount(1); setDims(DEFAULT_DIMS);
    return key;
  };

  /** key로 승차권을 불러옵니다. 없으면 false. */
  const openTicket = (key: string) => {
    const found = tickets.find((t) => t.key === key.trim().toUpperCase());
    if (!found) return false;
    setActiveKey(found.key);
    setDest(found.dest);
    return true;
  };

  /** 현재 승차권에 수하물을 등록합니다. */
  const registerBag = (photo: string | null = null) => {
    if (!ticket) return;
    const spec = bagSpec(size, weight, count, dims);
    const label = bagLabel(size, weight, count, dims);
    setTickets((prev) => prev.map((t) => (t.key === ticket.key ? { ...t, dest, bag: spec, label, photo } : t)));
  };

  const cancelBag = () => {
    if (!ticket) return;
    setTickets((prev) => prev.map((t) => (t.key === ticket.key ? { ...t, bag: null, label: null, photo: null } : t)));
  };
  const list = mode === "passenger" ? passengerScreens : staffScreens;
  const current = list[screen];
  const switchMode = (next: Mode) => { setMode(next); setScreen(0); };
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__jimkkok = {
      activeKey,
      allocated,
      passengers: tickets
        .filter((t) => t.bag)
        .map((t) => ({ key: t.key, dest: t.dest, seatCar: t.seatCar, seat: t.seat, photo: t.photo, ...t.bag! })),
      // 짐 목록이 바뀌면 app.js가 이걸 불러 배정 전 상태로 되돌립니다.
      // 30분 전 트리거를 다시 눌러야 새 목록으로 배정됩니다.
      setAllocated,
    };
  }, [tickets, activeKey, allocated]);
  const progress = useMemo(() => `${screen + 1} / ${list.length}`, [screen, list.length]);

  return (
    <main className="prototype-shell">
      <header className="site-topbar">
        <div className="brand"><span>KTX</span><div><b>수하물 안심배정</b><small>화면기획서 v1.0 · 독립 프로토타입</small></div></div>
        <div className="mode-switch" role="tablist" aria-label="사용자 모드">
          <button className={mode === "passenger" ? "active" : ""} onClick={() => switchMode("passenger")}>승객용</button>
          <button className={mode === "staff" ? "active" : ""} onClick={() => switchMode("staff")}>역무원용</button>
        </div>
        <div className="prototype-status"><i></i> 발표·시연용</div>
      </header>

      <section className="workspace">
        <aside className="screen-nav">
          <div className="nav-heading"><span>{mode === "passenger" ? "PASSENGER" : "STATION STAFF"}</span><h2>{mode === "passenger" ? "승객 화면 흐름" : "역무원 화면 흐름"}</h2><p>{mode === "passenger" ? "본인의 수하물 정보와 위치만 표시합니다." : "승객·특송·여유 공간의 전체 운영 상태를 표시합니다."}</p></div>
          <div className="screen-list">{list.map(([id, name], i) => <button key={id} className={screen === i ? "active" : ""} onClick={() => setScreen(i)}><span>{id}</span><b>{name}</b><em>{screen === i ? "●" : "›"}</em></button>)}</div>
          <div className="principle-card"><Icon name={mode === "passenger" ? "shield" : "sparkle"}/><p>{mode === "passenger" ? <><b>개인정보 보호</b><br/>다른 승객·특송·빈 공간은 보이지 않아요.</> : <><b>AI는 제안, 확정은 역무원</b><br/>충돌과 사용 불가 위치를 검토한 뒤 확정해요.</>}</p></div>
        </aside>

        <div className="device-stage">
          <div className="stage-label"><span>{current[0]}</span><h1>{current[1]}</h1><p>{progress}</p></div>
          <div className="phone-frame"><div className="phone-notch"></div>{mode === "passenger" ? <PassengerScreen index={screen} go={setScreen} dest={dest} setDest={setDest} size={size} setSize={setSize} weight={weight} setWeight={setWeight} count={count} setCount={setCount} dims={dims} setDims={setDims} registered={registered} ticket={ticket} tickets={tickets} issueTicket={issueTicket} openTicket={openTicket} registerBag={registerBag} cancelBag={cancelBag} allocated={allocated} setAllocated={setAllocated}/> : <StaffScreen index={screen} go={setScreen} dest={dest}/>}</div>
          <div className="stage-controls"><button disabled={screen===0} onClick={()=>setScreen(s=>Math.max(0,s-1))}>← 이전 화면</button><span>{list.map((_,i)=><i key={i} className={screen===i?"active":""}></i>)}</span><button disabled={screen===list.length-1} onClick={()=>setScreen(s=>Math.min(list.length-1,s+1))}>다음 화면 →</button></div>
        </div>

        <aside className="flow-note">
          <span className="note-number">{current[0]}</span><h2>{current[1]}</h2><p>{mode === "passenger" ? passengerDescriptions[screen] : staffDescriptions[screen]}</p>
          <div className="note-rule"><b>화면 적용 원칙</b><p>{mode === "passenger" ? "승객에게는 본인의 승차권·수하물 정보만 제공합니다." : "이름 대신 좌석 번호만 표시하고, 정상 상황에서는 현장 사진을 요구하지 않습니다."}</p></div>
          <div className="flow-diagram"><span>승객 선배정</span><i>↓</i><span>잔여 공간 계산</span><i>↓</i><span>특송 후배정</span></div>
        </aside>
      </section>
    </main>
  );
}

const passengerDescriptions = [
  "출발역 서울에서 도착역을 고르고, 시연 대상 열차편을 선택해 예매하는 진입 화면입니다.",
  "코레일톡 승차권 상세에서 대형 수하물 사전등록 기능을 발견하는 진입 화면입니다.",
  "등록이 필요한 짐과 등록 마감 시각, 이용 시 유의사항을 확인합니다.",
  "수하물 크기·무게·식별용 사진을 입력합니다.",
  "AI 규격 확인 결과와 배정 기준을 이해한 뒤 최종 등록합니다.",
  "등록 완료 상태와 위치 안내 예정 시각을 확인하고 마감 전 정보를 관리합니다.",
  "출발 30분 전 객차·보관대·칸 번호를 가장 크게 안내합니다.",
  "좌석에서 보관대까지의 경로와 사물함형 위치도를 탭으로 확인합니다.",
  "역무원의 확인 요청이 있을 때만 제시하는 수하물 QR 확인증입니다.",
  "등록 마감 전 정보를 수정하거나 등록을 취소합니다.",
  "배정 칸 점유·파손 등의 문제를 선택해 담당 승무원에게 도움을 요청합니다.",
  "규격 초과로 일반 보관대를 쓸 수 없는 짐을 외부 특송 서비스로 연결합니다.",
];
const staffDescriptions = [
  "오늘 담당하는 열차와 등록·특송 현황을 한눈에 확인합니다.",
  "승객 수하물, 특송 적재 가능 공간, 확인 필요 건수를 봅니다.",
  "AI 배정의 검증 결과와 시도 기록을 확인하고 역무원이 최종 확정합니다.",
  "호차별 보관대(7호차 A · 9호차 B · 12호차 C · 14호차 D)의 칸 상태를 봅니다.",
  "선택한 칸의 좌석·하차역·규격 등 업무상 필요한 정보만 봅니다.",
  "AI 배치 결과로 만든 적재 체크리스트입니다. 실을 때마다 체크합니다.",
  "현장에서 발견한 문제를 발생 위치·유형·사진·메모로 등록합니다.",
  "사용할 수 없게 된 칸의 대체 위치를 AI가 순위로 제안하고 역무원이 확정합니다.",
];
