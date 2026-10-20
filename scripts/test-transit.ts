// 在自己電腦實際打 Transitous 測東京路線：npm run test:transit
// （需要 Node.js 22.18 以上；只會發出幾次查詢）
import { transitGeocode, transitPlan, type LatLon } from "../src/transit.ts";

const HOME: LatLon = { lat: 35.7345, lon: 139.6925, name: "要町民宿" };
const trips: [string, string][] = [
  ["民宿", "舞浜駅"],
  ["民宿", "浅草駅"],
  ["民宿", "亀有駅"],
  ["新宿駅", "池袋駅"],
];

async function point(text: string): Promise<LatLon> {
  if (text === "民宿") return HOME;
  const p = await transitGeocode(text, HOME);
  if (!p) throw new Error(`找不到「${text}」`);
  return p;
}

for (const [a, b] of trips) {
  try {
    const [from, to] = [await point(a), await point(b)];
    const plans = await transitPlan(from, to);
    console.log(`\n=== ${a} → ${b}（${to.name ?? ""}）：${plans.length} 個方案`);
    for (const r of plans) {
      console.log(`\n  ${r.depart}→${r.arrive}（${r.minutes} 分，轉 ${r.transfers} 次）${r.note ? `⚠️ ${r.note}` : ""}`);
      for (const l of r.legs) {
        console.log(
          l.kind === "walk"
            ? `    🚶 ${l.from} → ${l.to}  ${l.minutes} 分 ${l.walk_m}m`
            : `    🚃 ${l.depart} ${l.from} 搭 ${l.line}（往${l.direction ?? "?"}，${l.stops} 站）→ ${l.arrive} ${l.to}${l.realtime ? " 🟢即時" : ""}`,
        );
      }
    }
  } catch (e: any) {
    console.log(`\n=== ${a} → ${b}：❌ ${e?.message ?? e}`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // 對 Transitous 客氣一點
}
