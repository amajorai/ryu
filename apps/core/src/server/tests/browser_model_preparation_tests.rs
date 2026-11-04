use crate::server::is_valid_browser_model_id;

#[test]
fn accepts_hub_ids_and_rejects_urls_or_revisions() {
    assert!(is_valid_browser_model_id(
        "onnx-community/SmolLM2-135M-ONNX"
    ));
    assert!(!is_valid_browser_model_id(
        "https://huggingface.co/acme/model"
    ));
    assert!(!is_valid_browser_model_id("acme/model@main"));
    assert!(!is_valid_browser_model_id("../acme/model"));
    assert!(!is_valid_browser_model_id("acme/model/extra"));
}
