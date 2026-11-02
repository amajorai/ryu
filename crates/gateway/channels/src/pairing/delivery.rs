//! Inbound delivery claims (exactly-once provider retries) and the reply-message
//! links Learning feedback resolves.

use super::*;

impl PairingStore {
    /// Claim a provider delivery before spawning any model or outbound work.
    ///
    /// Provider callbacks are at-least-once. A completed claim is retained for
    /// [`DELIVERY_RETENTION`], an in-flight claim suppresses concurrent retries
    /// for [`DELIVERY_LEASE`], and a stale/failed claim can be reclaimed. The
    /// claim is durably written before the webhook should return `200`.
    pub async fn claim_delivery(
        &self,
        platform: &str,
        delivery_id: &str,
    ) -> anyhow::Result<DeliveryClaim> {
        let key = delivery_key(platform, delivery_id)?;
        let now = unix_now();
        let cutoff = now.saturating_sub(DELIVERY_RETENTION.as_secs());
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;

        file.deliveries.retain(|_, record| {
            let live_processing = matches!(record.state, DeliveryState::Processing)
                && now.saturating_sub(record.updated_at) < DELIVERY_LEASE.as_secs();
            record.updated_at >= cutoff
                && (live_processing || !matches!(record.state, DeliveryState::Processing))
        });

        if let Some(record) = file.deliveries.get(&key) {
            match record.state {
                DeliveryState::Completed => return Ok(DeliveryClaim::Completed),
                DeliveryState::Processing
                    if now.saturating_sub(record.updated_at) < DELIVERY_LEASE.as_secs() =>
                {
                    return Ok(DeliveryClaim::InFlight);
                }
                DeliveryState::Processing | DeliveryState::Failed => {}
            }
        }

        let previous = file.deliveries.get(&key).cloned();
        let mut evicted = None;
        if previous.is_none() && file.deliveries.len() >= MAX_DELIVERY_RECORDS {
            let oldest = file
                .deliveries
                .iter()
                .filter(|(_, record)| {
                    !matches!(record.state, DeliveryState::Processing)
                        || now.saturating_sub(record.updated_at) >= DELIVERY_LEASE.as_secs()
                })
                .min_by_key(|(_, record)| record.updated_at)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                anyhow::bail!("channel delivery ledger is full of in-flight messages");
            };
            evicted = file
                .deliveries
                .remove(&oldest)
                .map(|record| (oldest, record));
        }

        file.version = 1;
        let attempts = previous
            .as_ref()
            .map_or(1, |record| record.attempts.saturating_add(1));
        file.deliveries.insert(
            key.clone(),
            DeliveryRecord {
                state: DeliveryState::Processing,
                updated_at: now,
                attempts,
            },
        );

        if let Some(path) = &self.path {
            if let Err(error) = self.persist_snapshot(path, &file).await {
                if let Some(previous) = previous {
                    file.deliveries.insert(key, previous);
                } else {
                    file.deliveries.remove(&key);
                }
                if let Some((evicted_key, evicted_record)) = evicted {
                    file.deliveries.insert(evicted_key, evicted_record);
                }
                return Err(error);
            }
        }
        Ok(DeliveryClaim::Claimed)
    }

    /// Extend an in-flight claim while the local retry budget is being used.
    pub async fn touch_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            if !matches!(record.state, DeliveryState::Processing) {
                return Ok(());
            }
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Mark a claimed delivery complete after the shared turn has either sent
    /// its reply or intentionally refused/dropped the message.
    pub async fn complete_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            record.state = DeliveryState::Completed;
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Record a terminal local failure. The key remains reclaimable on a later
    /// provider redelivery, while the failure itself is kept out of the durable
    /// store so provider URLs, user text, and other transport diagnostics cannot
    /// accidentally become long-lived pairing-state content.
    pub async fn fail_delivery(&self, platform: &str, delivery_id: &str) -> anyhow::Result<()> {
        let key = delivery_key(platform, delivery_id)?;
        let _persist_guard = self.persist_lock.lock().await;
        let mut file = self.inner.write().await;
        {
            let Some(record) = file.deliveries.get_mut(&key) else {
                return Ok(());
            };
            record.state = DeliveryState::Failed;
            record.updated_at = unix_now();
        }
        if let Some(path) = &self.path {
            self.persist_snapshot(path, &file).await
        } else {
            Ok(())
        }
    }

    /// Persist provider-message → Core-message links next to pairing state so a
    /// delayed reaction still targets the exact assistant row after restart.
    /// The table is TTL-pruned and hard-bounded on every write.
    pub async fn bind_reply_messages(
        &self,
        platform: &str,
        conversation_id: &str,
        provider_message_ids: &[String],
        core_message_ids: &[String],
    ) {
        let now = unix_now();
        let cutoff = now.saturating_sub(REPLY_LINK_TTL.as_secs());
        {
            let mut file = self.inner.write().await;
            file.reply_links.retain(|_, link| link.updated_at >= cutoff);
            for provider_message_id in provider_message_ids {
                if provider_message_id.trim().is_empty() {
                    continue;
                }
                file.reply_links.insert(
                    reply_link_key(platform, conversation_id, provider_message_id),
                    ReplyLink {
                        core_message_ids: core_message_ids.to_vec(),
                        updated_at: now,
                    },
                );
            }
            while file.reply_links.len() > MAX_REPLY_LINKS {
                let Some(oldest) = file
                    .reply_links
                    .iter()
                    .min_by_key(|(_, link)| link.updated_at)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                file.reply_links.remove(&oldest);
            }
        }
        self.persist().await;
    }

    pub async fn reply_message(
        &self,
        platform: &str,
        conversation_id: &str,
        provider_message_id: &str,
    ) -> Option<Vec<String>> {
        let cutoff = unix_now().saturating_sub(REPLY_LINK_TTL.as_secs());
        self.inner
            .read()
            .await
            .reply_links
            .get(&reply_link_key(
                platform,
                conversation_id,
                provider_message_id,
            ))
            .filter(|link| link.updated_at >= cutoff)
            .map(|link| link.core_message_ids.clone())
    }
}

pub(super) fn reply_link_key(
    platform: &str,
    conversation_id: &str,
    provider_message_id: &str,
) -> String {
    format!("{platform}\0{conversation_id}\0{provider_message_id}")
}

/// Scope one provider id to its channel type. The delimiter is not exposed to
/// providers; it only prevents a Telegram update id from colliding with a
/// WhatsApp message id in the shared node store.
pub(super) fn delivery_key(platform: &str, delivery_id: &str) -> anyhow::Result<String> {
    let platform = platform.trim();
    let delivery_id = delivery_id.trim();
    if platform.is_empty() || delivery_id.is_empty() {
        anyhow::bail!("channel delivery identity is empty");
    }
    if platform.len() > 80 || delivery_id.len() > 512 {
        anyhow::bail!("channel delivery identity is too long");
    }
    Ok(format!("{platform}\0{delivery_id}"))
}
