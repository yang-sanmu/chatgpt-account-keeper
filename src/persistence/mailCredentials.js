import { ApplicationError, ERROR_CODES } from "../application/errors.js";
import { normalizeTotpSecret } from "../totp.js";
import { deriveSealingKey, sealSecret, unsealSecret } from "./sealedBox.js";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const MAIL_SETTINGS_KEYS = new Set([
  "imapHost",
  "imapPort",
  "imapTls",
  "imapUser",
  "imapPassword",
  "autoReloginDefault",
  "reloginHeadless",
]);

function validationError(message) {
  return new ApplicationError(ERROR_CODES.VALIDATION_FAILED, message);
}

function normalizeOptionalHost(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw validationError("imapHost 必须是字符串或 null");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 255 || /[\s\r\n\0]/.test(trimmed)) {
    throw validationError("IMAP 服务器地址格式无效");
  }
  return trimmed;
}

function normalizeOptionalUser(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw validationError("imapUser 必须是字符串或 null");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 320 || /[\r\n\0]/.test(trimmed)) {
    throw validationError("IMAP 邮箱账号格式无效");
  }
  return trimmed;
}

/**
 * 接码邮箱（IMAP）全局设置与单账号密码/TOTP 加密凭据存储。
 */
export class MailCredentialStore {
  constructor(db, ipcKey) {
    this.db = db;
    this.key = deriveSealingKey(ipcKey, "keeper/mail-credentials/v1");

    this._readMailRow = db.prepare("SELECT * FROM mail_settings WHERE singleton_id = 1");
    this._writeMailRow = db.prepare(`
      INSERT INTO mail_settings (
        singleton_id, imap_host, imap_port, imap_tls, imap_user, imap_sealed_password,
        auto_relogin_default, relogin_headless, updated_at
      ) VALUES (1, @host, @port, @tls, @user, @sealedPassword, @autoReloginDefault, @reloginHeadless, @updatedAt)
      ON CONFLICT(singleton_id) DO UPDATE SET
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        imap_tls = excluded.imap_tls,
        imap_user = excluded.imap_user,
        imap_sealed_password = excluded.imap_sealed_password,
        auto_relogin_default = excluded.auto_relogin_default,
        relogin_headless = excluded.relogin_headless,
        updated_at = excluded.updated_at
    `);

    this._readCredRow = db.prepare(
      "SELECT account_id, sealed_password, sealed_totp_secret, updated_at FROM account_credentials WHERE account_id = ?"
    );
    this._listCredStatuses = db.prepare(
      "SELECT account_id, sealed_password, sealed_totp_secret FROM account_credentials"
    );
    this._upsertCredRow = db.prepare(`
      INSERT INTO account_credentials (account_id, sealed_password, sealed_totp_secret, updated_at)
      VALUES (@accountId, @sealedPassword, @sealedTotpSecret, @updatedAt)
      ON CONFLICT(account_id) DO UPDATE SET
        sealed_password = excluded.sealed_password,
        sealed_totp_secret = excluded.sealed_totp_secret,
        updated_at = excluded.updated_at
    `);
    this._deleteCredRow = db.prepare("DELETE FROM account_credentials WHERE account_id = ?");
  }

  _rawMailSettings() {
    return (
      this._readMailRow.get() ?? {
        singleton_id: 1,
        imap_host: null,
        imap_port: 993,
        imap_tls: 1,
        imap_user: null,
        imap_sealed_password: null,
        auto_relogin_default: 0,
        relogin_headless: null,
      }
    );
  }

  getSettings() {
    const row = this._rawMailSettings();
    const unsealedPassword = unsealSecret(this.key, "mail_settings:1", row.imap_sealed_password);
    return {
      imapHost: row.imap_host ?? null,
      imapPort: Number(row.imap_port || 993),
      imapTls: row.imap_tls !== 0,
      imapUser: row.imap_user ?? null,
      imapPasswordConfigured: Boolean(unsealedPassword),
      autoReloginDefault: !!row.auto_relogin_default,
      reloginHeadless: row.relogin_headless == null ? null : !!row.relogin_headless,
    };
  }

  getImapSecretConfig() {
    const row = this._rawMailSettings();
    const password = unsealSecret(this.key, "mail_settings:1", row.imap_sealed_password);
    if (!row.imap_host || !row.imap_user || !password) return null;
    return {
      host: row.imap_host,
      port: Number(row.imap_port || 993),
      tls: row.imap_tls !== 0,
      user: row.imap_user,
      password,
    };
  }

  updateSettings(patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw validationError("接码邮箱配置必须是 JSON 对象");
    }
    const unknown = Object.keys(patch).find((key) => !MAIL_SETTINGS_KEYS.has(key));
    if (unknown) throw validationError(`未知接码邮箱配置字段：${unknown}`);

    const current = this._rawMailSettings();
    const nextHost = hasOwn(patch, "imapHost") ? normalizeOptionalHost(patch.imapHost) : current.imap_host ?? null;
    const nextUser = hasOwn(patch, "imapUser") ? normalizeOptionalUser(patch.imapUser) : current.imap_user ?? null;

    let nextPort = Number(current.imap_port || 993);
    if (hasOwn(patch, "imapPort")) {
      if (!Number.isInteger(patch.imapPort) || patch.imapPort < 1 || patch.imapPort > 65535) {
        throw validationError("imapPort 必须是 1 到 65535 之间的整数");
      }
      nextPort = patch.imapPort;
    }

    let nextTls = current.imap_tls !== 0;
    if (hasOwn(patch, "imapTls")) {
      if (typeof patch.imapTls !== "boolean") throw validationError("imapTls 必须是布尔值");
      nextTls = patch.imapTls;
    }

    let nextSealedPassword = current.imap_sealed_password ?? null;
    if (hasOwn(patch, "imapPassword")) {
      if (patch.imapPassword === null || patch.imapPassword === "") {
        nextSealedPassword = null;
      } else if (typeof patch.imapPassword !== "string") {
        throw validationError("imapPassword 必须是字符串或 null");
      } else if (/[\r\n\0]/.test(patch.imapPassword)) {
        throw validationError("IMAP 授权码不能包含换行符");
      } else {
        nextSealedPassword = sealSecret(this.key, "mail_settings:1", patch.imapPassword);
      }
    }

    let nextAutoRelogin = !!current.auto_relogin_default;
    if (hasOwn(patch, "autoReloginDefault")) {
      if (typeof patch.autoReloginDefault !== "boolean") {
        throw validationError("autoReloginDefault 必须是布尔值");
      }
      nextAutoRelogin = patch.autoReloginDefault;
    }

    let nextReloginHeadless = current.relogin_headless == null ? null : !!current.relogin_headless;
    if (hasOwn(patch, "reloginHeadless")) {
      if (patch.reloginHeadless !== null && typeof patch.reloginHeadless !== "boolean") {
        throw validationError("reloginHeadless 必须是布尔值或 null");
      }
      nextReloginHeadless = patch.reloginHeadless;
    }

    this._writeMailRow.run({
      host: nextHost,
      port: nextPort,
      tls: nextTls ? 1 : 0,
      user: nextUser,
      sealedPassword: nextSealedPassword,
      autoReloginDefault: nextAutoRelogin ? 1 : 0,
      reloginHeadless: nextReloginHeadless == null ? null : nextReloginHeadless ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });

    return this.getSettings();
  }

  setAccountCredentials(accountId, { password, totpSecret } = {}) {
    const existing = this._readCredRow.get(accountId);
    let nextPassword = existing?.sealed_password ?? null;
    let nextTotp = existing?.sealed_totp_secret ?? null;

    if (password !== undefined) {
      if (password === null || password === "") {
        nextPassword = null;
      } else if (typeof password !== "string") {
        throw validationError("账号密码必须是字符串或 null");
      } else {
        nextPassword = sealSecret(this.key, `${accountId}:password`, password);
      }
    }

    if (totpSecret !== undefined) {
      if (totpSecret === null || totpSecret === "") {
        nextTotp = null;
      } else if (typeof totpSecret !== "string") {
        throw validationError("TOTP 密钥必须是字符串或 null");
      } else {
        let normalized;
        try {
          normalized = normalizeTotpSecret(totpSecret);
        } catch (err) {
          throw validationError(err.message);
        }
        nextTotp = sealSecret(this.key, `${accountId}:totp`, normalized);
      }
    }

    if (!nextPassword && !nextTotp) {
      this._deleteCredRow.run(accountId);
    } else {
      this._upsertCredRow.run({
        accountId,
        sealedPassword: nextPassword,
        sealedTotpSecret: nextTotp,
        updatedAt: new Date().toISOString(),
      });
    }
    return this.getCredentialStatus(accountId);
  }

  getAccountCredentials(accountId) {
    const row = this._readCredRow.get(accountId);
    if (!row) return { password: null, totpSecret: null };
    return {
      password: unsealSecret(this.key, `${accountId}:password`, row.sealed_password),
      totpSecret: unsealSecret(this.key, `${accountId}:totp`, row.sealed_totp_secret),
    };
  }

  _credentialFlags(accountId, row) {
    if (!row) return { hasPassword: false, hasTotpSecret: false };
    return {
      hasPassword: Boolean(unsealSecret(this.key, `${accountId}:password`, row.sealed_password)),
      hasTotpSecret: Boolean(unsealSecret(this.key, `${accountId}:totp`, row.sealed_totp_secret)),
    };
  }

  getCredentialStatus(accountId) {
    const row = this._readCredRow.get(accountId);
    return this._credentialFlags(accountId, row);
  }

  listCredentialStatusMap() {
    const map = new Map();
    for (const row of this._listCredStatuses.all()) {
      map.set(row.account_id, this._credentialFlags(row.account_id, row));
    }
    return map;
  }
}
