// api/engine/config-schema.ts — the configuration tree. Every leaf is
// required; types are `'string' | 'int' | 'bool' | 'list'`. The shipped
// defaults file is the explicit statement — nothing is defaulted here.

export type LeafType = 'string' | 'int' | 'bool' | 'list';

export type Schema = {
  readonly [key: string]: LeafType | Schema;
};

export const SCHEMA = {
  server: {
    name: 'string',
    port: 'int',
  },
  db: {
    host: 'string',
    port: 'int',
    user: 'string',
    pass: 'string',
    name: 'string',
  },
  media: {
    root: 'string',
    maxbytes: 'int',
  },
  preview: {
    enabled: 'bool',
    maxbytes: 'int',
    blocklist: 'list',
    allowlist: 'list',
  },
} as const satisfies Schema;

type TypeOf<T extends LeafType> = T extends 'string' ? string
  : T extends 'int' ? number
  : T extends 'bool' ? boolean
  : string[];

type ConfigOf<S> = {
  [K in keyof S]: S[K] extends LeafType ? TypeOf<S[K]> : ConfigOf<S[K]>;
};

export type Config = ConfigOf<typeof SCHEMA>;

export function leaves(
  schema: Schema,
  prefix: string[] = [],
): [string[], LeafType][] {
  const out: [string[], LeafType][] = [];
  for (const [key, spec] of Object.entries(schema)) {
    const path = [...prefix, key];
    if (
      spec === 'string' || spec === 'int' || spec === 'bool' || spec === 'list'
    ) {
      out.push([path, spec]);
    } else {
      out.push(...leaves(spec, path));
    }
  }
  return out;
}

export function envNameOf(path: string[]): string {
  return 'COMMUNICO_' + path.map((p) => p.toUpperCase()).join('_');
}

export function nodePathOf(path: string[]): string {
  return path.join('.');
}
