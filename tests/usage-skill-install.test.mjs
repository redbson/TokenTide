import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SKILL_NAME, createSkillInstaller } from "../server/skill-install.mjs";

const BUNDLED = fileURLToPath(new URL("../skills/tokentide-usage/", import.meta.url));

test("installs, updates, and removes the skill in an agent's skills folder", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tt-skill-"));
  try {
    const claudeHome = path.join(home, ".claude");
    await mkdir(claudeHome);
    const agents = [
      { id: "claude", name: "Claude Code", home: claudeHome, target: path.join(claudeHome, "skills", SKILL_NAME) },
      { id: "codex", name: "Codex", home: path.join(home, ".codex"), target: path.join(home, ".codex", "skills", SKILL_NAME) },
    ];
    const installer = createSkillInstaller({ agents, bundled: BUNDLED });

    let state = await installer.status();
    assert.equal(state.bundled, true);
    assert.deepEqual(state.agents.map((a) => [a.id, a.present, a.installed]), [["claude", true, false], ["codex", false, false]]);

    state = await installer.install("claude");
    assert.equal(state.agents[0].installed, true);
    assert.equal(state.agents[0].upToDate, true);
    assert.match(await readFile(path.join(agents[0].target, "SKILL.md"), "utf8"), /name: tokentide-usage/);
    assert.match(await readFile(path.join(agents[0].target, "scripts", "tokentide-usage.mjs"), "utf8"), /v1\/usage/);

    // An older copy is reported and replaced by Update.
    await writeFile(path.join(agents[0].target, "SKILL.md"), "---\nname: tokentide-usage\ndescription: old\n---\n");
    assert.equal((await installer.status()).agents[0].upToDate, false);
    assert.equal((await installer.install("claude")).agents[0].upToDate, true);

    await assert.rejects(installer.install("codex"), { code: "agentMissing" });
    await assert.rejects(installer.install("nope"), { code: "unknownAgent" });

    assert.equal((await installer.uninstall("claude")).agents[0].installed, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("never overwrites or removes a different skill that has the same folder name", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tt-skill-other-"));
  try {
    const target = path.join(home, "skills", SKILL_NAME);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: something-else\n---\nmine\n");
    const installer = createSkillInstaller({ agents: [{ id: "claude", name: "Claude Code", home, target }], bundled: BUNDLED });
    await assert.rejects(installer.install("claude"), { code: "skillConflict" });
    await assert.rejects(installer.uninstall("claude"), { code: "skillConflict" });
    assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /mine/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
