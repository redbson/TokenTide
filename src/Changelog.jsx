import { useState } from "react";
import changelog from "virtual:changelog";
import { useI18n } from "./i18n-context.js";
import { isNewerVersion } from "./changelog-parse.js";

/** Release notes for `language`, newest first, up to the running version. */
export function releaseNotes(language, version) {
  const releases = changelog[language] ?? changelog.en ?? [];
  return version ? releases.filter((release) => !isNewerVersion(release.version, version)) : releases;
}

/** True when the bundled changelog has notes for `version`. */
export const hasReleaseNotes = (version) => Boolean(version) && (changelog.en ?? []).some((release) => release.version === version);

// The README bullets use a little Markdown: `code`, **bold**, and [links](url) (shown as text).
function Inline({ text }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\([^)]+\)$/);
    return link ? link[1] : part;
  });
}

// The latest few versions are shown; older ones fold behind a button.
const RECENT_RELEASES = 3;

export function ChangelogView({ version, onBack, onOpenReleases }) {
  const { t, language } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const releases = releaseNotes(language, version);
  const shown = showAll ? releases : releases.slice(0, RECENT_RELEASES);
  const hidden = releases.length - shown.length;
  return (
    <section className="changelog" aria-labelledby="changelog-title">
      <div className="changelog-heading">
        <button className="link-button" type="button" onClick={onBack}>‹ {t("changelog.back")}</button>
        <h3 id="changelog-title">{t("changelog.title")}</h3>
      </div>
      {releases.length === 0 ? <p className="changelog-empty">{t("changelog.empty")}</p> : null}
      {shown.map((release) => (
        <article className="changelog-release" key={release.version}>
          <h4>
            {release.version}
            {release.version === version ? <span className="changelog-current">{t("changelog.current")}</span> : null}
          </h4>
          <ul>
            {release.items.map((item, index) => (
              <li key={index}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        </article>
      ))}
      {hidden > 0 ? (
        <button className="link-button changelog-more" type="button" onClick={() => setShowAll(true)}>
          {t("changelog.showOlder", { count: hidden })}
        </button>
      ) : null}
      <button className="link-button changelog-all" type="button" onClick={onOpenReleases}>
        {t("changelog.allReleases")}
      </button>
    </section>
  );
}
