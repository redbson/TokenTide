import { useMemo, useState } from "react";
import { useI18n } from "./i18n-context.js";
import { PROVIDER_META, STATS_PROVIDERS, formatPercent } from "./usage-format.js";
import {
  FULL_WEEK_PERCENT,
  STAT_RANGES,
  buildHeatmap,
  compareToBook,
  formatCredits,
  formatDayKey,
  formatHour,
  formatModelName,
  formatMoney,
  formatMonthDay,
  formatClock,
  formatShare,
  formatTokens,
  localDayKey,
  summarizeBalance,
  summarizeCreditDays,
  summarizeCreditWeeks,
  summarizeQuotaWeeks,
  summarizeStats,
  summarizeThisWeek,
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

// Qoder reports credits instead of tokens, so its history is measured in credits.
const measureOf = (provider) => (provider === "qoder" ? "credits" : "tokens");
const formatMeasure = (measure, value) => (measure === "credits" ? formatCredits(value) : formatTokens(value));

function Heatmap({ days, start, today, measure }) {
  const { t } = useI18n();
  const { columns } = useMemo(() => buildHeatmap(days, today, HEATMAP_WEEKS, measure), [days, today, measure]);
  const credits = measure === "credits";
  return (
    <div className="heatmap-block">
      <div
        className="heatmap"
        style={{ gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))` }}
        role="img"
        aria-label={t(credits ? "heatmap.labelCredits" : "heatmap.label", { weeks: HEATMAP_WEEKS })}
      >
        {columns.map((cells) =>
          cells.map((cell) => (
            <span
              key={cell.date}
              className={`heat-cell level-${cell.level} ${cell.future ? "is-future" : ""} ${cell.date < start ? "is-outside" : ""}`}
              title={
                cell.future
                  ? undefined
                  : credits
                    ? t("heatmap.cellCredits", { date: cell.date, credits: formatCredits(cell.credits), count: cell.sessions })
                    : t("heatmap.cell", { date: cell.date, tokens: formatTokens(cell.tokens), count: cell.sessions })
              }
            />
          )),
        )}
      </div>
      <div className="heatmap-legend">
        <span>{t("heatmap.caption", { weeks: HEATMAP_WEEKS })}</span>
        <span className="legend-scale" aria-hidden="true">
          {t("heatmap.less")}
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`heat-cell level-${level}`} />
          ))}
          {t("heatmap.more")}
        </span>
      </div>
    </div>
  );
}

function ModelList({ models, measure }) {
  const { t } = useI18n();
  if (models.length === 0) return <p className="stats-empty">{t("stats.noModels")}</p>;
  return (
    <ul className="model-list">
      {models.slice(0, 6).map(({ model, amount, share }) => (
        <li key={model}>
          <div className="model-row">
            <span className="model-name">{formatModelName(model)}</span>
            <span className="model-tokens">
              {formatMeasure(measure, amount)}
              {measure === "credits" ? ` ${t("stats.creditsUnit")}` : ""} · {formatShare(share)}
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

// Bars for the 使用率 views. With a few bars (30 or 7 days) they spread across the width with a
// label under each; with many (90 days, all) they pack to the right with dates at both ends.
const SPARSE_BARS = 12;

function BarChart({ label, bars, average = null, axis = ["", ""], markLegend = null }) {
  const sparse = bars.length <= SPARSE_BARS;
  const dense = bars.length > 30;
  const columns = sparse ? { gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` } : undefined;
  const marked = Boolean(markLegend) && bars.some((bar) => bar.mark);
  return (
    <div className={`quota-chart ${sparse ? "is-sparse" : ""} ${sparse && bars.length > 6 ? "is-crowded" : ""} ${dense ? "is-dense" : ""}`}>
      {average || marked ? (
        <div className="quota-legend">
          {marked ? (
            <span className="quota-legend-item">
              <i className="quota-dot" aria-hidden="true" />
              {markLegend}
            </span>
          ) : null}
          {average ? (
            <span className="quota-legend-item">
              <i className="quota-dash" aria-hidden="true" />
              {average.text}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="quota-bars" style={columns} role="img" aria-label={label}>
        {average ? <div className="quota-average" style={{ bottom: `${Math.min(average.height, 100)}%` }} /> : null}
        {bars.map((bar) => (
          <span key={bar.key} className={`quota-bar ${bar.className ?? ""}`} title={bar.title}>
            {bar.projection ? (
              <span className="quota-projection" style={{ height: `${Math.min(bar.projection, 100)}%` }} />
            ) : null}
            <span className="quota-fill" style={{ height: `${bar.height}%` }} />
          </span>
        ))}
      </div>
      {/* A dot under each marked bar (weeks reset early), in the bars' own columns. */}
      {marked ? (
        <div className="quota-marks" style={columns} aria-hidden="true">
          {bars.map((bar) => (
            <span key={bar.key}>{bar.mark ? <i className="quota-dot" /> : null}</span>
          ))}
        </div>
      ) : null}
      {sparse ? (
        <div className="quota-labels" style={columns}>
          {bars.map((bar) => (
            <span key={bar.key} className={bar.isCurrent ? "is-current" : ""}>
              {bar.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="quota-axis">
          <span>{axis[0]}</span>
          <span>{axis[1]}</span>
        </div>
      )}
    </div>
  );
}

function windowBar(window, t, extra = {}) {
  // A week reset early ended when the next one began, not at its scheduled reset.
  const period = `${formatMonthDay(weekStart(window))}–${formatMonthDay(window.endedEarly ? window.endedAt : window.resetsAt)}`;
  const title =
    t(window.estimated ? "quota.barEstimated" : "quota.barUsed", { period, percent: formatPercent(window.usedPercent) }) +
    (window.endedEarly ? t("quota.barEarly", { scheduled: formatMonthDay(window.resetsAt) }) : "") +
    (window.isCurrent ? t("quota.barCurrent") : "");
  const classes = [
    window.isCurrent ? "is-current" : "",
    window.estimated ? "is-estimated" : "",
    window.usedPercent >= FULL_WEEK_PERCENT ? "is-full" : "",
  ];
  return {
    key: window.resetsAt,
    height: Math.max(window.usedPercent ?? 0, 1.5),
    className: classes.filter(Boolean).join(" "),
    title,
    label: window.isCurrent ? t("quota.thisWeek") : formatMonthDay(weekStart(window)),
    isCurrent: Boolean(window.isCurrent),
    mark: Boolean(window.endedEarly),
    ...extra,
  };
}

function QuotaBars({ weeks, current, average }) {
  const { t } = useI18n();
  const windows = current ? [...weeks, { ...current, isCurrent: true }] : weeks;
  return (
    <BarChart
      label={t("quota.chart")}
      bars={windows.map((window) => windowBar(window, t))}
      average={average !== null ? { height: average, text: t("quota.average", { percent: formatPercent(average) }) } : null}
      markLegend={t("quota.earlyReset")}
      axis={[
        windows.length ? formatMonthDay(weekStart(windows[0])) : "",
        current ? t("quota.thisWeek") : windows.length ? formatMonthDay(windows.at(-1).resetsAt) : "",
      ]}
    />
  );
}

// 7 days for Codex and Claude Code: this week against last week, and where this week is heading.
function QuotaWeekFocus({ windows }) {
  const { t } = useI18n();
  const { current, previous, elapsedDays, projected } = useMemo(() => summarizeThisWeek(windows), [windows]);
  if (!current && !previous) return <p className="stats-empty">{t("quota.empty")}</p>;
  const approx = (estimated, text) => (estimated && text !== "—" ? `≈${text}` : text);
  const bars = [];
  if (previous) bars.push(windowBar(previous, t, { label: t("quota.lastWeek") }));
  if (current) {
    bars.push(
      windowBar({ ...current, isCurrent: true }, t, {
        projection: projected,
        title: `${windowBar({ ...current, isCurrent: true }, t).title}${projected !== null ? ` · ${t("quota.projectionBar", { percent: formatPercent(projected) })}` : ""}`,
      }),
    );
  }
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("quota.currentLabel")} value={formatPercent(current?.usedPercent)} />
        <StatCard label={t("quota.projectedLabel")} value={projected === null ? "—" : `≈${formatPercent(projected)}`} />
        <StatCard label={t("quota.lastWeekLabel")} value={approx(previous?.estimated, formatPercent(previous?.usedPercent))} />
        <StatCard label={t("quota.resetLabel")} value={current ? formatMonthDay(current.resetsAt) : "—"} />
      </div>
      <BarChart label={t("quota.chart")} bars={bars} />
      <p className="quota-note">
        {current
          ? t("quota.weekNote", {
              days: elapsedDays.toFixed(1),
              reset: `${formatMonthDay(current.resetsAt)} ${formatClock(current.resetsAt)}`,
            })
          : t("quota.noteNone")}
      </p>
    </>
  );
}

function QuotaUsage({ windows, estimate, provider, range }) {
  const { t, language } = useI18n();
  // Chinese sentences run together; English ones need a space.
  const gap = language === "zh" ? "" : " ";
  const summary = useMemo(() => summarizeQuotaWeeks(windows, range), [windows, range]);
  if (windows.length === 0) {
    return <p className="stats-empty">{t("quota.empty")}</p>;
  }
  if (range === "7d") return <QuotaWeekFocus windows={windows} />;

  let source = t("quota.sourceCodex", { date: formatMonthDay(summary.since) });
  if (provider === "claude") {
    source = t("quota.sourceClaude", { date: formatMonthDay(summary.recordedSince) });
    if (estimate) source += gap + t("quota.sourceEstimate", { count: estimate.calibrationWeeks });
  }
  // "≈" marks figures that include estimated weeks.
  const approx = (estimated, text) => (estimated && text !== "—" ? `≈${text}` : text);
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("quota.averageLabel")} value={approx(summary.estimatedWeeks > 0, formatPercent(summary.average))} />
        <StatCard label={t("quota.peakLabel")} value={approx(summary.peakEstimated, formatPercent(summary.peak))} />
        <StatCard
          label={t("quota.fullLabel")}
          value={approx(summary.fullWeeksEstimated, String(summary.fullWeeks))}
          detail={t("quota.weeksDetail", { count: summary.weeks.length })}
        />
        <StatCard label={t("quota.currentLabel")} value={formatPercent(summary.current?.usedPercent)} />
      </div>
      {summary.weeks.length || summary.current ? (
        <QuotaBars weeks={summary.weeks} current={summary.current} average={summary.average} />
      ) : null}
      <p className="quota-note">
        {summary.weeks.length
          ? summary.estimatedWeeks
            ? t("quota.noteEstimated", { count: summary.weeks.length, estimated: summary.estimatedWeeks })
            : t("quota.noteRecorded", { count: summary.weeks.length })
          : t("quota.noteNone")}
        {summary.earlyResets ? gap + t("quota.noteEarly", { count: summary.earlyResets }) : null}
        {gap}
        {source}
      </p>
    </>
  );
}

// 7 days for Qoder: credits per day.
function CreditDays({ days, today }) {
  const { t } = useI18n();
  const summary = useMemo(() => summarizeCreditDays(days, today), [days, today]);
  const max = Math.max(summary.peak, 1);
  const bars = summary.days.map((day) => ({
    key: day.date,
    height: day.credits > 0 ? Math.max((day.credits / max) * 100, 1.5) : 0,
    className: day.isToday ? "is-current" : "",
    isCurrent: day.isToday,
    label: day.isToday ? t("credits.today") : formatDayKey(day.date),
    title: t("credits.dayBar", { date: formatDayKey(day.date), credits: formatCredits(day.credits) }),
  }));
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("credits.dayTotal")} value={formatCredits(summary.total)} />
        <StatCard label={t("credits.dayAverage")} value={formatCredits(summary.average)} />
        <StatCard label={t("credits.dayPeak")} value={formatCredits(summary.peak)} />
        <StatCard label={t("credits.today")} value={formatCredits(summary.today)} />
      </div>
      <BarChart
        label={t("credits.dayChart")}
        bars={bars}
        average={summary.average ? { height: (summary.average / max) * 100, text: t("credits.averageDayLine", { credits: formatCredits(summary.average) }) } : null}
      />
      <p className="quota-note">{t(summary.total > 0 ? "credits.dayNote" : "credits.empty")}</p>
    </>
  );
}

function CreditUsage({ days, range, today }) {
  const { t } = useI18n();
  const summary = useMemo(() => summarizeCreditWeeks(days, range, today), [days, range, today]);
  if (range === "7d") return <CreditDays days={days} today={today} />;
  const max = Math.max(...summary.weeks.map((week) => week.credits), 1);
  const bars = summary.weeks.map((week) => ({
    key: week.start,
    height: week.credits > 0 ? Math.max((week.credits / max) * 100, 1.5) : 0,
    className: week.isCurrent ? "is-current" : "",
    isCurrent: week.isCurrent,
    label: week.isCurrent ? t("quota.thisWeek") : formatDayKey(week.start),
    title: t("credits.bar", { week: formatDayKey(week.start), credits: formatCredits(week.credits) }),
  }));
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("credits.total")} value={formatCredits(summary.total)} />
        <StatCard label={t("credits.average")} value={formatCredits(summary.average)} />
        <StatCard label={t("credits.peak")} value={formatCredits(summary.peak)} />
        <StatCard label={t("credits.thisWeek")} value={formatCredits(summary.current)} />
      </div>
      <BarChart
        label={t("credits.chart")}
        bars={bars}
        average={summary.average ? { height: (summary.average / max) * 100, text: t("credits.averageLine", { credits: formatCredits(summary.average) }) } : null}
        axis={[summary.weeks[0] ? formatDayKey(summary.weeks[0].start) : "", t("quota.thisWeek")]}
      />
      <p className="quota-note">{t("credits.note")}</p>
    </>
  );
}

const LEDGER_ROWS = 7;

// The spending record: each day the balance moved, newest first, with that day's tokens from
// DeepSeek Harness. Older days fold behind a button.
function SpendingRecord({ ledger, days, firstDate }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const harnessOn = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const harness = (date) => {
    const day = harnessOn.get(date);
    if (!day?.tokens) return "—";
    const tokens = t("balance.recordTokens", { tokens: formatTokens(day.tokens) });
    return day.cost > 0 ? `${tokens} · ${t("usage.cost", { amount: formatMoney(day.cost, "CNY") })}` : tokens;
  };
  const rows = ledger.filter((entry) => entry.date >= firstDate);
  if (!rows.length) return null;
  const shown = showAll ? rows : rows.slice(0, LEDGER_ROWS);
  const money = (value, currency) => formatMoney(value, currency);
  return (
    <section className="spending-record" aria-labelledby="spending-record-title">
      <h4 id="spending-record-title">{t("balance.record")}</h4>
      <ol>
        {shown.map((entry) => (
          <li key={entry.date}>
            <div className="spending-day">
              <span>{formatDayKey(entry.date)}</span>
              <small>{harness(entry.date)}</small>
            </div>
            <div className="spending-amounts">
              <strong className={entry.spent > 0 ? "" : "is-zero"}>{entry.spent > 0 ? `−${money(entry.spent, entry.currency)}` : money(0, entry.currency)}</strong>
              {entry.added > 0 ? <span className="spending-added">{t("balance.recordAdded", { amount: money(entry.added, entry.currency) })}</span> : null}
              <small>{t("balance.recordBalance", { amount: money(entry.balance, entry.currency) })}</small>
            </div>
          </li>
        ))}
      </ol>
      {rows.length > shown.length ? (
        <button className="link-button" type="button" onClick={() => setShowAll(true)}>
          {t("balance.recordMore", { count: rows.length - shown.length })}
        </button>
      ) : null}
    </section>
  );
}

// DeepSeek's balance: spending per day, worked out from the balance readings TokenTide keeps.
function BalanceUsage({ balance, days, range, today }) {
  const { t } = useI18n();
  const summary = useMemo(() => summarizeBalance(balance, range, today), [balance, range, today]);
  const money = (value) => formatMoney(value, balance.currency);
  const max = Math.max(summary.peak, 0.0001);
  const bars = summary.days.map((day) => ({
    key: day.date,
    height: day.spent > 0 ? Math.max((day.spent / max) * 100, 1.5) : 0,
    className: day.isToday ? "is-current" : "",
    isCurrent: day.isToday,
    label: day.isToday ? t("credits.today") : formatDayKey(day.date),
    title: day.recorded
      ? t("balance.dayBar", { date: formatDayKey(day.date), amount: money(day.spent) })
      : t("balance.dayUnrecorded", { date: formatDayKey(day.date) }),
  }));
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("balance.current")} value={money(balance.total)} />
        <StatCard label={t("balance.spent")} value={money(summary.total)} />
        <StatCard label={t("balance.average")} value={money(summary.average)} />
        <StatCard
          label={t("balance.runway")}
          value={summary.runway === null ? "—" : t("stats.days", { count: Math.floor(summary.runway) })}
        />
      </div>
      <BarChart
        label={t("balance.chart")}
        bars={bars}
        average={summary.average ? { height: (summary.average / max) * 100, text: t("balance.averageLine", { amount: money(summary.average) }) } : null}
        axis={[formatDayKey(summary.days[0].date), t("credits.today")]}
      />
      <p className="quota-note">{t("balance.note", { date: formatDayKey(localDayKey(new Date(balance.since))) })}</p>
      <SpendingRecord ledger={balance.ledger ?? []} days={days} firstDate={summary.days[0].date} />
    </>
  );
}

// When the history was counted, how often it updates, and a link to count it again now.
function StatsFreshness({ generatedAt, now, every, onReload }) {
  const { t } = useI18n();
  if (!generatedAt) return null;
  const minutes = Math.max(0, Math.floor((now - generatedAt) / 60_000));
  const counted =
    minutes < 1 ? t("stats.countedNow") : minutes < 60 ? t("stats.countedMinutes", { count: minutes }) : t("stats.countedHours", { count: Math.floor(minutes / 60) });
  return (
    <p className="stats-freshness">
      <span>{`${counted} · ${t("stats.everyMinutes", { count: every })}`}</span>
      <button className="link-button" type="button" onClick={onReload}>{t("stats.reload")}</button>
    </p>
  );
}

export function UsageStats({
  stats,
  error,
  provider: selected,
  range,
  view,
  hiddenProviders = [],
  onChange,
  now = Date.now(),
  onReload = () => {},
  reloadInterval = 30,
}) {
  const { t, language } = useI18n();
  const today = localDayKey();
  // Tools turned off in Settings are left out; Qoder and DeepSeek get a tab only when this Mac
  // has their transcripts, unless one is the only tool shown.
  const shownIds = STATS_PROVIDERS.filter((id) => !hiddenProviders.includes(id));
  const withRecords = shownIds.filter(
    (id) => id === "codex" || id === "claude" || stats?.providers.find((item) => item.id === id)?.days?.length,
  );
  const providerIds = withRecords.length ? withRecords : shownIds.length ? shownIds : [STATS_PROVIDERS[0]];
  const provider = providerIds.includes(selected) ? selected : providerIds[0];
  // DeepSeek is pay-as-you-go: a Balance view instead of Utilization.
  const views = provider === "deepseek" ? ["overview", "models", "balance"] : ["overview", "models", "quota"];
  const activeView = views.includes(view) ? view : "overview";
  const measure = measureOf(provider);
  const providerStats = stats?.providers.find((item) => item.id === provider);
  const days = useMemo(() => providerStats?.days ?? [], [providerStats]);
  const quotaWeeks = useMemo(() => providerStats?.quotaWeeks ?? [], [providerStats]);
  const summary = useMemo(() => summarizeStats(days, range, today, measure), [days, range, today, measure]);

  let body;
  if (error && !stats) {
    body = <p className="stats-empty">{error}</p>;
  } else if (!stats) {
    body = <p className="stats-empty">{t("stats.loading")}</p>;
  } else if (activeView === "balance") {
    body = providerStats?.balance ? (
      <BalanceUsage balance={providerStats.balance} days={days} range={range} today={today} />
    ) : (
      <p className="stats-empty">{t("balance.empty")}</p>
    );
  } else if (activeView === "quota" && provider === "qoder") {
    body = days.length ? <CreditUsage days={days} range={range} today={today} /> : <p className="stats-empty">{t("credits.empty")}</p>;
  } else if (activeView === "quota") {
    body = <QuotaUsage windows={quotaWeeks} estimate={providerStats?.quotaEstimate} provider={provider} range={range} />;
  } else if (days.length === 0) {
    body = <p className="stats-empty">{t("stats.noRecords", { name: PROVIDER_META[provider].name })}</p>;
  } else if (activeView === "models") {
    body = <ModelList models={summary.models} measure={measure} />;
  } else {
    const fact = measure === "tokens" ? compareToBook(summary.io, `${today}:${provider}:${range}`, language) : null;
    body = (
      <>
        <div className="stat-grid">
          <StatCard label={t("stats.sessions")} value={summary.sessions.toLocaleString()} />
          <StatCard label={t("stats.messages")} value={summary.messages.toLocaleString()} />
          {measure === "credits" ? (
            <StatCard label={t("stats.credits")} value={formatCredits(summary.credits)} />
          ) : (
            <StatCard label={t("stats.tokens")} value={formatTokens(summary.tokens)} />
          )}
          <StatCard label={t("stats.activeDays")} value={summary.activeDays} detail={`/${summary.totalDays}`} />
          <StatCard label={t("stats.currentStreak")} value={t("stats.days", { count: summary.currentStreak })} />
          {provider === "deepseek" ? (
            // Pay-as-you-go: what the range cost at DeepSeek's published prices, instead of a streak.
            <StatCard
              label={t("stats.cost")}
              value={formatMoney(days.reduce((sum, day) => (day.date >= summary.start ? sum + (day.cost ?? 0) : sum), 0), "CNY")}
            />
          ) : (
            <StatCard label={t("stats.longestStreak")} value={t("stats.days", { count: summary.longestStreak })} />
          )}
          <StatCard label={t("stats.peakHour")} value={formatHour(summary.peakHour)} />
          <StatCard label={t("stats.favoriteModel")} value={formatModelName(summary.favoriteModel)} compact />
        </div>
        <Heatmap days={days} start={summary.start} today={today} measure={measure} />
        {fact ? <p className="stats-fact">{fact}</p> : null}
      </>
    );
  }

  return (
    <section className={`usage-stats stats-${provider}`} aria-label={t("stats.label")}>
      <div
        className={`stats-providers ${providerIds.length > 3 ? "is-crowded" : ""}`}
        // Four tools: columns follow their names so "Claude Code" keeps its space.
        style={{ gridTemplateColumns: `repeat(${providerIds.length}, ${providerIds.length > 3 ? "auto" : "minmax(0, 1fr)"})` }}
        role="tablist"
        aria-label={t("stats.providers")}
      >
        {providerIds.map((id) => [id, PROVIDER_META[id]]).map(([id, meta]) => (
          <button key={id} type="button" role="tab" aria-selected={provider === id} onClick={() => onChange("statsProvider", id)}>
            <img src={meta.icon} alt="" />
            {meta.name}
          </button>
        ))}
      </div>
      <div className="stats-toolbar">
        <Segmented
          label={t("stats.view")}
          options={views.map((id) => [id, t(`stats.${id}`)])}
          value={activeView}
          onChange={(value) => onChange("statsView", value)}
        />
        <Segmented label={t("stats.range")} options={STAT_RANGES.map((id) => [id, t(`range.${id}`)])} value={range} onChange={(value) => onChange("statsRange", value)} />
      </div>
      {body}
      <StatsFreshness generatedAt={stats?.generatedAt} now={now} every={reloadInterval} onReload={onReload} />
    </section>
  );
}
