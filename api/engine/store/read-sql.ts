// Recognize only single statements that cannot write. The pinned Rust
// binding does not expose statement readonly metadata; Turso still parses
// and validates the SQL, and the native zero-growth limit stays in force.
const readPragmas = new Set([
  'DATABASE_LIST',
  'FOREIGN_KEYS',
  'INTEGRITY_CHECK',
  'JOURNAL_MODE',
  'MVCC_CHECKPOINT_THRESHOLD',
  'MVCC_GROUP_COMMIT',
  'PAGE_COUNT',
  'PAGE_SIZE',
  'QUICK_CHECK',
  'SCHEMA_VERSION',
  'SYNCHRONOUS',
  'USER_VERSION',
]);
// These pragma arguments select an object, not a new setting.
const inspectionPragmas = new Set([
  'FOREIGN_KEY_CHECK',
  'FOREIGN_KEY_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INDEX_XINFO',
  'TABLE_INFO',
  'TABLE_XINFO',
]);

export function isReadQuery(sql: string): boolean {
  const lexer =
    /[ \t\n\r\f]+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[a-z_\u0080-\uffff][a-z_0-9$\u0080-\uffff]*|./gisy;
  const tokens: string[] = [];
  while (lexer.lastIndex < sql.length) {
    const token = lexer.exec(sql)?.[0];
    if (token === undefined) return false;
    if (/^(?:[ \t\n\r\f]|--|\/\*)/.test(token)) continue;
    // An unmatched delimiter is not a token we know how to classify.
    if (token.length === 1 && '\'"`['.includes(token)) return false;
    tokens.push(/^[a-z_]/i.test(token) ? token.toUpperCase() : token);
  }
  if (tokens.at(-1) === ';') tokens.pop();
  if (tokens.includes(';')) return false;

  let i = 0;
  const take = (token: string) => tokens[i] === token && ++i > 0;
  const identifier = () => {
    if (!/^[A-Z_\u0080-\uffff"`\[]/.test(tokens[i] ?? '')) return false;
    i++;
    return true;
  };
  const group = () => {
    if (!take('(')) return false;
    let depth = 1;
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token === '(') depth++;
      if (token === ')' && --depth === 0) return true;
    }
    return false;
  };
  const read = () => take('SELECT') || take('VALUES');
  if (read()) return true;
  if (take('WITH')) {
    take('RECURSIVE');
    do {
      if (!identifier() || (tokens[i] === '(' && !group()) || !take('AS')) {
        return false;
      }
      if (take('NOT')) {
        if (!take('MATERIALIZED')) return false;
      } else take('MATERIALIZED');
      if (!group()) return false;
    } while (take(','));
    return read();
  }
  if (take('PRAGMA')) {
    let name = tokens[i++];
    if (take('.')) name = tokens[i++];
    if (i === tokens.length) {
      return readPragmas.has(name) || inspectionPragmas.has(name);
    }
    return inspectionPragmas.has(name) && group() && i === tokens.length;
  }
  return false;
}
