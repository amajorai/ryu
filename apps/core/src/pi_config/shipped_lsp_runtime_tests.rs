//! Shipped declarations through the real managed-agent materialization boundary.
//! The ACP caller uses this resolver/writer pair before Pi starts. This fixture
//! does not construct ServerState, drive Marketplace enable routes, or launch
//! third-party language-server binaries.

use super::*;
use std::collections::HashMap;

const PACKAGES: &[(&str, &str)] = &[
    (
        "clangd-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/clangd-lsp/manifest.json"),
    ),
    (
        "csharp-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/csharp-lsp/manifest.json"),
    ),
    (
        "gopls-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/gopls-lsp/manifest.json"),
    ),
    (
        "jdtls-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/jdtls-lsp/manifest.json"),
    ),
    (
        "kotlin-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/kotlin-lsp/manifest.json"),
    ),
    (
        "lua-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/lua-lsp/manifest.json"),
    ),
    (
        "php-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/php-lsp/manifest.json"),
    ),
    (
        "pyright-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/pyright-lsp/manifest.json"),
    ),
    (
        "ruby-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/ruby-lsp/manifest.json"),
    ),
    (
        "rust-analyzer-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/rust-analyzer-lsp/manifest.json"),
    ),
    (
        "swift-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/swift-lsp/manifest.json"),
    ),
    (
        "typescript-lsp",
        include_str!("../../../../generated/ryu-runtime/plugins-store/lsp/typescript-lsp/manifest.json"),
    ),
];

#[test]
fn shipped_lsp_packages_materialize_disable_and_retry_in_managed_agent_directory() {
    super::tests::with_temp_dir(|| {
        let path = config_dir().join("extensions").join("ryu-lsp.json");
        fs::create_dir_all(path.parent().unwrap()).expect("extensions dir");
        let unrelated = path.parent().unwrap().join("user-owned.ts");
        fs::write(&unrelated, "// preserved user extension\n").expect("user extension");

        for (package, source) in PACKAGES {
            let manifest: crate::plugin_manifest::PluginManifest =
                serde_json::from_str(source).expect("shipped manifest");
            let manifests = [manifest.clone()];
            let enabled =
                HashMap::from([(manifest.id.clone(), manifest.permission_grants.clone())]);
            let resolution = crate::lsp::resolve_lsp_servers(&manifests, &enabled);
            assert!(!resolution.is_empty(), "{package} contributes a server");
            assert!(
                resolution.skipped.is_empty(),
                "{package}: {:?}",
                resolution.skipped
            );
            write_lsp_servers_file(&resolution).expect("materialize shipped declaration");
            let bytes = fs::read_to_string(&path).expect("read persisted config");
            let persisted: Value = serde_json::from_str(&bytes).expect("read valid JSON");
            assert_eq!(persisted, resolution.to_wire_document(), "{package}");
            let expected = manifest.contributes.as_ref().unwrap().lsp_servers.len();
            assert_eq!(persisted["servers"].as_object().unwrap().len(), expected);
            for (name, declaration) in &manifest.contributes.as_ref().unwrap().lsp_servers {
                let key = format!("{}/{}", manifest.id, name);
                assert_eq!(persisted["servers"][&key]["command"], declaration.command);
                assert_eq!(
                    persisted["servers"][&key]["extensionToLanguage"],
                    serde_json::to_value(declaration.normalized_extensions()).unwrap()
                );
            }
            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            write_lsp_servers_file(&resolution).expect("idempotent same declaration");
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);

            let disabled = crate::lsp::resolve_lsp_servers(&manifests, &HashMap::new());
            assert!(disabled.is_empty());
            write_lsp_servers_file(&disabled).expect("disable removes stale config");
            assert!(
                !path.exists(),
                "{package} disable cannot retain its launch table"
            );
            write_lsp_servers_file(&disabled).expect("idempotent disabled config");

            // A directory occupying the owned file produces deterministic IO
            // failure even when tests run with elevated filesystem permissions.
            fs::create_dir(&path).expect("block config destination");
            let write_error = write_lsp_servers_file(&resolution).unwrap_err();
            assert!(format!("{write_error:#}").contains("write ryu-lsp.json"));
            assert!(path.is_dir());
            let delete_error = write_lsp_servers_file(&disabled).unwrap_err();
            assert!(format!("{delete_error:#}").contains("remove stale ryu-lsp.json"));
            assert!(
                path.is_dir(),
                "failed disable must report failure, not invent deletion"
            );
            fs::remove_dir(&path).expect("restore destination");
            write_lsp_servers_file(&resolution).expect("explicit retry succeeds");
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                bytes,
                "{package} retry readback"
            );
            write_lsp_servers_file(&disabled).expect("cleanup owned table");
            assert_eq!(
                fs::read_to_string(&unrelated).unwrap(),
                "// preserved user extension\n"
            );
        }
    });
}
