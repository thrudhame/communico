import pgpkg from 'pg';

const { Client } = pgpkg;

export interface SpikeClientOptions {
  database?: string;
  port?: number;
}

export function makeClient(opts: SpikeClientOptions = {}) {
  return new Client({
    host: '127.0.0.1',
    port: opts.port ?? 5432,
    user: 'root',
    password: 'secret',
    database: opts.database ?? 'postgres',
  });
}

export interface StepResult {
  label: string;
  ok: boolean;
  detail: string;
}

export class Spike {
  results: StepResult[] = [];
  constructor(public name: string) {}

  record(label: string, ok: boolean, detail: unknown) {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.results.push({ label, ok, detail: d });
    console.log(`  [${ok ? 'ok' : 'FAIL'}] ${label}: ${d}`);
  }

  // Run a statement, record success/failure, return rows (or null on error).
  async try(client: pgpkg.Client, label: string, sql: string) {
    try {
      const res = await client.query(sql);
      this.record(label, true, res.rows.slice(0, 5));
      return res.rows;
    } catch (e) {
      this.record(label, false, String(e));
      return null;
    }
  }

  finish(): boolean {
    const pass = this.results.every((r) => r.ok);
    console.log(`SPIKE ${this.name}: ${pass ? 'PASS' : 'FAIL'}`);
    console.log(`RESULTS-BLOCK-START`);
    console.log(`## ${this.name}`);
    console.log(`Status: ${pass ? 'PASS' : 'FAIL'}`);
    for (const r of this.results) {
      console.log(`- ${r.ok ? 'ok' : 'FAIL'} ${r.label}: ${r.detail}`);
    }
    console.log(`RESULTS-BLOCK-END`);
    return pass;
  }
}
