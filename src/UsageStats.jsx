import { useMemo } from "react";
import { useI18n } from "./i18n-context.js";
import { PROVIDER_META, STATS_PROVIDERS, formatPercent } from "./usage-format.js";
import {
  FULL_WEEK_PERCENT,
  STAT_RANGES,
  buildHeatmap,
  compareToBook,
  formatCredits,
  formatHour,
  formatModelName,
  formatMonthDay,
  formatShare,
  formatTokens,
  localDayKey,
  summarizeCreditWeeks,
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

function QuotaBars({ weeks, current, average }) {
  const { t } = useI18n();
  const bars = current ? [...weeks, { ...current, isCurrent: true }] : weeks;
  const period = (window) => `${formatMonthDay(weekStart(window))}–${formatMonthDay(window.resetsAt)}`;
  return (
    <div className="quota-chart">
      <div className={`quota-bars ${bars.length > 30 ? "is-dense" : ""}`} role="img" aria-label={t("quota.chart")}>
        {average !== null ? (
          <div className="quota-average" style={{ bottom: `${average}%` }}>
            <span>{t("quota.average", { percent: formatPercent(average) })}</span>
          </div>
        ) : null}
        {bars.map((window) => (
          <span
            key={window.resetsAt}
            className={`quota-bar ${window.isCurrent ? "is-current" : ""} ${window.estimated ? "is-estimated" : ""} ${window.usedPercent >= FULL_WEEK_PERCENT ? "is-full" : ""}`}
            title={
              t(window.estimated ? "quota.barEstimated" : "quota.barUsed", { period: period(window), percent: formatPercent(window.usedPercent) }) +
              (window.isCurrent ? t("quota.barCurrent") : "")
            }
          >
            <span style={{ height: `${Math.max(window.usedPercent, 1.5)}%` }} />
          </span>
        ))}
      </div>
      <div className="quota-axis">
        <span>{bars.length ? formatMonthDay(weekStart(bars[0])) : ""}</span>
        <span>{current ? t("quota.thisWeek") : bars.length ? formatMonthDay(bars.at(-1).resetsAt) : ""}</span>
      </div>
    </div>
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
        {gap}
        {source}
      </p>
    </>
  );
}

function CreditUsage({ days, range, today }) {
  const { t } = useI18n();
  const summary = useMemo(() => summarizeCreditWeeks(days, range, today), [days, range, today]);
  const max = Math.max(...summary.weeks.map((week) => week.credits), 1);
  return (
    <>
      <div className="stat-grid">
        <StatCard label={t("credits.total")} value={formatCredits(summary.total)} />
        <StatCard label={t("credits.average")} value={formatCredits(summary.average)} />
        <StatCard label={t("credits.peak")} value={formatCredits(summary.peak)} />
        <StatCard label={t("credits.thisWeek")} value={formatCredits(summary.current)} />
      </div>
      <div className="quota-chart">
        <div className={`quota-bars ${summary.weeks.length > 30 ? "is-dense" : ""}`} role="img" aria-label={t("credits.chart")}>
          {summary.average ? (
            <div className="quota-average" style={{ bottom: `${(summary.average / max) * 100}%` }}>
              <span>{t("credits.averageLine", { credits: formatCredits(summary.average) })}</span>
            </div>
          ) : null}
          {summary.weeks.map((week) => (
            <span
              key={week.start}
              className={`quota-bar ${week.isCurrent ? "is-current" : ""}`}
              title={t("credits.bar", { week: week.start.slice(5).replace("-", "/"), credits: formatCredits(week.credits) })}
            >
              <span style={{ height: `${week.credits > 0 ? Math.max((week.credits / max) * 100, 1.5) : 0}%` }} />
            </span>
          ))}
        </div>
        <div className="quota-axis">
          <span>{summary.weeks[0]?.start.slice(5).replace("-", "/")}</span>
          <span>{t("quota.thisWeek")}</span>
        </div>
      </div>
      <p className="quota-note">{t("credits.note")}</p>
    </>
  );
}

export function UsageStats({ stats, error, provider: selected, range, view, onChange }) {
  const { t, language } = useI18n();
  const today = localDayKey();
  // Qoder gets a tab only when this Mac has Qoder transcripts.
  const providerIds = STATS_PROVIDERS.filter(
    (id) => id !== "qoder" || stats?.providers.find((item) => item.id === "qoder")?.days?.length,
  );
  const provider = providerIds.includes(selected) ? selected : providerIds[0];
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
  } else if (view === "quota" && provider === "qoder") {
    body = days.length ? <CreditUsage days={days} range={range} today={today} /> : <p className="stats-empty">{t("credits.empty")}</p>;
  } else if (view === "quota") {
    body = <QuotaUsage windows={quotaWeeks} estimate={providerStats?.quotaEstimate} provider={provider} range={range} />;
  } else if (days.length === 0) {
    body = <p className="stats-empty">{t("stats.noRecords", { name: PROVIDER_META[provider].name })}</p>;
  } else if (view === "models") {
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
          <StatCard label={t("stats.longestStreak")} value={t("stats.days", { count: summary.longestStreak })} />
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
        className="stats-providers"
        style={{ gridTemplateColumns: `repeat(${providerIds.length}, minmax(0, 1fr))` }}
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
          options={["overview", "models", "quota"].map((id) => [id, t(`stats.${id}`)])}
          value={view}
          onChange={(value) => onChange("statsView", value)}
        />
        <Segmented label={t("stats.range")} options={STAT_RANGES.map((id) => [id, t(`range.${id}`)])} value={range} onChange={(value) => onChange("statsRange", value)} />
      </div>
      {body}
    </section>
  );
}
