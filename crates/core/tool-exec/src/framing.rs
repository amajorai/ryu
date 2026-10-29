//! Size limits on what a sandboxed program can make the host retain.

/// Maximum size of one guest-to-host frame (an operation request, a final
/// value, or a log line before truncation). A larger operation or final value
/// fails the run instead of making Core allocate whatever the guest asks for.
pub(crate) const MAX_PROTOCOL_FRAME_BYTES: usize = 64 * 1024;

/// Maximum number of log entries retained for one execution.
///
/// The byte cap alone does not bound allocation: an attacker can emit an
/// unbounded number of empty log frames. Keeping the count bounded closes that
/// zero-byte accumulation path while preserving the existing byte ceiling.
pub(crate) const MAX_LOG_LINES: usize = 1024;
