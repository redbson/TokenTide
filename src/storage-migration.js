// Merges the panel storage carried over from TokenTide's old port (server/storage-migration.mjs)
// into the current one. Settings the user already changed here win; the rest come from before.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mergeMigratedSettings(current, migrated, defaults) {
  if (!migrated || typeof migrated !== "object" || Array.isArray(migrated)) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(migrated)) {
    if (!(key in defaults) || !same(current[key], defaults[key])) continue;
    // Only values of the setting's own type (hiddenProviders is an array of ids).
    const expected = Array.isArray(defaults[key]) ? "array" : typeof defaults[key];
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (expected === actual) merged[key] = value;
  }
  return merged;
}

/** Quota-trend snapshots from both origins, newest first, one per time. */
export function mergeMigratedHistory(current, migrated, limit) {
  const byTime = new Map();
  for (const item of [...(Array.isArray(migrated) ? migrated : []), ...(current ?? [])]) {
    if (Number.isFinite(item?.at)) byTime.set(item.at, item);
  }
  return [...byTime.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}
