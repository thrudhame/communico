import { assert, assertEquals } from '@std/assert';
import { manifest, type SpecField } from '#tests/spec-contract.ts';
import { decodedField, decoderReads } from '#tests/spec-decoder.ts';

type Proof = { suite: string; case: string; test?: string; testClass?: string };
type Binding = {
  reviewed: boolean;
  decoder: string;
  owner: string;
  disposition: 'honored' | 'permitted no-op' | 'module disabled/rejected';
  proofs: Proof[];
  note: string;
};
type Consumption = {
  schema: number;
  specCommit: string;
  manifestSha256: string;
  bindings: Record<string, Binding>;
  notApplicable: Record<string, Record<string, string>>;
  proseContracts: {
    id: string;
    operation: string;
    source: string;
    binding: string;
    condition: string;
  }[];
  operations: {
    id: string;
    status: string;
    routes: string[];
    binding: string;
    request: {
      field: string;
      source: string;
      binding: string;
      review: string;
      decoders: string[];
    }[];
    response: SpecField[];
  }[];
};
export const consumption = JSON.parse(Deno.readTextFileSync(
  new URL('fixtures/spec-consumption-v1.16.json', import.meta.url),
)) as Consumption;

export function assertConsumptionInventory(candidate: Consumption) {
  assertEquals(candidate.schema, 1);
  assertEquals(candidate.specCommit, manifest.specCommit);
  const ids = candidate.operations.map((op) => op.id);
  assertEquals([...ids].sort(), manifest.operations.map((op) => op.id).sort());
  assertEquals(new Set(ids).size, ids.length, 'duplicate ledger operation');
  assertEquals(candidate.proseContracts.map((contract) => contract.id).sort(), [
    'profile-capability-legacy-flags',
    'search-global-and-group-continuations',
    'unconfigured-turn-empty-read',
  ]);
  for (const contract of candidate.proseContracts) {
    assert(
      ids.includes(contract.operation) &&
        manifest.schemas[contract.source] !== undefined &&
        candidate.bindings[contract.binding] !== undefined &&
        contract.condition.length > 0,
      contract.id + ': missing conditional/prose obligation',
    );
  }
  for (const operation of manifest.operations) {
    const row = candidate.operations.find((row) => row.id === operation.id)!;
    const fields = row.request.map((field) => field.field);
    assertEquals(
      new Set(fields).size,
      fields.length,
      operation.id + ': duplicate request field',
    );
    assertEquals(
      row.request.map((field) => [field.field, field.source]).sort(),
      operation.request.map((field) => [field.field, field.source]).sort(),
      operation.id + ': unclassified or stale request node',
    );
    assertEquals(
      row.response,
      operation.response,
      operation.id + ': response or prose contract lost',
    );
    for (const field of row.request) {
      assert(
        field.decoders.length > 0,
        operation.id + '/' + field.field + ': missing adapter',
      );
      assert(
        candidate.bindings[field.binding],
        operation.id + '/' + field.field + ': unreviewed request field',
      );
    }
    assert(
      candidate.bindings[row.binding],
      operation.id + ': unreviewed operation',
    );
  }
  for (const [name, binding] of Object.entries(candidate.bindings)) {
    assert(
      ['honored', 'permitted no-op', 'module disabled/rejected'].includes(
        binding.disposition,
      ),
      name + ': unresolved disposition',
    );
    assert(
      binding.decoder.startsWith('api/') && binding.owner.startsWith('api/'),
      name + ': missing ownership',
    );
    if (binding.disposition !== 'honored') {
      assert(binding.note.length > 0, name + ': missing normative rationale');
    }
    assert(binding.proofs.length > 0, name + ': no consumer proof');
    for (const proof of binding.proofs) {
      assert(
        /^[\w-]+$/.test(proof.suite) && proof.case.length > 0,
        name + ': invalid proof identity',
      );
    }
  }
}

export function unconsumedParameters(candidate = consumption): string[] {
  const missing: string[] = [];
  for (const operation of candidate.operations) {
    const exceptions = candidate.notApplicable[operation.id] ?? {};
    for (const [field, reason] of Object.entries(exceptions)) {
      assert(
        operation.request.some((entry) => entry.field === field),
        operation.id + '/' + field + ': stale not-applicable entry',
      );
      assert(
        reason.length > 0,
        operation.id + '/' + field + ': missing rationale',
      );
    }
    if (operation.status !== 'Routed') {
      assert(
        candidate.bindings[operation.binding].note.length > 0,
        operation.id + ': unavailable module needs an explicit reason',
      );
      continue;
    }
    const reads = operation.routes.map((route) => decoderReads(route));
    for (const parameter of operation.request) {
      const binding = candidate.bindings[parameter.binding];
      if (exceptions[parameter.field]) continue;
      if (binding.disposition !== 'honored' && binding.note.length > 0) {
        continue;
      }
      for (let i = 0; i < reads.length; i++) {
        let field = parameter.field;
        if (field.startsWith('path/')) {
          const specPath = operation.id.slice(operation.id.indexOf(' ') + 1)
            .split('/');
          const index = specPath.indexOf('{' + field.slice(5) + '}');
          const routePath = operation.routes[i].replace(
            'api/endpoints/matrix',
            '',
          ).split('/').slice(0, -1);
          if (index >= 0 && !routePath[index]?.startsWith('#')) continue;
          if (index >= 0) field = 'path/' + routePath[index].slice(1);
        }
        if (!decodedField(field, reads[i])) {
          missing.push(
            operation.id + '/' + parameter.field + ' (' + operation.routes[i] +
              ')',
          );
        }
      }
    }
  }
  return missing;
}

export function consumptionProofs(): Proof[] {
  const seen = new Set<string>();
  return Object.values(consumption.bindings).flatMap((binding) =>
    binding.proofs
  ).filter((proof) => {
    const key = proof.suite + '/' + proof.case;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// JUnit names are XML escaped. Match complete testcase attribute values, not
// substrings in failure text, suite names or the command's own output.
const xmlText = (value: string) =>
  value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
export function assertConsumptionProofs(
  xml: string,
  proofs = consumptionProofs(),
) {
  const cases = [
    ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ].map(([, attributes, content]) => ({
    name: xmlText(attributes.match(/\bname="([^"]*)"/)?.[1] ?? ''),
    className: xmlText(attributes.match(/\bclassname="([^"]*)"/)?.[1] ?? ''),
    content: content ?? '',
  }));
  for (const proof of proofs) {
    const matches = cases.filter((test) =>
      test.className.endsWith(
        '/' + (proof.testClass ?? 'tests/' + proof.suite + '.test.ts'),
      ) &&
      test.name === (proof.test ?? proof.case)
    );
    assert(
      matches.length > 0,
      proof.suite + ': consumer case did not execute: ' + proof.case,
    );
    assert(
      matches.every((test) =>
        !/<(?:failure|error|skipped)\b/.test(test.content)
      ),
      proof.suite + ': consumer case failed or skipped: ' + proof.case,
    );
  }
}
