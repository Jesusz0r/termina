//! NF01 (#160): a source swapped to a FIFO after observation must be
//! rejected promptly without blocking the core or mutating the destination.
//! Symlink and regular-file replacement controls prove the seam itself.

mod common;

use std::ffi::CString;
use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use common::{CoreProcess, TempFixture, expected_file_json, identity_json, wait_for_path};

const DEADLINE: Duration = Duration::from_secs(5);

fn copy_payload(
    source_root: &Path,
    source_name: &str,
    expected: serde_json::Value,
    dest_root: &Path,
    dest_name: &str,
    hook: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut payload = json!({
        "sourceRoot": source_root.to_str().unwrap(),
        "sourceRootIdentity": identity_json(source_root),
        "sourceComponents": [source_name],
        "sourceParentIdentity": identity_json(source_root),
        "expectedSource": expected,
        "destinationRoot": dest_root.to_str().unwrap(),
        "destinationRootIdentity": identity_json(dest_root),
        "destinationComponents": [dest_name],
        "destinationParentIdentity": identity_json(dest_root),
    });
    if let Some(hook) = hook {
        payload["testHook"] = hook;
    }
    payload
}

fn hook_payload(stage: &str, dir: &Path, name: &str) -> (serde_json::Value, PathBuf, PathBuf) {
    let ready = dir.join(format!("{name}.ready"));
    let release = dir.join(format!("{name}.release"));
    let hook = json!({
        "stage": stage,
        "readyPath": ready.to_str().unwrap(),
        "releasePath": release.to_str().unwrap(),
    });
    (hook, ready, release)
}

fn swap_to_fifo(path: &Path) {
    fs::remove_file(path).expect("remove source before fifo swap");
    let raw = CString::new(path.to_str().unwrap()).expect("fifo path has no NUL");
    let rc = unsafe { libc::mkfifo(raw.as_ptr(), 0o600) };
    assert_eq!(rc, 0, "mkfifo failed");
    assert!(
        fs::symlink_metadata(path)
            .expect("stat fifo")
            .file_type()
            .is_fifo(),
        "swap did not produce a fifo"
    );
}

fn assert_rejected_and_idle(response: &serde_json::Value, dest_path: &Path) {
    assert_eq!(
        response.get("ok").and_then(serde_json::Value::as_bool),
        Some(false),
        "swapped source was not rejected: {response}"
    );
    assert!(
        fs::symlink_metadata(dest_path).is_err(),
        "destination was mutated by a rejected copy"
    );
}

fn setup_two_file_fixture(prefix: &str) -> (TempFixture, PathBuf, PathBuf, PathBuf, PathBuf) {
    let fixture = TempFixture::new(prefix);
    let home = fixture.join("home");
    fs::create_dir_all(&home).expect("create home");
    let source_root = fixture.join("source");
    let dest_root = fixture.join("dest");
    fs::create_dir_all(&source_root).expect("create source root");
    fs::create_dir_all(&dest_root).expect("create dest root");
    let hooks = fixture.join("hooks");
    (fixture, home, source_root, dest_root, hooks)
}

fn write_source(root: &Path, name: &str, content: &str) -> PathBuf {
    let path = root.join(name);
    fs::write(&path, content).expect("write source file");
    path
}

#[test]
fn fifo_swap_after_observation_is_rejected_and_core_stays_usable() {
    let (fixture, home, source_root, dest_root, hooks_dir) =
        setup_two_file_fixture("bound-copy-fifo");
    fs::create_dir_all(&hooks_dir).expect("create hooks dir");
    let victim = write_source(&source_root, "victim.txt", "before-image\n");
    let healthy = write_source(&source_root, "healthy.txt", "healthy\n");
    let expected_victim = expected_file_json(&victim);
    let expected_healthy = expected_file_json(&healthy);

    let mut core = CoreProcess::spawn(&home, fixture.path());
    let (hook, ready, release) = hook_payload("promotion-copy-source-observed", &hooks_dir, "fifo");
    let payload = copy_payload(
        &source_root,
        "victim.txt",
        expected_victim,
        &dest_root,
        "victim-copy.txt",
        Some(hook),
    );
    let request_id = core
        .send("promotion-bound-copy-file", payload)
        .expect("send copy request");
    wait_for_path(&ready, DEADLINE);
    swap_to_fifo(&victim);
    fs::write(&release, b"release").expect("release paused copy");
    let response = core.recv(&request_id, DEADLINE).expect("receive rejection");
    assert_rejected_and_idle(&response, &dest_root.join("victim-copy.txt"));

    // The same core must still serve a later healthy copy.
    let healthy_payload = copy_payload(
        &source_root,
        "healthy.txt",
        expected_healthy,
        &dest_root,
        "healthy-copy.txt",
        None,
    );
    let healthy_response = core
        .request_ok("promotion-bound-copy-file", healthy_payload, DEADLINE)
        .expect("healthy copy after fifo rejection");
    assert!(
        healthy_response
            .get("result")
            .and_then(|r| r.get("leaf"))
            .is_some(),
        "healthy copy returned no leaf: {healthy_response}"
    );
    assert_eq!(
        fs::read_to_string(dest_root.join("healthy-copy.txt")).expect("read healthy copy"),
        "healthy\n"
    );

    core.shutdown();
}

#[test]
fn symlink_swap_after_observation_is_rejected() {
    let (fixture, home, source_root, dest_root, hooks_dir) =
        setup_two_file_fixture("bound-copy-symlink");
    fs::create_dir_all(&hooks_dir).expect("create hooks dir");
    let victim = write_source(&source_root, "victim.txt", "before-image\n");
    let target = write_source(&source_root, "target.txt", "target\n");
    let expected_victim = expected_file_json(&victim);

    let mut core = CoreProcess::spawn(&home, fixture.path());
    let (hook, ready, release) =
        hook_payload("promotion-copy-source-observed", &hooks_dir, "symlink");
    let payload = copy_payload(
        &source_root,
        "victim.txt",
        expected_victim,
        &dest_root,
        "victim-copy.txt",
        Some(hook),
    );
    let request_id = core
        .send("promotion-bound-copy-file", payload)
        .expect("send copy request");
    wait_for_path(&ready, DEADLINE);
    fs::remove_file(&victim).expect("remove source before symlink swap");
    symlink(&target, &victim).expect("swap source to symlink");
    fs::write(&release, b"release").expect("release paused copy");
    let response = core.recv(&request_id, DEADLINE).expect("receive rejection");
    assert_rejected_and_idle(&response, &dest_root.join("victim-copy.txt"));

    core.shutdown();
}

#[test]
fn regular_replacement_after_observation_is_rejected() {
    let (fixture, home, source_root, dest_root, hooks_dir) =
        setup_two_file_fixture("bound-copy-regular");
    fs::create_dir_all(&hooks_dir).expect("create hooks dir");
    let victim = write_source(&source_root, "victim.txt", "before-image\n");
    let expected_victim = expected_file_json(&victim);

    let mut core = CoreProcess::spawn(&home, fixture.path());
    let (hook, ready, release) =
        hook_payload("promotion-copy-source-observed", &hooks_dir, "regular");
    let payload = copy_payload(
        &source_root,
        "victim.txt",
        expected_victim,
        &dest_root,
        "victim-copy.txt",
        Some(hook),
    );
    let request_id = core
        .send("promotion-bound-copy-file", payload)
        .expect("send copy request");
    wait_for_path(&ready, DEADLINE);
    fs::remove_file(&victim).expect("remove source before regular swap");
    fs::write(&victim, "replacement\n").expect("write replacement source");
    fs::write(&release, b"release").expect("release paused copy");
    let response = core.recv(&request_id, DEADLINE).expect("receive rejection");
    assert_rejected_and_idle(&response, &dest_root.join("victim-copy.txt"));

    core.shutdown();
}
