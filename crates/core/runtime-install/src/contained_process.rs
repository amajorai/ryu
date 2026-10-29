//! Scoped containment for asynchronous validation children with piped stdio.
//! Extract stdio before borrowing the child. Drain the scope before publishing
//! a generation; only after dropping the lease may the caller wait/reap it.
use anyhow::{Context, Result};
use tokio::process::{Child, Command};

/// Configure containment before spawn. Windows starts suspended with no console;
/// Unix establishes an inherited process group before exec.
pub fn prepare_command(command: &mut Command) {
    // If attachment fails before a Job exists, a suspended child must not be
    // stranded when the caller returns the error.
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0000_0004 | 0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
}

/// Keeps the child unreaped until descendant drainage completes. On Windows the
/// owned Job kills inherited descendants on close, including after leader exit.
/// Unix groups contain ordinary descendants while this lease remains live;
/// setsid/setpgid escape and process crashes do not have Windows Job semantics.
pub struct ContainedProcessLease<'child> {
    job: crate::process_job::ProcessJob,
    child: &'child Child,
}

impl<'child> ContainedProcessLease<'child> {
    /// Attach immediately after a spawn configured by `prepare_command`, before
    /// using its pipes. Windows assigns the suspended process before resuming it.
    pub fn attach(child: &'child Child) -> Result<Self> {
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::BorrowedHandle;
            let handle = child
                .raw_handle()
                .context("validation child was already reaped")?;
            // Child owns the process handle and the returned lease borrows Child,
            // preventing close/reap throughout assignment and descendant drainage.
            let handle = unsafe { BorrowedHandle::borrow_raw(handle) };
            crate::process_job::ProcessJob::attach_suspended_handle(handle)?
        };
        #[cfg(unix)]
        let job = crate::process_job::ProcessJob::new(
            child
                .id()
                .context("validation process-group leader was already reaped")?,
        )?;
        Ok(Self { job, child })
    }

    /// Count contained writers. A successful leader exit alone does not prove
    /// descendants holding ACP pipes have exited.
    pub fn active_processes(&self) -> Result<u32> {
        self.child
            .id()
            .context("validation child was already reaped")?;
        self.job.active_processes()
    }

    /// Terminate and verify all ordinary contained descendants are stopped.
    /// This is blocking and bounded to ten seconds. Any error must prevent
    /// generation publication/cleanup; wait/reap the child only after success
    /// and dropping this lease.
    pub fn terminate_and_wait(&self) -> Result<()> {
        self.child
            .id()
            .context("validation child was already reaped")?;
        self.job.terminate_and_wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Stdio,
        time::{Duration, Instant},
    };
    use tokio::io::AsyncReadExt;

    fn writer_command(path: &std::path::Path, exit_leader: bool) -> Command {
        #[cfg(windows)]
        let mut command = {
            // Node/libuv creates its own kill-on-close Job for direct children
            // on Windows. A .NET-created Node writer instead exercises our Job
            // after its PowerShell leader exits, including inherited ACP pipes.
            let script = path.with_extension("js");
            fs::write(&script, "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.env.RYU_TEST_WRITER,'x'),20)").unwrap();
            let mut command = Command::new("powershell");
            command
                .args([
                    "-NoProfile",
                    "-Command",
                    r#"
                $start=New-Object System.Diagnostics.ProcessStartInfo;
                $start.FileName=(Get-Command node).Source;
                $start.Arguments='"'+$env:RYU_TEST_WRITER_SCRIPT+'"';
                $start.UseShellExecute=$false;
                [void][Diagnostics.Process]::Start($start);
                [Console]::Out.WriteLine('contained-leader-ready');
                if($env:RYU_TEST_EXIT_LEADER -eq 'exit'){Start-Sleep -Milliseconds 100;exit 0}
                while($true){Start-Sleep -Seconds 1}
            "#,
                ])
                .env("RYU_TEST_WRITER_SCRIPT", script)
                .env("RYU_TEST_WRITER", path)
                .env(
                    "RYU_TEST_EXIT_LEADER",
                    if exit_leader { "exit" } else { "stay" },
                );
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("node");
            command.args(["-e", r#"
            const {spawn}=require('node:child_process');
            spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)",process.argv[1]],{stdio:'inherit'});
            process.stdout.write('contained-leader-ready\n');
            if(process.argv[2]==='exit')setTimeout(()=>process.exit(0),100);
            else setInterval(()=>{},1000);
        "#]).arg(path).arg(if exit_leader { "exit" } else { "stay" })
            ;
            command
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_command(&mut command);
        command
    }

    fn wait_for_writer(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(path.exists(), "contained descendant did not start");
    }

    #[test]
    fn explicit_drain_stops_descendant_and_releases_inherited_pipe_after_leader_exit() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let home = tempfile::tempdir().unwrap();
            let writer = home.path().join("writer");
            let mut child = writer_command(&writer, true).spawn().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let _stderr = child.stderr.take().unwrap();
            drop(child.stdin.take());
            let lease = ContainedProcessLease::attach(&child).unwrap();
            wait_for_writer(&writer);
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(lease.active_processes().unwrap() > 0);
            let mut output = Vec::new();
            assert!(
                tokio::time::timeout(Duration::from_millis(150), stdout.read_to_end(&mut output))
                    .await
                    .is_err(),
                "descendant unexpectedly released inherited pipe"
            );
            lease.terminate_and_wait().unwrap();
            assert_eq!(lease.active_processes().unwrap(), 0);
            tokio::time::timeout(Duration::from_secs(3), stdout.read_to_end(&mut output))
                .await
                .unwrap()
                .unwrap();
            let length = fs::metadata(&writer).unwrap().len();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(fs::metadata(&writer).unwrap().len(), length);
            drop(lease);
            assert!(child.wait().await.unwrap().success());
        });
    }

    #[test]
    fn dropping_containment_stops_live_descendants_and_pipe_writers() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let home = tempfile::tempdir().unwrap();
            let writer = home.path().join("writer");
            let mut child = writer_command(&writer, false).spawn().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let lease = ContainedProcessLease::attach(&child).unwrap();
            wait_for_writer(&writer);
            assert!(lease.active_processes().unwrap() >= 2);
            drop(lease);
            tokio::time::timeout(Duration::from_secs(3), stdout.read_to_end(&mut Vec::new()))
                .await
                .unwrap()
                .unwrap();
            child.wait().await.unwrap();
            let length = fs::metadata(&writer).unwrap().len();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(fs::metadata(&writer).unwrap().len(), length);
        });
    }

    #[test]
    fn already_reaped_child_cannot_authorize_containment() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut child = Command::new("node")
                .args(["-e", "process.exit(0)"])
                .spawn()
                .unwrap();
            assert!(child.wait().await.unwrap().success());
            assert!(ContainedProcessLease::attach(&child).is_err());
        });
    }
}
