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
    shutdowngraceseconds: 'int',
  },
  admin: {
    socket: 'string',
  },
  media: {
    root: 'string',
    maxbytes: 'int',
  },
  e2ee: {
    maxrequestbytes: 'int',
    maxkeybytes: 'int',
    maxkeys: 'int',
    maxonetimekeys: 'int',
    maxinboxmessages: 'int',
    maxdestinationmessages: 'int',
    maxbackupsessions: 'int',
    maxbackupversions: 'int',
  },
  store: {
    dir: 'string',
    library: 'string',
    checkpointlogbytes: 'int',
    maxopenfiles: 'int',
    idleseconds: 'int',
  },
  preview: {
    enabled: 'bool',
    maxbytes: 'int',
    blocklist: 'list',
    allowlist: 'list',
  },
  federation: {
    enabled: 'bool',
    port: 'int',
    cert: 'string',
    key: 'string',
    cacerts: 'list',
    keyvalidityhours: 'int',
    keychange: 'string',
    mode: 'string',
    wellknown: 'string',
    wellknownmaxage: 'int',
    connectms: 'int',
    timeoutms: 'int',
    maxbytes: 'int',
    wellknownhours: 'int',
    wellknownmaxhours: 'int',
    wellknownerrorhours: 'int',
    keyfailminutes: 'int',
    witnesses: 'int',
    pendingmax: 'int',
    pendingdays: 'int',
    lookups: 'string',
    missingwaitms: 'int',
    missinglimit: 'int',
    missingbudgetms: 'int',
    missingmax: 'int',
    backfillbatch: 'int',
    backfillmax: 'int',
    bulkmaxbytes: 'int',
    backoffstartmillihours: 'int',
    backoffmaxmillihours: 'int',
    refusedmillihours: 'int',
    ungroundedmillihours: 'int',
    txnhours: 'int',
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
