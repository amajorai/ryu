//! A retained loopback listener that forwards only to a live, owned child.
//!
//! Clients may cache this address. Keep the listener reserved across child stops
//! and refuse new connections while the child is unavailable, rather than hand
//! a vacated address to a different local process.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use super::ProcessHandle;

pub struct OwnedLoopbackRelay {
    address: SocketAddr,
}

impl OwnedLoopbackRelay {
    pub async fn bind(
        process: ProcessHandle,
        backend_port: u16,
        ready: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let backend = SocketAddr::from((Ipv4Addr::LOCALHOST, backend_port));
        let slots = Arc::new(Semaphore::new(32));
        // Detach the listener task deliberately. Even if a manager is replaced,
        // its previously advertised address remains reserved until Core's Tokio
        // runtime exits; dropping a JoinHandle does not abort its task.
        tokio::spawn(async move {
            loop {
                let Ok((mut incoming, _)) = listener.accept().await else {
                    break;
                };
                let Ok(slot) = Arc::clone(&slots).try_acquire_owned() else {
                    continue;
                };
                let process = process.clone();
                let ready = Arc::clone(&ready);
                tokio::spawn(async move {
                    let _slot = slot;
                    forward_connection(&mut incoming, backend, move |local, peer| async move {
                        ready.load(Ordering::Acquire)
                            && process.owns_loopback_connection(local, peer).await
                    })
                    .await;
                });
            }
        });
        Ok(Self { address })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

async fn forward_connection<F: std::future::Future<Output = bool>>(
    incoming: &mut TcpStream,
    backend: SocketAddr,
    authorized: impl FnOnce(SocketAddr, SocketAddr) -> F,
) {
    // Connect before checking identity. No caller bytes have been sent, and
    // this established TCP peer cannot be replaced by a later port squatter.
    let Ok(Ok(mut outgoing)) = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        TcpStream::connect(backend),
    )
    .await
    else {
        return;
    };
    let (Ok(local), Ok(peer)) = (outgoing.local_addr(), outgoing.peer_addr()) else {
        return;
    };
    if !authorized(local, peer).await {
        return;
    }
    let _ = tokio::io::copy_bidirectional(incoming, &mut outgoing).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(authorized: bool) -> Vec<u8> {
        fixture_with_authorization(move |_, _| async move { authorized }).await
    }

    async fn fixture_with_authorization<F: std::future::Future<Output = bool> + Send>(
        authorized: impl FnOnce(SocketAddr, SocketAddr) -> F + Send + 'static,
    ) -> Vec<u8> {
        let backend = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = backend.local_addr().unwrap();
        let frontend = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let frontend_address = frontend.local_addr().unwrap();
        let worker = tokio::spawn(async move {
            let (mut incoming, _) = frontend.accept().await.unwrap();
            forward_connection(&mut incoming, address, authorized).await;
        });
        let captured = tokio::spawn(async move {
            let (mut socket, _) = backend.accept().await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let mut client = TcpStream::connect(frontend_address).await.unwrap();
        let _ = client.write_all(b"synthetic-inference-fixture").await;
        let _ = client.shutdown().await;
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(3), captured)
            .await
            .unwrap()
            .unwrap();
        worker.await.unwrap();
        bytes
    }

    #[tokio::test]
    async fn rejects_a_successful_but_unowned_listener_before_client_bytes() {
        assert!(fixture(false).await.is_empty());
    }

    #[tokio::test]
    async fn preserves_owned_child_transport() {
        assert_eq!(fixture(true).await, b"synthetic-inference-fixture");
    }

    #[tokio::test]
    async fn a_new_owned_listener_does_not_authorize_a_previously_accepted_fake_peer() {
        let bytes = fixture_with_authorization(|local, peer| async move {
            // The backend already accepted this TCP connection. The child may
            // subsequently own LISTEN, but has no ESTABLISHED socket matching it.
            let changed_owner = format!("p123\nf9\nn{peer}\n");
            super::super::process::established_socket_matches(
                changed_owner.as_bytes(),
                123,
                &format!("{peer}->{local}"),
            )
        })
        .await;
        assert!(bytes.is_empty());
    }

    #[tokio::test]
    async fn retained_endpoint_refuses_a_listener_after_child_exit() {
        let process = ProcessHandle::new();
        let backend = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = backend.local_addr().unwrap().port();
        let relay = OwnedLoopbackRelay::bind(process, port, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        let address = relay.address();
        drop(relay);
        assert!(
            TcpListener::bind(address).await.is_err(),
            "Core retains the advertised socket even after its manager is dropped"
        );
        let captured = tokio::spawn(async move {
            let (mut socket, _) = backend.accept().await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let mut cached_client = TcpStream::connect(address).await.unwrap();
        let _ = cached_client.write_all(b"synthetic-cached-request").await;
        let _ = cached_client.shutdown().await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), captured)
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
    }
}
