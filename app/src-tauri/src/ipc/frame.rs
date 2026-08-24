//! 4 字节小端长度前缀 + UTF-8 JSON 的帧编解码。
//!
//! 上限检查必须发生在分配 payload 缓冲区**之前**：一个声称 4 GiB 的长度前缀不能
//! 让我们先去分配 4 GiB 再发现它超限。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::contract::MAX_FRAME_BYTES;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("IPC 连接已关闭")]
    Closed,
    #[error("IPC frame 长度无效：{0}")]
    InvalidLength(i64),
    #[error("IPC 读写失败：{0}")]
    Io(#[from] std::io::Error),
}

/// 读一帧。长度为 0 或超过 8 MiB 都是协议违规，不是可恢复错误。
pub async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, FrameError>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut prefix = [0u8; 4];
    read_exact(reader, &mut prefix).await?;
    // Agent 侧写的是 int32，负数不可能合法，但要能报出来而不是转成巨大的 usize。
    let length = i32::from_le_bytes(prefix) as i64;
    if length <= 0 || length > MAX_FRAME_BYTES as i64 {
        return Err(FrameError::InvalidLength(length));
    }

    let mut payload = vec![0u8; length as usize];
    read_exact(reader, &mut payload).await?;
    Ok(payload)
}

/// 写一帧。长度前缀与 payload 之间不能被别的写入穿插，调用方负责序列化写操作。
pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::InvalidLength(payload.len() as i64));
    }
    let prefix = (payload.len() as u32).to_le_bytes();
    writer.write_all(&prefix).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

/// `read_exact` 但把「对端正常关闭」与「读到一半断开」区分开。
///
/// tokio 的 `read_exact` 两者都报 `UnexpectedEof`，而正常关闭是断线重连的日常路径，
/// 不该在日志里长得像故障。
async fn read_exact<R>(reader: &mut R, buffer: &mut [u8]) -> Result<(), FrameError>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut offset = 0;
    while offset < buffer.len() {
        let read = reader.read(&mut buffer[offset..]).await?;
        if read == 0 {
            return Err(FrameError::Closed);
        }
        offset += read;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn round_trips_a_payload() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"{\"ok\":true}").await.unwrap();
        assert_eq!(&buffer[..4], &[11, 0, 0, 0]);

        let mut cursor = Cursor::new(buffer);
        let payload = read_frame(&mut cursor).await.unwrap();
        assert_eq!(payload, b"{\"ok\":true}");
    }

    #[tokio::test]
    async fn rejects_an_oversized_length_prefix_without_allocating() {
        // 声称 16 MiB。必须在读 payload 之前就拒绝，所以这里故意不提供 payload：
        // 如果实现先分配再校验，它会卡在读取上而不是立刻返回错误。
        let mut framed = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(b"x");
        let mut cursor = Cursor::new(framed);
        let error = read_frame(&mut cursor).await.unwrap_err();
        assert!(matches!(error, FrameError::InvalidLength(_)), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_a_zero_length_frame() {
        let mut cursor = Cursor::new(vec![0, 0, 0, 0]);
        let error = read_frame(&mut cursor).await.unwrap_err();
        assert!(matches!(error, FrameError::InvalidLength(0)), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_a_negative_length_prefix() {
        let mut cursor = Cursor::new((-1i32).to_le_bytes().to_vec());
        let error = read_frame(&mut cursor).await.unwrap_err();
        assert!(matches!(error, FrameError::InvalidLength(-1)), "{error:?}");
    }

    #[tokio::test]
    async fn reports_a_clean_close_distinctly_from_a_truncated_frame() {
        let mut empty = Cursor::new(Vec::new());
        assert!(matches!(
            read_frame(&mut empty).await.unwrap_err(),
            FrameError::Closed
        ));

        // 长度说 8 字节，实际只给 3：读到一半断开，同样是 Closed（对端没了），
        // 但和上面的区别在于这里已经消费过前缀。两者都不该 panic。
        let mut truncated = Cursor::new({
            let mut bytes = 8u32.to_le_bytes().to_vec();
            bytes.extend_from_slice(b"abc");
            bytes
        });
        assert!(matches!(
            read_frame(&mut truncated).await.unwrap_err(),
            FrameError::Closed
        ));
    }

    #[tokio::test]
    async fn refuses_to_write_an_empty_or_oversized_payload() {
        let mut buffer = Vec::new();
        assert!(write_frame(&mut buffer, b"").await.is_err());
        assert!(buffer.is_empty(), "拒绝的写入不该产生任何字节");

        let huge = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(write_frame(&mut buffer, &huge).await.is_err());
        assert!(buffer.is_empty());
    }

    #[tokio::test]
    async fn accepts_a_payload_at_exactly_the_limit() {
        let mut buffer = Vec::new();
        let exact = vec![b'x'; MAX_FRAME_BYTES];
        write_frame(&mut buffer, &exact).await.unwrap();
        let mut cursor = Cursor::new(buffer);
        assert_eq!(
            read_frame(&mut cursor).await.unwrap().len(),
            MAX_FRAME_BYTES
        );
    }
}
