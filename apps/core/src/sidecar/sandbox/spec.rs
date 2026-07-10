//! Byte-for-byte Core mirror of the Gateway's canonical `SandboxSpec` and its
//! two shared enums (`GpuKind` / `OsKind`).
//!
//! The authoritative definition lives in `apps/gateway/src/api/sandbox.rs`
//! (implementer B), which imports `GpuKind` / `OsKind` from `apps/gateway/src/
//! config.rs` (implementer A). Core is a separate crate, so per the FROZEN
//! CONTRACT (§2) it duplicates the struct and both enums here with the exact
//! serde strings — the two sides interoperate only through the wire JSON, so the
//! serde renames MUST match on the byte, not the identifier.
//!
//! Frozen wire strings (do not "clean up" with `rename_all` — it mishandles the
//! digit-bearing variants):
//!   - `GpuKind` → `"none" | "h200" | "h100" | "rtx_pro_6000" | "rtx_5090" | "rtx_4090"`
//!   - `OsKind`  → `"linux" | "windows"`
//!
//! Canonical wire JSON:
//! ```json
//! { "vcpu": 2, "mem_gib": 4, "storage_gib": 10, "gpu": "none", "gpu_count": 0, "os": "linux" }
//! ```

use serde::{Deserialize, Serialize};

/// GPU class attached to a sandbox, mirrored from `crate::config::GpuKind` on the
/// Gateway. `None` means CPU-only; the priced variants map to the Daytona GPU
/// rate table. Serde strings are frozen per the shared-name resolution table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
pub enum GpuKind {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "h200")]
    H200,
    #[serde(rename = "h100")]
    H100,
    #[serde(rename = "rtx_pro_6000")]
    RtxPro6000,
    #[serde(rename = "rtx_5090")]
    Rtx5090,
    #[serde(rename = "rtx_4090")]
    Rtx4090,
}

/// Sandbox operating system, mirrored from `crate::config::OsKind` on the
/// Gateway. Windows carries a per-vCPU surcharge in the cost math; Linux does
/// not. Serde strings are frozen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
pub enum OsKind {
    #[default]
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "windows")]
    Windows,
}

/// Resource shape of one sandbox run, mirrored byte-for-byte from the Gateway's
/// canonical `SandboxSpec`. Sent as-is inside the `POST /sandbox/tick` request so
/// the Gateway can price the elapsed second-delta against its rate table.
///
/// `gpu_count` defaults to `0`; when `gpu != None` and `gpu_count == 0` the
/// Gateway treats it as `1` (see the cost math in the contract §4). Core does not
/// re-derive cost — it only reports this spec.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SandboxSpec {
    /// Virtual CPU count.
    pub vcpu: u32,
    /// Memory in GiB.
    pub mem_gib: u32,
    /// Persistent storage in GiB (first `sandbox_free_storage_gib` are free).
    pub storage_gib: u32,
    /// GPU class attached, or [`GpuKind::None`] for CPU-only.
    pub gpu: GpuKind,
    /// Number of GPUs; `0` for [`GpuKind::None`]. `gpu != None && gpu_count == 0`
    /// is billed as one GPU by the Gateway.
    #[serde(default)]
    pub gpu_count: u32,
    /// Operating system of the sandbox.
    pub os: OsKind,
}

impl Default for SandboxSpec {
    /// A minimal CPU-only Linux box (2 vCPU / 4 GiB / 10 GiB / no GPU). This is
    /// the fallback shape when nothing more specific is configured.
    fn default() -> Self {
        Self {
            vcpu: 2,
            mem_gib: 4,
            storage_gib: 10,
            gpu: GpuKind::None,
            gpu_count: 0,
            os: OsKind::Linux,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_kind_serde_strings_are_frozen() {
        for (variant, expected) in [
            (GpuKind::None, "\"none\""),
            (GpuKind::H200, "\"h200\""),
            (GpuKind::H100, "\"h100\""),
            (GpuKind::RtxPro6000, "\"rtx_pro_6000\""),
            (GpuKind::Rtx5090, "\"rtx_5090\""),
            (GpuKind::Rtx4090, "\"rtx_4090\""),
        ] {
            assert_eq!(serde_json::to_string(&variant).unwrap(), expected);
            let back: GpuKind = serde_json::from_str(expected).unwrap();
            assert_eq!(back, variant);
        }
    }

    #[test]
    fn os_kind_serde_strings_are_frozen() {
        assert_eq!(serde_json::to_string(&OsKind::Linux).unwrap(), "\"linux\"");
        assert_eq!(
            serde_json::to_string(&OsKind::Windows).unwrap(),
            "\"windows\""
        );
        let linux: OsKind = serde_json::from_str("\"linux\"").unwrap();
        assert_eq!(linux, OsKind::Linux);
    }

    #[test]
    fn spec_wire_json_matches_contract() {
        let spec = SandboxSpec {
            vcpu: 2,
            mem_gib: 4,
            storage_gib: 10,
            gpu: GpuKind::None,
            gpu_count: 0,
            os: OsKind::Linux,
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "vcpu": 2, "mem_gib": 4, "storage_gib": 10,
                "gpu": "none", "gpu_count": 0, "os": "linux"
            })
        );
    }

    #[test]
    fn spec_gpu_count_defaults_to_zero_on_deserialize() {
        // `gpu_count` is `#[serde(default)]`, so an omitted field round-trips to 0.
        let spec: SandboxSpec = serde_json::from_str(
            r#"{ "vcpu": 8, "mem_gib": 32, "storage_gib": 100, "gpu": "h100", "os": "linux" }"#,
        )
        .unwrap();
        assert_eq!(spec.gpu_count, 0);
        assert_eq!(spec.gpu, GpuKind::H100);
    }
}
