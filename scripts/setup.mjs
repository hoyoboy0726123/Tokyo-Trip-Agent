// 一鍵部署（Windows / Mac / Linux 通用）：登入 Cloudflare → 部署 → 設定密碼與 API 金鑰
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const run = (cmd, opts = {}) => spawnSync(cmd, { shell: true, stdio: "inherit", ...opts }).status === 0;
const quiet = (cmd) => spawnSync(cmd, { shell: true, stdio: "ignore" }).status === 0;
const step = (t) => console.log(`\n▶︎ ${t}`);

console.log("🗼 東京旅伴 部署精靈");

if (!existsSync("node_modules")) {
  step("安裝套件…");
  if (!run("npm install")) process.exit(1);
}

step("登入 Cloudflare（會打開瀏覽器，請按 Allow）");
if (!quiet("npx wrangler whoami") || spawnSync("npx wrangler whoami", { shell: true, encoding: "utf8" }).stdout.includes("not authenticated")) {
  if (!run("npx wrangler login")) process.exit(1);
}

step("部署到 Cloudflare");
if (!run("npx wrangler deploy")) process.exit(1);

const secrets = [
  ["ROOM_PASSWORD", "家人共用的房間密碼"],
  ["ADMIN_PASSWORD", "管理員密碼（只有你知道）"],
  ["GEMINI_API_KEY", "Gemini API key（Google AI Studio）"],
  ["TAVILY_API_KEY", "Tavily API key（網路搜尋）"],
];
step("設定密碼與金鑰（貼上後按 Enter；不想改的直接按 Ctrl+C 會跳過那一項）");
for (const [name, label] of secrets) {
  console.log(`\n🔑 ${label}`);
  if (!run(`npx wrangler secret put ${name}`)) console.log(`   ⏭  略過 ${name}`);
}

console.log("\n🎉 完成！打開上面部署顯示的 https://tokyo-trip-agent.<你的子網域>.workers.dev");
