import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fromInstallRoot } from "../paths.js";
import { ApplicationError, ERROR_CODES } from "../application/errors.js";

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

const METHOD_CONTRACTS = Object.freeze({
  "system.hello": ["helloParams", "helloResult"],
  "system.bootstrap": ["emptyParams", "bootstrapResult"],
  "system.getActivity": ["emptyParams", "activityResult"],
  "system.prepareUpdate": ["prepareUpdateParams", "prepareUpdateResult"],
  "system.shutdown": ["shutdownParams", "acceptedResult"],
  "accounts.list": ["emptyParams", "accountArray"],
  "accounts.create": ["accountCreateParams", "accountResult"],
  "accounts.update": ["accountUpdateParams", "accountResult"],
  "accounts.remove": ["accountRemoveParams", "okResult"],
  "accounts.getStatus": ["idParams", "accountStatusResult"],
  "accounts.refreshStatus": ["idParams", "operationResult"],
  "accounts.runNow": ["idParams", "operationResult"],
  "accounts.checkSelectors": ["selectorCheckParams", "operationResult"],
  "browser.startLogin": ["loginParams", "operationResult"],
  "browser.openPage": ["accountIdParams", "operationResult"],
  "browser.closePage": ["accountIdParams", "okResult"],
  "browser.listOpenPages": ["emptyParams", "jsonObject"],
  "browser.getTask": ["taskIdParams", "jsonObject"],
  "history.query": ["historyQueryParams", "historyEntryArray"],
  "accounts.history": ["historyQueryParams", "historyEntryArray"],
  "history.listAccounts": ["emptyParams", "historyAccountArray"],
  "groups.list": ["emptyParams", "groupArray"],
  "groups.create": ["groupCreateParams", "groupResult"],
  "groups.update": ["groupUpdateParams", "groupResult"],
  "groups.remove": ["idParams", "okResult"],
  "proxies.getState": ["emptyParams", "proxyStateResult"],
  "proxies.importSubscription": ["subscriptionParams", "operationResult"],
  "proxies.refreshSubscription": ["emptyParams", "operationResult"],
  "proxies.setRuntimeDirectory": ["runtimeDirectoryParams", "operationResult"],
  "proxies.setNodeEnabled": ["nodeEnabledParams", "operationResult"],
  "proxies.testNode": ["idParams", "operationResult"],
  "proxies.testAll": ["emptyParams", "operationResult"],
  "profiles.scan": ["emptyParams", "operationResult"],
  "profiles.cleanCache": ["profileCleanParams", "operationResult"],
  "profiles.archiveOrphan": ["nameParams", "operationResult"],
  "profiles.purgeOrphan": ["nameParams", "operationResult"],
  "conversations.list": ["emptyParams", "conversationMap"],
  "conversations.upsert": ["conversationUpsertParams", "conversationResult"],
  "conversations.remove": ["nameParams", "okResult"],
  "scheduler.getState": ["emptyParams", "schedulerResult"],
  "scheduler.start": ["emptyParams", "schedulerResult"],
  "scheduler.stop": ["emptyParams", "schedulerResult"],
  "settings.get": ["emptyParams", "settingsResult"],
  "settings.update": ["settingsUpdateParams", "settingsResult"],
  "operations.get": ["idParams", "operationResult"],
  "operations.listActive": ["emptyParams", "operationArray"],
  "operations.list": ["operationListParams", "operationArray"],
  "queue.getSnapshot": ["emptyParams", "queueSnapshotResult"],
  "browserRuns.list": ["emptyParams", "browserRunListResult"],
  "browserRuns.close": ["browserRunCloseParams", "browserRunCloseResult"]
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
