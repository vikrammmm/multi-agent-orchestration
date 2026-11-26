/**
 * Tiny argv parser: --key value, --flag, repeated keys become arrays.
 * Bare tokens land in `._`. `--` ends option parsing.
 */
export function parseArgs(argv) {
  const out = { _: [] };
  const args = argv.slice();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        setKey(out, tok.slice(2, eq), tok.slice(eq + 1));
        continue;
      }
      const key = tok.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        setKey(out, key, next);
        i += 1;
      } else {
        setKey(out, key, true);
      }
      continue;
    }
    out._.push(tok);
  }
  return out;
}

function setKey(out, key, value) {
  if (!Object.prototype.hasOwnProperty.call(out, key) || key === '_') {
    out[key] = value;
    return;
  }
  const cur = out[key];
  if (Array.isArray(cur)) cur.push(value);
  else out[key] = [cur, value];
}

export function asList(value) {
  if (value === undefined || value === true || value === false) return [];
  if (Array.isArray(value)) return value.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export function hasFlag(args, name) {
  return args[name] === true || args[name] === 'true' || args[name] === '1';
}
