const isMeaningfulText = (value) => typeof value === 'string' && value.trim().length > 8;

const UNSAFE_TITLE_NORMALIZED = new Set([
  'new chat',
  'what are we fixing building or figuring out',
  'no idea where to start',
  'great question',
]);

const normalizeTitleText = (value) =>
  (typeof value === 'string' ? value : '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isUnsafeSessionTitle = (normalized) => {
  if (!normalized) return true;
  if (UNSAFE_TITLE_NORMALIZED.has(normalized)) return true;
  if (normalized.endsWith('great question')) return true;
  if (/^(g\s*day|hello|hi|hey|howdy|good morning|good afternoon)\b/.test(normalized)) return true;
  if (normalized.includes('what are we fixing')) return true;
  return false;
};

const buildSessionTitle = (content) => {
  if (!isMeaningfulText(content)) {
    return null;
  }
  const sanitized = content.replace(/\s+/g, ' ').trim();
  const normalized = normalizeTitleText(sanitized);
  if (isUnsafeSessionTitle(normalized)) {
    return null;
  }
  const firstSentence = sanitized.split(/[.!?\n]/)[0]?.trim();
  const titleText = firstSentence || sanitized;
  const candidate = titleText.slice(0, 80).trim();
  if (candidate.length < 5 || isUnsafeSessionTitle(normalizeTitleText(candidate))) {
    return null;
  }
  return candidate;
};

module.exports = {
  buildSessionTitle,
  isUnsafeSessionTitle,
  normalizeTitleText,
};
