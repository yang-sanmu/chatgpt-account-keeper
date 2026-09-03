// 账号编辑模型：基线 / 草稿 / 在途提交的三路合并。
//
// 这里是纯函数，不依赖 React 也不依赖 store。三条规则各自对应一个已经发生过的用户可见
// 缺陷，`src/store/__tests__/accountModel.test.ts` 逐条钉住：
//
// 1. 巡检推来的快照不能覆盖用户正在编辑的字段（默认 15 分钟一轮，撞上是常态）。
// 2. 提交在途时用户又改了同一字段，响应回来不能把界面退回已提交的值。
// 3. 单条增量事件只改那一条记录，其余记录保持引用不变（否则下游 memo 全部失效）。

import type {
  Account,
  AccountPatch,
  PromoEligibility,
  SwitchRule,
} from "@/ipc/types";

/// 用户可编辑的字段。数组而非类型别名：合并逻辑需要在运行时遍历它。
export const EDITABLE_ACCOUNT_FIELDS = [
  "note",
  "groupId",
  "enabled",
  "switchRule",
  "minWindows",
  "maxWindows",
] as const;

export type EditableAccountField = (typeof EDITABLE_ACCOUNT_FIELDS)[number];

export type AccountDraft = AccountPatch;

export interface AccountRecord {
  /// 服务端确认的值。
  baseline: Account;
  /// 用户改了但还没提交的字段。只包含与 baseline 不同的项。
  draft: AccountDraft;
  /// 已发出 accounts.update、还没等到响应的那一份 patch。null 表示没有在途提交。
  inFlight: AccountDraft | null;
  /// baseline 叠加 draft 的结果，界面直接读它。预先算好而不是渲染时算，
  /// 是为了让记录的引用相等性可以直接当作 memo 的判据。
  effective: Account;
  /// 有未保存改动的字段名。空集合表示干净。
  dirtyFields: ReadonlySet<EditableAccountField>;
}

export type AccountRecords = Readonly<Record<string, AccountRecord>>;

function readField(source: Account, field: EditableAccountField): unknown {
  return source[field];
}

/// 丢掉与基线相同的草稿项。
///
/// 不做这一步的后果是「改了又手动改回去」的字段仍然算脏：卡片会一直亮着未保存边框，
/// 而用户看不出到底哪里还没保存。
function pruneDraft(baseline: Account, draft: AccountDraft): AccountDraft {
  const pruned: AccountDraft = {};
  for (const field of EDITABLE_ACCOUNT_FIELDS) {
    const value = draft[field];
    if (value === undefined) continue;
    if (value === readField(baseline, field)) continue;
    assignDraftField(pruned, field, value);
  }
  return pruned;
}

/// 把一个已知合法的草稿值写进目标对象。
///
/// 单独一个函数是因为 AccountDraft 的六个字段类型各不相同，逐字段 switch 才能在
/// strict 模式下不用 any 就通过检查。
function assignDraftField(
  target: AccountDraft,
  field: EditableAccountField,
  value: unknown
): void {
  switch (field) {
    case "note":
      if (typeof value === "string") target.note = value;
      return;
    case "groupId":
      if (typeof value === "string" || value === null) target.groupId = value;
      return;
    case "enabled":
      if (typeof value === "boolean") target.enabled = value;
      return;
    case "switchRule":
      if (value === "random" || value === "sequential") {
        target.switchRule = value satisfies SwitchRule;
      }
      return;
    case "minWindows":
      if (typeof value === "number" && Number.isFinite(value)) target.minWindows = value;
      return;
    case "maxWindows":
      if (typeof value === "number" && Number.isFinite(value)) target.maxWindows = value;
      return;
  }
}

/// 基线叠加草稿。
export function projectAccount(baseline: Account, draft: AccountDraft): Account {
  const keys = Object.keys(draft) as EditableAccountField[];
  if (keys.length === 0) return baseline;
  return { ...baseline, ...draft };
}

function draftFieldSet(draft: AccountDraft): ReadonlySet<EditableAccountField> {
  const fields = new Set<EditableAccountField>();
  for (const field of EDITABLE_ACCOUNT_FIELDS) {
    if (draft[field] !== undefined) fields.add(field);
  }
  return fields;
}

/// 由基线与草稿组装一条记录。draft 会先被剪枝，所以 dirtyFields 一定是真实的差异。
export function makeAccountRecord(
  baseline: Account,
  draft: AccountDraft = {},
  inFlight: AccountDraft | null = null
): AccountRecord {
  const prunedDraft = pruneDraft(baseline, draft);
  return {
    baseline,
    draft: prunedDraft,
    inFlight,
    effective: projectAccount(baseline, prunedDraft),
    dirtyFields: draftFieldSet(prunedDraft),
  };
}

export function isAccountDirty(record: AccountRecord): boolean {
  return record.dirtyFields.size > 0;
}

/// 规则 1：全量快照到达。
///
/// 服务端列表决定有哪些账号以及它们的顺序，但每条已存在记录的草稿要留下来——只保留
/// 与**新**基线仍然不同的部分。用户改过备注、此刻收到一份含旧备注的快照，输入框里必须
/// 还是用户的值。
export function reconcileFromSnapshot(
  records: AccountRecords,
  serverAccounts: readonly Account[]
): { records: AccountRecords; ids: string[] } {
  const next: Record<string, AccountRecord> = {};
  const ids: string[] = [];

  for (const account of serverAccounts) {
    ids.push(account.id);
    const previous = records[account.id];
    next[account.id] = previous
      ? makeAccountRecord(account, previous.draft, previous.inFlight)
      : makeAccountRecord(account);
  }

  return { records: next, ids };
}

/// 用户改了一个字段。
export function applyDraft(
  records: AccountRecords,
  id: string,
  patch: AccountDraft
): AccountRecords {
  const previous = records[id];
  if (!previous) return records;
  return {
    ...records,
    [id]: makeAccountRecord(
      previous.baseline,
      { ...previous.draft, ...patch },
      previous.inFlight
    ),
  };
}

/// 放弃草稿，回到服务端确认的值。
export function discardDraft(records: AccountRecords, id: string): AccountRecords {
  const previous = records[id];
  if (!previous) return records;
  if (previous.dirtyFields.size === 0) return records;
  return {
    ...records,
    [id]: makeAccountRecord(previous.baseline, {}, previous.inFlight),
  };
}

export function beginSubmit(
  records: AccountRecords,
  id: string,
  patch: AccountDraft
): AccountRecords {
  const previous = records[id];
  if (!previous) return records;
  return { ...records, [id]: { ...previous, inFlight: patch } };
}

/// 规则 2：提交完成。
///
/// 逐字段判断：草稿当前值 === 提交值，说明用户没再改，服务端已确认，清掉草稿；
/// 不相等说明提交在途时用户又改了，**保留新草稿**并保持脏标记——把界面退回已提交的值
/// 等于悄悄丢掉用户刚敲进去的东西。
export function finishSubmit(
  records: AccountRecords,
  id: string,
  submitted: AccountDraft,
  serverAccount?: Account
): AccountRecords {
  const previous = records[id];
  if (!previous) return records;

  const nextBaseline = serverAccount ?? projectAccount(previous.baseline, submitted);
  const remainingDraft: AccountDraft = { ...previous.draft };

  for (const field of EDITABLE_ACCOUNT_FIELDS) {
    const submittedValue = submitted[field];
    if (submittedValue === undefined) continue;
    if (remainingDraft[field] === submittedValue) {
      delete remainingDraft[field];
    }
  }

  return {
    ...records,
    [id]: makeAccountRecord(nextBaseline, remainingDraft, null),
  };
}

export function failSubmit(records: AccountRecords, id: string): AccountRecords {
  const previous = records[id];
  if (!previous) return records;
  if (previous.inFlight === null) return records;
  return { ...records, [id]: { ...previous, inFlight: null } };
}

/// 规则 3：单条 account.changed。只换那一条记录，草稿与在途提交都留着。
export function applyAccountChanged(
  records: AccountRecords,
  account: Account
): { records: AccountRecords; isNew: boolean } {
  const previous = records[account.id];
  return {
    records: {
      ...records,
      [account.id]: previous
        ? makeAccountRecord(account, previous.draft, previous.inFlight)
        : makeAccountRecord(account),
    },
    isNew: !previous,
  };
}

export function applyAccountRemoved(
  records: AccountRecords,
  id: string
): AccountRecords {
  if (!records[id]) return records;
  const next = { ...records };
  delete next[id];
  return next;
}

/// 巡检 / 调度事件带来的只读状态字段。都是 optional：事件只带变化的那几项，
/// undefined 一律表示「这次没提到，保持原值」，与 null（明确清空）不同。
export interface AccountStatusPatch {
  status?: string;
  stale?: boolean;
  statusCheckedAt?: string | null;
  promoEligibility?: PromoEligibility | null;
  promoCheckedAt?: string | null;
  promoStale?: boolean;
  promoCheckDetail?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunOk?: boolean | null;
  lastRunReason?: string | null;
  pageOpen?: boolean;
  rotationTopic?: string | null;
  rotationDone?: number;
  rotationTarget?: number;
  exitNode?: string | null;
  exitNodeMissing?: boolean;
  gptName?: string | null;
  email?: string | null;
  groupName?: string | null;
  running?: boolean;
}

const STATUS_PATCH_FIELDS = [
  "status",
  "stale",
  "statusCheckedAt",
  "promoEligibility",
  "promoCheckedAt",
  "promoStale",
  "promoCheckDetail",
  "nextRunAt",
  "lastRunAt",
  "lastRunOk",
  "lastRunReason",
  "pageOpen",
  "rotationTopic",
  "rotationDone",
  "rotationTarget",
  "exitNode",
  "exitNodeMissing",
  "gptName",
  "email",
  "groupName",
  "running",
] as const satisfies readonly (keyof AccountStatusPatch)[];

/// 规则 3 的另一半：状态类增量事件。
///
/// 这些字段都不可编辑，所以直接进基线；草稿不受影响。没有任何字段真的变化时返回原
/// records 引用，让「一条事件重渲染一张卡」这件事在 store 层就成立。
export function applyAccountStatus(
  records: AccountRecords,
  id: string,
  patch: AccountStatusPatch
): AccountRecords {
  const previous = records[id];
  if (!previous) return records;

  let changed = false;
  const nextBaseline: Account = { ...previous.baseline };

  for (const field of STATUS_PATCH_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (previous.baseline[field] === value) continue;
    Object.assign(nextBaseline, { [field]: value });
    changed = true;
  }

  if (!changed) return records;

  return {
    ...records,
    [id]: makeAccountRecord(nextBaseline, previous.draft, previous.inFlight),
  };
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export type AccountStatusFilter =
  | "all"
  | "ok"
  | "reauth"
  | "out"
  | "unknown"
  | "stale"
  | "node_missing"
  | "disabled"
  | "page_open";

export type AccountPromoFilter =
  | "all"
  | "eligible"
  | "free_trial"
  | "half_price"
  | "none"
  | "unchecked";

export interface AccountFilter {
  keyword: string;
  groupId: string | "all" | "none";
  status: AccountStatusFilter;
  promo: AccountPromoFilter;
  switchRule: SwitchRule | "all";
}

export const DEFAULT_ACCOUNT_FILTER: AccountFilter = {
  keyword: "",
  groupId: "all",
  status: "all",
  promo: "all",
  switchRule: "all",
};

export function isFilterActive(filter: AccountFilter): boolean {
  return (
    filter.keyword.trim().length > 0 ||
    filter.groupId !== "all" ||
    filter.status !== "all" ||
    filter.promo !== "all" ||
    filter.switchRule !== "all"
  );
}

function matchesPromo(account: Account, promo: AccountPromoFilter): boolean {
  const eligibility = account.promoEligibility;
  switch (promo) {
    case "all":
      return true;
    case "eligible":
      return eligibility === "free_trial" || eligibility === "half_price" || eligibility === "both";
    case "free_trial":
      return eligibility === "free_trial" || eligibility === "both";
    case "half_price":
      return eligibility === "half_price" || eligibility === "both";
    case "none":
      return eligibility === "none";
    case "unchecked":
      return eligibility === null;
  }
}

function matchesStatus(account: Account, status: AccountStatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "stale":
      return account.stale;
    case "node_missing":
      return account.exitNodeMissing;
    case "disabled":
      return !account.enabled;
    case "page_open":
      return account.pageOpen;
    default:
      return account.status === status;
  }
}

function matchesKeyword(account: Account, keyword: string): boolean {
  if (keyword.length === 0) return true;
  const haystack = [
    account.email,
    account.note,
    account.id,
    account.gptName,
    account.groupName,
  ];
  return haystack.some(
    (value) => typeof value === "string" && value.toLowerCase().includes(keyword)
  );
}

/// 按当前筛选条件挑出可见记录，顺序沿用服务端给的 ids。
///
/// 每次读取都重新算，而不是在事件处理里维护一份可见列表——一个账号的状态变了，它是否
/// 还该出现在当前筛选下就可能变，缓存那份列表必然会漏掉这种情况。
export function selectVisibleAccounts(
  records: AccountRecords,
  ids: readonly string[],
  filter: AccountFilter
): AccountRecord[] {
  const keyword = filter.keyword.trim().toLowerCase();
  const visible: AccountRecord[] = [];

  for (const id of ids) {
    const record = records[id];
    if (!record) continue;
    const account = record.effective;

    if (!matchesKeyword(account, keyword)) continue;
    if (!matchesStatus(account, filter.status)) continue;
    if (!matchesPromo(account, filter.promo)) continue;
    if (filter.switchRule !== "all" && account.switchRule !== filter.switchRule) continue;

    if (filter.groupId === "none") {
      if (account.groupId) continue;
    } else if (filter.groupId !== "all") {
      if (account.groupId !== filter.groupId) continue;
    }

    visible.push(record);
  }

  return visible;
}
