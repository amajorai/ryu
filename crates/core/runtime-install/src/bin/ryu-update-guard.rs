//! Detached update supervisor. Desktop must checkpoint and save its plan before
//! handing off, and the platform installer must suppress automatic app launch.
#![cfg_attr(windows, windows_subsystem = "windows")]

use anyhow::{ensure, Context, Result};
use ryu_runtime_install::{
    recovery::RecoveryCheckpoint,
    supervision::{supervise, SupervisionPlan},
};
use std::{fs, io::Write, path::PathBuf};

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut root = PathBuf::from(args.next().context("missing checkpoint path")?);
    let recovering = root.as_os_str() == "--recover";
    if recovering {
        root = PathBuf::from(args.next().context("missing recovery checkpoint path")?);
    }
    if root.as_os_str() == "--handoff" {
        let directory = PathBuf::from(args.next().context("missing handoff path")?);
        ensure!(args.next().is_none(), "unexpected handoff arguments");
        ryu_runtime_install::handoff::run_handoff(directory)?;
        return Ok(());
    }
    ensure!(
        args.next().is_none() && root.is_absolute(),
        "expected one absolute checkpoint path"
    );
    let checkpoint = RecoveryCheckpoint::open_taking_over(root, std::time::Duration::from_secs(2))?;
    let plan: SupervisionPlan =
        serde_json::from_slice(&fs::read(checkpoint.root().join("supervision-plan.json"))?)?;
    let outcome = if recovering {
        ryu_runtime_install::supervision::recover_interrupted(&checkpoint, &plan)
    } else {
        supervise(&checkpoint, &plan)
    };
    let evidence = match &outcome {
        Ok(outcome) => serde_json::json!({"guard_pid": std::process::id(), "outcome": outcome}),
        Err(error) => {
            serde_json::json!({"guard_pid": std::process::id(), "error": format!("{error:#}")})
        }
    };
    let mut file = tempfile::NamedTempFile::new_in(checkpoint.root())?;
    file.write_all(&serde_json::to_vec_pretty(&evidence)?)?;
    file.as_file().sync_all()?;
    file.persist(checkpoint.root().join("supervision-outcome.json"))
        .map_err(|error| error.error)?;
    outcome?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("update supervision stopped: {error:#}");
        std::process::exit(1);
    }
}
