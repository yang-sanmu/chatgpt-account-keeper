//! IPC 凭据：256 位随机值，落盘时只允许当前用户读取。
//!
//! 这是管理 IPC 的身份边界。Agent 在 `system.hello` 里用常量时间比较校验它，不带
//! 凭据的连接在任何业务调用前被关闭。

use std::path::Path;

use base64::Engine;
use rand::RngCore;

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("读写 IPC 凭据文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("无法限制 IPC 凭据文件权限：{0}")]
    Permissions(String),
}

/// 读取或创建凭据。已有文件必须是合法的 32 字节 base64，否则重新生成。
pub fn load_or_create(key_file: &Path) -> Result<String, CredentialError> {
    if let Some(parent) = key_file.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if let Ok(existing) = std::fs::read_to_string(key_file) {
        let trimmed = existing.trim();
        let decoded = base64::engine::general_purpose::STANDARD.decode(trimmed);
        if matches!(decoded, Ok(ref bytes) if bytes.len() == 32) {
            // 已有文件的权限也要复核：它可能是旧版本写的，或被用户手工改过。
            restrict_permissions(key_file)?;
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let credential = base64::engine::general_purpose::STANDARD.encode(bytes);

    // 先写临时文件并收紧权限，再原子替换：中间态一刻都不能是全局可读的。
    let temporary = key_file.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| -> Result<(), CredentialError> {
        std::fs::write(&temporary, &credential)?;
        restrict_permissions(&temporary)?;
        std::fs::rename(&temporary, key_file)?;
        restrict_permissions(key_file)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result?;

    Ok(credential)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(windows)]
fn restrict_permissions(path: &Path) -> Result<(), CredentialError> {
    // 必须移除继承（/inheritance:r）：只加一条 ACE 而保留继承的话，父目录上任何
    // 宽松授权（Users、Authenticated Users）仍然生效，凭据等于公开。
    let identity = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );
    let output = std::process::Command::new("icacls.exe")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{identity}:(F)"))
        .output()
        .map_err(|error| CredentialError::Permissions(error.to_string()))?;
    if !output.status.success() {
        return Err(CredentialError::Permissions(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("keeper-cred-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn creates_a_256_bit_credential_and_reuses_it() {
        let root = temporary_directory();
        let key_file = root.join("ipc.key");

        let first = load_or_create(&key_file).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&first)
            .unwrap();
        assert_eq!(decoded.len(), 32);

        // 复用而不是每次重新生成：换了凭据就等于把后台仍在运行的 Agent 锁在外面。
        let second = load_or_create(&key_file).unwrap();
        assert_eq!(first, second);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_corrupted_credential_file_is_replaced() {
        let root = temporary_directory();
        let key_file = root.join("ipc.key");
        std::fs::write(&key_file, "not-base64!!").unwrap();

        let credential = load_or_create(&key_file).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&credential)
            .unwrap();
        assert_eq!(decoded.len(), 32);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_wrong_length_credential_is_replaced() {
        let root = temporary_directory();
        let key_file = root.join("ipc.key");
        // 合法 base64 但只有 16 字节：长度不足也必须重新生成，否则凭据强度悄悄减半。
        std::fs::write(
            &key_file,
            base64::engine::general_purpose::STANDARD.encode([7u8; 16]),
        )
        .unwrap();

        let credential = load_or_create(&key_file).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&credential)
                .unwrap()
                .len(),
            32
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_different_directories_get_different_credentials() {
        let one = temporary_directory();
        let two = temporary_directory();
        let a = load_or_create(&one.join("ipc.key")).unwrap();
        let b = load_or_create(&two.join("ipc.key")).unwrap();
        assert_ne!(a, b);
        std::fs::remove_dir_all(&one).ok();
        std::fs::remove_dir_all(&two).ok();
    }

    #[test]
    #[cfg(unix)]
    fn the_credential_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = temporary_directory();
        let key_file = root.join("ipc.key");
        load_or_create(&key_file).unwrap();
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let root = temporary_directory();
        load_or_create(&root.join("ipc.key")).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
        std::fs::remove_dir_all(&root).ok();
    }
}
