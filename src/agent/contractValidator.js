import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fromInstallRoot } from "../paths.js";
import { ApplicationError, ERROR_CODES } from "../application/errors.js";
import { METHOD_CONTRACTS } from "./methodContracts.js";

const schema = JSON.parse(
  fs.readFileSync(fromInstallRoot("contracts", "ipc-v1.schema.json"), "utf8")
);
const methodSchema = JSON.parse(
  fs.readFileSync(fromInstallRoot("contracts", "ipc-v1.methods.schema.json"), "utf8")
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);
ajv.addSchema(methodSchema);

function definition(name) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`IPC schema definition is missing: ${name}`);
  return validate;
}

const validators = Object.freeze({
  request: definition("request"),
  success: definition("successResponse"),
  error: definition("errorResponse"),
  event: definition("event"),
});

const methodValidators = Object.fromEntries(
  Object.entries(METHOD_CONTRACTS).map(([method, [paramsName, resultName]]) => [
    method,
    {
      params: ajv.getSchema(`${methodSchema.$id}#/$defs/${paramsName}`),
      result: ajv.getSchema(`${methodSchema.$id}#/$defs/${resultName}`),
    },
  ])
);

function conciseErrors(validate) {
  return (validate.errors ?? []).slice(0, 5).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "invalid",
  }));
}

export function assertRequestContract(request) {
  if (!validators.request(request)) {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, "IPC 请求不符合 v1 契约", {
      details: { errors: conciseErrors(validators.request) },
    });
  }
  const validate = methodValidators[request.method]?.params;
  if (!validate || !validate(request.params ?? {})) {
    throw new ApplicationError(ERROR_CODES.VALIDATION_FAILED, `IPC 方法 ${request.method} 的参数不符合契约`, {
      details: { errors: validate ? conciseErrors(validate) : [{ path: "/method", message: "missing contract" }] },
    });
  }
}

export function assertMethodResultContract(method, result) {
  const validate = methodValidators[method]?.result;
  if (!validate || !validate(result)) {
    throw new ApplicationError(ERROR_CODES.INTERNAL, `Agent 方法 ${method} 返回了不符合契约的结果`, {
      details: { errors: validate ? conciseErrors(validate) : [{ path: "/method", message: "missing contract" }] },
    });
  }
}

export { METHOD_CONTRACTS };

export function assertOutgoingContract(envelope) {
  const validate = envelope.event
    ? validators.event
    : envelope.error
      ? validators.error
      : validators.success;
  if (!validate(envelope)) {
    throw new ApplicationError(ERROR_CODES.INTERNAL, "Agent 生成了不符合 v1 契约的消息", {
      details: { errors: conciseErrors(validate) },
    });
  }
}
