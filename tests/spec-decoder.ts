// Static request-flow analysis, not a search for field names in import closures.
// Follow values from an adapter's request through called functions. A property
// read counts only when its receiver originates in that operation's request.
import ts from 'typescript';

type Value = {
  paths: string[];
  strings: string[];
  fields: Record<string, Value>;
  functions: Callable[];
  shadowed: Set<string>;
};
type Callable = {
  file: string;
  node: ts.FunctionLikeDeclaration;
  closure: Map<string, Value>;
};
const empty = (): Value => ({
  paths: [],
  strings: [],
  fields: Object.create(null),
  functions: [],
  shadowed: new Set(),
});
const symbolic = (...paths: string[]): Value => ({ ...empty(), paths });
const carriesInput = (value: Value): boolean =>
  value.paths.length > 0 ||
  Object.values(value.fields).some(carriesInput);
function union(...values: Value[]): Value {
  const out = empty();
  for (const value of values) {
    out.paths.push(...value.paths);
    out.strings.push(...value.strings);
    out.functions.push(...value.functions);
    for (const [key, child] of Object.entries(value.fields)) {
      out.fields[key] = union(out.fields[key] ?? empty(), child);
    }
  }
  out.paths = [...new Set(out.paths)];
  out.strings = [...new Set(out.strings)];
  const sources = values.filter((value) => value.paths.length > 0);
  if (sources.length > 0) {
    out.shadowed = new Set(
      [...sources[0].shadowed].filter((name) =>
        sources.every((value) => value.shadowed.has(name))
      ),
    );
  }
  return out;
}
type Module = {
  source: ts.SourceFile;
  imports: Map<string, { file: string; name: string }>;
  namespaces: Map<string, string>;
  exports: Map<string, string>;
  functions: Map<string, ts.FunctionLikeDeclaration>;
  variables: Map<string, ts.Expression>;
};
const modules = new Map<string, Module>();
const root = new URL('../', import.meta.url);
function resolve(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('#engine/')) {
    return 'api/engine/' + specifier.slice(8);
  }
  if (specifier.startsWith('#root/')) return specifier.slice(6);
  if (specifier.startsWith('#endpoints/')) {
    return 'api/endpoints/' + specifier.slice(11);
  }
  if (specifier.startsWith('.')) {
    return new URL(specifier, new URL(file, root)).pathname.slice(
      root.pathname.length,
    );
  }
}
function module(
  file: string,
  overrides: Map<string, string>,
  cache: Map<string, Module>,
): Module {
  const previous = cache.get(file);
  if (previous) return previous;
  const source = ts.createSourceFile(
    file,
    overrides.get(file) ??
      Deno.readTextFileSync(new URL(file.replaceAll('#', '%23'), root)),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result: Module = {
    source,
    imports: new Map(),
    namespaces: new Map(),
    exports: new Map(),
    functions: new Map(),
    variables: new Map(),
  };
  cache.set(file, result);
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolve(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const clause = statement.importClause;
      if (clause?.name) {
        result.imports.set(clause.name.text, { file: target, name: 'default' });
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        result.namespaces.set(clause.namedBindings.name.text, target);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          if (!item.isTypeOnly) {
            result.imports.set(item.name.text, {
              file: target,
              name: item.propertyName?.text ?? item.name.text,
            });
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? 'default';
      result.functions.set(name, statement);
      if (
        statement.modifiers?.some((m) =>
          m.kind === ts.SyntaxKind.DefaultKeyword
        )
      ) {
        result.exports.set('default', name);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          result.variables.set(declaration.name.text, declaration.initializer);
        }
        if (
          ts.isIdentifier(declaration.name) && declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          result.functions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) && statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const target = statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ? resolve(file, statement.moduleSpecifier.text)
        : undefined;
      for (const item of statement.exportClause.elements) {
        const name = item.propertyName?.text ?? item.name.text;
        if (target) result.imports.set(item.name.text, { file: target, name });
        else result.exports.set(item.name.text, name);
      }
    }
  }
  return result;
}

export function decoderReads(
  route: string,
  overrides = new Map<string, string>(),
): Set<string> {
  const reads = new Set<string>();
  const active = new Set<ts.Node>();
  const cache = overrides.size ? new Map<string, Module>() : modules;
  function callable(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): Value {
    const identity = file + ':' + name;
    if (seen.has(identity)) return empty();
    seen.add(identity);
    const mod = module(file, overrides, cache);
    name = mod.exports.get(name) ?? name;
    const node = mod.functions.get(name);
    if (node) {
      return { ...empty(), functions: [{ file, node, closure: new Map() }] };
    }
    const imported = mod.imports.get(name);
    if (imported) return callable(imported.file, imported.name, seen);
    const value = mod.variables.get(name);
    return value ? expression(value, file, new Map()) : empty();
  }
  function member(value: Value, names: string[]): Value {
    const out = union(
      ...names.flatMap((name) =>
        name === '*'
          ? Object.values(value.fields)
          : [value.fields[name] ?? value.fields['*'] ?? empty()]
      ),
    );
    for (const path of value.paths) {
      for (const name of names) {
        // Explicit properties replace spread values, including their source.
        if (value.shadowed.has(name)) continue;
        const selected = path + '/' + name;
        out.paths.push(selected);
        if (/^(body|query|path|header)\//.test(selected)) reads.add(selected);
      }
    }
    return out;
  }
  function bind(name: ts.BindingName, value: Value, env: Map<string, Value>) {
    if (ts.isIdentifier(name)) env.set(name.text, value);
    else {for (const [index, element] of name.elements.entries()) {
        if (ts.isOmittedExpression(element)) continue;
        const key = ts.isArrayBindingPattern(name)
          ? String(index)
          : element.propertyName?.getText().replace(/^['"]|['"]$/g, '') ??
            element.name.getText();
        bind(element.name, member(value, [key]), env);
      }}
  }
  function invoke(fn: Callable, args: Value[]): Value {
    if (active.has(fn.node)) return empty();
    active.add(fn.node);
    const env = new Map(fn.closure);
    fn.node.parameters.forEach((param, i) =>
      bind(param.name, args[i] ?? empty(), env)
    );
    const returns: Value[] = [];
    if (fn.node.body) {
      if (ts.isBlock(fn.node.body)) walk(fn.node.body, fn.file, env, returns);
      else returns.push(expression(fn.node.body, fn.file, env));
    }
    active.delete(fn.node);
    return union(...returns);
  }
  function expression(
    node: ts.Node | undefined,
    file: string,
    env: Map<string, Value>,
  ): Value {
    if (!node) return empty();
    if (ts.isIdentifier(node)) {
      return env.get(node.text) ?? callable(file, node.text);
    }
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
      return { ...empty(), strings: [node.text] };
    }
    if (
      ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) ||
      ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ) {
      return expression(node.expression, file, env);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return { ...empty(), functions: [{ file, node, closure: new Map(env) }] };
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const namespace = module(file, overrides, cache).namespaces.get(
          node.expression.text,
        );
        if (namespace) return callable(namespace, node.name.text);
      }
      const receiver = expression(node.expression, file, env);
      if (receiver.paths.includes('request')) {
        const kind = {
          query: 'query',
          params: 'path',
          headers: 'header',
          body: 'body/application/octet-stream',
        }[node.name.text];
        if (kind) return symbolic(kind);
      }
      return member(receiver, [node.name.text]);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = expression(node.argumentExpression, file, env);
      return member(
        expression(node.expression, file, env),
        key.strings.length ? key.strings : ['*'],
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      let out = empty();
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) {
          out = union(out, expression(item.expression, file, env));
        } else if (
          ts.isPropertyAssignment(item) ||
          ts.isShorthandPropertyAssignment(item)
        ) {
          const names = ts.isComputedPropertyName(item.name)
            ? expression(item.name.expression, file, env).strings
            : [item.name.getText().replace(/^['"]|['"]$/g, '')];
          for (const name of names.length ? names : ['*']) {
            out.fields[name] = expression(
              ts.isPropertyAssignment(item) ? item.initializer : item.name,
              file,
              env,
            );
            out.shadowed.add(name);
          }
        }
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map((item) => expression(item, file, env));
      return {
        ...empty(),
        strings: items.flatMap((v) => v.strings),
        fields: { '[]': union(...items) },
      };
    }
    if (ts.isConditionalExpression(node)) {
      expression(node.condition, file, env);
      return union(
        expression(node.whenTrue, file, env),
        expression(node.whenFalse, file, env),
      );
    }
    if (ts.isBinaryExpression(node)) {
      const right = expression(node.right, file, env);
      const left = expression(node.left, file, env);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return {
          ...union(left, right),
          strings: left.strings.flatMap((a) => right.strings.map((b) => a + b)),
        };
      }
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        env.set(
          node.left.text,
          union(env.get(node.left.text) ?? empty(), right),
        );
      }
      return union(left, right);
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map((arg) => expression(arg, file, env));
      const name = node.expression.getText();
      const functions = expression(node.expression, file, env).functions;
      if (
        functions.some((fn) =>
          fn.file === 'api/engine/operation-body.ts' &&
          fn.node.name?.getText() === 'parseJson'
        )
      ) {
        return args[0]?.paths.includes('request')
          ? symbolic('body/application/json')
          : empty();
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = expression(node.expression.expression, file, env);
        const method = node.expression.name.text;
        if (
          method === 'json' &&
          receiver.paths.includes('body/application/octet-stream')
        ) {
          return symbolic('body/application/json');
        }
        if (['catch', 'finally', 'then'].includes(method)) return receiver;
        if (method === 'stream' || method === 'bytes') {
          for (const path of receiver.paths) reads.add(path);
        }
        if (
          (method === 'get' || method === 'getAll' || method === 'has') &&
          receiver.paths.some((path) => ['query', 'header'].includes(path))
        ) {
          const selected = member(receiver, args[0]?.strings ?? []);
          return method === 'getAll' ? member(selected, ['[]']) : selected;
        }
        if (
          ['map', 'forEach', 'filter', 'every', 'some', 'flatMap'].includes(
            method,
          )
        ) {
          const item = union(member(receiver, ['[]']), {
            ...empty(),
            strings: receiver.strings,
          });
          const output = (args[0]?.functions ?? []).map((fn) =>
            invoke(fn, [item])
          );
          return method === 'map' || method === 'flatMap'
            ? { ...empty(), fields: { '[]': union(...output) } }
            : receiver;
        }
        if (name === 'Object.entries' || name === 'Object.values') {
          const value = member(args[0], ['*']);
          return {
            ...empty(),
            fields: {
              '[]': name === 'Object.entries'
                ? { ...empty(), fields: { '0': empty(), '1': value } }
                : value,
            },
          };
        }
        if (name === 'JSON.stringify') {
          for (const path of args[0]?.paths ?? []) reads.add(path + '/**');
        }
        if (name === 'JSON.parse') return args[0] ?? empty();
      }
      if (functions.length) {
        return union(
          ...functions.filter((fn) =>
            args.some(carriesInput) ||
            [...fn.closure.values()].some(carriesInput)
          ).map((fn) => invoke(fn, args)),
        );
      }
      // The tenant's transaction API injects tx through a callback; follow the
      // callback with its captured request values, without running a store.
      for (const arg of args) {
        for (const fn of arg.functions) invoke(fn, [empty()]);
      }
      // Follow the dynamic transaction seam through its actual binding and
      // argument mapping, not an assumed forwarding contract.
      const bound = name.endsWith('.keyBackup.version')
        ? 'version'
        : name.endsWith('.keyBackup.keys')
        ? 'keys'
        : undefined;
      if (bound && args.some(carriesInput)) {
        const tx = union(
          ...callable('api/engine/tenant/index.ts', 'bind').functions
            .map((fn) => invoke(fn, [])),
        );
        return union(
          ...member(member(tx, ['keyBackup']), [bound]).functions
            .map((fn) => invoke(fn, args)),
        );
      }
      // Shape/primitive validators preserve input identity; do not infer a
      // property read or whole-request consumption from an unknown call.
      return union(...args);
    }
    const values: Value[] = [];
    ts.forEachChild(node, (child) => {
      values.push(expression(child, file, env));
    });
    return union(...values);
  }
  function walk(
    node: ts.Node,
    file: string,
    env: Map<string, Value>,
    returns: Value[],
  ) {
    if (ts.isVariableDeclaration(node)) {
      bind(node.name, expression(node.initializer, file, env), env);
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns.push(expression(node.expression, file, env));
      return;
    }
    if (ts.isExpressionStatement(node)) {
      expression(node.expression, file, env);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) {
        env.set(node.name.text, {
          ...empty(),
          functions: [{ file, node, closure: env }],
        });
      }
      return;
    }
    if (ts.isForOfStatement(node)) {
      const value = expression(node.expression, file, env);
      const element = union(member(value, ['[]']), {
        ...empty(),
        strings: value.strings,
      });
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          bind(declaration.name, element, env);
        }
      }
      walk(node.statement, file, env, returns);
      return;
    }
    // Conditions are reads too; declarations/types are not executable input use.
    if (ts.isExpression(node)) {
      expression(node, file, env);
      return;
    }
    if (ts.isTypeNode(node)) return;
    ts.forEachChild(node, (child) => walk(child, file, env, returns));
  }
  const entry = callable(route, 'default');
  for (const fn of entry.functions) invoke(fn, [symbolic('request'), empty()]);
  return reads;
}

export function decodedField(field: string, reads: Set<string>): boolean {
  // Composition nodes are schema structure, not actual JSON properties.
  const physical = field.replace(/\/(?:allOf|anyOf|oneOf)\d+(?=\/|$)/g, '')
    .replace(/\/\{[^}]+\}/g, '/*');
  const matches = (a: string, b: string) => {
    const left = a.split('/');
    const right = b.split('/');
    return left.length <= right.length &&
      left.every((part, i) =>
        part === right[i] || part === '*' || right[i] === '*'
      );
  };
  return [...reads].some((read) => {
    if (read.endsWith('/**')) {
      const prefix = read.slice(0, -3);
      if (!matches(prefix, physical)) return false;
      // Serializing an opaque map consumes its values, but persisting a whole
      // request is not evidence that its named schema fields were decoded.
      return physical.slice(prefix.length).split('/').filter(Boolean)
        .every((part) => part === '*' || part === '[]');
    }
    // Reading a child consumes its enclosing container. A container read does
    // not consume an unread named child.
    return matches(physical, read) ||
      (physical.endsWith('/[]') && read === physical.slice(0, -3));
  });
}
