import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

let excludedSegments = new Set(["node_modules", "dist", "reports", ".git", ".tmp"]);
let externalJson = new Set(["package.json", "package-lock.json", "tsconfig.json", "tsconfig.runtime.json"]);
const HASHLESS_STATE_PROJECTIONS = new Set(["manifests/PROJECT-STATE.json", "PROJECT-STATUS.md"]);

function parseArgs(argv) {
  const result = { root: ".", report: null, schema: null, instance: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--root", "--report", "--schema", "--instance"].includes(key) || index + 1 >= argv.length) {
      throw new TypeError(`Unknown or incomplete argument: ${key}`);
    }
    result[key.slice(2)] = argv[++index];
  }
  if (Boolean(result.schema) !== Boolean(result.instance)) {
    throw new TypeError("--schema and --instance must be supplied together");
  }
  return result;
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedSegments.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function dateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function formatErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.keyword}: ${error.message}`);
}

function addFailure(failures, scope, message) {
  failures.push(`${scope}: ${message}`);
}

function validateMigration(root, migration, failures) {
  const ids = new Set();
  const destinations = new Set();
  const counts = { COPIED: 0, REWRITTEN: 0, GENERATED: 0, EXCLUDED: 0 };
  for (const entry of migration.entries ?? []) {
    if (ids.has(entry.id)) addFailure(failures, "MIGRATION-MANIFEST", `duplicate id ${entry.id}`);
    ids.add(entry.id);
    counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
    if (entry.destination !== null) {
      if (destinations.has(entry.destination)) addFailure(failures, "MIGRATION-MANIFEST", `duplicate destination ${entry.destination}`);
      destinations.add(entry.destination);
    }
    if (entry.disposition === "COPIED") {
      if (!entry.destination || !entry.source_sha256 || !entry.destination_sha256 || entry.rewritten) {
        addFailure(failures, entry.id, "COPIED entry contract is incomplete");
      } else if (entry.source_sha256.toUpperCase() !== entry.destination_sha256.toUpperCase()) {
        addFailure(failures, entry.id, "byte-for-byte copy hashes differ");
      }
    } else if (entry.disposition === "REWRITTEN") {
      if (HASHLESS_STATE_PROJECTIONS.has(entry.destination)) {
        if (entry.category !== "RUN_ARTIFACT" || entry.source_sha256 !== null
          || entry.destination_sha256 !== null || !entry.rewritten) {
          addFailure(failures, entry.id, "hashless state projection contract is invalid");
        }
      } else if (!entry.destination || !entry.source_sha256 || !entry.rewritten) {
        addFailure(failures, entry.id, "REWRITTEN entry contract is incomplete");
      }
    } else if (entry.disposition === "GENERATED") {
      if (!entry.destination || entry.source_sha256 !== null || entry.rewritten) addFailure(failures, entry.id, "GENERATED entry contract is invalid");
    } else if (entry.disposition === "EXCLUDED") {
      if (entry.destination !== null || entry.destination_sha256 !== null || entry.rewritten) addFailure(failures, entry.id, "EXCLUDED entry contract is invalid");
    }
    if (entry.destination_sha256 && entry.destination) {
      const path = resolve(root, entry.destination);
      if (!existsSync(path) || !statSync(path).isFile()) addFailure(failures, entry.id, `destination is missing: ${entry.destination}`);
      else if (sha256(path) !== entry.destination_sha256.toUpperCase()) addFailure(failures, entry.id, `destination hash mismatch: ${entry.destination}`);
    }
  }
  const summary = migration.summary ?? {};
  const expected = {
    candidate_count: migration.entries?.length ?? 0,
    copied_count: counts.COPIED,
    rewritten_count: counts.REWRITTEN,
    generated_count: counts.GENERATED,
    excluded_count: counts.EXCLUDED,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (summary[key] !== value) addFailure(failures, "MIGRATION-MANIFEST", `${key} is ${summary[key]}, expected ${value}`);
  }
  const active = walk(root).filter((path) => !excludedSegments.has(relative(root, path).split(/[\\/]/u)[0]));
  for (const path of active) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (!destinations.has(name)) addFailure(failures, "MIGRATION-MANIFEST", `release file has no disposition: ${name}`);
  }
}

function validateSourceHashes(root, manifest, failures) {
  const paths = new Set();
  for (const entry of manifest.target_files ?? []) {
    if (paths.has(entry.path)) addFailure(failures, "SOURCE-HASHES", `duplicate path ${entry.path}`);
    paths.add(entry.path);
    const path = resolve(root, entry.path);
    if (!existsSync(path) || !statSync(path).isFile()) addFailure(failures, "SOURCE-HASHES", `missing ${entry.path}`);
    else {
      if (sha256(path) !== entry.sha256.toUpperCase()) addFailure(failures, "SOURCE-HASHES", `hash mismatch ${entry.path}`);
      if (statSync(path).size !== entry.bytes) addFailure(failures, "SOURCE-HASHES", `byte count mismatch ${entry.path}`);
    }
  }
  const excludedFiles = new Set(["manifests/SOURCE-HASHES.json", "manifests/PROJECT-STATE.json", "PROJECT-STATUS.md"]);
  for (const path of walk(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (excludedFiles.has(name)) continue;
    if (!paths.has(name)) addFailure(failures, "SOURCE-HASHES", `active file not hashed: ${name}`);
  }
}

function validateAcceptance(acceptance, failures) {
  const ids = new Set((acceptance.criteria ?? []).map((item) => item.id));
  if (ids.size !== (acceptance.criteria?.length ?? 0)) addFailure(failures, "ACCEPTANCE-CONTRACT", "criterion IDs are not unique");
  for (const id of acceptance.hard_constraints ?? []) {
    if (!ids.has(id)) addFailure(failures, "ACCEPTANCE-CONTRACT", `unknown hard constraint ${id}`);
  }
}

function validateQueuedScopeExtensions(value, failures) {
  const extensionIds = new Set();
  const workItemIds = new Set();
  const sourceIds = new Set();
  const candidateIds = new Set();
  for (const extension of value.extensions ?? []) {
    if (extensionIds.has(extension.extension_id)) addFailure(failures, "QUEUED-SCOPE-EXTENSIONS", `duplicate extension id ${extension.extension_id}`);
    extensionIds.add(extension.extension_id);
    for (const item of extension.work_items ?? []) {
      if (workItemIds.has(item.id)) addFailure(failures, "QUEUED-SCOPE-EXTENSIONS", `duplicate work item id ${item.id}`);
      workItemIds.add(item.id);
      for (const source of item.evidence_sources ?? []) {
        if (sourceIds.has(source.source_id)) addFailure(failures, "QUEUED-SCOPE-EXTENSIONS", `duplicate evidence source id ${source.source_id}`);
        sourceIds.add(source.source_id);
      }
      for (const candidate of item.candidate_experiments ?? []) {
        if (candidateIds.has(candidate.candidate_id)) addFailure(failures, "QUEUED-SCOPE-EXTENSIONS", `duplicate candidate id ${candidate.candidate_id}`);
        candidateIds.add(candidate.candidate_id);
      }
    }
  }
}

function readJson(path, failures, scope) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    addFailure(failures, scope, error.message);
    return null;
  }
}

function registerSchemas(root, failures) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addFormat("date-time", { type: "string", validate: dateTime });
  const byName = new Map();
  const schemas = walk(resolve(root, "schemas")).filter((path) => path.endsWith(".schema.json")).sort();
  for (const path of schemas) {
    const schema = readJson(path, failures, relative(root, path));
    if (!schema) continue;
    try {
      ajv.addSchema(schema);
      byName.set(basename(path, ".schema.json"), schema.$id);
    } catch (error) {
      addFailure(failures, relative(root, path), error.message);
    }
  }
  for (const [name, id] of byName) {
    try { ajv.getSchema(id); }
    catch (error) { addFailure(failures, `schema ${name}`, error.message); }
  }
  return { ajv, byName, count: schemas.length };
}

function validateInstance(ajv, schemaId, path, root, failures) {
  const value = readJson(path, failures, relative(root, path));
  if (!value) return null;
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    addFailure(failures, relative(root, path), `schema unavailable: ${schemaId}`);
    return value;
  }
  if (!validate(value)) {
    for (const message of formatErrors(validate.errors)) addFailure(failures, relative(root, path), message);
  }
  return value;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);
  const packageContract = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const releaseExcludedDirectories = packageContract.codingHarness?.releaseExcludedDirectories;
  const externalJsonContracts = packageContract.codingHarness?.externalJsonContracts;
  if (!Array.isArray(releaseExcludedDirectories) || releaseExcludedDirectories.length === 0
    || releaseExcludedDirectories.some((entry) => typeof entry !== "string" || entry.length === 0 || /[\\/]/u.test(entry))) {
    throw new TypeError("package.json releaseExcludedDirectories is invalid");
  }
  if (!Array.isArray(externalJsonContracts) || externalJsonContracts.length === 0
    || externalJsonContracts.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.includes("\\"))) {
    throw new TypeError("package.json externalJsonContracts is invalid");
  }
  excludedSegments = new Set(releaseExcludedDirectories);
  externalJson = new Set(externalJsonContracts);
  const failures = [];
  const parsed = walk(root).filter((path) => path.endsWith(".json")).sort();
  for (const path of parsed) readJson(path, failures, relative(root, path));
  const { ajv, byName, count: schemaCount } = registerSchemas(root, failures);
  let validatedInstances = 0;

  if (args.schema) {
    const schemaPath = resolve(args.schema);
    const schema = readJson(schemaPath, failures, args.schema);
    if (schema) {
      if (!ajv.getSchema(schema.$id)) {
        try { ajv.addSchema(schema); } catch (error) { addFailure(failures, args.schema, error.message); }
      }
      validateInstance(ajv, schema.$id, resolve(args.instance), root, failures);
      validatedInstances = 1;
    }
  } else {
    const pairs = [
      ["config/default.json", "config"],
      ["manifests/PROJECT-STATE.json", "project-state"],
      ["manifests/ACCEPTANCE-CONTRACT.json", "acceptance"],
      ["manifests/CACHE-PROVIDER-EVIDENCE.json", "cache-provider-evidence"],
      ["manifests/QUEUED-SCOPE-EXTENSIONS.json", "queued-scope-extensions"],
      ["manifests/MIGRATION-MANIFEST.json", "migration-manifest"],
      ["manifests/SOURCE-HASHES.json", "source-hashes"],
    ];
    for (const path of walk(resolve(root, "fixtures")).filter((item) => item.endsWith(".valid.json")).sort()) {
      pairs.push([relative(root, path).replaceAll("\\", "/"), basename(path, ".valid.json")]);
    }
    const mapped = new Set();
    const values = new Map();
    for (const [name, schemaName] of pairs) {
      const path = resolve(root, name);
      mapped.add(name);
      if (!existsSync(path)) {
        addFailure(failures, name, "required JSON instance is missing");
        continue;
      }
      const schemaId = byName.get(schemaName);
      if (!schemaId) {
        addFailure(failures, name, `local schema is missing: ${schemaName}`);
        continue;
      }
      values.set(name, validateInstance(ajv, schemaId, path, root, failures));
      validatedInstances += 1;
    }
    for (const path of parsed) {
      const name = relative(root, path).replaceAll("\\", "/");
      if (name.startsWith("schemas/") || mapped.has(name) || externalJson.has(name)) continue;
      addFailure(failures, name, "JSON file is neither schema-validated nor declared as an external tool contract");
    }
    if (values.get("manifests/MIGRATION-MANIFEST.json")) validateMigration(root, values.get("manifests/MIGRATION-MANIFEST.json"), failures);
    if (values.get("manifests/SOURCE-HASHES.json")) validateSourceHashes(root, values.get("manifests/SOURCE-HASHES.json"), failures);
    if (values.get("manifests/ACCEPTANCE-CONTRACT.json")) validateAcceptance(values.get("manifests/ACCEPTANCE-CONTRACT.json"), failures);
    if (values.get("manifests/QUEUED-SCOPE-EXTENSIONS.json")) validateQueuedScopeExtensions(values.get("manifests/QUEUED-SCOPE-EXTENSIONS.json"), failures);
  }

  const report = {
    status: failures.length ? "FAIL" : "PASS",
    json_files_parsed: parsed.length,
    schemas_compiled: schemaCount,
    schema_validated_instances: validatedInstances,
    failures,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args.report) {
    const reportPath = resolve(args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, rendered, "utf8");
  }
  process.stdout.write(rendered);
  if (failures.length) process.exitCode = 1;
}

try { run(); }
catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
