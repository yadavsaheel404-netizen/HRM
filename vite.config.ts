import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  plugins: [],
  nitro: {
    preset: process.env.VERCEL ? "vercel" : "node-server",
    hooks: {
      compiled: async (nitro) => {
        const outputDir = nitro.options.output.serverDir || path.resolve(".vercel/output/functions/__server.func");
        if (!fs.existsSync(outputDir)) return;
        
        function patchDir(dir: string) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              patchDir(fullPath);
            } else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
              let content = fs.readFileSync(fullPath, "utf8");
              if (content.includes("var __exportAll = (all, no_symbols) =>")) {
                content = content.replace(
                  /var __exportAll = \(all, no_symbols\) =>/g,
                  "function __exportAll(all, no_symbols)"
                );
                fs.writeFileSync(fullPath, content, "utf8");
              }
            }
          }
        }
        
        patchDir(outputDir);

        if (process.env.VERCEL) {
          const vercelDir = path.resolve(".vercel/output");
          if (fs.existsSync(vercelDir)) {
            const configJsonPath = path.join(vercelDir, "config.json");
            if (!fs.existsSync(configJsonPath)) {
              fs.writeFileSync(
                configJsonPath,
                JSON.stringify(
                  {
                    version: 3,
                    routes: [
                      { handle: "filesystem" },
                      { src: "/(.*)", dest: "/__server" },
                    ],
                  },
                  null,
                  2
                ),
                "utf8"
              );
            }

            const vcConfigPath = path.join(outputDir, ".vc-config.json");
            if (!fs.existsSync(vcConfigPath)) {
              fs.writeFileSync(
                vcConfigPath,
                JSON.stringify(
                  {
                    runtime: "nodejs22.x",
                    handler: "index.mjs",
                    launcherType: "Nodejs",
                  },
                  null,
                  2
                ),
                "utf8"
              );
            }
          }
        }
      },
    },
  },
});
