// One definition of "the same config file" for the Codex trust key (`<file>:pre_tool_use:<index>:<n>`), used by the text scanner and the parsed-file check.
// Slashes and case do not matter on Windows, and a path written with doubled backslashes (as in some literal-string fixtures) is folded, but a UNC prefix
// (\\server\share) keeps its two leading backslashes.
export function normalizeConfigPath(value) {
  const text = String(value);
  const unc = /^\\\\(?=[^\\])/.test(text) ? '\\\\' : '';
  const rest = text.slice(unc.length).replace(/\\\\/g, '\\');
  return (unc + rest).replace(/\\/g, '/').toLowerCase();
}

export const sameConfigFile = (a, b) => normalizeConfigPath(a) === normalizeConfigPath(b);
