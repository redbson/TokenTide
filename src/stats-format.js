export const STAT_RANGES = [
  ["all", "全部"],
  ["90d", "90 天"],
  ["30d", "30 天"],
  ["7d", "7 天"],
];

const RANGE_DAYS = { "90d": 90, "30d": 30, "7d": 7 };
const DAY_MS = 86_400_000;

// Token counts of well-known books, as used by Claude Code's /stats.
const BOOKS = [
  ["小王子", 22_000],
  ["老人与海", 35_000],
  ["圣诞颂歌", 37_000],
  ["动物农场", 39_000],
  ["华氏 451", 60_000],
  ["了不起的盖茨比", 62_000],
  ["五号屠场", 64_000],
  ["美丽新世界", 83_000],
  ["麦田里的守望者", 95_000],
  ["哈利·波特与魔法石", 103_000],
  ["霍比特人", 123_000],
  ["1984", 123_000],
  ["杀死一只知更鸟", 130_000],
  ["傲慢与偏见", 156_000],
  ["沙丘", 244_000],
  ["白鲸", 268_000],
  ["罪与罚", 274_000],
  ["权力的游戏", 381_000],
  ["安娜·卡列尼娜", 468_000],
  ["堂吉诃德", 520_000],
  ["指环王", 576_000],
  ["基督山伯爵", 603_000],
  ["悲惨世界", 689_000],
  ["战争与和平", 730_000],
];

const pad = (value) => String(value).padStart(2, "0");

export function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateOf(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function addDays(key, amount) {
  const date = dateOf(key);
  date.setDate(date.getDate() + amount);
  return localDayKey(date);
}

function daysBetween(from, to) {
  return Math.round((dateOf(to) - dateOf(from)) / DAY_MS);
}

const isActive = (day) => day.sessions > 0 || day.messages > 0 || day.tokens > 0;

function rangeStart(range, days, today) {
  if (RANGE_DAYS[range]) return addDays(today, -(RANGE_DAYS[range] - 1));
  return days.find(isActive)?.date ?? today;
}

function currentStreak(activeDates, today) {
  // Today may simply not have started yet; a streak through yesterday still counts.
  let cursor = activeDates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (activeDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function longestStreak(activeDates, start, today) {
  let longest = 0;
  let run = 0;
  for (let cursor = start; cursor <= today; cursor = addDays(cursor, 1)) {
    run = activeDates.has(cursor) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Totals, streaks, peak hour, and model shares for one provider over a range. */
export function summarizeStats(days, range, today = localDayKey()) {
  const start = rangeStart(range, days, today);
  const inRange = days.filter((day) => day.date >= start && day.date <= today);
  const hours = {};
  const models = {};
  const totals = { sessions: 0, messages: 0, tokens: 0, io: 0 };

  for (const day of inRange) {
    totals.sessions += day.sessions;
    totals.messages += day.messages;
    totals.tokens += day.tokens;
    totals.io += day.io;
    for (const [hour, value] of Object.entries(day.hours ?? {})) hours[hour] = (hours[hour] ?? 0) + value;
    for (const [model, value] of Object.entries(day.models ?? {})) models[model] = (models[model] ?? 0) + value;
  }

  const peak = Object.entries(hours).sort(([hourA, a], [hourB, b]) => b - a || hourA - hourB)[0];
  const modelList = Object.entries(models)
    .filter(([, tokens]) => tokens > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([model, tokens]) => ({ model, tokens, share: totals.tokens > 0 ? tokens / totals.tokens : 0 }));

  const activeInRange = new Set(inRange.filter(isActive).map((day) => day.date));
  const activeAll = new Set(days.filter(isActive).map((day) => day.date));

  return {
    ...totals,
    activeDays: activeInRange.size,
    totalDays: daysBetween(start, today) + 1,
    currentStreak: currentStreak(activeAll, today),
    longestStreak: longestStreak(activeInRange, start, today),
    peakHour: peak ? Number(peak[0]) : null,
    favoriteModel: modelList[0]?.model ?? null,
    models: modelList,
    start,
  };
}

// A weekly window at or above this counts as having used up its quota.
export const FULL_WEEK_PERCENT = 99.5;
const WEEK_SECONDS = 7 * 86_400;

/**
 * Weekly quota utilization for one provider. `windows` come from the stats service (oldest
 * first); each is one weekly window with the highest usage seen before it reset, or an
 * estimate (`estimated: true`). Averages use windows that ended inside the range; the open
 * window is reported as `current`.
 */
export function summarizeQuotaWeeks(windows = [], range = "all", now = Date.now()) {
  const nowSeconds = now / 1000;
  const cutoff = RANGE_DAYS[range] ? nowSeconds - RANGE_DAYS[range] * 86_400 : -Infinity;
  const weeks = windows.filter((window) => window.resetsAt <= nowSeconds && window.resetsAt > cutoff);
  // Several accounts can each have an open window; the most recently seen one is "this week".
  const current =
    windows.filter((window) => window.resetsAt > nowSeconds).sort((a, b) => b.lastAt - a.lastAt)[0] ?? null;
  const values = weeks.map((window) => window.usedPercent);
  const peak = values.length ? Math.max(...values) : null;
  const fullWeeks = weeks.filter((window) => window.usedPercent >= FULL_WEEK_PERCENT);

  return {
    weeks,
    current,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    peak,
    fullWeeks: fullWeeks.length,
    estimatedWeeks: weeks.filter((window) => window.estimated).length,
    peakEstimated: peak !== null && !weeks.some((window) => !window.estimated && window.usedPercent === peak),
    fullWeeksEstimated: fullWeeks.some((window) => window.estimated),
    since: windows.length ? windows[0].resetsAt - WEEK_SECONDS : null,
    // When recording started; estimated weeks are not recordings.
    recordedSince: windows.some((window) => !window.estimated)
      ? Math.min(...windows.filter((window) => !window.estimated).map((window) => window.firstAt)) / 1000
      : null,
  };
}

export function weekStart(window) {
  return window.resetsAt - WEEK_SECONDS;
}

/** `9/16`, or `2025/11/6` outside the current year. */
export function formatMonthDay(seconds, now = new Date()) {
  const date = new Date(seconds * 1000);
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}/${monthDay}`;
}

/** GitHub-style grid: `weeks` columns (Monday first) ending with the current week. */
export function buildHeatmap(days, today = localDayKey(), weeks = 26) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const weekday = (dateOf(today).getDay() + 6) % 7;
  const first = addDays(today, -((weeks - 1) * 7 + weekday));
  const columns = [];
  const values = [];

  for (let column = 0; column < weeks; column += 1) {
    const cells = [];
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(first, column * 7 + row);
      const day = byDate.get(date);
      const cell = { date, tokens: day?.tokens ?? 0, sessions: day?.sessions ?? 0, future: date > today, level: 0 };
      if (!cell.future && cell.tokens > 0) values.push(cell.tokens);
      cells.push(cell);
    }
    columns.push(cells);
  }

  // Quartiles of the visible non-zero days set the four intensity levels.
  values.sort((a, b) => a - b);
  const quantile = (q) => values[Math.floor(q * (values.length - 1))];
  const thresholds = values.length ? [quantile(0.25), quantile(0.5), quantile(0.75)] : [];
  for (const cells of columns) {
    for (const cell of cells) {
      if (cell.future || cell.tokens <= 0) continue;
      cell.level = 1 + thresholds.filter((threshold) => cell.tokens > threshold).length;
    }
  }

  return { columns, first };
}

export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit}`;
    }
  }
  return String(Math.round(value));
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function formatModelName(model) {
  if (!model) return "—";
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) return `${capitalize(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = model.match(/^gpt-([\d.]+)(?:-(.+))?$/i);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split("-").map(capitalize).join(" ")}` : ""}`;
  return model;
}

export function formatShare(share) {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

export function formatHour(hour) {
  return hour === null ? "—" : `${pad(hour)}:00`;
}

/**
 * A book comparison for input + output tokens. Picks among the largest books the total
 * exceeds, so ratios stay readable; `seed` keeps the pick stable within a day.
 */
export function compareToBook(ioTokens, seed = "") {
  const qualifying = BOOKS.filter(([, tokens]) => ioTokens >= tokens).slice(-5);
  if (qualifying.length === 0) return null;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const [name, tokens] = qualifying[hash % qualifying.length];
  const ratio = ioTokens / tokens;
  return ratio >= 2
    ? `输入和输出约是《${name}》全书的 ${Math.floor(ratio)} 倍。`
    : `输入和输出大约相当于一本《${name}》。`;
}
