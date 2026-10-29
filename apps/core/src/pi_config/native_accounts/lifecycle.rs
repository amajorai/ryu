use super::custody_fs::{reject_links, valid_namespace};
use super::*;

impl NativeAccounts {
    /// Login stays alive until the CLI finishes device authorization. No shell is
    /// involved. A successful exit still requires an independent identity probe.
    pub async fn login(&self, account_id: &str) -> Result<()> {
        let (attempt, mut command) = self.begin_login(account_id)?;
        // Headless convenience. Interactive routes use begin_login and forward
        // instructions themselves. Discard output here instead of buffering it.
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status = tokio::time::timeout(Duration::from_secs(600), command.status())
            .await
            .context("Native login timed out")?
            .context("Starting native login")?;
        if !status.success() {
            bail!("Native login failed; retry signing in");
        }
        self.finish_login(attempt).await
    }

    /// The caller must drain stdout/stderr, deliver device-flow instructions to
    /// its authenticated UI, and retain/kill this child on cancellation. Do not
    /// log authorization instructions or mark an ACP acknowledgment connected.
    pub fn begin_login(&self, account_id: &str) -> Result<(NativeLoginAttempt, Command)> {
        let operation = self.operation(account_id)?;
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        let (expected, mut registration) = self.read(account_id)?;
        if registration.state == ConnectionState::Connected {
            bail!("Disconnect this native account before signing in again");
        }
        let env = self.profile_env(&registration)?;
        // New attempt identity makes competing and cancelled completions stale.
        registration.identity_epoch = uuid::Uuid::new_v4().simple().to_string();
        registration.state = ConnectionState::Pending;
        let expected_new = serde_json::to_value(&registration)?;
        if !self
            .vault
            .replace_credential(SCOPE, account_id, &expected, expected_new.clone())?
        {
            bail!("Native account changed before login");
        }
        let command = self.command(&env, &["login", "--use-device-flow"]);
        Ok((
            NativeLoginAttempt {
                account_id: account_id.to_owned(),
                expected: expected_new,
                registration,
                env,
                _operation: operation,
            },
            command,
        ))
    }

    pub async fn finish_login(&self, attempt: NativeLoginAttempt) -> Result<()> {
        let NativeLoginAttempt {
            account_id,
            expected,
            mut registration,
            env,
            _operation,
        } = attempt;
        let (current, _) = self.read(&account_id)?;
        if current != expected {
            bail!("Native account changed during login");
        }
        let identity_output = self
            .run(
                &env,
                &["whoami", "--format", "json"],
                Duration::from_secs(30),
            )
            .await?;
        let identity = parse_identity(&identity_output)?;
        // An unexpected identity change also invalidates this attempt's epoch.
        if registration
            .identity
            .as_ref()
            .is_some_and(|old| old != &identity)
        {
            registration.identity_epoch = uuid::Uuid::new_v4().simple().to_string();
        }
        registration.identity = Some(identity);
        registration.state = ConnectionState::Connected;
        registration.credential_revision = registration
            .credential_revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("Native credential revision exhausted"))?;
        if !self.vault.replace_credential(
            SCOPE,
            &account_id,
            &expected,
            serde_json::to_value(registration)?,
        )? {
            bail!("Native account changed during login; authorization was not attached");
        }
        if self.vault.active_info(SCOPE)?.is_none() {
            self.select(&account_id)?;
        }
        Ok(())
    }

    pub fn disconnect(&self, account_id: &str) -> Result<()> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        let (expected, mut registration) = self.read(account_id)?;
        registration.state = ConnectionState::Disconnected;
        // Every disconnect invalidates existing process and resume captures.
        registration.identity_epoch = uuid::Uuid::new_v4().simple().to_string();
        if !self.vault.replace_credential(
            SCOPE,
            account_id,
            &expected,
            serde_json::to_value(registration)?,
        )? {
            bail!("Native account changed during disconnect");
        }
        Ok(())
    }

    /// Removal revokes Core dispatch first, then wipes the account's isolated
    /// vendor home. The vendor CLI stores its tokens there in plaintext, and a
    /// removed registration can never be reassigned, so nothing could use them
    /// again; leaving them would only keep live credentials on disk. A vendor
    /// session revoked server-side still needs an explicit logout first.
    pub fn remove(&self, account_id: &str) -> Result<bool> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        let namespace = self
            .read(account_id)
            .ok()
            .map(|(_, registration)| registration.custody_namespace);
        let removed = self.vault.remove(SCOPE, account_id)?;
        if removed {
            if let Some(namespace) = namespace {
                self.wipe_home(&namespace);
            }
        }
        Ok(removed)
    }

    /// Delete one custody home. Best effort: a failure is logged, and the
    /// directory stays owner-only.
    fn wipe_home(&self, namespace: &str) {
        if !valid_namespace(namespace) {
            return;
        }
        let home = self.root.join(namespace);
        if reject_links(&home).is_err() {
            tracing::warn!("native account home is a link; leaving it in place");
            return;
        }
        match std::fs::remove_dir_all(&home) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(%error, "could not wipe a removed native account home"),
        }
    }

    pub async fn logout(&self, account_id: &str) -> Result<()> {
        let _operation = self.operation(account_id)?;
        self.disconnect(account_id)?;
        let (_, registration) = self.read(account_id)?;
        self.run(
            &self.profile_env(&registration)?,
            &["logout"],
            Duration::from_secs(30),
        )
        .await?;
        Ok(())
    }

    /// Revalidate the exact captured identity before dispatch, without switching
    /// to whichever account happens to be active now.
    pub async fn verify_capture(&self, captured: &NativeLaunch) -> Result<()> {
        let current = self.capture(&captured.affinity.account_id)?;
        if current.affinity != captured.affinity {
            bail!("Native account changed before dispatch");
        }
        let output = self
            .run(
                &current.env,
                &["whoami", "--format", "json"],
                Duration::from_secs(30),
            )
            .await?;
        let identity = parse_identity(&output)?;
        let (_, registration) = self.read(&captured.affinity.account_id)?;
        if registration.identity.as_ref() != Some(&identity) {
            bail!("Native CLI identity changed; reconnect account");
        }
        if self.capture(&captured.affinity.account_id)?.affinity != captured.affinity {
            bail!("Native account changed during identity verification");
        }
        Ok(())
    }

    async fn run(
        &self,
        env: &HashMap<String, String>,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        let mut command = self.command(env, args);
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = command.spawn().context("Starting native CLI operation")?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Native CLI stdout unavailable"))?;
        let work = async {
            let mut output = Vec::new();
            stdout.take(65537).read_to_end(&mut output).await?;
            if output.len() > 65536 {
                bail!("Native CLI identity output exceeds limit");
            }
            let status = child.wait().await?;
            if !status.success() {
                bail!("Native CLI operation failed; reconnect the selected account");
            }
            Ok(output)
        };
        tokio::time::timeout(timeout, work)
            .await
            .context("Native CLI operation timed out")?
    }

    fn command(&self, env: &HashMap<String, String>, args: &[&str]) -> Command {
        let mut command = Command::new(&self.cli);
        // Vendor auth must not inherit AWS bearer or bridge credentials. Only OS
        // process essentials are inherited; profile env is always authoritative.
        command.env_clear();
        for key in [
            "SystemRoot",
            "WINDIR",
            "PATH",
            "PATHEXT",
            "COMSPEC",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(env).args(args).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command.stdin(std::process::Stdio::null());
        command
    }

    fn operation(&self, account_id: &str) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        let lock = self
            .operations
            .lock()
            .map_err(|_| anyhow!("Account operations lock unavailable"))?
            .entry(account_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        lock.try_lock_owned()
            .map_err(|_| anyhow!("An authorization operation is already running for this account"))
    }
}
