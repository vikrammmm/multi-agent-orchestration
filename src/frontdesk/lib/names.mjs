// Display names for model families, for plain-language output.
export const NAMES = {
  'claude-opus-5-5': 'Claude Opus 5.5', 'claude-opus-5': 'Claude Opus 5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-5-5': 'Claude Haiku 5.5', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-sol': 'GPT-6 Sol', 'gpt-6-luna': 'GPT-6 Luna', 'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra', 'grok-4.7': 'Grok 4.7', 'composer-2.5': 'Composer 2.5', 'muse-spark-1.3': 'Muse Spark 1.3', 'muse-wonder-1.0': 'Muse Wonder',
  'muse-wonder-full-1.0': 'Muse Wonder Full', 'gemini-4-argon': 'Gemini 4 Argon', 'qwen-local': 'Qwenbox (Qwen)', auto: 'Cursor Auto',
};
export const pretty = (family) => NAMES[family] || family;
export const ROUTE_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', muse: 'Muse Code', qwen: 'Qwen Code' };
