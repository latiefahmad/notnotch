import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and shouldn't watch the Rust files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // More pages: the detached timer window and the copies of the closed notch on other monitors.
  build: { rollupOptions: { input: { main: "index.html", timer: "timer.html", mirror: "mirror.html" } } },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target-shared/**", "**/.claude/**"] },
  },
});
