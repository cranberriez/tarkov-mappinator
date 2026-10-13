//! Phase 0 throwaway: can a "public" page reach a loopback listener, and how do Chrome/Edge react?
//!
//! `cargo run --example lna_spike` serves an API on 127.0.0.1:47614 (beside the real companion's
//! 47615–47619) and the test page on 127.0.0.1:47690, then opens Chrome (or Edge) in a throwaway
//! profile with `--ip-address-space-overrides=127.0.0.1:47690=public`, so the page counts as a public
//! site like tarkovhideout.com. Every request is logged here. `-- --no-browser` skips the launch.
//!
//! API query flags: `nopna=1` omits `Access-Control-Allow-Private-Network`/`-Local-Network`,
//! `nocors=1` omits all CORS headers, `status=<code>` changes the response status.

use std::time::Instant;
use tiny_http::{Header, Method, Response, Server};

const API: &str = "127.0.0.1:47614";
const PAGE: &str = "127.0.0.1:47690";

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn main() {
    let page = Server::http(PAGE).expect("page port");
    std::thread::spawn(move || {
        for request in page.incoming_requests() {
            let response = Response::from_string(include_str!("lna_spike.html"))
                .with_header(header("Content-Type", "text/html; charset=utf-8"));
            let _ = request.respond(response);
        }
    });

    let api = Server::http(API).unwrap_or_else(|error| panic!("{API} is unavailable: {error}"));
    if !std::env::args().any(|arg| arg == "--no-browser") {
        open_browser();
    }
    let started = Instant::now();
    let mut last: Option<Instant> = None;
    println!("API http://{API}  page http://{PAGE}");
    for request in api.incoming_requests() {
        let now = Instant::now();
        let gap = last
            .map(|at| format!("{:.1}s", (now - at).as_secs_f64()))
            .unwrap_or("-".into());
        if *request.method() != Method::Options {
            last = Some(now);
        }
        let get = |name: &str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
                .map(|h| h.value.as_str().to_owned())
        };
        let origin = get("Origin");
        let interesting: Vec<String> = request
            .headers()
            .iter()
            .filter(|h| {
                let name = h.field.as_str().as_str().to_ascii_lowercase();
                name.starts_with("access-control-request")
                    || name.starts_with("sec-fetch")
                    || name == "authorization"
            })
            .map(|h| format!("{}={}", h.field, h.value))
            .collect();
        println!(
            "[{:>7.1}s gap {gap:>6}] {} {} origin={} {}",
            started.elapsed().as_secs_f64(),
            request.method(),
            request.url(),
            origin.as_deref().unwrap_or("(none)"),
            interesting.join(" ")
        );

        let url = request.url().to_owned();
        let flag = |name: &str| url.contains(&format!("{name}=1"));
        let status = url
            .split(['?', '&'])
            .find_map(|part| part.strip_prefix("status="))
            .and_then(|code| code.parse().ok())
            .unwrap_or(200);
        let preflight = *request.method() == Method::Options;
        let body = if preflight {
            String::new()
        } else {
            format!(
                "{{\"ok\":true,\"at\":{:.1}}}",
                started.elapsed().as_secs_f64()
            )
        };
        let mut response =
            Response::from_string(body).with_status_code(if preflight { 204 } else { status });
        if !flag("nocors") {
            response.add_header(header(
                "Access-Control-Allow-Origin",
                origin.as_deref().unwrap_or("*"),
            ));
            response.add_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
            response.add_header(header(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            ));
            response.add_header(header("Access-Control-Max-Age", "600"));
            response.add_header(header("Vary", "Origin"));
            if !flag("nopna") {
                response.add_header(header("Access-Control-Allow-Private-Network", "true"));
                response.add_header(header("Access-Control-Allow-Local-Network", "true"));
            }
        }
        response.add_header(header("Content-Type", "application/json"));
        let _ = request.respond(response);
    }
}

/// Chrome, else Edge, in a separate profile so the override flag and permission grants stay out of
/// the everyday profile.
fn open_browser() {
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    let Some(browser) = candidates.iter().find(|path| std::path::Path::new(path).exists()) else {
        println!("No Chrome or Edge found; open http://{PAGE} in a browser started with --ip-address-space-overrides={PAGE}=public");
        return;
    };
    let profile = std::env::temp_dir().join("lna-spike-profile");
    let result = std::process::Command::new(browser)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check"])
        .arg(format!("--ip-address-space-overrides={PAGE}=public"))
        .arg(format!("http://{PAGE}/"))
        .spawn();
    match result {
        Ok(_) => println!("Opened {browser} (profile {})", profile.display()),
        Err(error) => println!("Unable to open {browser}: {error}"),
    }
}
