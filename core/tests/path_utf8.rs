//! #251: non-UTF8 Git paths must fail the op, never drop or forge entries.

mod common;

use std::ffi::OsStr;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);

fn git_env(home: &Path, tmp: &Path) -> Vec<(String, String)> {
    vec![
        (
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        ),
        ("HOME".to_string(), home.to_str().unwrap().to_string()),
        ("TMPDIR".to_string(), tmp.to_str().unwrap().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ]
}

fn git(home: &Path, tmp: &Path, cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-C"])
        .arg(cwd)
        .args(args)
        .envs(git_env(home, tmp))
        .status()
        .unwrap_or_else(|e| panic!("run git {:?}: {e}", args));
    assert!(status.success(), "git {:?} failed", args);
}

fn git_init(home: &Path, tmp: &Path, source: &Path) {
    let env = git_env(home, tmp);
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .arg(source)
        .envs(env.iter().cloned())
        .status()
        .expect("run git init");
    assert!(status.success(), "git init failed");
}

fn non_utf8_name() -> &'static OsStr {
    OsStr::from_bytes(b"bad\xff.txt")
}

struct RepoHarness {
    _fixture: TempFixture,
    home: PathBuf,
    tmp: PathBuf,
    source: PathBuf,
    core: CoreProcess,
}

impl RepoHarness {
    fn new(prefix: &str) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let source = fixture.join("source");
        fs::create_dir_all(&source).expect("create source");
        fs::write(source.join("keep.txt"), "keep\n").expect("write keep");
        let tmp = fixture.path().to_path_buf();
        git_init(&home, &tmp, &source);
        git(&home, &tmp, &source, &["add", "keep.txt"]);
        git(
            &home,
            &tmp,
            &source,
            &[
                "-c",
                "user.email=dev@termina.local",
                "-c",
                "user.name=termina",
                "commit",
                "-m",
                "keep",
            ],
        );
        let core = CoreProcess::spawn(&home, fixture.path());
        Self {
            _fixture: fixture,
            home,
            tmp,
            source,
            core,
        }
    }

    fn request(&mut self, op: &str, extra: Value) -> Value {
        let mut payload = extra.as_object().cloned().unwrap_or_default();
        payload.insert(
            "root".to_string(),
            json!(self.source.to_str().expect("source is UTF-8")),
        );
        self.core
            .request(op, Value::Object(payload), DEADLINE)
            .unwrap_or_else(|e| panic!("{op} response: {e}"))
    }

    fn expect_utf8_error(&mut self, op: &str, extra: Value, needle: &str) {
        let response = self.request(op, extra);
        assert_eq!(
            response.get("ok").and_then(Value::as_bool),
            Some(false),
            "{op} must fail closed on a non-UTF8 path: {response}"
        );
        let error = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{op} is missing error: {response}"));
        assert!(
            error.contains("not valid UTF-8") && error.contains(needle),
            "{op} error must name the path class: {error}"
        );
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

#[test]
fn untracked_non_utf8_fails_capture() {
    let mut harness = RepoHarness::new("utf8-capture");
    fs::write(harness.source.join(non_utf8_name()), "secret\n").expect("write untracked");
    let store_dir = harness
        .source
        .parent()
        .expect("source parent")
        .join("store");
    let created = harness
        .core
        .request_ok(
            "store-create",
            json!({
                "storeDir": store_dir.to_str().unwrap(),
                "sourceGitDir": harness.source.join(".git").to_str().unwrap(),
                "objectFormat": "sha1",
            }),
            DEADLINE,
        )
        .expect("store-create");
    let mut payload = json!({
        "storeDir": store_dir.to_str().unwrap(),
        "sourceRoot": harness.source.to_str().unwrap(),
        "sourceGitDir": harness.source.join(".git").to_str().unwrap(),
        "objectFormat": "sha1",
        "head": Value::Null,
        "parentCommit": Value::Null,
    });
    for (key, value) in created.as_object().expect("store-create object") {
        if key.starts_with("store") {
            payload[key] = value.clone();
        }
    }
    let response = harness
        .core
        .request("capture", payload, DEADLINE)
        .expect("capture response");
    assert_eq!(
        response.get("ok").and_then(Value::as_bool),
        Some(false),
        "capture must fail on an untracked non-UTF8 path: {response}"
    );
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .expect("capture error");
    assert!(
        error.contains("not valid UTF-8"),
        "capture must not drop the untracked path: {error}"
    );
    harness.shutdown();
}

#[test]
fn staged_non_utf8_fails_status_and_tracked() {
    let mut harness = RepoHarness::new("utf8-status");
    fs::write(harness.source.join(non_utf8_name()), "staged\n").expect("write staged");
    git(&harness.home, &harness.tmp, &harness.source, &["add", "-A"]);
    harness.expect_utf8_error("ls-tracked", json!({}), "tracked");
    harness.expect_utf8_error("repo-status", json!({}), "status");
    harness.shutdown();
}

#[test]
fn ignored_non_utf8_fails_ls_ignored() {
    let mut harness = RepoHarness::new("utf8-ignored");
    fs::write(harness.source.join(".gitignore"), "*.txt\n").expect("write gitignore");
    fs::write(harness.source.join(non_utf8_name()), "ignored\n").expect("write ignored");
    harness.expect_utf8_error("ls-ignored", json!({}), "ignored");
    harness.shutdown();
}

#[test]
fn committed_non_utf8_fails_repo_diff() {
    let mut harness = RepoHarness::new("utf8-diff");
    let from = Command::new("git")
        .args(["-C"])
        .arg(&harness.source)
        .args(["rev-parse", "HEAD"])
        .envs(git_env(&harness.home, &harness.tmp))
        .output()
        .expect("rev-parse");
    assert!(from.status.success(), "rev-parse failed");
    let from = String::from_utf8(from.stdout).unwrap().trim().to_string();
    fs::write(harness.source.join(non_utf8_name()), "committed\n").expect("write committed");
    git(&harness.home, &harness.tmp, &harness.source, &["add", "-A"]);
    git(
        &harness.home,
        &harness.tmp,
        &harness.source,
        &[
            "-c",
            "user.email=dev@termina.local",
            "-c",
            "user.name=termina",
            "commit",
            "-m",
            "non-utf8",
        ],
    );
    let to = Command::new("git")
        .args(["-C"])
        .arg(&harness.source)
        .args(["rev-parse", "HEAD"])
        .envs(git_env(&harness.home, &harness.tmp))
        .output()
        .expect("rev-parse to");
    assert!(to.status.success(), "rev-parse to failed");
    let to = String::from_utf8(to.stdout).unwrap().trim().to_string();
    harness.expect_utf8_error("repo-diff", json!({ "from": from, "to": to }), "diff");
    harness.shutdown();
}
