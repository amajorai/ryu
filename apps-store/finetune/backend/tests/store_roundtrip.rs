//! Smoke coverage for the extracted fine-tune durable state: the SQLite job store
//! round-trips a job and the JSON adapter catalog is idempotent + prunes phantoms.

use ryu_finetune::adapters::{self, InstalledAdapter};
use ryu_finetune::{FinetuneJob, FinetuneStore};

fn job(id: &str) -> FinetuneJob {
    FinetuneJob {
        id: id.to_string(),
        base_model: "unsloth/gemma-3-4b".to_string(),
        output_name: None,
        state: "queued".to_string(),
        target: "local".to_string(),
        remote_url: None,
        remote_token: None,
        output_ref: None,
        error: None,
        created_at: "2026-07-17T00:00:00Z".to_string(),
        updated_at: "2026-07-17T00:00:00Z".to_string(),
    }
}

#[tokio::test]
async fn store_records_updates_and_lists() {
    let dir = std::env::temp_dir().join(format!("ryu-finetune-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = FinetuneStore::open(dir.join("finetune.db")).unwrap();

    store.record(&job("job-1")).await.unwrap();
    assert!(store.get("job-1").await.unwrap().is_some());

    let updated = store
        .update_state("job-1", "succeeded", Some("/models/out"), None, "2026-07-17T01:00:00Z")
        .await
        .unwrap();
    assert!(updated);
    let got = store.get("job-1").await.unwrap().unwrap();
    assert_eq!(got.state, "succeeded");
    assert_eq!(got.output_ref.as_deref(), Some("/models/out"));

    assert_eq!(store.list().await.unwrap().len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn adapters_record_is_idempotent_and_prunes_missing() {
    let dir = std::env::temp_dir().join(format!("ryu-finetune-adapters-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    ryu_finetune::init_data_dir(dir.clone());

    // A directory that exists on disk is retained; a phantom is pruned.
    let present_dir = dir.join("present-stem");
    std::fs::create_dir_all(&present_dir).unwrap();
    adapters::record(InstalledAdapter {
        stem: "present-stem".to_string(),
        base_model: "unsloth/gemma-3-4b".to_string(),
        job_id: "job-1".to_string(),
        path: present_dir.to_string_lossy().to_string(),
        created_at: "2026-07-17T00:00:00Z".to_string(),
    })
    .unwrap();
    // Re-record the same stem: idempotent (still one entry).
    adapters::record(InstalledAdapter {
        stem: "present-stem".to_string(),
        base_model: "unsloth/gemma-3-4b".to_string(),
        job_id: "job-2".to_string(),
        path: present_dir.to_string_lossy().to_string(),
        created_at: "2026-07-17T00:00:00Z".to_string(),
    })
    .unwrap();
    adapters::record(InstalledAdapter {
        stem: "phantom-stem".to_string(),
        base_model: "unsloth/gemma-3-4b".to_string(),
        job_id: "job-3".to_string(),
        path: dir.join("does-not-exist").to_string_lossy().to_string(),
        created_at: "2026-07-17T00:00:00Z".to_string(),
    })
    .unwrap();

    let present = adapters::load_present();
    assert_eq!(present.len(), 1);
    assert_eq!(present[0].stem, "present-stem");
    std::fs::remove_dir_all(&dir).ok();
}
