/**
 * SPA 진입점.
 *
 * 팀원이 만든 UI(app/page.tsx)를 그대로 마운트하기만 합니다.
 * 마크업·클래스명·스타일은 여기서 일절 건드리지 않습니다.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import Home from "../app/page";
import "../app/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root 엘리먼트를 찾지 못했습니다. index.html을 확인하세요.");
}

createRoot(container).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
