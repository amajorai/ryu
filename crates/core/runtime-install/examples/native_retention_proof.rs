//! Prepare only private test history for actual desktop startup maintenance.
use anyhow::{ensure, Result};
use ryu_runtime_install::recovery::RecoveryCheckpoint;
use std::{fs, path::PathBuf};

fn main() -> Result<()> {
    let namespace = PathBuf::from(
        std::env::var_os("LOCALAPPDATA").ok_or_else(|| anyhow::anyhow!("missing cache"))?,
    )
    .join("ryu-update-recovery/com.ryu.shutdown-proof");
    ensure!(
        !namespace.join("pending-dev.json").exists(),
        "private update is pending"
    );
    fs::create_dir_all(namespace.join("transactions"))?;
    let home = tempfile::Builder::new()
        .prefix("ryu-retention-proof-")
        .tempdir()?;
    let home = home.keep();
    let suffix = home.file_name().unwrap().to_string_lossy();
    let partial_id = format!("{suffix}-partial");
    let partial = namespace.join("transactions").join(&partial_id);
    fs::create_dir(&partial)?;
    fs::create_dir(partial.join("snapshot-0"))?;
    fs::write(partial.join("snapshot-0/partial"), "interrupted-copy")?;
    let identity = ryu_runtime_install::tree_identity::TreeIdentity::read(&partial)?
        .ok_or_else(|| anyhow::anyhow!("private fixture identity unavailable"))?;
    let partial_receipt = namespace
        .join("transactions")
        .join(format!(".preparation-{partial_id}.json"));
    ryu_runtime_install::handoff::write_json(
        &partial_receipt,
        &serde_json::json!({
            "schema":1,"transaction":partial_id,"profile":"dev","phase":"capturing","identity":identity
        }),
    )?;
    let mut fixtures = Vec::new();
    for (name, profile) in [
        ("first", "dev"),
        ("second", "dev"),
        ("third", "dev"),
        ("beta", "beta"),
    ] {
        let data = home.join(name);
        fs::create_dir(&data)?;
        fs::write(data.join("value"), "previous-data")?;
        let id = format!("{suffix}-{name}");
        let checkpoint = RecoveryCheckpoint::create(
            namespace.join("transactions").join(&id),
            &[data.clone()],
            "1".into(),
            "2".into(),
            profile.into(),
        )?;
        let restore_parent = checkpoint.read()?.roots[0]
            .target
            .parent()
            .unwrap()
            .to_owned();
        let restore_temporary = tempfile::Builder::new()
            .prefix(".ryu-restore-")
            .tempdir_in(&restore_parent)?
            .keep();
        let restore_identity =
            ryu_runtime_install::tree_identity::TreeIdentity::read(&restore_temporary)?
                .ok_or_else(|| anyhow::anyhow!("private restore temporary identity unavailable"))?;
        let restore_receipt = checkpoint.root().join("restoring-temporaries.json");
        ryu_runtime_install::handoff::write_json(
            &restore_receipt,
            &serde_json::json!({
                "schema": 1, "transaction": id, "profile": profile,
                "trees": [{"root_index": 0, "path": restore_temporary, "identity": restore_identity}]
            }),
        )?;
        fs::write(
            restore_temporary.join("partial-model"),
            "interrupted-restore-copy",
        )?;
        checkpoint.begin_installation()?;
        fs::write(data.join("value"), "current-data")?;
        checkpoint.await_health()?;
        checkpoint.commit("2")?;
        let ready = data.parent().unwrap().join(format!(".{name}.{id}.restore"));
        ensure!(ready.exists(), "rollback tree was not reserved");
        fixtures.push(serde_json::json!({"name":name,"profile":profile,"checkpoint":checkpoint.root(),"data":data,"ready":ready,"restoreTemporary":restore_temporary,"restoreTemporaryProfile":profile,"restoreTemporaryReceipt":restore_receipt}));
    }
    println!(
        "{}",
        serde_json::json!({"namespace":namespace,"home":home,"fixtures":fixtures,"partial":partial,"partialReceipt":partial_receipt})
    );
    Ok(())
}
