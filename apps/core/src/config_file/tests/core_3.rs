//! The CONFIG rows of `docs/env-audit/core-3.md`: each documented grouped path
//! must flatten to the exact name its reader uses, or the file setting would
//! silently do nothing.

use crate::config_file::{friendly_path_to_env_name, is_reserved_or_secret};

const CASES: &[(&str, &str)] = &[
    ("sandbox.daytonaTimeoutSecs", "RYU_SANDBOX_DAYTONA_TIMEOUT_SECS"),
    ("sandbox.daytonaVcpu", "RYU_SANDBOX_DAYTONA_VCPU"),
    ("sandbox.dockerBinary", "RYU_SANDBOX_DOCKER_BINARY"),
    ("sandbox.dockerDetectSecs", "RYU_SANDBOX_DOCKER_DETECT_SECS"),
    ("sandbox.dockerImage", "RYU_SANDBOX_DOCKER_IMAGE"),
    ("sandbox.localEnable", "RYU_SANDBOX_LOCAL_ENABLE"),
    ("sandbox.microsandboxBinary", "RYU_SANDBOX_MICROSANDBOX_BINARY"),
    ("sandbox.microsandboxDetectSecs", "RYU_SANDBOX_MICROSANDBOX_DETECT_SECS"),
    ("sandbox.microsandboxImage", "RYU_SANDBOX_MICROSANDBOX_IMAGE"),
    ("sandbox.mxcAllowDaclMutation", "RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION"),
    ("sandbox.mxcBinary", "RYU_SANDBOX_MXC_BINARY"),
    ("sandbox.mxcDetectSecs", "RYU_SANDBOX_MXC_DETECT_SECS"),
    ("sandbox.opensandboxBinary", "RYU_SANDBOX_OPENSANDBOX_BINARY"),
    ("sandbox.opensandboxDetectSecs", "RYU_SANDBOX_OPENSANDBOX_DETECT_SECS"),
    ("sandbox.opensandboxImage", "RYU_SANDBOX_OPENSANDBOX_IMAGE"),
    ("sandbox.opensandboxTimeout", "RYU_SANDBOX_OPENSANDBOX_TIMEOUT"),
    ("sandbox.singularityBinary", "RYU_SANDBOX_SINGULARITY_BINARY"),
    ("sandbox.singularityDetectSecs", "RYU_SANDBOX_SINGULARITY_DETECT_SECS"),
    ("sandbox.singularityImage", "RYU_SANDBOX_SINGULARITY_IMAGE"),
    ("sandbox.sshBinary", "RYU_SANDBOX_SSH_BINARY"),
    ("sd.model", "RYU_SD_MODEL"),
    ("session.boxIdleSecs", "RYU_SESSION_BOX_IDLE_SECS"),
    ("sglang.model", "RYU_SGLANG_MODEL"),
    ("shadow.releaseUrl", "RYU_SHADOW_RELEASE_URL"),
    ("sidecar.idleSecs", "RYU_SIDECAR_IDLE_SECS"),
    ("sidecar.releaseBase", "RYU_SIDECAR_RELEASE_BASE"),
    ("sidecar.sandbox", "RYU_SIDECAR_SANDBOX"),
    ("sidecar.sandboxPlugins", "RYU_SIDECAR_SANDBOX_PLUGINS"),
    ("silero.vadModelSha256", "RYU_SILERO_VAD_MODEL_SHA256"),
    ("silero.vadModelUrl", "RYU_SILERO_VAD_MODEL_URL"),
    ("skills.author", "RYU_SKILLS_AUTHOR"),
    ("skills.disclosure", "RYU_SKILLS_DISCLOSURE"),
    ("spaces.linkExpansion", "RYU_SPACES_LINK_EXPANSION"),
    ("voice.sttEngine", "RYU_STT_ENGINE"),
    ("stt.gatewayModel", "RYU_STT_GATEWAY_MODEL"),
    ("stt.gatewayProvider", "RYU_STT_GATEWAY_PROVIDER"),
    ("tool.catalogPrecedence", "RYU_TOOL_CATALOG_PRECEDENCE"),
    ("tool.execMemoryMb", "RYU_TOOL_EXEC_MEMORY_MB"),
    ("trace.maxRows", "RYU_TRACE_MAX_ROWS"),
    ("trace.retentionDays", "RYU_TRACE_RETENTION_DAYS"),
    ("treg.catalogCacheTtlSecs", "RYU_TREG_CATALOG_CACHE_TTL_SECS"),
    ("treg.catalogUrl", "RYU_TREG_CATALOG_URL"),
    ("voice.ttsEngine", "RYU_TTS_ENGINE"),
    ("vault.auditFailClosed", "RYU_VAULT_AUDIT_FAIL_CLOSED"),
    ("vault.auditRetentionDays", "RYU_VAULT_AUDIT_RETENTION_DAYS"),
    ("vault.brokerBurst", "RYU_VAULT_BROKER_BURST"),
    ("vault.brokerLogMaxAgeHours", "RYU_VAULT_BROKER_LOG_MAX_AGE_HOURS"),
    ("vault.brokerLogMaxRows", "RYU_VAULT_BROKER_LOG_MAX_ROWS"),
    ("vault.brokerMaxRequestBytes", "RYU_VAULT_BROKER_MAX_REQUEST_BYTES"),
    ("vault.brokerNetworkAllowlist", "RYU_VAULT_BROKER_NETWORK_ALLOWLIST"),
    ("vault.brokerRps", "RYU_VAULT_BROKER_RPS"),
    ("vault.externalAllowLoopback", "RYU_VAULT_EXTERNAL_ALLOW_LOOPBACK"),
    ("vault.externalAllowPrivate", "RYU_VAULT_EXTERNAL_ALLOW_PRIVATE"),
    ("vault.loginRatePerMin", "RYU_VAULT_LOGIN_RATE_PER_MIN"),
    ("vault.shared", "RYU_VAULT_SHARED"),
    ("vault.sharedCacheSecs", "RYU_VAULT_SHARED_CACHE_SECS"),
    ("vault.sharedStaleSecs", "RYU_VAULT_SHARED_STALE_SECS"),
    ("vault.transitSoftDeleteDays", "RYU_VAULT_TRANSIT_SOFT_DELETE_DAYS"),
    ("vector.cacheMb", "RYU_VECTOR_CACHE_MB"),
    ("vllm.model", "RYU_VLLM_MODEL"),
];

#[test]
fn core_3_node_config_paths_reach_their_readers() {
    for (path, expected) in CASES {
        let path: Vec<String> = path.split('.').map(str::to_owned).collect();
        assert_eq!(&friendly_path_to_env_name(&path), expected, "path {path:?}");
        assert!(!is_reserved_or_secret(expected), "{expected} is reserved");
    }
}

/// The shipped example is mounted as live config by `docker-compose.yml`, so
/// every engine it pins must be one the reader accepts. `whispercpp` is not an
/// STT engine id, and pinning one would also override the build's default.
#[test]
fn shipped_example_does_not_pin_the_stt_engine() {
    let example = include_str!("../../../../../config/node-config.example.json");
    assert!(!example.contains("sttEngine"), "{example}");
}
