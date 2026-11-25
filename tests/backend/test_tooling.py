"""Phase 6: checks on the scripts around the API (the dev proxy, deploy and smoke scripts)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess  # noqa: S404 - runs the repository's own scripts, test-only

import pytest

from conftest import ROOT

PROXY = ROOT / "bin" / "proxy-server.js"


def _forwarded_headers() -> str:
    """The object literal of headers the dev proxy passes on to the Lambda."""
    source = PROXY.read_text(encoding="utf-8")
    block = re.search(r"headers: \{(.*?)\n    \}\n  \};", source, re.S)
    assert block is not None, "could not find the proxy's forwarded headers"
    return block.group(1)


def test_the_dev_proxy_forwards_the_idempotency_key_like_authorization() -> None:
    forwarded = _forwarded_headers()
    assert "...(headers.authorization && { authorization: headers.authorization })" in forwarded
    assert (
        "...(headers['idempotency-key'] && { 'idempotency-key': headers['idempotency-key'] })"
        in forwarded
    )


def test_the_dev_proxy_still_parses() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed here")
    result = subprocess.run(  # noqa: S603 - fixed arguments
        [node, "--check", str(PROXY)], capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr


# ---------------------------------------------------------------------------------------
# Part G: edge and infrastructure
# ---------------------------------------------------------------------------------------

SECURITY_HEADERS_POLICY = "67f7725c-6f97-4210-82d7-5512b31e9d03"  # Managed-SecurityHeadersPolicy


def _cloudfront() -> str:
    return (ROOT / "infra" / "cloudfront.tf").read_text(encoding="utf-8")


def _block(source: str, opening: str) -> str:
    """The text of the brace-delimited block that starts at ``opening``."""
    start = source.index(opening)
    depth = 0
    for index in range(source.index("{", start), len(source)):
        depth += {"{": 1, "}": -1}.get(source[index], 0)
        if depth == 0:
            return source[start : index + 1]
    raise AssertionError(f"unbalanced block after {opening!r}")


def _code(block: str) -> str:
    """A Terraform block without its comment lines."""
    return "\n".join(line for line in block.splitlines() if not line.strip().startswith("#"))


def test_both_kinds_of_behaviour_get_the_managed_security_headers_and_compression() -> None:
    source = _cloudfront()
    for opening in ('dynamic "ordered_cache_behavior"', "default_cache_behavior {"):
        behaviour = _code(_block(source, opening))
        assert f'response_headers_policy_id = "{SECURITY_HEADERS_POLICY}"' in behaviour, opening
        assert re.search(r"compress\s*=\s*true", behaviour), opening
    # the managed policy is referenced by id: no response headers policy resource is created
    assert 'resource "aws_cloudfront_response_headers_policy"' not in source


def test_the_spa_rewrite_function_is_gated_and_only_on_the_default_behaviour() -> None:
    source = _cloudfront()
    function = _block(source, 'resource "aws_cloudfront_function" "spa_rewrite"')
    assert "var.enable_spa_rewrite ? 1 : 0" in function
    assert 'runtime = "cloudfront-js-2.0"' in function
    assert 'file("${path.module}/spa-rewrite.js")' in function
    default = _code(_block(source, "default_cache_behavior {"))
    assert 'event_type   = "viewer-request"' in default
    assert "for_each = aws_cloudfront_function.spa_rewrite" in default
    api = _code(_block(source, 'dynamic "ordered_cache_behavior"'))
    assert "function_association" not in api
    variable = _block(
        (ROOT / "infra" / "variable.tf").read_text(encoding="utf-8"),
        'variable "enable_spa_rewrite"',
    )
    assert re.search(r"type\s*=\s*bool", variable) and re.search(r"default\s*=\s*true", variable)


def test_custom_error_response_is_never_re_added() -> None:
    assert "custom_error_response" not in _code(_cloudfront())


def _fake_aws(tmp_path) -> tuple[dict, object]:
    """A stand-in ``aws`` on PATH that only records how it was called."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "aws.log"
    fake = bin_dir / "aws"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        'printf "%s\\x1f" "$@" >> "$AWS_LOG"\n'
        'printf "\\n" >> "$AWS_LOG"\n'
    )
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "AWS_LOG": str(log)}
    return env, log


def _calls(log) -> list[list[str]]:
    if not log.exists():
        return []
    return [line.split("\x1f")[:-1] for line in log.read_text().splitlines() if line]


def _build(tmp_path, *, assets: bool = True):
    build = tmp_path / "dist"
    build.mkdir()
    (build / "index.html").write_text("<html></html>")
    (build / "favicon.svg").write_text("<svg/>")
    if assets:
        (build / "assets").mkdir()
        (build / "assets" / "index-abc123.js").write_text("console.log(1)")
    return build


def _upload(env, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - the repository's own script, fixed arguments
        [str(ROOT / "bin" / "upload-frontend.sh"), *args],
        capture_output=True, text=True, env=env, timeout=60,
    )


def test_upload_sets_cache_control_per_kind_of_file_and_still_deletes(tmp_path) -> None:
    env, log = _fake_aws(tmp_path)
    build = _build(tmp_path)
    result = _upload(env, str(build), "my-bucket")
    assert result.returncode == 0, result.stderr
    hashed, root, cleanup = _calls(log)

    assert hashed[:4] == ["s3", "cp", f"{build}/assets/", "s3://my-bucket/assets/"]
    assert "--recursive" in hashed
    assert hashed[hashed.index("--cache-control") + 1] == "public, max-age=31536000, immutable"

    assert root[:4] == ["s3", "cp", f"{build}/", "s3://my-bucket/"]
    assert "--recursive" in root
    assert root[root.index("--exclude") + 1] == "assets/*"
    assert root[root.index("--cache-control") + 1] == "no-cache"

    assert cleanup[:4] == ["s3", "sync", f"{build}/", "s3://my-bucket/"]
    assert "--delete" in cleanup
    assert "--cache-control" not in cleanup


def test_upload_passes_extra_arguments_and_copes_without_assets(tmp_path) -> None:
    env, log = _fake_aws(tmp_path)
    build = _build(tmp_path, assets=False)
    result = _upload(env, str(build), "my-bucket", "--endpoint-url", "http://localhost:4566")
    assert result.returncode == 0, result.stderr
    calls = _calls(log)
    assert [call[1] for call in calls] == ["cp", "sync"]
    assert all(call[-2:] == ["--endpoint-url", "http://localhost:4566"] for call in calls)


def test_upload_refuses_a_directory_that_is_not_a_build(tmp_path) -> None:
    env, log = _fake_aws(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    result = _upload(env, str(empty), "my-bucket")
    assert result.returncode == 1
    assert "no index.html" in result.stdout
    assert _calls(log) == []
    assert _upload(env).returncode != 0


def test_deploy_frontend_uploads_through_the_cache_control_script() -> None:
    script = (ROOT / "bin" / "deploy-frontend.sh").read_text(encoding="utf-8")
    assert '$SCRIPT_DIR/upload-frontend.sh "$BUILD_DIR" "$BUCKET_NAME"' in script
    assert not re.search(r"^aws s3 sync", script, re.M)


FAKE_CURL = r'''#!/usr/bin/env python3
"""A stand-in curl for the smoke test's edge checks: answers a pretend CloudFront site."""
import os
import sys

args = sys.argv[1:]
url = next(arg for arg in reversed(args) if arg.startswith("http"))
mode = os.environ["EDGE"]
out = args[args.index("-o") + 1] if "-o" in args else None
dump_headers = "-D" in args
fmt = args[args.index("-w") + 1] if "-w" in args else ""
path = url.split("example.cloudfront.test", 1)[1]

SECURITY = (
    "strict-transport-security: max-age=31536000\r\nx-content-type-options: nosniff\r\n"
    "x-frame-options: SAMEORIGIN\r\nreferrer-policy: strict-origin-when-cross-origin\r\n"
)
PAGE = (
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
    '<script type="module" crossorigin src="/assets/index-abc123.js"></script></head>'
    '<body><div id="root"></div></body></html>'
)

def finish(status, content_type, body, headers=""):
    if dump_headers:
        sys.stdout.write(f"HTTP/2 {status}\r\ncontent-type: {content_type}\r\n{headers}\r\n")
    if out and out != "/dev/null":
        with open(out, "w") as handle:
            handle.write(body)
    elif not out:
        sys.stdout.write(body)
    report = fmt.replace("%{http_code}", str(status)).replace("%{content_type}", content_type)
    sys.stdout.write(report)
    sys.exit(0)

good = mode == "good"
if path.startswith("/api/tracker/health") and dump_headers:
    extra = "cache-control: no-store\r\n" + (SECURITY if good else "")
    finish(200, "application/json", "{}", extra)
if path.startswith("/api/"):
    sys.exit(7)  # the API checks are not what this stand-in is for
if path == "/":
    finish(200, "text/html", PAGE if good else "<html></html>", SECURITY if good else "")
if path.startswith("/assets/"):
    finish(200, "text/javascript", "", "content-encoding: br\r\n" if good else "")
if path == "/projects":
    if good:
        finish(200, "text/html", PAGE)
    finish(403, "application/xml", "<Error><Code>AccessDenied</Code></Error>")
sys.exit(7)
'''

EDGE_CHECKS = (
    "security header strict-transport-security on the page",
    "security header x-content-type-options on the page",
    "security header x-frame-options on the page",
    "security header referrer-policy on the page",
    "security headers on the API",
    "index.html carries the Content-Security-Policy",
    "the main script is served compressed",
    "/projects returns the app's HTML",
)


def _smoke(tmp_path, url: str, edge: str, **extra: str) -> str:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "curl"
    fake.write_text(FAKE_CURL)
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "EDGE": edge,
           "SEED_PASSWORD": "Given-Pass-123", **extra}
    result = subprocess.run(  # noqa: S603 - the repository's own script, fixed arguments
        [str(ROOT / "bin" / "smoke-test.sh"), url], capture_output=True, text=True, env=env,
        timeout=120,
    )
    return result.stdout


def _outcomes(output: str) -> dict[str, str]:
    lines = [line for line in output.splitlines() if line[:4] in ("PASS", "FAIL", "SKIP")]
    return {line[6:]: line[:4] for line in lines}


def test_smoke_test_checks_the_edge_of_an_https_site(tmp_path) -> None:
    outcomes = _outcomes(_smoke(tmp_path, "https://example.cloudfront.test", "good"))
    for check in EDGE_CHECKS:
        matching = [name for name in outcomes if name.startswith(check)]
        assert matching, check
        assert outcomes[matching[0]] == "PASS", check
    assert outcomes["API responses say Cache-Control: no-store"] == "PASS"


def test_smoke_test_fails_an_edge_without_headers_compression_or_the_rewrite(tmp_path) -> None:
    output = _smoke(tmp_path, "https://example.cloudfront.test", "bad")
    outcomes = _outcomes(output)
    for check in EDGE_CHECKS:
        matching = [name for name in outcomes if name.startswith(check)]
        assert matching, check
        assert outcomes[matching[0]] == "FAIL", check
    assert "check(s) failed" in output


def test_smoke_test_can_skip_the_rewrite_check(tmp_path) -> None:
    output = _smoke(tmp_path, "https://example.cloudfront.test", "good", SPA_REWRITE="0")
    assert "SKIP  /projects returns the app's HTML (SPA_REWRITE=0)" in output
    assert "PASS  /projects returns the app's HTML" not in output


def test_smoke_test_leaves_the_edge_alone_for_a_plain_http_url(tmp_path) -> None:
    output = _smoke(tmp_path, "http://example.cloudfront.test", "good")
    assert not any(check in output for check in EDGE_CHECKS)


def test_the_readme_documents_the_known_gaps_with_their_reasons() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    gaps = readme[readme.index("## Known gaps") :]
    for phrase in (
        "Function URL has no authentication of its own",
        "authenticates every request itself",
        "CORS allows any origin",
        "a Terraform cycle",
        "as the master user",
        "random_pet",
        "Secrets Manager",
        "per email, not per IP",
        "not single-use",
    ):
        assert phrase in gaps, phrase


# ---------------------------------------------------------------------------------------
# Part H: CI and reproducibility
# ---------------------------------------------------------------------------------------

WORKFLOW = ROOT / ".github" / "workflows" / "tests.yml"


def _job(name: str) -> str:
    """The text of one job of the tests workflow (jobs are indented by two spaces)."""
    workflow = WORKFLOW.read_text(encoding="utf-8")
    jobs = workflow[workflow.index("\njobs:\n") :]
    found = re.search(rf"\n  {name}:\n(.*?)(?=\n  \w[\w-]*:\n|\Z)", jobs, re.S)
    assert found is not None, f"no job named {name}"
    return found.group(1)


def test_the_tests_workflow_runs_on_push_and_pull_request() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert re.search(r"^on: \[push, pull_request\]$", workflow, re.M)


def test_the_backend_job_runs_the_test_script_against_postgresql_16() -> None:
    job = _job("backend")
    assert "image: postgres:16" in job
    assert "POSTGRES_PASSWORD: postgres123" in job
    assert "5432:5432" in job
    assert "pg_isready" in job
    assert "run: ./bin/test-backend.sh" in job
    assert "PGPASSWORD: postgres123" in job
    assert "'3.10'" in job and "'3.13'" in job


def test_the_backend_job_checks_out_the_history_the_migration_tests_read() -> None:
    """After a schema change is committed the old schema is at HEAD^ or earlier.

    actions/checkout fetches one commit unless told otherwise, and test_schema_migration.py
    fails without its baseline commit.
    """
    job = _job("backend")
    checkout = re.search(r"uses: actions/checkout@v\d+\n((?:        .*\n)*)", job)
    assert checkout is not None, "the backend job does not check the repository out"
    assert re.search(r"^        with:\n          fetch-depth: 0$", checkout.group(1), re.M)


def test_the_frontend_job_installs_the_lockfile_then_lints_tests_and_builds() -> None:
    job = _job("frontend")
    steps = re.findall(r"run: (.+)", job)
    assert steps == ["npm ci", "npm run lint", "npm run test:coverage", "npm run build"]
    assert "working-directory: frontend" in job
    assert "cache-dependency-path: frontend/package-lock.json" in job


def test_the_frontend_lockfile_is_tracked_and_matches_package_json() -> None:
    import json

    lock_path = ROOT / "frontend" / "package-lock.json"
    assert lock_path.is_file()
    git = shutil.which("git")
    if git and (ROOT / ".git").exists():
        ignored = subprocess.run(  # noqa: S603 - fixed arguments
            [git, "check-ignore", "-q", "frontend/package-lock.json"], cwd=ROOT, timeout=60,
        )
        assert ignored.returncode == 1, "frontend/package-lock.json is still git-ignored"
        # the examples' lockfiles stay ignored
        still = subprocess.run(  # noqa: S603 - fixed arguments
            [git, "check-ignore", "-q", "backend/_examples/nodejs-service/package-lock.json"],
            cwd=ROOT, timeout=60,
        )
        assert still.returncode == 0
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    root = lock["packages"][""]
    assert lock["lockfileVersion"] >= 2
    assert root["dependencies"] == package["dependencies"]
    assert root["devDependencies"] == package["devDependencies"]
    for name in (*package["dependencies"], *package["devDependencies"]):
        assert f"node_modules/{name}" in lock["packages"], name
