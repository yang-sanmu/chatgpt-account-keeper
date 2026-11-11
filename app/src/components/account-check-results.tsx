import type { AccountCheckResult } from "@/ipc/types";
import { PROMO_LABELS } from "@/lib/format";

interface Props {
  result: AccountCheckResult;
  accountLabel: (id: string) => string;
}

export function AccountCheckResults({ result, accountLabel }: Props) {
  return (
    <div className="space-y-2 text-sm text-secondary">
      <p role="status">共 {result.total} 个账号，成功 {result.succeeded} 个，失败 {result.failures.length} 个。</p>
      {!!result.successIds?.length && (
        <details>
          <summary className="cursor-pointer text-ok">成功明细（{result.successIds.length} 个账号）</summary>
          <ul className="mt-2 max-h-36 space-y-1 overflow-auto pl-4">
            {result.successIds.map((id) => {
              const eligibility = result.promoResults?.[id];
              return <li key={id} className="break-words">{accountLabel(id)}{eligibility && ` · ${PROMO_LABELS[eligibility]}`}</li>;
            })}
          </ul>
        </details>
      )}
      {result.failures.length > 0 && (
        <details>
          <summary className="cursor-pointer text-danger">失败明细（{result.failures.length} 个账号）</summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto pl-4">
            {result.failures.map(({ id, detail }) => (
              <li key={id} className="break-words">{accountLabel(id)} · {detail}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
