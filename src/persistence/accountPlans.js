import { accessTokenExpiry } from "../accessToken.js";
import { deriveSealingKey, sealSecret, unsealSecret } from "./sealedBox.js";

export class AccountPlanStore {
  constructor(db, ipcKey) {
    this.key = deriveSealingKey(ipcKey, "keeper/account-access-token/v1");
    // 对话和选择器自检也会确认登录邮箱，但只刷新状态缓存。
    this.read = db.prepare(`
      SELECT p.*, s.state = 'ok' AND lower(trim(s.email)) <> lower(trim(a.email)) AS identity_changed
      FROM account_plans p
      JOIN accounts a ON a.id = p.account_id
      LEFT JOIN account_status s ON s.account_id = p.account_id
      WHERE p.account_id = ?`);
    this.writeToken = db.prepare(`
      INSERT INTO account_plans (account_id, sealed_token)
      SELECT id, ? FROM accounts WHERE id = ? AND lower(trim(email)) = lower(trim(?))
      ON CONFLICT(account_id) DO UPDATE SET sealed_token = excluded.sealed_token`);
    this.deleteToken = db.prepare(`
      UPDATE account_plans SET sealed_token = NULL,
        check_detail = CASE WHEN plan_type IS NOT NULL THEN '会话已失效，请巡检后重新查询' ELSE check_detail END
      WHERE account_id = ? AND sealed_token IS NOT NULL`);
    this.writePlan = db.prepare(`
      UPDATE account_plans SET plan_type = coalesce(@planType, plan_type),
        checked_at = CASE WHEN @planType IS NULL THEN checked_at ELSE @checkedAt END,
        check_detail = @detail WHERE account_id = @id AND sealed_token = @sealed`);
  }

  saveToken(id, email, token) {
    if (this.getToken(id)?.token === token) return;
    const sealed = sealSecret(this.key, id, token);
    if (!this.writeToken.run(sealed, id, email).changes) throw new Error("账号身份已变更");
  }

  clearToken(id) {
    this.deleteToken.run(id);
  }

  getToken(id) {
    const row = this.read.get(id);
    if (row?.identity_changed) return null;
    const sealed = row?.sealed_token;
    if (!sealed) return null;
    const token = unsealSecret(this.key, id, sealed);
    return token == null ? null : { sealed, token };
  }

  getPlan(id) {
    const row = this.read.get(id);
    if (row?.identity_changed) {
      return { planType: null, planCheckedAt: null, planCheckDetail: "登录账号已变更，请先巡检" };
    }
    return {
      planType: row?.plan_type ?? null,
      planCheckedAt: row?.checked_at ?? null,
      planCheckDetail: row?.check_detail ?? null,
    };
  }

  getTokenStatus(id) {
    const token = this.getToken(id)?.token;
    return {
      hasAccessToken: !!token,
      accessTokenExpiresAt: token ? accessTokenExpiry(token) : null,
    };
  }

  savePlan(id, sealed, { planType = null, detail = null }) {
    if (this.read.get(id)?.identity_changed) return false;
    return this.writePlan.run({ id, sealed, planType, detail, checkedAt: new Date().toISOString() }).changes > 0;
  }
}
