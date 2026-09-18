import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { runtimeGatewayPlugin } from "./server/vite-plugin.ts";

// The native shell loads dist/ over file://, where WKWebView refuses
// ES-module scripts (opaque "null" origin, CORS). Emit a classic bundle
// and rewrite the entry tag to a deferred classic script.
const shellFileCompat: Plugin = {
  name: "shell-file-compat",
  apply: "build",
  transformIndexHtml(html) {
    return html
      .replace(/<script([^>]*)>/g, (tag, attrs: string) =>
        /type="module"/.test(attrs)
          ? `<script${attrs.replace(/\s*type="module"/, "").replace(/\s*crossorigin(="[^"]*")?/g, "")} defer>`
          : tag,
      )
      .replace(/\s+crossorigin(?=[\s>])/g, "");
  },
};

export default defineConfig({
  plugins: [react(), runtimeGatewayPlugin(), shellFileCompat],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The native shell loads dist/ over file://, where WKWebView refuses
    // ES-module scripts (opaque "null" origin, CORS). Emit a classic bundle.
    modulePreload: false,
    rollupOptions: { output: { format: "iife" } },
  },
});

