import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // Vercel의 Vite 프리셋이 기본으로 찾는 출력 폴더
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // app/page.tsx 첫 줄의 "use client"는 Next 전용 지시어입니다.
        // 번들러에는 의미가 없고 SPA에서는 무해하므로 경고를 숨깁니다.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
