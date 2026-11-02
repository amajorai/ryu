use super::*;

#[test]
fn parse_quant_picks_most_specific() {
    assert_eq!(
        parse_quant("gemma-4-E2B-it-Q4_K_M.gguf").as_deref(),
        Some("Q4_K_M")
    );
    assert_eq!(parse_quant("model.Q8_0.gguf").as_deref(), Some("Q8_0"));
    assert_eq!(parse_quant("model-f16.gguf").as_deref(), Some("F16"));
    assert_eq!(parse_quant("model-bf16.gguf").as_deref(), Some("BF16"));
    assert_eq!(parse_quant("model-IQ4_XS.gguf").as_deref(), Some("IQ4_XS"));
    assert_eq!(
        parse_quant("model-IQ2_XXS.gguf").as_deref(),
        Some("IQ2_XXS")
    );
    assert_eq!(parse_quant("Qwen-Q6_K.gguf").as_deref(), Some("Q6_K"));
    // Community suffix variants that the old fixed-list parser missed.
    assert_eq!(parse_quant("model-Q3_K_P.gguf").as_deref(), Some("Q3_K_P"));
    assert_eq!(parse_quant("model-Q8_K_P.gguf").as_deref(), Some("Q8_K_P"));
    assert_eq!(
        parse_quant("model-UD-Q4_K_XL.gguf").as_deref(),
        Some("Q4_K_XL")
    );
    assert_eq!(parse_quant("weights.gguf"), None);
}

#[test]
fn split_id_handles_org_and_bare() {
    assert_eq!(
        split_id("unsloth/gemma"),
        ("unsloth".into(), "gemma".into())
    );
    assert_eq!(split_id("gemma"), (String::new(), "gemma".into()));
}

#[test]
fn local_stem_strips_extension() {
    assert_eq!(local_stem("gemma-Q4_K_M.gguf"), "gemma-Q4_K_M");
}

#[test]
fn validate_gguf_filename_accepts_plain_names() {
    assert!(validate_gguf_filename("gemma-4-E2B-it-Q4_K_M.gguf").is_ok());
    assert!(validate_gguf_filename("model-00001-of-00002.gguf").is_ok());
    assert!(validate_gguf_filename("Model.GGUF").is_ok());
}

#[test]
fn validate_gguf_filename_rejects_traversal() {
    // Path traversal and separators must never reach the on-disk stem.
    assert!(validate_gguf_filename("../evil.gguf").is_err());
    assert!(validate_gguf_filename("..\\..\\evil.gguf").is_err());
    assert!(validate_gguf_filename("sub/dir/model.gguf").is_err());
    assert!(validate_gguf_filename("C:\\Windows\\System32\\evil.gguf").is_err());
    assert!(validate_gguf_filename("/etc/cron.d/evil.gguf").is_err());
    assert!(validate_gguf_filename(".hidden.gguf").is_err());
    // Wrong extension is rejected regardless of shape.
    assert!(validate_gguf_filename("model.bin").is_err());
    assert!(validate_gguf_filename("..").is_err());
}

#[test]
fn subfoldered_hub_paths_install_under_their_basename() {
    // The published QuantStack/Wan2.2-I2V-A14B-GGUF layout keeps each half
    // of the transformer pair in its own folder.
    for path in [
        "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf",
        "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf",
    ] {
        assert!(validate_hub_gguf_path(path).is_ok(), "{path}");
    }
    assert_eq!(
        local_stem("LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf"),
        "Wan2.2-I2V-A14B-LowNoise-Q4_K_M"
    );
    assert_eq!(local_stem("a/b/c-Q8_0.gguf"), "c-Q8_0");
    assert!(validate_hub_gguf_path("plain-Q4_K_M.gguf").is_ok());
}

#[test]
fn subfoldered_hub_paths_keep_traversal_blocked() {
    for path in [
        "../evil.gguf",
        "LowNoise/../../evil.gguf",
        "../LowNoise/evil.gguf",
        "./LowNoise/evil.gguf",
        ".hidden/evil.gguf",
        "/etc/evil.gguf",
        "LowNoise//evil.gguf",
        "LowNoise/",
        "Low Noise/evil.gguf",
        "LowNoise\\evil.gguf",
        "C:/evil.gguf",
        "LowNoise/.evil.gguf",
        "LowNoise/evil.bin",
    ] {
        assert!(validate_hub_gguf_path(path).is_err(), "{path}");
    }
}

#[test]
fn validate_repo_id_accepts_author_name() {
    assert!(validate_repo_id("unsloth/gemma-4-E2B-it-GGUF").is_ok());
    assert!(validate_repo_id("TheBloke/Llama-2-7B.GGUF").is_ok());
}

#[test]
fn validate_repo_id_rejects_malformed() {
    assert!(validate_repo_id("nogroup").is_err());
    assert!(validate_repo_id("../../etc").is_err());
    assert!(validate_repo_id("a/b/c").is_err());
    assert!(validate_repo_id("author/").is_err());
    assert!(validate_repo_id("/name").is_err());
    assert!(validate_repo_id("au thor/name").is_err());
    assert!(validate_repo_id("author/..").is_err());
}
