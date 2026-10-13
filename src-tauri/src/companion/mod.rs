//! Site companion: a loopback HTTP adapter the Tarkov Hideout site polls for scanner events.
//! Independent of Tauri; `lib.rs` feeds it scanner snapshots and forwards its status to the UI.
//! See `docs/site-companion-plan.md` for the contract and pairing flow.
pub mod api;
mod journal;
pub mod model;
mod server;

use api::{Method, Request, Response, PROTOCOL};
use chrono::{DateTime, Utc};
use model::{
    CompanionStatus, ConnectionState, PairRequested, PairedClient, PairingState, PendingPairing,
    SourceState, StatusResponse, SyncResponse,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub const PORTS: std::ops::RangeInclusive<u16> = 47615..=47619;
/// About 5× the site's 30 s idle poll: hidden tabs can be throttled to one timer per minute.
pub const STALE_AFTER: Duration = Duration::from_secs(150);
const PAIRING_TTL: Duration = Duration::from_secs(120);
/// How long a decided pairing stays readable by the site.
const DECIDED_TTL: Duration = Duration::from_secs(60);
/// After a Deny, the same origin can't prompt again for this long.
const DENY_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_PENDING: usize = 3;
const PERSIST_EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredClient {
    id: String,
    origin: String,
    /// SHA-256 of the token, hex. The token itself is never stored.
    token_hash: String,
    paired_at: String,
    last_seen: Option<String>,
}

struct Client {
    stored: StoredClient,
    /// Last authenticated request in this run.
    polled: Option<Instant>,
}

enum Decision {
    Pending,
    Allowed { token: String, client: String },
    Denied,
}

struct Pairing {
    id: String,
    origin: String,
    requested: Instant,
    requested_at: DateTime<Utc>,
    decision: Decision,
    decided: Option<Instant>,
}

#[derive(Default)]
struct Health {
    scanner_running: bool,
    logs: Option<SourceState>,
    screenshots: Option<SourceState>,
}

struct Inner {
    running: Option<server::Running>,
    error: Option<String>,
    clients: Vec<Client>,
    pairings: Vec<Pairing>,
    denied: Vec<(String, Instant)>,
    journal: journal::Journal,
    health: Health,
    persisted: Instant,
    last_status: Option<CompanionStatus>,
}

type Notify = Box<dyn Fn(&CompanionStatus) + Send + Sync>;

pub struct Companion {
    inner: Mutex<Inner>,
    store: PathBuf,
    epoch: String,
    version: String,
    notify: Notify,
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("OS random source");
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn source_state(status: &crate::scanner::SourceStatus) -> SourceState {
    use crate::scanner::SourceStatus::*;
    match status {
        NotConfigured => SourceState::NotConfigured,
        Available => SourceState::Available,
        _ => SourceState::Unavailable,
    }
}

impl Companion {
    /// `store` is the paired-clients file; `notify` receives every status change.
    pub fn new(store: PathBuf, version: String, notify: Notify) -> Arc<Self> {
        let clients = std::fs::read(&store)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<StoredClient>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|stored| Client {
                stored,
                polled: None,
            })
            .collect();
        Arc::new(Self {
            inner: Mutex::new(Inner {
                running: None,
                error: None,
                clients,
                pairings: Vec::new(),
                denied: Vec::new(),
                journal: journal::Journal::default(),
                health: Health::default(),
                persisted: Instant::now(),
                last_status: None,
            }),
            store,
            epoch: random_hex(8),
            version,
            notify,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic mid-request must not take the companion down with it.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, inner: &mut Inner) {
        inner.persisted = Instant::now();
        let stored: Vec<_> = inner
            .clients
            .iter()
            .map(|client| client.stored.clone())
            .collect();
        let result = self
            .store
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|_| {
                let temporary = self.store.with_extension("tmp");
                std::fs::write(
                    &temporary,
                    serde_json::to_vec_pretty(&stored).unwrap_or_default(),
                )?;
                std::fs::rename(&temporary, &self.store)
            });
        if let Err(error) = result {
            eprintln!("Unable to save companion clients: {error}");
        }
    }

    fn status_of(inner: &Inner) -> CompanionStatus {
        let now = Instant::now();
        let last_poll = inner
            .clients
            .iter()
            .filter_map(|client| client.polled)
            .max();
        let connection = match (&inner.running, &inner.error) {
            (_, Some(reason)) => ConnectionState::Error {
                reason: reason.clone(),
            },
            (None, None) => ConnectionState::Off,
            (Some(_), None) => match last_poll {
                None => ConnectionState::Waiting,
                Some(at) if now - at <= STALE_AFTER => ConnectionState::Connected,
                Some(_) => ConnectionState::Stale,
            },
        };
        let wall = |at: Instant| {
            (Utc::now() - chrono::Duration::from_std(now - at).unwrap_or_default()).to_rfc3339()
        };
        CompanionStatus {
            connection,
            port: inner.running.as_ref().map(|running| running.port),
            last_poll: last_poll.map(wall),
            stale_after_secs: STALE_AFTER.as_secs() as u32,
            clients: inner
                .clients
                .iter()
                .map(|client| PairedClient {
                    id: client.stored.id.clone(),
                    origin: client.stored.origin.clone(),
                    paired_at: client.stored.paired_at.clone(),
                    last_seen: client.stored.last_seen.clone(),
                })
                .collect(),
            pending: inner
                .pairings
                .iter()
                .filter(|pairing| matches!(pairing.decision, Decision::Pending))
                .map(|pairing| PendingPairing {
                    id: pairing.id.clone(),
                    origin: pairing.origin.clone(),
                    requested_at: pairing.requested_at.to_rfc3339(),
                    expires_at: (pairing.requested_at
                        + chrono::Duration::from_std(PAIRING_TTL).unwrap())
                    .to_rfc3339(),
                })
                .collect(),
        }
    }

    pub fn status(&self) -> CompanionStatus {
        Self::status_of(&self.lock())
    }

    /// Expires pairings and announces any status change. Call after every mutation and once a second.
    fn publish(&self, mut inner: std::sync::MutexGuard<'_, Inner>) {
        let now = Instant::now();
        let mut orphaned = Vec::new();
        inner.pairings.retain(|pairing| match &pairing.decision {
            Decision::Pending => now - pairing.requested < PAIRING_TTL,
            decided => {
                let keep = pairing.decided.is_some_and(|at| now - at < DECIDED_TTL);
                // Allowed but never collected: the site gave up, so the client is useless.
                if let (false, Decision::Allowed { client, .. }) = (keep, decided) {
                    orphaned.push(client.clone());
                }
                keep
            }
        });
        inner.denied.retain(|(_, at)| now - *at < DENY_COOLDOWN);
        if !orphaned.is_empty() {
            inner
                .clients
                .retain(|client| !orphaned.contains(&client.stored.id));
            self.persist(&mut inner);
        }
        let status = Self::status_of(&inner);
        if inner.last_status.as_ref() != Some(&status) {
            inner.last_status = Some(status.clone());
            drop(inner);
            (self.notify)(&status);
        }
    }

    pub fn tick(&self) {
        let inner = self.lock();
        self.publish(inner);
    }

    /// Binds the first free port in `PORTS`. Idempotent; a previous error is retried.
    pub fn start(self: &Arc<Self>) -> CompanionStatus {
        let mut inner = self.lock();
        if inner.running.is_none() {
            inner.error = None;
            match server::Running::bind(self.clone()) {
                Ok(running) => inner.running = Some(running),
                Err(reason) => inner.error = Some(reason),
            }
        }
        self.publish(inner);
        self.status()
    }

    pub fn stop(&self) -> CompanionStatus {
        let mut inner = self.lock();
        let running = inner.running.take();
        inner.error = None;
        inner.pairings.clear();
        for client in &mut inner.clients {
            client.polled = None;
        }
        self.persist(&mut inner);
        self.publish(inner);
        // Joined outside the lock: the server thread may be waiting for it.
        if let Some(running) = running {
            running.shutdown();
        }
        self.status()
    }

    /// The server thread stopped on its own.
    fn failed(&self, reason: String) {
        let mut inner = self.lock();
        inner.running = None;
        inner.error = Some(reason);
        self.publish(inner);
    }

    pub fn respond(&self, pairing_id: &str, allow: bool) -> Result<CompanionStatus, String> {
        let mut inner = self.lock();
        let index = inner
            .pairings
            .iter()
            .position(|pairing| {
                pairing.id == pairing_id && matches!(pairing.decision, Decision::Pending)
            })
            .ok_or("That request has expired.")?;
        let origin = inner.pairings[index].origin.clone();
        inner.pairings[index].decided = Some(Instant::now());
        if allow {
            let token = random_hex(32);
            let id = random_hex(8);
            inner.clients.push(Client {
                stored: StoredClient {
                    id: id.clone(),
                    origin,
                    token_hash: hash_token(&token),
                    paired_at: Utc::now().to_rfc3339(),
                    last_seen: None,
                },
                polled: None,
            });
            inner.pairings[index].decision = Decision::Allowed { token, client: id };
            self.persist(&mut inner);
        } else {
            inner.pairings[index].decision = Decision::Denied;
            inner.denied.push((origin, Instant::now()));
        }
        self.publish(inner);
        Ok(self.status())
    }

    pub fn revoke(&self, client_id: &str) -> CompanionStatus {
        let mut inner = self.lock();
        inner.clients.retain(|client| client.stored.id != client_id);
        self.persist(&mut inner);
        self.publish(inner);
        self.status()
    }

    /// Feeds the journal; cheap enough to call on every scanner update.
    pub fn observe(&self, snapshot: &crate::scanner::ScannerSnapshot, resolve: journal::Resolve) {
        let mut inner = self.lock();
        inner.journal.observe(snapshot, resolve);
        inner.health = Health {
            scanner_running: snapshot.monitoring == crate::scanner::MonitoringStatus::Running,
            logs: Some(source_state(&snapshot.logs.status)),
            screenshots: Some(source_state(&snapshot.screenshots.status)),
        };
    }

    pub fn handle(&self, request: &Request) -> Response {
        let mut inner = self.lock();
        let port = inner
            .running
            .as_ref()
            .map(|running| running.port)
            .unwrap_or_default();
        let mut response = self.route(&mut inner, request, port);
        if let Some(origin) = request
            .origin
            .as_deref()
            .filter(|origin| api::origin_allowed(origin))
        {
            response.cors_origin = Some(origin.into());
        }
        self.publish(inner);
        response
    }

    fn route(&self, inner: &mut Inner, request: &Request, port: u16) -> Response {
        // DNS rebinding: a hostile name resolving to 127.0.0.1 would carry its own Host.
        let host_ok = request.host.as_deref().is_some_and(|host| {
            host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
        });
        if !host_ok {
            return Response::error(
                421,
                "bad_host",
                "Requests must address 127.0.0.1 or localhost.",
            );
        }
        let Some(origin) = request.origin.clone() else {
            return Response::error(403, "origin_required", "An Origin header is required.");
        };
        if !api::origin_allowed(&origin) {
            return Response::error(
                403,
                "origin_not_allowed",
                "This site may not use the companion.",
            );
        }
        if request.method == Method::Options {
            return Response {
                status: 204,
                body: String::new(),
                cors_origin: None,
                preflight: true,
            };
        }

        let client = request.token.as_deref().map(hash_token).and_then(|hash| {
            inner.clients.iter().position(|client| {
                client.stored.token_hash == hash && client.stored.origin == origin
            })
        });
        let authenticated = |inner: &mut Inner| -> Result<usize, Response> {
            let index = match (request.token.is_some(), client) {
                (_, Some(index)) => index,
                (false, None) => {
                    return Err(Response::error(
                        401,
                        "token_required",
                        "Pair with the app first.",
                    ))
                }
                (true, None) => {
                    return Err(Response::error(
                        401,
                        "invalid_token",
                        "This pairing was revoked or never existed.",
                    ))
                }
            };
            let entry = &mut inner.clients[index];
            entry.polled = Some(Instant::now());
            entry.stored.last_seen = Some(Utc::now().to_rfc3339());
            Ok(index)
        };

        let path: Vec<&str> = request.path.trim_matches('/').split('/').collect();
        let response = match (&request.method, path.as_slice()) {
            (Method::Get, ["v1", "status"]) => {
                let minimal = StatusResponse {
                    app: "tarkov-mappinator".into(),
                    version: self.version.clone(),
                    protocol: PROTOCOL,
                    paired: false,
                    epoch: None,
                    seq: None,
                    scanner_running: None,
                    logs: None,
                    screenshots: None,
                };
                if request.token.is_none() {
                    return Response::json(200, &minimal);
                }
                if let Err(response) = authenticated(inner) {
                    return response;
                }
                Response::json(
                    200,
                    &StatusResponse {
                        paired: true,
                        epoch: Some(self.epoch.clone()),
                        seq: Some(inner.journal.seq()),
                        scanner_running: Some(inner.health.scanner_running),
                        logs: inner.health.logs.clone(),
                        screenshots: inner.health.screenshots.clone(),
                        ..minimal
                    },
                )
            }
            (Method::Get, ["v1", "sync"]) => {
                if let Err(response) = authenticated(inner) {
                    return response;
                }
                let Some(since) = request
                    .param("since")
                    .and_then(|value| value.parse::<u64>().ok())
                else {
                    return Response::error(
                        400,
                        "bad_cursor",
                        "`since` must be a non-negative integer.",
                    );
                };
                let Some(events) = inner.journal.since(since) else {
                    return Response::error(
                        400,
                        "bad_cursor",
                        "`since` is ahead of this app's journal; the app restarted. Sync from 0.",
                    );
                };
                Response::json(
                    200,
                    &SyncResponse {
                        protocol: PROTOCOL,
                        epoch: self.epoch.clone(),
                        seq: inner.journal.seq(),
                        oldest: inner.journal.oldest(),
                        state: inner.journal.state(),
                        events,
                    },
                )
            }
            (Method::Post, ["v1", "pair"]) => {
                if let Some(existing) = inner.pairings.iter().find(|pairing| {
                    pairing.origin == origin && matches!(pairing.decision, Decision::Pending)
                }) {
                    let left = PAIRING_TTL.saturating_sub(existing.requested.elapsed());
                    return Response::json(
                        202,
                        &PairRequested {
                            pairing_id: existing.id.clone(),
                            expires_in_secs: left.as_secs() as u32,
                        },
                    );
                }
                if inner.denied.iter().any(|(denied, _)| *denied == origin) {
                    return Response::error(
                        429,
                        "recently_denied",
                        "The app just denied a request. Try again shortly.",
                    );
                }
                if inner
                    .pairings
                    .iter()
                    .filter(|pairing| matches!(pairing.decision, Decision::Pending))
                    .count()
                    >= MAX_PENDING
                {
                    return Response::error(
                        429,
                        "too_many_requests",
                        "Too many pairing requests are waiting.",
                    );
                }
                let id = random_hex(8);
                inner.pairings.push(Pairing {
                    id: id.clone(),
                    origin,
                    requested: Instant::now(),
                    requested_at: Utc::now(),
                    decision: Decision::Pending,
                    decided: None,
                });
                Response::json(
                    202,
                    &PairRequested {
                        pairing_id: id,
                        expires_in_secs: PAIRING_TTL.as_secs() as u32,
                    },
                )
            }
            (Method::Get, ["v1", "pair", id]) => {
                let Some(index) = inner
                    .pairings
                    .iter()
                    .position(|pairing| pairing.id == *id && pairing.origin == origin)
                else {
                    return Response::json(200, &PairingState::Expired);
                };
                match &inner.pairings[index].decision {
                    Decision::Pending => Response::json(200, &PairingState::Pending),
                    Decision::Denied => Response::json(200, &PairingState::Denied),
                    Decision::Allowed { token, .. } => {
                        let state = PairingState::Allowed {
                            token: token.clone(),
                        };
                        // Handed out once.
                        inner.pairings.remove(index);
                        Response::json(200, &state)
                    }
                }
            }
            (Method::Delete, ["v1", "pair"]) => match authenticated(inner) {
                Ok(index) => {
                    inner.clients.remove(index);
                    self.persist(inner);
                    Response {
                        status: 204,
                        body: String::new(),
                        cors_origin: None,
                        preflight: false,
                    }
                }
                Err(response) => response,
            },
            _ => Response::error(404, "not_found", "Unknown endpoint."),
        };
        if client.is_some() && inner.persisted.elapsed() > PERSIST_EVERY {
            self.persist(inner);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn companion() -> (tempfile::TempDir, Arc<Companion>) {
        let dir = tempfile::tempdir().unwrap();
        let companion = Companion::new(
            dir.path().join("clients.json"),
            "test".into(),
            Box::new(|_| {}),
        );
        (dir, companion)
    }

    fn request(method: Method, path: &str, origin: Option<&str>, token: Option<&str>) -> Request {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        Request {
            method,
            path: path.into(),
            query: query.into(),
            origin: origin.map(Into::into),
            host: Some("127.0.0.1:0".into()),
            token: token.map(Into::into),
        }
    }

    const SITE: Option<&str> = Some("https://tarkovhideout.com");

    fn pair(companion: &Companion) -> String {
        let response = companion.handle(&request(Method::Post, "/v1/pair", SITE, None));
        assert_eq!(response.status, 202);
        let id = serde_json::from_str::<serde_json::Value>(&response.body).unwrap()["pairing_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(companion.status().pending.len(), 1);
        companion.respond(&id, true).unwrap();
        let response =
            companion.handle(&request(Method::Get, &format!("/v1/pair/{id}"), SITE, None));
        let body: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["state"], "allowed");
        body["token"].as_str().unwrap().to_owned()
    }

    #[test]
    fn origins_and_hosts_are_checked() {
        let (_dir, companion) = companion();
        let evil = companion.handle(&request(
            Method::Get,
            "/v1/status",
            Some("https://evil.example"),
            None,
        ));
        assert_eq!(evil.status, 403);
        assert!(evil.cors_origin.is_none());
        assert_eq!(
            companion
                .handle(&request(Method::Get, "/v1/status", None, None))
                .status,
            403
        );
        let mut rebound = request(Method::Get, "/v1/status", SITE, None);
        rebound.host = Some("attacker.example:47615".into());
        assert_eq!(companion.handle(&rebound).status, 421);
        let preflight = companion.handle(&request(Method::Options, "/v1/sync", SITE, None));
        assert_eq!(preflight.status, 204);
        assert!(preflight
            .headers()
            .iter()
            .any(|(name, _)| *name == "Access-Control-Allow-Private-Network"));
    }

    #[test]
    fn pairing_tokens_and_revocation() {
        let (dir, companion) = companion();
        assert_eq!(
            companion
                .handle(&request(Method::Get, "/v1/sync?since=0", SITE, None))
                .status,
            401
        );
        let token = pair(&companion);
        assert!(!std::fs::read_to_string(dir.path().join("clients.json"))
            .unwrap()
            .contains(&token));
        let sync = companion.handle(&request(
            Method::Get,
            "/v1/sync?since=0",
            SITE,
            Some(&token),
        ));
        assert_eq!(sync.status, 200, "{}", sync.body);
        assert_eq!(
            companion
                .handle(&request(
                    Method::Get,
                    "/v1/sync?since=x",
                    SITE,
                    Some(&token)
                ))
                .status,
            400
        );
        assert_eq!(
            companion
                .handle(&request(
                    Method::Get,
                    "/v1/sync?since=99",
                    SITE,
                    Some(&token)
                ))
                .status,
            400
        );
        // Tokens are bound to the origin that paired.
        let other = companion.handle(&request(
            Method::Get,
            "/v1/sync?since=0",
            Some("http://localhost:3000"),
            Some(&token),
        ));
        assert_eq!(other.status, 401);
        let id = companion.status().clients[0].id.clone();
        companion.revoke(&id);
        assert_eq!(
            companion
                .handle(&request(
                    Method::Get,
                    "/v1/sync?since=0",
                    SITE,
                    Some(&token)
                ))
                .status,
            401
        );
    }

    #[test]
    fn deny_blocks_prompt_spam() {
        let (_dir, companion) = companion();
        let response = companion.handle(&request(Method::Post, "/v1/pair", SITE, None));
        let id = serde_json::from_str::<serde_json::Value>(&response.body).unwrap()["pairing_id"]
            .as_str()
            .unwrap()
            .to_owned();
        companion.respond(&id, false).unwrap();
        let state = companion.handle(&request(Method::Get, &format!("/v1/pair/{id}"), SITE, None));
        assert!(state.body.contains("denied"));
        assert_eq!(
            companion
                .handle(&request(Method::Post, "/v1/pair", SITE, None))
                .status,
            429
        );
    }

    #[test]
    fn clients_survive_restart() {
        let (dir, companion) = companion();
        let token = pair(&companion);
        drop(companion);
        let companion = Companion::new(
            dir.path().join("clients.json"),
            "test".into(),
            Box::new(|_| {}),
        );
        assert_eq!(companion.status().clients.len(), 1);
        assert_eq!(
            companion
                .handle(&request(Method::Get, "/v1/status", SITE, Some(&token)))
                .status,
            200
        );
    }

    #[test]
    fn export_companion_contract() {
        use ts_rs::TS;
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings");
        CompanionStatus::export_all_to(out).unwrap();
        SyncResponse::export_all_to(out).unwrap();
        StatusResponse::export_all_to(out).unwrap();
        PairingState::export_all_to(out).unwrap();
        PairRequested::export_all_to(out).unwrap();
        model::ApiError::export_all_to(out).unwrap();
    }
}
