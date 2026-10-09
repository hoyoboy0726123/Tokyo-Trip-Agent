// 旅程的初始資料（範例）。複製成 src/trip-data.ts 再改成你們的旅程：
//   cp src/trip-data.example.ts src/trip-data.ts
// trip-data.ts 有住址、航班這些私人資料，不會進 git（見 .gitignore）。
// 第一次啟動時寫進資料庫，之後修改都存在資料庫（長期記憶）。
// 門鎖密碼、Wi-Fi 密碼等敏感資訊不寫在這裡，請在聊天中叫 AI「記住」。

export const TRIP = {
  title: "東京親子旅行（範例）",
  travelers: "2 大 2 小的台灣家庭",
  timezone: "Asia/Tokyo",
  startDate: "2026-10-03",
  endDate: "2026-10-07",
  accommodation: {
    name: "範例民宿（Airbnb）",
    address: "〒100-0005 東京都千代田区丸の内1-9-1",
    addressEn: "1-9-1 Marunouchi, Chiyoda-ku, Tokyo 100-0005",
    lat: 35.6812,
    lon: 139.7671,
    // 地圖、導航用：地區名稱、導航地址（不含郵遞區號與大樓名，Google 地圖最穩）、
    // 房源名稱等專有寫法（模型用這些搜尋常跑錯地方，系統會一律換成正確位置）
    area: "丸の内",
    navAddress: "東京都千代田区丸の内1-9-1",
    aliases: ["範例民宿"],
    nearestStation: "JR「東京站」丸之內北口，步行約 3 分",
    walkingRoute: "丸之內北口出站 → 直走過馬路 → 右手邊大樓",
    checkIn: "15:00",
    checkOut: "10:00",
    // 房東給的地圖連結；沒有就用地址的 Google 地圖搜尋連結
    googleMap: "https://www.google.com/maps/search/?api=1&query=%E6%9D%B1%E4%BA%AC%E9%A7%85",
    rules: ["全面禁菸", "晚上 10 點後請降低音量", "玄關脫鞋"],
  },
  flights: [
    { date: "2026-10-03", flight: "範例航空 XX101", from: "桃園 T2 09:00", to: "成田 T1 13:00" },
    { date: "2026-10-07", flight: "範例航空 XX102", from: "成田 T1 18:00", to: "桃園 T2 21:00" },
  ],
  airportRoutes: `成田機場 → 住宿：
- 推薦：成田特快 N'EX 到東京站（約 1 小時），出站後步行到住宿。
- 帶小孩行李多：到東京站後直接搭計程車。`,
};

export const INITIAL_ITINERARY: { date: string; title: string; detail: string; status: string }[] = [
  { date: "2026-10-03", title: "抵達成田 → 前往住宿", detail: "入住後在附近簡單逛逛", status: "住宿固定" },
  { date: "2026-10-04", title: "淺草、晴空塔", detail: "", status: "彈性" },
  { date: "2026-10-05", title: "東京迪士尼樂園 整天", detail: "", status: "⚠️ 尚未購票" },
  { date: "2026-10-06", title: "彈性／購物日", detail: "", status: "彈性" },
  { date: "2026-10-07", title: "最後採買 → 成田機場 → 返台", detail: "", status: "回程日" },
];

/** 預設清單（第一次啟動寫入，之後全家共用、可增刪勾選） */
export const DEFAULT_CHECKLIST: { list: string; item: string }[] = [
  { list: "行李", item: "護照（效期 6 個月以上）" },
  { list: "行李", item: "Visit Japan Web 入境 QR Code 截圖" },
  { list: "行李", item: "機票電子票證" },
  { list: "行李", item: "日圓現金" },
  { list: "行李", item: "信用卡" },
  { list: "行李", item: "Suica／PASMO 交通卡（或 iPhone 錢包）" },
  { list: "行李", item: "網卡／eSIM" },
  { list: "行李", item: "手機充電器、行動電源（放隨身行李）" },
  { list: "行李", item: "小孩常備藥、退燒藥、OK 繃" },
  { list: "行李", item: "折疊傘或雨衣" },
  { list: "行李", item: "好走的鞋" },
  { list: "待辦", item: "填 Visit Japan Web" },
];

/** 翻譯頁的預設常用句（第一次啟動寫入資料庫，之後全家共用、可新增刪除） */
export const DEFAULT_PHRASES: { category: string; zh: string; ja: string; kana: string }[] = [
  // 計程車：住宿與行程上的景點
  { category: "🚕 計程車", zh: "請載我們到這個地址（住宿）", ja: "ここまでお願いします。\n東京都千代田区丸の内1-9-1", kana: "ここまでおねがいします。とうきょうと ちよだく まるのうち いちのきゅうのいち" },
  { category: "🚕 計程車", zh: "請到東京迪士尼樂園", ja: "東京ディズニーランドまでお願いします。", kana: "とうきょうでぃずにーらんどまでおねがいします。" },
  { category: "🚕 計程車", zh: "我們有 4 個人和行李", ja: "4人と荷物があります。", kana: "よにんとにもつがあります。" },
  { category: "🚕 計程車", zh: "大概要多少錢？", ja: "だいたいいくらぐらいですか？", kana: "だいたいいくらぐらいですか？" },
  { category: "🚕 計程車", zh: "在這裡停就好", ja: "ここで止めてください。", kana: "ここでとめてください。" },
  // 餐廳
  { category: "🍜 餐廳", zh: "4 位，2 個大人 2 個小孩", ja: "4人です。大人2人と子ども2人です。", kana: "よにんです。おとなふたりとこどもふたりです。" },
  { category: "🍜 餐廳", zh: "有兒童座椅嗎？", ja: "子ども用の椅子はありますか？", kana: "こどもようのいすはありますか？" },
  { category: "🍜 餐廳", zh: "有中文或英文菜單嗎？", ja: "中国語か英語のメニューはありますか？", kana: "ちゅうごくごかえいごのめにゅーはありますか？" },
  { category: "🍜 餐廳", zh: "有兒童餐嗎？", ja: "お子様メニューはありますか？", kana: "おこさまめにゅーはありますか？" },
  { category: "🍜 餐廳", zh: "我要這個", ja: "これをください。", kana: "これをください。" },
  { category: "🍜 餐廳", zh: "請不要做辣", ja: "辛くしないでください。", kana: "からくしないでください。" },
  { category: "🍜 餐廳", zh: "大概要等多久？", ja: "どのくらい待ちますか？", kana: "どのくらいまちますか？" },
  { category: "🍜 餐廳", zh: "可以外帶嗎？", ja: "持ち帰りできますか？", kana: "もちかえりできますか？" },
  { category: "🍜 餐廳", zh: "請結帳", ja: "お会計をお願いします。", kana: "おかいけいをおねがいします。" },
  // 購物
  { category: "🛍 購物", zh: "可以免稅嗎？", ja: "免税できますか？", kana: "めんぜいできますか？" },
  { category: "🛍 購物", zh: "這個多少錢？", ja: "これはいくらですか？", kana: "これはいくらですか？" },
  { category: "🛍 購物", zh: "可以刷卡嗎？", ja: "カードは使えますか？", kana: "かーどはつかえますか？" },
  { category: "🛍 購物", zh: "有其他尺寸嗎？", ja: "ほかのサイズはありますか？", kana: "ほかのさいずはありますか？" },
  { category: "🛍 購物", zh: "不用袋子", ja: "袋はいりません。", kana: "ふくろはいりません。" },
  // 緊急與常用
  { category: "🆘 緊急／常用", zh: "廁所在哪裡？", ja: "トイレはどこですか？", kana: "といれはどこですか？" },
  { category: "🆘 緊急／常用", zh: "我聽不懂日文", ja: "日本語がわかりません。", kana: "にほんごがわかりません。" },
  { category: "🆘 緊急／常用", zh: "請說慢一點", ja: "もう少しゆっくり話してください。", kana: "もうすこしゆっくりはなしてください。" },
  { category: "🆘 緊急／常用", zh: "小孩走失了，請幫忙", ja: "子どもが迷子になりました。助けてください。", kana: "こどもがまいごになりました。たすけてください。" },
  { category: "🆘 緊急／常用", zh: "附近有醫院嗎？", ja: "近くに病院はありますか？", kana: "ちかくにびょういんはありますか？" },
  { category: "🆘 緊急／常用", zh: "請叫救護車", ja: "救急車を呼んでください。", kana: "きゅうきゅうしゃをよんでください。" },
];
