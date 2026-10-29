//! Provider-free process proof using the production generation publisher.
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::RuntimeGenerations;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdout, Command, Stdio},
};

fn candidate(store: &RuntimeGenerations, version: &str) -> Result<tempfile::TempDir> {
    let directory = store.stage()?;
    for name in ["core", "gateway", "cli"] {
        fs::write(directory.path().join(name), version)?;
    }
    Ok(directory)
}

fn versions(directory: &Path) -> Result<Vec<String>> {
    ["core", "gateway", "cli"]
        .iter()
        .map(|name| Ok(fs::read_to_string(directory.join(name))?))
        .collect()
}

fn read_worker(child: &mut Child, reader: &mut BufReader<ChildStdout>) -> Result<Vec<String>> {
    child
        .stdin
        .as_mut()
        .context("worker stdin")?
        .write_all(b"state\n")?;
    let mut line = String::new();
    ensure!(
        reader.read_line(&mut line)? > 0,
        "worker exited unexpectedly"
    );
    Ok(serde_json::from_str(&line)?)
}

fn main() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = RuntimeGenerations::new(root.path().to_path_buf());
    let original = store.activate(candidate(&store, "1")?)?;
    let mut worker = Command::new("node").args(["-e", "const fs=require('node:fs');const path=require('node:path');const dir=process.argv[1];require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify(['core','gateway','cli'].map(name=>fs.readFileSync(path.join(dir,name),'utf8')))+'\\n')); "])
        .arg(&original).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let original_pid = worker.id();
    let mut reader = BufReader::new(worker.stdout.take().context("worker stdout")?);
    ensure!(
        read_worker(&mut worker, &mut reader)? == ["1", "1", "1"],
        "initial worker release"
    );

    // Simulate a failed dependency preparation before publication.
    {
        let failed = store.stage()?;
        fs::write(failed.path().join("core"), "broken")?;
    }
    ensure!(
        store.active_dir()? == original,
        "failed preparation changed the active release"
    );
    let after_failure = read_worker(&mut worker, &mut reader)?;
    ensure!(
        after_failure == ["1", "1", "1"],
        "failed preparation changed running work"
    );

    let current = store.activate(candidate(&store, "2")?)?;
    let selected = versions(&store.active_dir()?)?;
    let still_running = read_worker(&mut worker, &mut reader)?;
    ensure!(selected == ["2", "2", "2"], "partial release selection");
    ensure!(
        still_running == ["1", "1", "1"] && worker.id() == original_pid,
        "running worker lost its original dependency tree"
    );
    ensure!(
        store.rollback()? == original,
        "rollback did not restore the original release"
    );
    let restored = versions(&store.active_dir()?)?;
    ensure!(
        restored == ["1", "1", "1"] && current.is_dir(),
        "rollback removed an existing generation"
    );
    drop(worker.stdin.take());
    ensure!(worker.wait()?.success(), "worker did not exit cleanly");
    println!(
        "{}",
        serde_json::json!({
            "worker_pid": original_pid,
            "after_failed_preparation": after_failure,
            "active_release_after_commit": selected,
            "original_worker_after_commit": still_running,
            "active_release_after_rollback": restored,
            "worker_exited_cleanly": true,
        })
    );
    Ok(())
}
