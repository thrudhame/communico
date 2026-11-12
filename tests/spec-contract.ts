import { assert, assertEquals } from '@std/assert';
import { config } from '#engine/config.ts';

export type Schema = boolean | {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, Schema>;
  patternProperties?: Record<string, Schema>;
  additionalProperties?: Schema;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean | number;
  exclusiveMaximum?: boolean | number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
};
export type SpecField = {
  field: string;
  source: string;
  required: boolean;
  description?: string;
  referenceAnnotations?: Record<string, unknown>;
  responseDescription?: string;
};
export type SpecOperation = {
  id: string;
  operationId: string;
  method: string;
  path: string;
  request: SpecField[];
  response: SpecField[];
};
export const manifest = JSON.parse(Deno.readTextFileSync(
  new URL('fixtures/spec-contracts-v1.16.json', import.meta.url),
)) as {
  schema: number;
  generatorVersion: number;
  specTag: string;
  specCommit: string;
  sources: Record<string, string>;
  schemas: Record<string, Schema>;
  operations: SpecOperation[];
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  return JSON.stringify(
    object(value)
      ? Object.fromEntries(
        Object.keys(value).sort().map((
          key,
        ) => [key, JSON.parse(canonical(value[key]))]),
      )
      : Array.isArray(value)
      ? value.map((entry) => JSON.parse(canonical(entry)))
      : value,
  );
}
export function schemaErrors(
  value: unknown,
  input: Schema,
  path = '$',
): string[] {
  if (input === true) return [];
  if (input === false) return [path + ': forbidden value'];
  if (input.$ref !== undefined) {
    const target = manifest.schemas[input.$ref];
    assert(target !== undefined, 'unresolved pinned schema ' + input.$ref);
    return schemaErrors(value, target, path);
  }
  const errors: string[] = [];
  const fail = (message: string) => errors.push(path + ': ' + message);
  if (value === null && input.nullable === true) return [];
  const types = typeof input.type === 'string' ? [input.type] : input.type;
  if (
    types !== undefined && !types.some((type) => {
      switch (type) {
        case 'object':
          return object(value);
        case 'array':
          return Array.isArray(value);
        case 'integer':
          return typeof value === 'number' && Number.isInteger(value);
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'null':
          return value === null;
        default:
          return typeof value === type;
      }
    })
  ) fail('expected ' + types.join('|'));
  if (
    input.enum !== undefined &&
    !input.enum.some((candidate) => canonical(candidate) === canonical(value))
  ) fail('value is not in enum');
  if (
    Object.hasOwn(input, 'const') && canonical(value) !== canonical(input.const)
  ) fail('value differs from const');
  for (const schema of input.allOf ?? []) {
    errors.push(...schemaErrors(value, schema, path));
  }
  if (
    input.anyOf !== undefined &&
    !input.anyOf.some((schema) =>
      schemaErrors(value, schema, path).length === 0
    )
  ) fail('no anyOf branch matches');
  if (
    input.oneOf !== undefined &&
    input.oneOf.filter((schema) =>
        schemaErrors(value, schema, path).length === 0
      ).length !== 1
  ) fail('expected exactly one oneOf branch');
  if (
    input.not !== undefined && schemaErrors(value, input.not, path).length === 0
  ) fail('forbidden schema matches');
  if (typeof value === 'number') {
    if (
      input.minimum !== undefined &&
      (value < input.minimum ||
        (input.exclusiveMinimum === true && value === input.minimum))
    ) fail('below minimum');
    if (
      input.maximum !== undefined &&
      (value > input.maximum ||
        (input.exclusiveMaximum === true && value === input.maximum))
    ) fail('above maximum');
    if (
      typeof input.exclusiveMinimum === 'number' &&
      value <= input.exclusiveMinimum
    ) fail('below exclusive minimum');
    if (
      typeof input.exclusiveMaximum === 'number' &&
      value >= input.exclusiveMaximum
    ) fail('above exclusive maximum');
    if (
      input.multipleOf !== undefined &&
      !Number.isInteger(value / input.multipleOf)
    ) fail('not a multiple');
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (input.minLength !== undefined && length < input.minLength) {
      fail('string too short');
    }
    if (input.maxLength !== undefined && length > input.maxLength) {
      fail('string too long');
    }
    if (input.pattern !== undefined && !new RegExp(input.pattern).test(value)) {
      fail('string pattern mismatch');
    }
  }
  if (Array.isArray(value)) {
    if (input.minItems !== undefined && value.length < input.minItems) {
      fail('too few array items');
    }
    if (input.maxItems !== undefined && value.length > input.maxItems) {
      fail('too many array items');
    }
    if (
      input.uniqueItems === true &&
      new Set(value.map(canonical)).size !== value.length
    ) fail('duplicate array items');
    if (input.items !== undefined) {
      for (const [index, child] of value.entries()) {
        errors.push(...schemaErrors(child, input.items, path + '/' + index));
      }
    }
  }
  if (object(value)) {
    const keys = Object.keys(value);
    if (
      input.minProperties !== undefined && keys.length < input.minProperties
    ) fail('too few object members');
    if (
      input.maxProperties !== undefined && keys.length > input.maxProperties
    ) fail('too many object members');
    for (const key of input.required ?? []) {
      if (!Object.hasOwn(value, key)) fail('missing required member ' + key);
    }
    for (const [key, child] of Object.entries(value)) {
      let matched = false;
      const property = input.properties?.[key];
      if (property !== undefined) {
        matched = true;
        errors.push(...schemaErrors(child, property, path + '/' + key));
      }
      for (
        const [pattern, schema] of Object.entries(input.patternProperties ?? {})
      ) {
        if (new RegExp(pattern).test(key)) {
          matched = true;
          errors.push(...schemaErrors(child, schema, path + '/' + key));
        }
      }
      if (!matched && input.additionalProperties !== undefined) {
        errors.push(
          ...schemaErrors(child, input.additionalProperties, path + '/' + key),
        );
      }
    }
  }
  return errors;
}

function responseSchema(
  operation: SpecOperation,
  field: SpecField,
  query = new URLSearchParams(),
): Schema {
  // The approved unconfigured TURN read follows Synapse's empty-object
  // contract. It is not permission to omit credentials for configured TURN,
  // or to return a partial credential object when unconfigured.
  if (
    operation.id ===
      'data/api/client-server/voip.yaml#GET /_matrix/client/v3/voip/turnServer'
  ) {
    const turn = config().turn;
    if (
      turn.uris.length === 0 || turn.ttl === 0 ||
      (turn.secret === '' && (turn.username === '' || turn.password === ''))
    ) {
      return { type: 'object', maxProperties: 0 };
    }
  }
  // The tagged oneOf includes an arbitrary content object and a client event,
  // so those branches overlap structurally. Its response prose discriminates
  // them by the request's format, not by counting schema matches.
  if (
    operation.id ===
      'data/api/client-server/rooms.yaml#GET /_matrix/client/v3/rooms/{roomId}/state/{eventType}/{stateKey}'
  ) {
    assert(field.responseDescription?.includes('if `?format=event` was used'));
    const schema = manifest.schemas[field.source];
    assert(typeof schema === 'object' && schema.oneOf?.length === 2);
    return schema.oneOf[query.get('format') === 'event' ? 1 : 0];
  }
  // v1.16 query.yaml explicitly permits absent profile fields to be null in
  // response prose, although its property schemas only say string. Retain the
  // tagged schema unchanged and apply that exact, reviewed prose permission.
  if (
    operation.id ===
      'data/api/server-server/query.yaml#GET /_matrix/federation/v1/query/profile'
  ) {
    assert(
      field.responseDescription?.includes(
        'exclude it from the response body or give it the value `null`',
      ),
    );
    const root = manifest.schemas[field.source];
    assert(typeof root === 'object' && root.properties !== undefined);
    return {
      ...root,
      properties: {
        ...root.properties,
        displayname: { anyOf: [root.properties.displayname, { type: 'null' }] },
        avatar_url: { anyOf: [root.properties.avatar_url, { type: 'null' }] },
      },
    };
  }
  return { $ref: field.source };
}

export function assertSpecResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
) {
  const operations = manifest.operations.filter((operation) =>
    operation.method === method && operation.path === path
  );
  assert(
    operations.length > 0,
    method + ' ' + path + ': operation not in tagged spec',
  );
  let checked = 0;
  for (const operation of operations) {
    const roots = operation.response.filter((field) =>
      field.field === 'response/' + status + '/application/json'
    );
    for (const field of roots) {
      checked++;
      assertEquals(
        schemaErrors(value, responseSchema(operation, field)),
        [],
        operation.id + ' response ' + status,
      );
    }
  }
  assert(
    checked > 0,
    method + ' ' + path + ': no tagged JSON response for ' + status,
  );
}

function matchesPath(template: string, actual: string): boolean {
  const pattern = template.split(/(\{[^}]+\})/).map((part) =>
    part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('');
  return new RegExp('^' + pattern + '$').test(actual);
}

export async function assertSpecHttpResponse(
  request: Request,
  response: Response,
) {
  if (response.status < 200 || response.status >= 300) return;
  const path = new URL(request.url).pathname;
  const operations = manifest.operations.filter((operation) =>
    operation.method === request.method && matchesPath(operation.path, path)
  );
  if (operations.length === 0) return; // Extensions have their own contracts.
  let value: unknown;
  let parsed = false;
  for (const operation of operations) {
    for (const field of operation.response) {
      if (field.field === 'response/' + response.status + '/application/json') {
        if (!parsed) {
          value = await response.clone().json();
          parsed = true;
        }
        assertEquals(
          schemaErrors(
            value,
            responseSchema(operation, field, new URL(request.url).searchParams),
          ),
          [],
          operation.id + ' HTTP response',
        );
      }
      const prefix = 'header/' + response.status + '/';
      if (
        field.field.startsWith(prefix) &&
        !field.field.slice(prefix.length).includes('/')
      ) {
        const name = field.field.slice(prefix.length);
        const header = response.headers.get(name);
        if (header === null) {
          assert(
            !field.required,
            operation.id + ': missing required header ' + name,
          );
        } else {assertEquals(
            schemaErrors(header, { $ref: field.source }),
            [],
            operation.id + ' header ' + name,
          );}
      }
    }
  }
}
