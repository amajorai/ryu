//! Build-shape guards for the standalone Gateway.
//!
//! Nothing at runtime exercises the Gateway image build or the standalone lock:
//! in this monorepo every build resolves through the root workspace. Both broke
//! silently before (missing path deps in the image, then a stale standalone lock
//! that `--locked` rejects), so these source checks pin the shape instead.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn gateway_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn parse(path: &Path) -> toml::Value {
    toml::from_str(&read(path)).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// `name version` of every `[[package]]` in a lock, with its dependency names.
fn lock_packages(path: &Path) -> BTreeMap<(String, String, String), BTreeSet<String>> {
    let lock = parse(path);
    let mut packages = BTreeMap::new();
    for package in lock["package"].as_array().expect("lock has packages") {
        let field = |key: &str| {
            package
                .get(key)
                .and_then(toml::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let dependencies = package
            .get("dependencies")
            .and_then(toml::Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(toml::Value::as_str)
                    .map(|entry| entry.split(' ').next().unwrap_or(entry).to_owned())
                    .collect()
            })
            .unwrap_or_default();
        packages.insert(
            (field("name"), field("version"), field("source")),
            dependencies,
        );
    }
    packages
}

/// The dependency tables of a manifest that the standalone lock resolves: plain
/// and build, plus dev for the root package only (path dependencies outside the
/// standalone root are not workspace members, so their dev-dependencies are never
/// resolved), each including target-specific tables.
fn dependency_tables(manifest: &toml::Value, include_dev: bool) -> Vec<&toml::value::Table> {
    let kinds: &[&str] = if include_dev {
        &["dependencies", "dev-dependencies", "build-dependencies"]
    } else {
        &["dependencies", "build-dependencies"]
    };
    let mut tables: Vec<&toml::value::Table> = kinds
        .iter()
        .filter_map(|kind| manifest.get(*kind).and_then(toml::Value::as_table))
        .collect();
    if let Some(targets) = manifest.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            tables.extend(
                kinds
                    .iter()
                    .filter_map(|kind| target.get(*kind).and_then(toml::Value::as_table)),
            );
        }
    }
    tables
}

struct LocalCrate {
    name: String,
    version: String,
    /// Non-optional dependency package names (renames resolved).
    required: BTreeSet<String>,
}

/// The Gateway plus every crate it reaches through `path =` dependencies.
fn local_crates() -> Vec<LocalCrate> {
    let root = gateway_dir().canonicalize().expect("gateway dir exists");
    let mut pending = vec![root.clone()];
    let mut seen = BTreeSet::new();
    let mut crates = Vec::new();
    while let Some(dir) = pending.pop() {
        let dir = dir.canonicalize().expect("path dependency exists");
        if !seen.insert(dir.clone()) {
            continue;
        }
        let manifest = parse(&dir.join("Cargo.toml"));
        let package = &manifest["package"];
        let mut required = BTreeSet::new();
        for table in dependency_tables(&manifest, dir == root) {
            for (key, spec) in table {
                let package_name = spec
                    .get("package")
                    .and_then(toml::Value::as_str)
                    .unwrap_or(key)
                    .to_owned();
                if let Some(path) = spec.get("path").and_then(toml::Value::as_str) {
                    pending.push(dir.join(path));
                }
                let optional = spec
                    .get("optional")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(false);
                if !optional {
                    required.insert(package_name);
                }
            }
        }
        crates.push(LocalCrate {
            name: package["name"].as_str().expect("name").to_owned(),
            version: package["version"].as_str().expect("version").to_owned(),
            required,
        });
    }
    crates
}

#[test]
fn standalone_lock_covers_every_local_crate_and_its_dependencies() {
    let packages = lock_packages(&gateway_dir().join("Cargo.lock"));
    for local in local_crates() {
        let key = (local.name.clone(), local.version.clone(), String::new());
        let Some(locked) = packages.get(&key) else {
            panic!(
                "apps/gateway/Cargo.lock has no entry for {} {}; run \
                 apps/gateway/scripts/sync-standalone-lock.sh",
                local.name, local.version
            );
        };
        let missing: Vec<_> = local.required.difference(locked).collect();
        assert!(
            missing.is_empty(),
            "apps/gateway/Cargo.lock entry for {} is missing {missing:?}; run \
             apps/gateway/scripts/sync-standalone-lock.sh",
            local.name
        );
    }
}

#[test]
fn standalone_lock_is_pruned_from_the_root_lock() {
    // The public mirror has no root workspace, so there is nothing to compare.
    let root_lock = gateway_dir().join("../../Cargo.lock");
    if !root_lock.exists() {
        return;
    }
    let root = lock_packages(&root_lock);
    let drifted: Vec<_> = lock_packages(&gateway_dir().join("Cargo.lock"))
        .into_keys()
        .filter(|key| !root.contains_key(key))
        .map(|(name, version, _)| format!("{name} {version}"))
        .collect();
    assert!(
        drifted.is_empty(),
        "apps/gateway/Cargo.lock pins versions the root lock does not ({drifted:?}); run \
         apps/gateway/scripts/sync-standalone-lock.sh"
    );
}

#[test]
fn standalone_build_graph_does_not_link_libdbus() {
    // keyring's Linux Secret Service backend links libdbus-sys, which needs the
    // libdbus-1 headers the Gateway image does not install. The Gateway reaches
    // ryu-crypto only through ryu-composio, which turns its keychain feature off.
    let packages = lock_packages(&gateway_dir().join("Cargo.lock"));
    let linked: Vec<_> = packages
        .keys()
        .map(|(name, _, _)| name.as_str())
        .filter(|name| matches!(*name, "keyring" | "libdbus-sys" | "dbus"))
        .collect();
    assert!(linked.is_empty(), "Gateway graph pulls {linked:?}");
    let dockerfile = read(&gateway_dir().join("Dockerfile"));
    let installs_libdbus = dockerfile
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .any(|line| line.contains("libdbus"));
    assert!(!installs_libdbus, "Dockerfile installs libdbus");
}

#[test]
fn gateway_image_builds_from_the_whole_repo_context() {
    let dockerfile = read(&gateway_dir().join("Dockerfile"));
    // Copying only apps/gateway (+ crates) missed path deps twice; the image must
    // copy the repo-root context and build by manifest path against a lock.
    assert!(
        dockerfile.lines().any(|line| line.trim() == "COPY . ."),
        "Gateway Dockerfile must copy the whole repo-root context"
    );
    assert!(
        dockerfile
            .contains("cargo build --release --locked --manifest-path apps/gateway/Cargo.toml"),
        "Gateway Dockerfile must build the gateway by manifest path with --locked"
    );
    assert!(
        dockerfile.contains("ENV CARGO_TARGET_DIR=/src/target")
            && dockerfile.contains("cp /src/target/release/ryu-gateway"),
        "Gateway Dockerfile must copy the binary from the pinned target dir"
    );
}
