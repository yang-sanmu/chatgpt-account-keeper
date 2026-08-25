import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { METHOD_CONTRACTS } from "../src/agent/methodContracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const mainSchemaPath = path.join(root, "contracts", "ipc-v1.schema.json");
const methodSchemaPath = path.join(root, "contracts", "ipc-v1.methods.schema.json");
const outputPath = path.join(root, "app", "src", "ipc", "generated.ts");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "$ref" || typeof child !== "string") return [key, rewriteRefs(child)];
      return [
        key,
        child
          .replace(/^ipc-v1\.schema\.json#\/[$]defs\//, "#/$defs/")
          .replace(/^ipc-v1\.methods\.schema\.json#\/[$]defs\//, "#/$defs/"),
      ];
    })
  );
}

function typeName(definitionName) {
  return definitionName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function targetDefinitionName(definitions, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`IPC definition alias cycle: ${[...seen, name].join(" -> ")}`);
  const definition = definitions[name];
  if (!definition) throw new Error(`IPC method contract references missing definition: ${name}`);
  const keys = Object.keys(definition);
  if (keys.length !== 1 || typeof definition.$ref !== "string") return name;
  const match = definition.$ref.match(/^#\/\$defs\/([^/]+)$/);
  if (!match) return name;
  return targetDefinitionName(definitions, match[1], new Set([...seen, name]));
}

function definitionType(definitions, name) {
  if (name === "emptyParams") return "Record<string, never>";
  return typeName(targetDefinitionName(definitions, name));
}

function renderMethodTypes(definitions) {
  const rows = Object.entries(METHOD_CONTRACTS).map(([method, [paramsName, resultName]]) => {
    const paramsType = definitionType(definitions, paramsName);
    const resultType = definitionType(definitions, resultName);
    return `  ${JSON.stringify(method)}: { params: ${paramsType}; result: ${resultType} };`;
  });
  const operationMethods = Object.entries(METHOD_CONTRACTS)
    .filter(([, [, resultName]]) => targetDefinitionName(definitions, resultName) === "operation")
    .map(([method]) => method);

  return `
export interface IpcMethodContracts {
${rows.join("\n")}
}

export type IpcMethod = keyof IpcMethodContracts;
export type IpcParams<M extends IpcMethod> = IpcMethodContracts[M]["params"];
export type IpcResult<M extends IpcMethod> = IpcMethodContracts[M]["result"];

export const OPERATION_METHODS = ${JSON.stringify(operationMethods, null, 2)} as const satisfies readonly IpcMethod[];
export type OperationMethod = (typeof OPERATION_METHODS)[number];

/** Tauri 将 Agent 信封的 event 字段改名为 name，并省略 revision。 */
export type AgentEventEnvelope = Event extends infer Envelope
  ? Envelope extends { event: infer Name extends EventName; payload: infer Payload }
    ? Omit<Envelope, "event" | "revision"> & { name: Name; payload: Payload }
    : never
  : never;
`;
}

async function generate() {
  const mainSchema = rewriteRefs(readJson(mainSchemaPath));
  const methodSchema = rewriteRefs(readJson(methodSchemaPath));
  if (Object.keys(methodSchema.$defs ?? {}).length !== 53) {
    throw new Error("ipc-v1.methods.schema.json must keep all 53 method DTO definitions");
  }

  const definitions = {
    ...methodSchema.$defs,
    // helloParams / helloResult share their names with the method aliases. The canonical main
    // definitions win so the merged generator schema does not contain a self-reference.
    ...mainSchema.$defs,
  };
  const combinedSchema = {
    $schema: mainSchema.$schema,
    $id: "https://github.com/yang-sanmu/chatgpt-account-keeper/contracts/ipc-v1.generated.schema.json",
    title: "Keeper IPC v1 Generated Schema",
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.keys(definitions).map((name) => [name, { $ref: `#/$defs/${name}` }])
    ),
    $defs: definitions,
  };
  const banner = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * Sources: contracts/ipc-v1.schema.json, contracts/ipc-v1.methods.schema.json,
 *          src/agent/methodContracts.js
 * Regenerate with: npm run ipc:generate
 */`;
  const generated = await compile(combinedSchema, "KeeperIpcV1GeneratedSchema", {
    additionalProperties: false,
    bannerComment: banner,
    cwd: path.join(root, "contracts"),
    unreachableDefinitions: true,
    unknownAny: true,
  });
  const output = `${generated.trimEnd()}\n${renderMethodTypes(definitions)}`.replaceAll("\r\n", "\n");

  // Fail loudly if a compiler upgrade silently changes alias naming and breaks the appended map.
  const exportedNames = new Set(
    [...output.matchAll(/export (?:interface|type) ([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1])
  );
  for (const [, [paramsName, resultName]] of Object.entries(METHOD_CONTRACTS)) {
    for (const name of [paramsName, resultName]) {
      const rendered = definitionType(definitions, name);
      if (!rendered.startsWith("Record<") && !exportedNames.has(rendered)) {
        throw new Error(
          `Generated TypeScript is missing ${rendered} for $defs/${name}; exports: ${[...exportedNames].join(", ")}`
        );
      }
    }
  }
  return output;
}

const output = await generate();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8").replaceAll("\r\n", "\n")
    : null;
  if (current !== output) {
    console.error("app/src/ipc/generated.ts is stale; run `npm run ipc:generate` and commit the result.");
    process.exitCode = 1;
  } else {
    console.log("IPC generated types are up to date.");
  }
} else {
  fs.writeFileSync(outputPath, output, "utf8");
  console.log(`Generated ${path.relative(root, outputPath)}.`);
}
