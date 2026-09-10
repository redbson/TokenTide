import { useMemo } from "react";
import { PROVIDER_META, formatPercent } from "./usage-format.js";
import {
  FULL_WEEK_PERCENT,
  STAT_RANGES,
  buildHeatmap,
  compareToBook,
  formatHour,
  formatModelName,
  formatMonthDay,
  formatShare,
  formatTokens,
  localDayKey,
  summarizeQuotaWeeks,
  summarizeStats,
  weekStart,
} from "./stats-format.js";

const HEATMAP_WEEKS = 26;

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function StatCard({ label, value, detail, compact }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <strong className={compact ? "is-compact" : ""} title={typeof value === "string" ? value : undefined}>
        {value}
        {detail ? <small>{detail}</small> : null}
      </strong>
    </div>
  );
}

function Heatmap({ days, start, today }) {
  const { columns } = useMemo(() => buildHeatmap(days, today, HEATMAP_WEEKS), [days, today]);
  return (
    <div className="heatmap-block">
      <div
        className="heatmap"
        style={{ gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`最近 ${HEATMAP_WEEKS} 周每日 token 用量`}
      >
        {columns.map((cells) =>
          cells.map((cell) => (
            <span
              key={cell.date}
              className={`heat-cell level-${cell.level} ${cell.future ? "is-future" : ""} ${cell.date < start ? "is-outside" : ""}`}
              title={cell.future ? undefined : `${cell.date} · ${formatTokens(cell.tokens)} tokens · ${cell.sessions} 次会话`}
            />
          )),
        )}
      </div>
      <div className="heatmap-legend">
        <span>最近 {HEATMAP_WEEKS} 周</span>
        <span className="legend-scale" aria-hidden="true">
          少
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`heat-cell level-${level}`} />
          ))}
          多
        </span>
      </div>
    </div>
  );
}

function ModelList({ models }) {
  if (models.length === 0) return <p className="stats-empty">这段时间没有模型用量。</p>;
  return (
    <ul className="model-list">
      {models.slice(0, 6).map(({ model, tokens, share }) => (
        <li key={model}>
          <div className="model-row">
            <span className="model-name">{formatModelName(model)}</span>
            <span className="model-tokens">
              {formatTokens(tokens)} · {formatShare(share)}
            </span>
          </div>
          <div className="model-bar">
            <span style={{ width: `${Math.max(2, share * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuotaBars({ weeks, current, average }) {
  const bars = current ? [...weeks, { ...current, isCurrent: true }] : weeks;
  const period = (window) => `${formatMonthDay(weekStart(window))}–${formatMonthDay(window.resetsAt)}`;
  return (
    <div className="quota-chart">
      <div className={`quota-bars ${bars.length > 30 ? "is-dense" : ""}`} role="img" aria-label="每周额度使用率">
        {average !== null ? (
          <div className="quota-average" style={{ bottom: `${average}%` }}>
            <span>平均 {formatPercent(average)}</span>
          </div>
        ) : null}
        {bars.map((window) => (
          <span
            key={window.resetsAt}
            className={`quota-bar ${window.isCurrent ? "is-current" : ""} ${window.estimated ? "is-estimated" : ""} ${window.usedPercent >= FULL_WEEK_PERCENT ? "is-full" : ""}`}
            title={`${period(window)} · ${window.estimated ? "估算约 " : "已用 "}${formatPercent(window.usedPercent)}${window.isCurrent ? "（进行中）" : ""}`}
          >
            <span style={{ height: `${Math.max(window.usedPercent, 1.5)}%` }} />
          </span>
        ))}
      </div>
      <div className="quota-axis">
        <span>{bars.length ? formatMonthDay(weekStart(bars[0])) : ""}</span>
        <span>{current ? "本周" : bars.length ? formatMonthDay(bars.at(-1).resetsAt) : ""}</span>
      </div>
    </div>
  );
}

function QuotaUsage({ windows, estimate, provider, range }) {
  const summary = useMemo(() => summarizeQuotaWeeks(windows, range), [windows, range]);
  if (windows.length === 0) {
    return <p className="stats-empty">还没有记录到每周额度，TokenTide 每次刷新都会记一次。</p>;
  }

  let source = `来自 Codex 会话记录，最早从 ${formatMonthDay(summary.since)} 起。`;
  if (provider === "claude") {
    source = `Claude Code 不在本机保存历史额度，TokenTide 从 ${formatMonthDay(summary.recordedSince)} 开始记录。`;
    if (estimate) {
      source +=
        `更早的周（空心柱）按本机 Claude Code 的用量估算，用已记录的 ${estimate.calibrationWeeks} 周校准；` +
        "claude.ai 网页、App 和其他电脑的用量不在本机，估算偏低。";
    }
  }
  // "≈" marks figures that include estimated weeks.
  const approx = (estimated, text) => (estimated && text !== "—" ? `≈${text}` : text);
  return (
    <>
      <div className="stat-grid">
        <StatCard label="平均使用率" value={approx(summary.estimatedWeeks > 0, formatPercent(summary.average))} />
        <StatCard label="最高一周" value={approx(summary.peakEstimated, formatPercent(summary.peak))} />
        <StatCard
          label="用满"
          value={approx(summary.fullWeeksEstimated, String(summary.fullWeeks))}
          detail={`/${summary.weeks.length} 周`}
        />
        <StatCard label="本周已用" value={formatPercent(summary.current?.usedPercent)} />
      </div>
      {summary.weeks.length || summary.current ? (
        <QuotaBars weeks={summary.weeks} current={summary.current} average={summary.average} />
      ) : null}
      <p className="quota-note">
        {summary.weeks.length
          ? summary.estimatedWeeks
            ? `已结束的 ${summary.weeks.length} 个周期，其中 ${summary.estimatedWeeks} 个为估算。`
            : `已结束的 ${summary.weeks.length} 个周期，每个周期取重置前记录到的最高使用率。`
          : "这段时间内还没有结束的周期。"}
        {source}
      </p>
    </>
  );
}

export function UsageStats({ stats, error, provider, range, view, onChange }) {
  const today = localDayKey();
  const providerStats = stats?.providers.find((item) => item.id === provider);
  const days = useMemo(() => providerStats?.days ?? [], [providerStats]);
  const quotaWeeks = useMemo(() => providerStats?.quotaWeeks ?? [], [providerStats]);
  const summary = useMemo(() => summarizeStats(days, range, today), [days, range, today]);

  let body;
  if (error && !stats) {
    body = <p className="stats-empty">{error}</p>;
  } else if (!stats) {
    body = <p className="stats-empty">正在统计本机记录…</p>;
  } else if (view === "quota") {
    body = <QuotaUsage windows={quotaWeeks} estimate={providerStats?.quotaEstimate} provider={provider} range={range} />;
  } else if (days.length === 0) {
    body = <p className="stats-empty">本机还没有 {PROVIDER_META[provider].name} 的使用记录。</p>;
  } else if (view === "models") {
    body = <ModelList models={summary.models} />;
  } else {
    const fact = compareToBook(summary.io, `${today}:${provider}:${range}`);
    body = (
      <>
        <div className="stat-grid">
          <StatCard label="会话" value={summary.sessions.toLocaleString()} />
          <StatCard label="消息" value={summary.messages.toLocaleString()} />
          <StatCard label="总 Tokens" value={formatTokens(summary.tokens)} />
          <StatCard label="活跃天数" value={summary.activeDays} detail={`/${summary.totalDays}`} />
          <StatCard label="当前连续" value={`${summary.currentStreak} 天`} />
          <StatCard label="最长连续" value={`${summary.longestStreak} 天`} />
          <StatCard label="高峰时段" value={formatHour(summary.peakHour)} />
          <StatCard label="常用模型" value={formatModelName(summary.favoriteModel)} compact />
        </div>
        <Heatmap days={days} start={summary.start} today={today} />
        {fact ? <p className="stats-fact">{fact}</p> : null}
      </>
    );
  }

  return (
    <section className={`usage-stats stats-${provider}`} aria-label="使用记录">
      <div className="stats-providers" role="tablist" aria-label="服务">
        {Object.entries(PROVIDER_META).map(([id, meta]) => (
          <button key={id} type="button" role="tab" aria-selected={provider === id} onClick={() => onChange("statsProvider", id)}>
            <img src={meta.icon} alt="" />
            {meta.name}
          </button>
        ))}
      </div>
      <div className="stats-toolbar">
        <Segmented
          label="视图"
          options={[
            ["overview", "概览"],
            ["models", "模型"],
            ["quota", "使用率"],
          ]}
          value={view}
          onChange={(value) => onChange("statsView", value)}
        />
        <Segmented label="时间范围" options={STAT_RANGES} value={range} onChange={(value) => onChange("statsRange", value)} />
      </div>
      {body}
    </section>
  );
}
