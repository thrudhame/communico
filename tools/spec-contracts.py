#!/usr/bin/env python3
"""Generate the v1.16 operation contracts from a local matrix-spec checkout.

Requires PyYAML. Reads the tag with git show, never the spec working tree.
Run with --check in the project execution guest after making the pinned source
checkout available. Generation is source analysis, not a homeserver workload.
"""
import argparse
import hashlib
import json
import pathlib
import posixpath
import re
import subprocess

import yaml


def generate(source):
    tag = "v1.16"
    commit = subprocess.check_output(
        ["git", "rev-parse", tag + "^{commit}"], cwd=source, text=True
    ).strip()
    documents = {}
    hashes = {}
    schemas = {}

    def document(file):
        if file not in documents:
            raw = subprocess.check_output(["git", "show", tag + ":" + file], cwd=source)
            hashes[file] = hashlib.sha256(raw).hexdigest()
            documents[file] = yaml.safe_load(raw)
        return documents[file]

    def pointer(parts):
        return "/" + "/".join(str(p).replace("~", "~0").replace("/", "~1") for p in parts)

    def resolve(schema, file, parts):
        seen = set()
        annotations = {}
        while isinstance(schema, dict) and "$ref" in schema:
            ref = schema["$ref"]
            if (file, ref) in seen:
                raise ValueError("cyclic direct schema reference: " + file + ref)
            seen.add((file, ref))
            annotations.update({k: v for k, v in schema.items() if k != "$ref"})
            target, _, fragment = ref.partition("#")
            if target:
                file = posixpath.normpath(str(pathlib.PurePosixPath(file).parent / target))
            schema = document(file)
            parts = ()
            for part in fragment.lstrip("/").split("/") if fragment else []:
                part = part.replace("~1", "/").replace("~0", "~")
                key = int(part) if isinstance(schema, list) else part
                schema = schema[key]
                parts += (key,)
        return schema, file, parts, annotations

    def schema_reference(value, file, parts):
        if isinstance(value, bool):
            return value
        value, file, parts, _ = resolve(value, file, parts)
        identity = file + "#" + pointer(parts)
        if identity in schemas:
            return {"$ref": identity}
        schemas[identity] = {}
        result = {}
        for key in ("type", "enum", "const", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "pattern", "required", "nullable", "format", "description"):
            if key in value:
                result[key] = value[key]
        for key in ("properties", "patternProperties"):
            if key in value:
                result[key] = {name: schema_reference(child, file, parts + (key, name)) for name, child in value[key].items()}
        for key in ("items", "additionalProperties", "not"):
            if key in value:
                result[key] = schema_reference(value[key], file, parts + (key,))
        for key in ("allOf", "anyOf", "oneOf"):
            if key in value:
                result[key] = [schema_reference(child, file, parts + (key, index)) for index, child in enumerate(value[key])]
        schemas[identity] = result
        return {"$ref": identity}

    def fields(schema, file, parts, path, required=False, ancestors=()):
        schema, file, parts, annotations = resolve(schema, file, parts)
        if not isinstance(schema, dict):
            return []
        schema_reference(schema, file, parts)
        row = {"field": path, "source": file + "#" + pointer(parts), "required": required}
        for key in ("type", "enum", "default", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "description", "nullable"):
            if key in schema:
                row[key] = schema[key]
        if annotations:
            row["referenceAnnotations"] = annotations
        identity = (file, parts)
        if identity in ancestors:
            row["recursive"] = True
            return [row]
        ancestors += (identity,)
        result = [row]
        for name, child in schema.get("properties", {}).items():
            result += fields(child, file, parts + ("properties", name), path + "/" + name.replace("~", "~0").replace("/", "~1"), name in schema.get("required", []), ancestors)
        if "items" in schema:
            result += fields(schema["items"], file, parts + ("items",), path + "/[]", False, ancestors)
        if isinstance(schema.get("additionalProperties"), dict):
            result += fields(schema["additionalProperties"], file, parts + ("additionalProperties",), path + "/*", False, ancestors)
        for pattern, child in schema.get("patternProperties", {}).items():
            result += fields(child, file, parts + ("patternProperties", pattern), path + "/{" + pattern + "}", False, ancestors)
        for composition in ("allOf", "anyOf", "oneOf"):
            for index, child in enumerate(schema.get(composition, [])):
                result += fields(child, file, parts + (composition, index), path + "/" + composition + str(index), required, ancestors)
        return result

    paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", tag, "data/api/client-server", "data/api/server-server"], cwd=source, text=True).splitlines()
    operations = []
    for file in paths:
        if file.count("/") != 3 or not file.endswith(".yaml"):
            continue
        doc = document(file)
        server = doc.get("servers", [{}])[0]
        base = server.get("variables", {}).get("basePath", {}).get("default", "")
        if not base and "basePath" not in server.get("url", ""):
            base = re.sub(r"^\{[^}]+\}://\{[^}]+\}", "", server.get("url", ""))
        for path, item in doc.get("paths", {}).items():
            for method, operation in item.items():
                if method not in {"get", "post", "put", "delete", "patch", "head", "options"}:
                    continue
                fullpath = (base.rstrip("/") + path).strip()
                if fullpath in {"/_matrix/client/v3/pushrules", "/_matrix/client/v3/pushrules/global"}:
                    fullpath += "/"
                loc = ("paths", path, method)
                entry = {"id": file + "#" + method.upper() + " " + fullpath, "operationId": operation.get("operationId"), "method": method.upper(), "path": fullpath, "description": operation.get("description", ""), "request": [], "response": []}
                for owner, ploc in [(item, ("paths", path)), (operation, loc)]:
                    for index, param in enumerate(owner.get("parameters", [])):
                        param, pf, pp, _ = resolve(param, file, ploc + ("parameters", index))
                        rows = fields(param.get("schema", {}), pf, pp + ("schema",), param["in"] + "/" + param["name"], param.get("required", False))
                        if rows:
                            rows[0]["description"] = param.get("description", "")
                        entry["request"] += rows
                if "requestBody" in operation:
                    body, bf, bp, _ = resolve(operation["requestBody"], file, loc + ("requestBody",))
                    for mime, content in body.get("content", {}).items():
                        entry["request"] += fields(content.get("schema", {}), bf, bp + ("content", mime, "schema"), "body/" + mime, body.get("required", False))
                for status, response in operation.get("responses", {}).items():
                    if not str(status).startswith("2"):
                        continue
                    response, rf, rp, _ = resolve(response, file, loc + ("responses", status))
                    for header, value in response.get("headers", {}).items():
                        value, hf, hp, _ = resolve(value, rf, rp + ("headers", header))
                        entry["response"] += fields(value.get("schema", {}), hf, hp + ("schema",), "header/" + str(status) + "/" + header, value.get("required", False))
                    for mime, content in response.get("content", {}).items():
                        rows = fields(content.get("schema", {}), rf, rp + ("content", mime, "schema"), "response/" + str(status) + "/" + mime)
                        if rows:
                            rows[0]["responseDescription"] = response.get("description", "")
                        entry["response"] += rows
                operations.append(entry)
    return {"schema": 1, "generatorVersion": 1, "specTag": tag, "specCommit": commit, "sources": dict(sorted(hashes.items())), "schemas": dict(sorted(schemas.items())), "operations": sorted(operations, key=lambda operation: operation["id"])}


def body_contracts(manifest):
    """Keep requestBody.required intact; derive the empty-object compatibility.

    Synapse/Complement accept missing JSON bytes for operations such as join,
    whose v1.16 body is marked required but whose object has no required fields.
    This does not make required fields optional or accept whitespace as absence.
    """
    def accepts_empty(schema):
        if isinstance(schema, bool):
            return schema
        if "$ref" in schema:
            return accepts_empty(manifest["schemas"][schema["$ref"]])
        types = schema.get("type", "object")
        if isinstance(types, str):
            types = [types]
        if "object" not in types or schema.get("required") or schema.get("minProperties", 0) > 0:
            return False
        if "enum" in schema and {} not in schema["enum"]:
            return False
        if "const" in schema and schema["const"] != {}:
            return False
        if not all(accepts_empty(s) for s in schema.get("allOf", [])):
            return False
        if "anyOf" in schema and not any(accepts_empty(s) for s in schema["anyOf"]):
            return False
        if "oneOf" in schema and sum(accepts_empty(s) for s in schema["oneOf"]) != 1:
            return False
        return "not" not in schema or not accepts_empty(schema["not"])

    operations = []
    for operation in manifest["operations"]:
        for field in operation["request"]:
            if field["field"] == "body/application/json":
                operations.append(dict(id=operation["id"], method=operation["method"],
                    path=operation["path"], required=field["required"],
                    emptyObject=accepts_empty(manifest["schemas"][field["source"]])))
    return dict(schema=1, specCommit=manifest["specCommit"], operations=operations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--body-output", type=pathlib.Path)
    args = parser.parse_args()
    result = generate(args.source)
    bodies = body_contracts(result)
    body_output = args.body_output or pathlib.Path(__file__).resolve().parents[1] / "api/engine/operation-bodies.json"
    if args.check:
        if json.loads(args.output.read_text()) != result:
            raise SystemExit("OpenAPI manifest differs from the pinned source")
        if json.loads(body_output.read_text()) != bodies:
            raise SystemExit("Operation body contracts differ from the pinned source")
        print("OpenAPI manifest matches pinned source")
    else:
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=True) + "\n")
        body_output.write_text(json.dumps(bodies, indent=2, ensure_ascii=True) + "\n")
        print("Generated", len(result["operations"]), "operations")


if __name__ == "__main__":
    main()
