/** Last path segment of a vendor/model id. */
export function modelLeaf(model: string): string {
  const n = model.trim().toLowerCase();
  const slash = n.lastIndexOf("/");
  return slash >= 0 ? n.slice(slash + 1) : n;
}

/** Parsed GPT major.minor from the model leaf, or null when the id is not gpt-N. */
export function gptVersion(model: string): { major: number; minor: number } | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[.-]|$)/.exec(modelLeaf(model));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** GPT-5.6 and later, including gpt-6+. Used for cache-field support. */
export function isGpt56OrLaterModel(model: string): boolean {
  const version = gptVersion(model);
  if (!version) return false;
  return version.major > 5 || (version.major === 5 && version.minor >= 6);
}

/** OpenAI o-series ids (`o1`, `o3`, `vendor/o4-mini`). */
export function oSeriesModel(model: string): boolean {
  return /(?:^|\/)o[0-9]/.test(model.toLowerCase());
}
