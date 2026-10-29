//! Contain supervised children before their code can spawn ordinary descendants.
#[cfg(windows)]
mod windows_job {
    use anyhow::{ensure, Context, Result};
    use std::{
        mem::{size_of, zeroed},
        os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle},
        process::Child,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{GetProcessId, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(crate) struct ProcessJob {
        handle: Handle,
    }
    impl ProcessJob {
        pub(crate) fn attach_and_resume(child: &Child) -> Result<Self> {
            Self::attach_suspended_handle(child.as_handle())
        }

        pub(crate) fn attach_suspended_handle(process: BorrowedHandle<'_>) -> Result<Self> {
            // Derive the identity from the borrowed live process object, never
            // reopen a PID that could now name an unrelated process.
            let process_id = unsafe { GetProcessId(process.as_raw_handle() as HANDLE) };
            ensure!(process_id != 0, "cannot identify suspended process handle");
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            ensure!(
                handle != 0,
                "cannot create recovery process job: {}",
                std::io::Error::last_os_error()
            );
            let job = Self {
                handle: Handle(handle),
            };
            job.set_kill_on_close(true)?;
            ensure!(
                unsafe {
                    AssignProcessToJobObject(job.handle.0, process.as_raw_handle() as HANDLE)
                } != 0,
                "cannot contain recovery child: {}",
                std::io::Error::last_os_error()
            );
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            ensure!(
                snapshot != INVALID_HANDLE_VALUE,
                "cannot inspect suspended child threads"
            );
            let snapshot = Handle(snapshot);
            let mut entry: THREADENTRY32 = unsafe { zeroed() };
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut present = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
            let mut resumed = false;
            while present {
                if entry.th32OwnerProcessID == process_id {
                    let thread =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    ensure!(thread != 0, "cannot open suspended child thread");
                    let thread = Handle(thread);
                    ensure!(
                        unsafe { ResumeThread(thread.0) } == 1,
                        "contained child did not have exactly one initial suspension"
                    );
                    resumed = true;
                }
                present = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
            }
            ensure!(resumed, "contained child had no resumable initial thread");
            Ok(job)
        }
        fn set_kill_on_close(&self, enabled: bool) -> Result<()> {
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = if enabled {
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            } else {
                0
            };
            ensure!(
                unsafe {
                    SetInformationJobObject(
                        self.handle.0,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    )
                } != 0,
                "cannot configure recovery process job: {}",
                std::io::Error::last_os_error()
            );
            Ok(())
        }
        pub(crate) fn release(&self) -> Result<()> {
            self.set_kill_on_close(false)
                .context("could not release the committed app's process job")
        }
        pub(crate) fn active_processes(&self) -> Result<u32> {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            ensure!(
                unsafe {
                    QueryInformationJobObject(
                        self.handle.0,
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut _,
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        std::ptr::null_mut(),
                    )
                } != 0,
                "cannot inspect contained update writers: {}",
                std::io::Error::last_os_error()
            );
            Ok(accounting.ActiveProcesses)
        }
        pub(crate) fn terminate_and_wait(&self) -> Result<()> {
            ensure!(
                unsafe { TerminateJobObject(self.handle.0, 1) } != 0,
                "cannot terminate contained update writers: {}",
                std::io::Error::last_os_error()
            );
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while self.active_processes()? != 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            ensure!(
                self.active_processes()? == 0,
                "contained update writers did not stop; refusing restore"
            );
            Ok(())
        }
    }
}

#[cfg(windows)]
pub(crate) use windows_job::ProcessJob;

#[cfg(any(unix, test))]
fn verify_group_anchor(leader_reaped: bool, actual_group: i32, group: i32) -> anyhow::Result<()> {
    anyhow::ensure!(
        !leader_reaped,
        "recovery group leader was reaped; refusing an unverified process-group signal"
    );
    anyhow::ensure!(
        actual_group == group,
        "recovery child left its original group; refusing an unverified process-group signal"
    );
    Ok(())
}

#[cfg(any(unix, test))]
fn group_signal_result(result: i32, error: std::io::Error) -> anyhow::Result<()> {
    // ESRCH is shared by the supported Linux/macOS targets: an empty group has
    // already stopped. Every other failure must prevent rollback.
    if result == 0 || error.raw_os_error() == Some(3) {
        Ok(())
    } else {
        Err(error.into())
    }
}

#[cfg(unix)]
mod unix_group {
    // Groups contain ordinary inherited descendants while the guard runs.
    // SIGKILL bypasses Drop, and setsid/setpgid can escape. Those paths require
    // platform containment and persisted verified ownership on a Unix runner;
    // this is not kill-on-close crash containment.
    use anyhow::{ensure, Result};
    use sysinfo::{ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
        fn getpgid(pid: i32) -> i32;
    }

    pub(crate) struct ProcessJob {
        group: i32,
        released: bool,
        leader_reaped: bool,
    }

    impl ProcessJob {
        // CommandExt::process_group(0) establishes this group before exec.
        pub(crate) fn new(pid: u32) -> Result<Self> {
            let group = i32::try_from(pid)?;
            ensure!(group > 1, "invalid recovery process group");
            super::verify_group_anchor(false, unsafe { getpgid(group) }, group)?;
            Ok(Self {
                group,
                released: false,
                leader_reaped: false,
            })
        }

        pub(crate) fn leader_reaped(&mut self) {
            self.leader_reaped = true;
        }

        pub(crate) fn release(&mut self) -> Result<()> {
            self.released = true;
            Ok(())
        }

        pub(crate) fn active_processes(&self) -> Result<u32> {
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            // A dead unreaped descendant cannot write. Waiting for kill(0) to
            // report an empty group would incorrectly block on those zombies.
            Ok(system
                .processes()
                .iter()
                .filter(|(pid, process)| {
                    process.status() != ProcessStatus::Zombie
                        && i32::try_from(pid.as_u32())
                            .is_ok_and(|pid| unsafe { getpgid(pid) } == self.group)
                })
                .count() as u32)
        }

        fn terminate(&self) -> Result<()> {
            // An unreaped Child pins its PID, including after it becomes a
            // zombie. Once reaped, a PGID can be reused: never signal that number.
            super::verify_group_anchor(
                self.leader_reaped,
                unsafe { getpgid(self.group) },
                self.group,
            )?;
            let result = unsafe { kill(-self.group, 9) };
            super::group_signal_result(result, std::io::Error::last_os_error())
        }

        pub(crate) fn terminate_and_wait(&self) -> Result<()> {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            self.terminate()?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while self.active_processes()? != 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            ensure!(
                self.active_processes()? == 0,
                "contained update writers did not stop; refusing restore"
            );
            Ok(())
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            if !self.released && !self.leader_reaped {
                let _ = self.terminate();
            }
        }
    }
}

#[cfg(unix)]
pub(crate) use unix_group::ProcessJob;

#[cfg(test)]
mod signal_tests {
    #[test]
    fn process_group_signal_requires_an_unreaped_original_leader() {
        assert!(super::verify_group_anchor(false, 100, 100).is_ok());
        assert!(super::verify_group_anchor(true, 100, 100).is_err());
        assert!(super::verify_group_anchor(false, -1, 100).is_err());
        assert!(super::verify_group_anchor(false, 200, 100).is_err());
    }

    #[test]
    fn group_signal_only_accepts_success_or_an_already_empty_group() {
        for code in [1, 13, 22] {
            assert!(
                super::group_signal_result(-1, std::io::Error::from_raw_os_error(code)).is_err()
            );
        }
        assert!(super::group_signal_result(-1, std::io::Error::from_raw_os_error(3)).is_ok());
        assert!(super::group_signal_result(0, std::io::Error::from_raw_os_error(1)).is_ok());
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::ProcessJob;
    use std::{
        os::unix::process::CommandExt,
        process::Command,
        time::{Duration, Instant},
    };

    #[test]
    fn live_group_termination_drains_an_inherited_writer_before_reap() {
        let home = tempfile::tempdir().unwrap();
        let writer = home.path().join("writer");
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "(while :; do printf x >> \"$1\"; sleep 0.05; done) & wait",
                "sh",
            ])
            .arg(&writer)
            .process_group(0)
            .spawn()
            .unwrap();
        let mut job = ProcessJob::new(child.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !writer.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(writer.exists());
        assert!(job.active_processes().unwrap() >= 2);
        job.terminate_and_wait().unwrap();
        assert_eq!(job.active_processes().unwrap(), 0);
        let length = std::fs::metadata(&writer).unwrap().len();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(std::fs::metadata(&writer).unwrap().len(), length);
        child.wait().unwrap();
        job.leader_reaped();
    }
}
