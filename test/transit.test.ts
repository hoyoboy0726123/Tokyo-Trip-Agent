// 用實際查到的東京資料（要町附近 → 舞浜，2026-10-20）測試精簡邏輯：node --test test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compactPlan, jstTime, jstToUtcIso, parseLatLon } from "../src/transit.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tokyo-kanamecho-maihama.json", import.meta.url), "utf8"));

test("時間換成東京時間（+9 小時）", () => {
  assert.equal(jstTime("2026-10-20T08:16:00Z"), "17:16");
  assert.equal(jstToUtcIso("2026-10-21T08:30"), "2026-10-20T23:30:00.000Z");
  assert.equal(jstToUtcIso("明天"), null);
});

test("有取消段落的路線會被排除", () => {
  const out = compactPlan(fixture);
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => !o.legs.some((l) => l.line?.includes("ディズニーリゾートライン"))));
});

test("路線名稱：清楚的名字去掉英文、只有數字代碼的改成業者＋方向", () => {
  const out = compactPlan(fixture);
  const names = out.flatMap((o) => o.legs.filter((l) => l.kind === "ride").map((l) => l.line));
  assert.ok(names.includes("西武池袋線"));
  assert.ok(names.includes("東京メトロ丸ノ内線"));
  assert.ok(names.includes("JR京葉線"));
  assert.ok(names.includes("東京メトロ（往荻窪）"));
  assert.ok(!names.some((n) => /\d{5,}/.test(n ?? "")), `不能出現數字代碼：${names}`);
});

test("站名、方向去掉重複英文", () => {
  const legs = compactPlan(fixture).flatMap((o) => o.legs);
  assert.ok(legs.some((l) => l.from === "椎名町"));
  assert.ok(legs.some((l) => l.direction === "蘇我"));
  assert.ok(legs.some((l) => l.to === "目的地"));
});

test("整體摘要：東京時間、轉乘次數、第一段步行太長會提醒", () => {
  const [first] = compactPlan(fixture);
  assert.equal(first.depart, "17:16");
  assert.equal(first.arrive, "18:29");
  assert.equal(first.minutes, 73);
  assert.equal(first.transfers, 2);
  assert.match(first.note ?? "", /走 13 分鐘/);
  // 同一站內 0 公尺的步行要合併掉
  assert.ok(!first.legs.some((l) => l.kind === "walk" && l.walk_m === 0));
  assert.equal(first.legs.find((l) => l.line === "西武池袋線")?.realtime, true);
});

test("精簡後資料夠小，適合交給 AI", () => {
  assert.ok(JSON.stringify(compactPlan(fixture)).length < 3000);
});

test("座標字串", () => {
  assert.deepEqual(parseLatLon("35.7345, 139.6925"), { lat: 35.7345, lon: 139.6925 });
  assert.equal(parseLatLon("池袋站"), null);
});
