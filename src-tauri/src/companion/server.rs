//! The socket side: one background thread per running server, loopback only.
use super::api::{Method, Request};
use super::{Companion, PORTS};
use std::sync::Arc;
use std::thread::JoinHandle;
use tiny_http::{Header, Response, Server};

pub struct Running {
    pub port: u16,
    server: Arc<Server>,
    thread: JoinHandle<()>,
}

impl Running {
    pub fn bind(companion: Arc<Companion>) -> Result<Self, String> {
        let mut last_error = String::new();
        for port in PORTS {
            match Server::http(("127.0.0.1", port)) {
                Ok(server) => {
                    let server = Arc::new(server);
                    let serving = server.clone();
                    let thread = std::thread::Builder::new()
                        .name("companion-http".into())
                        .spawn(move || serve(&serving, &companion))
                        .map_err(|error| error.to_string())?;
                    return Ok(Self {
                        port,
                        server,
                        thread,
                    });
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(format!(
            "Ports {}–{} are all in use ({last_error}).",
            PORTS.start(),
            PORTS.end()
        ))
    }

    pub fn shutdown(self) {
        self.server.unblock();
        let _ = self.thread.join();
    }
}

fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_owned())
}

fn serve(server: &Server, companion: &Companion) {
    let mut failures = 0;
    loop {
        let mut request = match server.recv() {
            Ok(request) => {
                failures = 0;
                request
            }
            // `unblock` from `shutdown`.
            Err(error) if error.to_string() == "thread unblocked" => return,
            // Accept errors are usually one bad connection; only a run of them means the socket is gone.
            Err(error) => {
                failures += 1;
                eprintln!("Companion accept error: {error}");
                if failures >= 20 {
                    companion.failed(format!("Server stopped: {error}"));
                    return;
                }
                continue;
            }
        };
        // No endpoint takes a body; drain any so keep-alive stays in sync.
        let _ = std::io::copy(
            &mut request.as_reader().take(64 * 1024),
            &mut std::io::sink(),
        );
        let (path, query) = request.url().split_once('?').unwrap_or((request.url(), ""));
        let parsed = Request {
            method: match request.method() {
                tiny_http::Method::Get => Method::Get,
                tiny_http::Method::Post => Method::Post,
                tiny_http::Method::Delete => Method::Delete,
                tiny_http::Method::Options => Method::Options,
                _ => Method::Other,
            },
            path: path.into(),
            query: query.into(),
            origin: header(&request, "Origin"),
            host: header(&request, "Host"),
            token: header(&request, "Authorization").and_then(|value| {
                value
                    .strip_prefix("Bearer ")
                    .map(|token| token.trim().to_owned())
            }),
        };
        let response = companion.handle(&parsed);
        let mut reply =
            Response::from_string(response.body.clone()).with_status_code(response.status);
        for (name, value) in response.headers() {
            if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                reply.add_header(header);
            }
        }
        let _ = request.respond(reply);
    }
}

use std::io::Read as _;
