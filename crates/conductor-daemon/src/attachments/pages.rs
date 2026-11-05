//! ADR-0038 (Rust only): the outcome server's `publish_page` tool hands one HTML document here,
//! and the daemon posts it to the orchestrator (POST `/api/daemon/sessions/<session>/pages`, its
//! machine credential, JSON). The orchestrator stores and serves the page (`/p/<id>`); the daemon
//! never serves it. The tool is listed only for a state with the `pages` tool alias.

use conductor_protocol::{
    DAEMON_AUTH_HEADER, PAGE_HTML_MAX_BYTES, PAGE_TITLE_MAX, PAGE_TTL_MAX_DAYS,
    auth::daemon_auth_header_value,
};
use serde_json::{Value, json};

use super::upload::{AttachTarget, UPLOAD_TIMEOUT};

/// What `publish_page` was called with (already bounded by `check`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishPageRequest {
    pub title: String,
    pub html: String,
    pub ttl_days: Option<u32>,
    pub share: bool,
}

/// The arguments' bounds, checked before anything is sent: Err = the text for the agent.
pub fn check(req: &PublishPageRequest) -> Result<(), String> {
    let title_len = req.title.encode_utf16().count();
    if req.title.trim().is_empty() || title_len > PAGE_TITLE_MAX {
        return Err(format!("title: 1 to {PAGE_TITLE_MAX} characters"));
    }
    if req.html.trim().is_empty() {
        return Err("html: one HTML document".into());
    }
    if req.html.len() > PAGE_HTML_MAX_BYTES {
        return Err(format!(
            "the page is {} bytes; at most {PAGE_HTML_MAX_BYTES} (inline less, or split it)",
            req.html.len()
        ));
    }
    if let Some(d) = req.ttl_days
        && !(1..=PAGE_TTL_MAX_DAYS as u32).contains(&d)
    {
        return Err(format!("ttl_days: 1 to {PAGE_TTL_MAX_DAYS}"));
    }
    Ok(())
}

/// The agent-readable text for a refused publish.
fn refusal(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from));
    match (status, message) {
        (404, _) => "the conductor server doesn't take pages for this session (it may be an older server, or the session has ended)".into(),
        (401, _) => "the conductor server refused this machine's credential".into(),
        (_, Some(m)) => format!("the conductor server refused it ({status}): {m}"),
        (_, None) => format!("the conductor server answered HTTP {status}"),
    }
}

/// Publish the page for the target session. Ok: the text for the agent (the URL to attach).
pub async fn publish(
    client: &reqwest::Client,
    target: &AttachTarget,
    req: &PublishPageRequest,
) -> Result<String, String> {
    check(req)?;
    let url = target
        .base
        .join(&format!(
            "api/daemon/sessions/{}/pages",
            super::upload::encode_uri_component(&target.session_id)
        ))
        .map_err(|e| format!("bad URL: {e}"))?;
    let mut body = json!({ "title": req.title.trim(), "html": req.html });
    if let Some(d) = req.ttl_days {
        body["ttl_days"] = json!(d);
    }
    if req.share {
        body["share"] = json!(true);
    }
    let mut r = client
        .post(url)
        .timeout(UPLOAD_TIMEOUT)
        .header("content-type", "application/json")
        .body(body.to_string());
    if let Some(c) = &target.credential {
        r = r.header(DAEMON_AUTH_HEADER, daemon_auth_header_value(c));
    }
    // No retry: a second POST would publish a second page.
    let res = r
        .send()
        .await
        .map_err(|e| format!("the publish failed: {e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(refusal(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| "the server's answer was not JSON")?;
    let page_url = v["url"].as_str().unwrap_or_default();
    let expires = v["expires_at"].as_str().unwrap_or_default();
    let share = v["share_url"]
        .as_str()
        .map(|s| format!(" Share link (opens without signing in): {s}."))
        .unwrap_or_default();
    Ok(format!(
        "Published {page_url} (expires {expires}).{share} Add it to your result as \"pages\": [{{\"url\": {}, \"title\": {}}}] so the human can open it from the card.",
        json!(page_url),
        json!(req.title.trim()),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use reqwest::Url;

    use super::*;

    fn req(html: &str) -> PublishPageRequest {
        PublishPageRequest {
            title: "Mockup".into(),
            html: html.into(),
            ttl_days: None,
            share: false,
        }
    }

    #[test]
    fn checks_the_bounds_before_sending() {
        assert!(check(&req("<p>x</p>")).is_ok());
        assert!(check(&req("  ")).is_err());
        assert!(
            check(&PublishPageRequest {
                title: " ".into(),
                ..req("<p>x</p>")
            })
            .is_err()
        );
        assert!(
            check(&PublishPageRequest {
                ttl_days: Some(31),
                ..req("<p>x</p>")
            })
            .is_err()
        );
        assert!(
            check(&PublishPageRequest {
                ttl_days: Some(30),
                ..req("<p>x</p>")
            })
            .is_ok()
        );
        assert!(check(&req(&"x".repeat(PAGE_HTML_MAX_BYTES + 1))).is_err());
    }

    type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

    async fn stub(status: StatusCode, answer: &'static str) -> (Url, Seen) {
        let seen: Seen = Arc::default();
        let app = Router::new()
            .route(
                "/api/daemon/sessions/{id}/pages",
                post(
                    move |State(seen): State<Seen>,
                          axum::extract::Path(id): axum::extract::Path<String>,
                          headers: HeaderMap,
                          body: String| async move {
                        let auth = headers
                            .get("authorization")
                            .map(|v| v.to_str().unwrap_or_default().to_string());
                        seen.lock().unwrap().push((
                            id,
                            auth,
                            serde_json::from_str(&body).unwrap_or(Value::Null),
                        ));
                        (status, answer)
                    },
                ),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (Url::parse(&format!("http://{addr}/")).unwrap(), seen)
    }

    fn target(base: Url) -> AttachTarget {
        AttachTarget {
            base,
            credential: Some("cred-1".into()),
            session_id: "s-1".into(),
            roots: vec![],
        }
    }

    #[tokio::test]
    async fn posts_the_page_with_the_credential_and_returns_the_url() {
        let (base, seen) = stub(
            StatusCode::CREATED,
            r#"{"id":"p","url":"https://c.example/p/p","share_url":"https://c.example/p/p?t=tok","expires_at":"2026-11-12T00:00:00.000Z"}"#,
        )
        .await;
        let r = PublishPageRequest {
            share: true,
            ttl_days: Some(3),
            ..req("<h1>x</h1>")
        };
        let text = publish(&reqwest::Client::new(), &target(base), &r)
            .await
            .unwrap();
        assert!(text.contains("https://c.example/p/p"), "{text}");
        assert!(text.contains("?t=tok"), "{text}");
        assert!(
            text.contains(r#""pages": [{"url": "https://c.example/p/p", "title": "Mockup"}]"#),
            "{text}"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "s-1");
        assert!(seen[0].1.as_deref().unwrap_or_default().contains("cred-1"));
        assert_eq!(
            seen[0].2,
            json!({"title": "Mockup", "html": "<h1>x</h1>", "ttl_days": 3, "share": true})
        );
    }

    #[tokio::test]
    async fn a_refusal_is_agent_readable_text() {
        let (base, _) = stub(
            StatusCode::CONFLICT,
            r#"{"error":{"code":"page_limit","message":"a ticket has at most 30 live pages"}}"#,
        )
        .await;
        let err = publish(&reqwest::Client::new(), &target(base), &req("<p>x</p>"))
            .await
            .unwrap_err();
        assert!(err.contains("at most 30 live pages"), "{err}");
    }
}
