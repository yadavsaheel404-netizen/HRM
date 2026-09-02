import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  plugins: [],
  nitro: {
    preset: process.env.VERCEL ? "vercel" : "node-server",
  },
});
