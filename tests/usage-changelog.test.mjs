import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHANGELOG_HEADINGS, isNewerVersion, parseChangelog } from "../src/changelog-parse.js";

const readme = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const { version } = JSON.parse(readme("package.json"));

test("parses versions and bullets, skipping unreleased notes", () => {
  const markdown = [
    "# App",
    "## Changelog",
    "",
    "### Unreleased",
    "- not shipped yet",
    "",
    "### 0.2.0",
    "- **Bold** and `code`",
    "- second",
    "",
    "### v0.1.0",
    "- first",
    "",
    "See all releases.",
    "## License",
    "- not a release note",
  ].join("\n");
  assert.deepEqual(parseChangelog(markdown, "Changelog"), [
    { version: "0.2.0", items: ["**Bold** and `code`", "second"] },
    { version: "0.1.0", items: ["first"] },
  ]);
  assert.deepEqual(parseChangelog("no changelog here", "Changelog"), []);
  assert.equal(isNewerVersion("0.10.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.6.3", "0.6.3"), false);
});

test("both READMEs have the same released versions, newest first", () => {
  const en = parseChangelog(readme("README.md"), CHANGELOG_HEADINGS.en);
  const zh = parseChangelog(readme("README.zh-CN.md"), CHANGELOG_HEADINGS.zh);
  assert.ok(en.length >= 5);
  assert.deepEqual(en.map((release) => release.version), zh.map((release) => release.version));
  for (let index = 1; index < en.length; index += 1) {
    assert.ok(isNewerVersion(en[index - 1].version, en[index].version), `${en[index - 1].version} before ${en[index].version}`);
  }
  // The version being built has notes for the "What's new" banner, unless it is still unreleased.
  assert.ok(!isNewerVersion(en[0].version, version), "no notes newer than package.json");
});
