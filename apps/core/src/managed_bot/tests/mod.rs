//! Tests of managed-bot pairing.

use super::*;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn session(nonce: &str, expires_at: &str) -> PairSession {
    PairSession {
        nonce: nonce.to_string(),
        claim_secret: Secret::new("s3cr3t-claim-secret-0123456789ab"),
        deep_link: "https://t.me/ryu_bot?start=mb_x".to_string(),
        expires_at: expires_at.to_string(),
    }
}

// Declared ahead of the others so a branch that appends a module merges cleanly.
mod pair_account;

mod bodies;
mod landing;
mod pairing_state;
