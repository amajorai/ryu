//! Build script — best-effort OpenAPI client codegen from the vendored specs.
//!
//! This only does work when the `codegen` feature is enabled. The default build
//! is a no-op, so the crate can never be reddened by the generator. The vendored
//! specs are OpenAPI **3.1**, which `progenitor` (via `openapiv3`, a 3.0-only
//! model) does not fully support — hence codegen is opt-in and the hand-written
//! `model` client is the shipping transport. When the generator gains 3.1
//! support (or the spec is down-converted), `--features codegen` produces a
//! typed client at `OUT_DIR/gateway_client.rs`, surfaced as `ryu_sdk::generated`.

fn main() {
    println!("cargo:rerun-if-changed=specs/gateway-openapi.yaml");
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(feature = "codegen")]
    generate_gateway_client();
}

#[cfg(feature = "codegen")]
fn generate_gateway_client() {
    use std::path::Path;

    let spec_path = "specs/gateway-openapi.yaml";
    let raw = std::fs::read_to_string(spec_path)
        .unwrap_or_else(|e| panic!("read {spec_path}: {e}"));

    // progenitor consumes an `openapiv3::OpenAPI` (OpenAPI 3.0 model). A 3.1
    // spec may fail here; that failure is expected and is why the feature is
    // off by default.
    let spec: openapiv3::OpenAPI = serde_yaml::from_str(&raw).unwrap_or_else(|e| {
        panic!(
            "parse {spec_path} as OpenAPI 3.0: {e}. The vendored spec is 3.1; \
             down-convert it or wait for progenitor 3.1 support before enabling \
             the `codegen` feature."
        )
    });

    let mut generator = progenitor::Generator::default();
    let tokens = generator
        .generate_tokens(&spec)
        .unwrap_or_else(|e| panic!("progenitor codegen failed: {e}"));
    let ast = syn::parse2(tokens).expect("generated tokens parse as Rust");
    let content = prettyplease::unparse(&ast);

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
    let out_path = Path::new(&out_dir).join("gateway_client.rs");
    std::fs::write(&out_path, content)
        .unwrap_or_else(|e| panic!("write {}: {e}", out_path.display()));
}
