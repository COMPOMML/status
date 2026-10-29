"""Fetch the same data the status page fetches (read-only, through gh) and write it
as the site's local-preview file. Also checks that both GraphQL queries are valid."""
import datetime, json, re, subprocess, sys
from pathlib import Path

site = Path(sys.argv[1])
src = (site / "app.js").read_text(encoding="utf-8")
q_over = re.search(r"const Q_OVERVIEW = `(.*?)`;", src, re.S).group(1)
q_board = re.search(r"const Q_BOARD = `(.*?)`;", src, re.S).group(1)
ORG = "COMPOMML"


def gh(*args):
    p = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout, p.stderr


since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=14)).isoformat()
rc, out, err = gh("api", "graphql", "-f", "query=" + q_over, "-f", "org=" + ORG, "-f", "since=" + since)
data = json.loads(out) if out.strip() else {}
if data.get("errors"):
    print("OVERVIEW ERRORS:", json.dumps(data["errors"], indent=1)[:2000])
if not data.get("data"):
    print("overview failed", rc, err[:500]); sys.exit(1)
overview = data["data"]
repos = [r for r in overview["organization"]["repositories"]["nodes"] if not r["isArchived"]]
print("overview ok:", len(repos), "repos,", sum(len(r["issues"]["nodes"]) for r in repos), "open issues")

rc, out, err = gh("api", "graphql", "-f", "query=" + q_board, "-f", "org=" + ORG, "-F", "num=1")
bj = json.loads(out) if out.strip() else {}
board_error = None
if bj.get("errors"):
    msgs = "; ".join(e.get("message", "") for e in bj["errors"])
    print("BOARD:", msgs[:400])
    board_error = "The board needs the Projects permission on your token (" + msgs + ")."
schema_bad = [e for e in bj.get("errors", []) if e.get("extensions", {}).get("code") in ("undefinedField", "argumentLiteralsIncompatible", "selectionMismatch")]
print("board schema errors:", schema_bad or "none")

runs = {}
for r in repos:
    if not r["defaultBranchRef"]:
        continue
    rc, out, err = gh("api", f"repos/{ORG}/{r['name']}/actions/runs?branch={r['defaultBranchRef']['name']}&exclude_pull_requests=true&per_page=6")
    runs[r["name"]] = json.loads(out).get("workflow_runs", []) if rc == 0 else {"error": "unavailable"}
    runs[r["name"]] = [{k: w.get(k) for k in ("status", "conclusion", "html_url", "created_at", "updated_at", "name")} for w in runs[r["name"]]] if isinstance(runs[r["name"]], list) else runs[r["name"]]


def raw(path):
    rc, out, err = gh("api", "-H", "Accept: application/vnd.github.raw+json", f"repos/{ORG}/docs/contents/{path}")
    return out if rc == 0 else None


local = {"overview": overview, "plan": raw("plan.md"), "arch": raw("architecture/README.md"), "runs": runs,
         "board": None, "boardError": board_error}
(site / ".local").mkdir(exist_ok=True)
(site / ".local" / "local-data.js").write_text("window.__COMPO_LOCAL = " + json.dumps(local) + ";\n", encoding="utf-8")
print("runs:", {k: (v[0]["conclusion"] if isinstance(v, list) and v else v) for k, v in runs.items()})
print("written", (site / ".local" / "local-data.js").stat().st_size, "bytes")
