use super::custody_fs::{
    private_directory, private_namespace_home, reject_descendant_links, reject_links,
    valid_namespace,
};
use super::*;

impl NativeAccounts {
    /// `data_dir` is the directory that holds `native-accounts/` — Core passes
    /// its `<data dir>/secrets`.
    pub fn new(vault: AccountVault, data_dir: &Path, cli: &Path) -> Result<Self> {
        if !cli.is_absolute() || !data_dir.is_absolute() {
            bail!("Native account data and executable paths must be absolute");
        }
        let root = data_dir.join("native-accounts").join("kiro");
        reject_links(&data_dir.join("native-accounts"))?;
        reject_links(&root)?;
        std::fs::create_dir_all(&root).context("Creating native account root")?;
        let root = root
            .canonicalize()
            .context("Resolving native account root")?;
        private_directory(&root)?;
        Ok(Self {
            vault,
            root,
            cli: cli.to_owned(),
            mutation: Arc::new(Mutex::new(())),
            operations: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn list(&self) -> Result<Vec<NativeAccountInfo>> {
        self.vault
            .list(SCOPE)?
            .into_iter()
            .map(|info| {
                let (_, registration) = self.read(&info.account_id)?;
                Ok(NativeAccountInfo {
                    account_id: info.account_id,
                    label: info.label,
                    active: info.active,
                    verified: registration.state == ConnectionState::Connected,
                    state: registration.state,
                    kind: KIND.into(),
                })
            })
            .collect()
    }

    pub fn create(&self, label: &str) -> Result<NativeAccountInfo> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        let label = label.trim();
        if label.is_empty() || label.len() > 200 || label.chars().any(char::is_control) {
            bail!("Account label must contain 1 to 200 printable bytes");
        }
        let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
        let registration = Registration {
            version: 1,
            custody_namespace: uuid::Uuid::new_v4().simple().to_string(),
            identity_epoch: uuid::Uuid::new_v4().simple().to_string(),
            credential_revision: 0,
            state: ConnectionState::Pending,
            identity: None,
        };
        self.profile_env(&registration)?;
        self.vault.upsert_inactive(
            SCOPE,
            &account_id,
            label,
            KIND,
            serde_json::to_value(registration)?,
        )?;
        Ok(NativeAccountInfo {
            account_id,
            label: label.to_owned(),
            active: false,
            state: ConnectionState::Pending,
            verified: false,
            kind: KIND.into(),
        })
    }

    pub(super) fn read(&self, account_id: &str) -> Result<(Value, Registration)> {
        let value = self
            .vault
            .credential(SCOPE, account_id)?
            .ok_or_else(|| anyhow!("Native account is missing or has no custody registration"))?;
        let record: Registration = serde_json::from_value(value.clone())
            .context("Invalid native account custody registration")?;
        if record.version != 1
            || !valid_namespace(&record.custody_namespace)
            || !valid_namespace(&record.identity_epoch)
        {
            bail!("Invalid native account custody namespace");
        }
        Ok((value, record))
    }

    pub(super) fn profile_env(
        &self,
        registration: &Registration,
    ) -> Result<HashMap<String, String>> {
        if !valid_namespace(&registration.custody_namespace) {
            bail!("Invalid custody namespace");
        }
        let home = self.root.join(&registration.custody_namespace);
        // Refuse redirected existing directories before creating children. Never
        // resolve a registration-supplied arbitrary path or copy a global login.
        reject_links(&home)?;
        std::fs::create_dir_all(&home)?;
        let home = home.canonicalize()?;
        if home.parent() != Some(self.root.as_path()) {
            bail!("Custody home escapes account root");
        }
        // The vendor CLI keeps its sign-in tokens here in plaintext (it has no
        // environment or stdin credential input), so each home is owner-only on
        // its own, not just through the root. Windows homes inherit the root's
        // owner-only ACL (`(OI)(CI)` grant, inheritance removed above them).
        private_namespace_home(&home)?;
        let mut env = HashMap::new();
        for (name, relative) in [
            ("HOME", ""),
            ("USERPROFILE", ""),
            ("APPDATA", "AppData/Roaming"),
            ("LOCALAPPDATA", "AppData/Local"),
            ("KIRO_HOME", ".kiro"),
        ] {
            let directory = home.join(relative);
            reject_descendant_links(&home, &directory)?;
            std::fs::create_dir_all(&directory)?;
            env.insert(name.to_owned(), directory.to_string_lossy().into_owned());
        }
        let aws = home.join(".aws");
        reject_links(&aws)?;
        std::fs::create_dir_all(&aws)?;
        env.insert(
            "AWS_SHARED_CREDENTIALS_FILE".into(),
            aws.join("credentials").to_string_lossy().into_owned(),
        );
        env.insert(
            "AWS_CONFIG_FILE".into(),
            aws.join("config").to_string_lossy().into_owned(),
        );
        env.insert("AWS_EC2_METADATA_DISABLED".into(), "true".into());
        Ok(env)
    }

    pub fn capture(&self, account_id: &str) -> Result<NativeLaunch> {
        let (_, registration) = self.read(account_id)?;
        if registration.state != ConnectionState::Connected || registration.identity.is_none() {
            bail!("Native account is not verified; finish signing in before launching");
        }
        let env = self.profile_env(&registration)?;
        Ok(NativeLaunch {
            affinity: NativeAffinity {
                account_id: account_id.to_owned(),
                custody_namespace: registration.custody_namespace,
                identity_epoch: registration.identity_epoch,
                credential_revision: registration.credential_revision,
            },
            env,
        })
    }

    pub fn capture_active(&self) -> Result<NativeLaunch> {
        let info = self
            .vault
            .active_info(SCOPE)?
            .ok_or_else(|| anyhow!("No native account selected"))?;
        self.capture(&info.account_id)
    }

    /// Discovery captures one selected account before reading its environment.
    /// A removed or invalid selection is an error, never signed-out fallback.
    pub fn capture_for_discovery(&self) -> Result<Option<NativeLaunch>> {
        self.vault
            .active_info(SCOPE)?
            .map(|info| self.capture(&info.account_id))
            .transpose()
    }

    /// Persist affinity before spawning. Existing conversations never fall back
    /// to the active picker when their account was removed or disconnected.
    pub fn capture_conversation(
        &self,
        conversation: Option<&str>,
        agent_id: &str,
    ) -> Result<NativeLaunch> {
        use sha2::{Digest, Sha256};
        let Some(conversation) = conversation.filter(|value| !value.is_empty()) else {
            return self.capture_active();
        };
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&(
            conversation,
            agent_id,
        ))?));
        let scope = "native:kiro:conversation-affinity";
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        if let Some(value) = self.vault.credential(scope, &key)? {
            let affinity: NativeAffinity = serde_json::from_value(value)?;
            let launch = self.capture(&affinity.account_id)?;
            if !affinity.resume_matches(&launch.affinity) {
                bail!(
                    "This conversation's native account identity changed; start a new conversation"
                );
            }
            return Ok(launch);
        }
        let launch = self.capture_active()?;
        self.vault.upsert(
            scope,
            &key,
            "Native conversation binding",
            KIND,
            Some(serde_json::to_value(&launch.affinity)?),
        )?;
        Ok(launch)
    }

    /// Signed-out discovery gets a private empty profile without creating a
    /// saved account. It cannot read the user's global CLI authorization.
    pub fn discovery_env(&self) -> Result<HashMap<String, String>> {
        if let Some(info) = self.vault.active_info(SCOPE)? {
            let (_, record) = self.read(&info.account_id)?;
            return self.profile_env(&record);
        }
        self.signed_out_discovery_env()
    }

    /// Does not re-read the picker after discovery established no selection.
    pub fn signed_out_discovery_env(&self) -> Result<HashMap<String, String>> {
        self.profile_env(&Registration {
            version: 1,
            custody_namespace: "00000000000000000000000000000000".into(),
            identity_epoch: "00000000000000000000000000000000".into(),
            credential_revision: 0,
            state: ConnectionState::Pending,
            identity: None,
        })
    }

    pub fn select(&self, account_id: &str) -> Result<()> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| anyhow!("Account lifecycle lock unavailable"))?;
        self.capture(account_id)?;
        if !self.vault.set_active(SCOPE, account_id)? {
            bail!("Native account was removed");
        }
        Ok(())
    }
}
