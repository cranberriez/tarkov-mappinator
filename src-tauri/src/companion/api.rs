//! Transport-free request handling, so the contract is testable without sockets.
use serde::Serialize;

pub const PROTOCOL: u32 = 1;

/// Production site origins plus the local Next.js dev server.
pub const ALLOWED_ORIGINS: &[&str] = &[
    "https://tarkovhideout.com",
    "https://www.tarkovhideout.com",
    "https://dev.tarkovhideout.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

/// The Phase 0 test page (`examples/lna_spike.rs`), accepted only in debug builds.
pub const DEV_TEST_ORIGIN: &str = "http://127.0.0.1:47690";

pub fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGINS.contains(&origin) || (cfg!(debug_assertions) && origin == DEV_TEST_ORIGIN)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Delete,
    Options,
    Other,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: Method,
    pub path: String,
    pub query: String,
    pub origin: Option<String>,
    pub host: Option<String>,
    pub token: Option<String>,
}

impl Request {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query
            .split('&')
            .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: String,
    /// Echoed as `Access-Control-Allow-Origin`; unset for disallowed origins so browsers block the read.
    pub cors_origin: Option<String>,
    pub preflight: bool,
}

impl Response {
    pub fn json(status: u16, value: &impl Serialize) -> Self {
        Self {
            status,
            body: serde_json::to_string(value).unwrap_or_default(),
            cors_origin: None,
            preflight: false,
        }
    }

    pub fn error(status: u16, code: &str, message: &str) -> Self {
        Self::json(
            status,
            &super::model::ApiError {
                error: code.into(),
                message: message.into(),
            },
        )
    }

    pub fn headers(&self) -> Vec<(&'static str, String)> {
        let mut headers = vec![
            ("Content-Type", "application/json".to_string()),
            ("Cache-Control", "no-store".into()),
        ];
        if let Some(origin) = &self.cors_origin {
            headers.push(("Access-Control-Allow-Origin", origin.clone()));
            headers.push(("Vary", "Origin".into()));
            if self.preflight {
                headers.push((
                    "Access-Control-Allow-Methods",
                    "GET, POST, DELETE, OPTIONS".into(),
                ));
                headers.push((
                    "Access-Control-Allow-Headers",
                    "Authorization, Content-Type".into(),
                ));
                headers.push(("Access-Control-Max-Age", "600".into()));
                // Chrome's older Private Network Access preflight; Local Network Access uses a permission prompt.
                headers.push(("Access-Control-Allow-Private-Network", "true".into()));
                headers.push(("Access-Control-Allow-Local-Network", "true".into()));
            }
        }
        headers
    }
}
