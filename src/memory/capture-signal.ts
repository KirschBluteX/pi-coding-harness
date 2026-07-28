const explicitPatterns = [
  /^\s*(?:请|麻烦)?\s*(?:(?:长期|永久|一直|以后(?:都)?|今后(?:都)?|从今以后)\s*)?(?:记住|记下|保存为长期(?:偏好|记忆))(?:这(?:一)?点)?\s*[:：﹕,，-]?\s*(.+)$/u,
  /^\s*(?:长期|永久|一直|以后(?:都)?|今后(?:都)?|从今以后)\s*(?:请\s*)?(?:记住|记下)\s*[:：﹕,，-]?\s*(.+)$/u,
] as const;

const legacyEnglishExplicitPattern = /^\s*(?:please\s+)?remember(?:\s+that)?\s*[:：﹕]?\s*(.+)$/iu;
const weakPreferencePattern = /(?:^|[，。；;]\s*)(?:我(?:(?:一直|通常|一贯|总是)\s*)?(?:更)?(?:偏好|喜欢|习惯|倾向于)|我的(?:长期)?(?:偏好|习惯)(?:是|为)|以后(?:请|都)|今后(?:请|都)|对我来说.{0,12}(?:更好|更合适))/u;

function normalizeSignal(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function explicitUserMemoryBody(value: string): string | null {
  const normalized = normalizeSignal(value);
  for (const pattern of explicitPatterns) {
    const body = pattern.exec(normalized)?.[1];
    if (body?.trim()) return normalizeSignal(body);
  }
  return null;
}

export function legacyUserMemoryBody(value: string): string | null {
  const body = legacyEnglishExplicitPattern.exec(normalizeSignal(value))?.[1];
  return body?.trim() ? normalizeSignal(body) : null;
}

export function hasWeakUserMemoryPreference(value: string): boolean {
  return weakPreferencePattern.test(normalizeSignal(value));
}

export function hasPotentialUserMemorySignal(value: string): boolean {
  return explicitUserMemoryBody(value) !== null
    || legacyUserMemoryBody(value) !== null
    || hasWeakUserMemoryPreference(value);
}
