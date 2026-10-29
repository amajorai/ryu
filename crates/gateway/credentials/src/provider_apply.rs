//! Secret-free receipt contract for authored provider runtime application.

use crate::ConfigRevision;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRuntimeEpoch {
    pub boot: uuid::Uuid,
    pub sequence: u64,
}

impl ProviderRuntimeEpoch {
    pub fn circuit_key(&self, provider: &str) -> String {
        format!("{}:{}:{provider}", self.boot, self.sequence)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderApplyErrorCode {
    ConfigUnavailable,
    InvalidConfig,
    SourcesChanged,
    PublicationFailed,
    Transport,
    UnexpectedResponse,
    ApplyNotEnabled,
}

/// Persistence is reported by the editing caller, independently of this receipt.
/// The revision identifies provider connections/policies and bound ModelRouter,
/// pools and egress inputs. It does not acknowledge unrelated configuration,
/// authentication, budgets or the separately owned smart-routing classifier.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderApplyOutcome {
    Applied {
        requested_revision: ConfigRevision,
        applied_revision: ConfigRevision,
        epoch: ProviderRuntimeEpoch,
    },
    AlreadyApplied {
        requested_revision: ConfigRevision,
        applied_revision: ConfigRevision,
        epoch: ProviderRuntimeEpoch,
    },
    Superseded {
        requested_revision: ConfigRevision,
        current_revision: ConfigRevision,
    },
    Failed {
        requested_revision: ConfigRevision,
        active_revision: Option<ConfigRevision>,
        code: ProviderApplyErrorCode,
    },
    Offline {
        requested_revision: ConfigRevision,
    },
    Unmanaged {
        requested_revision: ConfigRevision,
    },
}

impl ProviderApplyOutcome {
    pub fn requested_revision(&self) -> &ConfigRevision {
        match self {
            Self::Applied {
                requested_revision, ..
            }
            | Self::AlreadyApplied {
                requested_revision, ..
            }
            | Self::Superseded {
                requested_revision, ..
            }
            | Self::Failed {
                requested_revision, ..
            }
            | Self::Offline { requested_revision }
            | Self::Unmanaged { requested_revision } => requested_revision,
        }
    }

    pub fn validates_request(&self, expected: &ConfigRevision) -> bool {
        self.requested_revision() == expected
            && match self {
                Self::Applied {
                    applied_revision, ..
                }
                | Self::AlreadyApplied {
                    applied_revision, ..
                } => applied_revision == expected,
                _ => true,
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_round_trip_is_secret_free_and_binds_applied_revision() {
        let revision = ConfigRevision::parse(&"a".repeat(64)).unwrap();
        let outcome = ProviderApplyOutcome::Applied {
            requested_revision: revision.clone(),
            applied_revision: revision.clone(),
            epoch: ProviderRuntimeEpoch {
                boot: uuid::Uuid::new_v4(),
                sequence: 1,
            },
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["status"], "applied");
        assert_eq!(value["requestedRevision"], revision.as_str());
        let parsed: ProviderApplyOutcome = serde_json::from_value(value).unwrap();
        assert!(parsed.validates_request(&revision));
        assert!(!parsed.validates_request(&ConfigRevision::parse(&"b".repeat(64)).unwrap()));
    }

    #[test]
    fn receipt_rejects_extra_material_or_mismatched_applied_revision() {
        let request = "a".repeat(64);
        assert!(
            serde_json::from_value::<ProviderApplyOutcome>(serde_json::json!({
                "status":"offline","requestedRevision":request,"apiKey":"must-not-be-received"
            }))
            .is_err()
        );
        let mismatch: ProviderApplyOutcome = serde_json::from_value(serde_json::json!({
            "status":"applied","requestedRevision":"a".repeat(64),"appliedRevision":"b".repeat(64),
            "epoch":{"boot":uuid::Uuid::new_v4(),"sequence":1}
        }))
        .unwrap();
        assert!(!mismatch.validates_request(&ConfigRevision::parse(&"a".repeat(64)).unwrap()));
    }
}
