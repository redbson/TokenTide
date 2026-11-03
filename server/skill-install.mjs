import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Settings → More → Agent skill: installs the tokentide-usage skill (skills/ in the repository,
// bundled with the app) into the coding agents' own skill folders, so they learn the local API.
// Only the user's click installs, updates, or removes it, and only that one folder is touched.

export const SKILL_NAME = "tokentide-usage";
const BUNDLED = fileURLToPath(new URL(`../skills/${SKILL_NAME}/`, import.meta.url));

/** The agents that read skills from a folder in their home, and where that folder is. */
export function skillAgents(env = process.env, home = os.homedir()) {
  return [
    { id: "claude", name: "Claude Code", home: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") },
    { id: "codex", name: "Codex", home: env.CODEX_HOME || path.join(home, ".codex") },
  ].map((agent) => ({ ...agent, target: path.join(agent.home, "skills", SKILL_NAME) }));
}

async function filesOf(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesOf(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** A fingerprint of a skill folder's files and contents, to tell whether a copy is current. */
async function fingerprint(directory) {
  const hash = createHash("sha256");
  for (const file of await filesOf(directory)) {
    hash.update(file).update("\0").update(await readFile(path.join(directory, ...file.split("/")))).update("\0");
  }
  return hash.digest("hex");
}

/** Whether `directory` holds this skill (and not something else that happens to share its name). */
async function isOurSkill(directory) {
  const text = await readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => "");
  return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "m").test(text);
}

const shortPath = (file, home = os.homedir()) => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);

export function createSkillInstaller({ agents = skillAgents(), bundled = BUNDLED } = {}) {
  const find = (id) => {
    const agent = agents.find((item) => item.id === id);
    if (!agent) throw Object.assign(new Error("Unknown agent."), { code: "unknownAgent" });
    return agent;
  };

  async function status() {
    const available = existsSync(path.join(bundled, "SKILL.md"));
    const current = available ? await fingerprint(bundled) : null;
    return {
      skill: SKILL_NAME,
      bundled: available,
      agents: await Promise.all(
        agents.map(async (agent) => {
          const installed = existsSync(path.join(agent.target, "SKILL.md"));
          return {
            id: agent.id,
            name: agent.name,
            // The agent is set up on this computer (its home folder exists).
            present: existsSync(agent.home),
            installed,
            upToDate: installed && current !== null && (await fingerprint(agent.target)) === current,
            location: shortPath(agent.target),
          };
        }),
      ),
    };
  }

  return {
    status,

    /** Copies the bundled skill into the agent's skills folder, replacing an older copy. */
    async install(id) {
      const agent = find(id);
      if (!existsSync(path.join(bundled, "SKILL.md"))) throw Object.assign(new Error("No bundled skill."), { code: "skillMissing" });
      if (!existsSync(agent.home)) throw Object.assign(new Error("Agent not set up."), { code: "agentMissing" });
      if (existsSync(agent.target) && !(await isOurSkill(agent.target))) {
        throw Object.assign(new Error("Another skill uses this name."), { code: "skillConflict" });
      }
      await mkdir(path.dirname(agent.target), { recursive: true });
      // Copy next to it first, so a failed copy never leaves a half-installed skill behind.
      const staging = `${agent.target}.installing`;
      await rm(staging, { recursive: true, force: true });
      await cp(bundled, staging, { recursive: true });
      await rm(agent.target, { recursive: true, force: true });
      await rename(staging, agent.target);
      return status();
    },

    /** Removes the skill from the agent's skills folder, if it is this skill. */
    async uninstall(id) {
      const agent = find(id);
      if (existsSync(agent.target)) {
        if (!(await isOurSkill(agent.target))) throw Object.assign(new Error("Another skill uses this name."), { code: "skillConflict" });
        await rm(agent.target, { recursive: true, force: true });
      }
      return status();
    },
  };
}
