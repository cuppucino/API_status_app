from flask import Flask, render_template, jsonify, make_response
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import os, time, requests

app = Flask(__name__)

# -------- Config --------
BASE_URL = os.environ.get("TARGET_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
LATENCY_DEGRADED_S = float(os.environ.get("LATENCY_DEGRADED_S", "1.0"))
TIMEOUT_S = float(os.environ.get("HTTP_TIMEOUT_S", "5"))

# Optional test creds for an authenticated "Passing" check
LEAVE_USER = os.environ.get("LEAVE_USER")
LEAVE_PASS = os.environ.get("LEAVE_PASS")

# Endpoints: add a POST "active" check for sign-in. Others stay as health GETs.
ENDPOINTS = [
    # label, path, category, method, active?, expect statuses, body spec (optional)
    {"label": "Root",                 "path": "/",                    "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Sign In",       "path": "/leave/sign-in",       "category": "Leave System", "method": "POST", "active": True,
     "expect": [200, 201, 204, 301, 302, 303, 307, 308],
     "body_type": "form",  # or "json"
     "body_env": {"username": "LEAVE_USER", "password": "LEAVE_PASS"}},

    {"label": "Leave: Register",      "path": "/leave/register",      "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Request Test",  "path": "/leave/request/test",  "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Request Apply", "path": "/leave/request/apply", "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Request List",  "path": "/leave/request/list",  "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Authorise",     "path": "/leave/authorise",     "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: User List",     "path": "/leave/user/list",     "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Balance List",  "path": "/leave/balance/list",  "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Staff On Leave","path": "/leave/staff/onleave", "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Holiday List",  "path": "/leave/holiday/list",  "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Personal List", "path": "/leave/personal/list", "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Holiday Total", "path": "/leave/holiday/total", "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Profile",       "path": "/leave/personal/profile","category":"Leave System","method": "GET",  "active": False},
    {"label": "Leave: Edit Profile",  "path": "/leave/personal/editprofile","category":"Leave System","method":"GET","active": False},
    {"label": "Leave: Settings",      "path": "/leave/settings",      "category": "Leave System", "method": "GET",  "active": False},
    {"label": "Leave: Update Limit",  "path": "/leave/settings/update-limit","category":"Leave System","method":"GET","active": False},
]

# -------- Rolling stores --------
history_rtt = defaultdict(lambda: deque(maxlen=60))
history_ok  = defaultdict(lambda: deque(maxlen=200))
logs_store  = defaultdict(list)

def add_log(name: str, level: str, message: str):
    entry = {"ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             "level": level, "message": message}
    logs_store[name].append(entry)
    if len(logs_store[name]) > 60:
        logs_store[name] = logs_store[name][-60:]

def compute_average(name: str, fallback: float) -> float:
    series = history_rtt[name]
    return round(sum(series) / len(series), 3) if series else round(fallback, 3)

def compute_uptime(name: str) -> float:
    series = history_ok[name]
    return round(100.0 * sum(series) / len(series), 2) if series else 0.0

def build_body_from_env(body_env: dict, body_type: str):
    if not body_env:
        return None
    body = {}
    for key, envvar in body_env.items():
        val = os.environ.get(envvar)
        if val is None:
            return None  # missing one of the needed env vars
        body[key] = val
    return ("json", body) if body_type == "json" else ("data", body)

def classify_health(sc: int, rtt: float):
    ok_2xx = 200 <= sc < 300
    if ok_2xx and rtt <= LATENCY_DEGRADED_S:
        return "Online", "INFO"
    elif sc < 500:  # reachable but auth/method/path/etc.
        return "Degraded", "WARN"
    else:
        return "Offline", "ERROR"

def check_one(item: dict) -> dict:
    name = item["label"]
    url  = BASE_URL + item["path"]
    method = item.get("method", "GET").upper()

    # -------- Health probe (always) --------
    t0 = time.perf_counter()
    try:
        resp = requests.request(method if method in ("GET","HEAD") else "GET",
                                url, timeout=TIMEOUT_S, allow_redirects=True)
        rtt = round(time.perf_counter() - t0, 3)
        health_status, health_level = classify_health(resp.status_code, rtt)
        history_rtt[name].append(rtt)
        history_ok[name].append(1 if (200 <= resp.status_code < 300) else 0)
        add_log(name, health_level, f"HEALTH {resp.status_code} in {rtt}s")
    except requests.RequestException as e:
        rtt = round(time.perf_counter() - t0, 3)
        history_rtt[name].append(rtt)
        history_ok[name].append(0)
        health_status, health_level = "Offline", "ERROR"
        add_log(name, health_level, f"{type(e).__name__}: {str(e)[:120]}")

    # -------- Activity probe (only for active=True) --------
    activity = "Idle"
    last_method = method
    activity_note = ""

    if item.get("active"):
        expect = set(item.get("expect", [200, 201, 204, 302, 303, 307, 308]))
        body_spec = build_body_from_env(item.get("body_env"), item.get("body_type","form"))

        if body_spec is None:
            # no creds → idle by design
            activity = "Idle"
            activity_note = "No credentials configured"
        else:
            arg_kind, body = body_spec
            try:
                t1 = time.perf_counter()
                resp2 = requests.request(
                    method, url, timeout=TIMEOUT_S, allow_redirects=True,
                    **{arg_kind: body}
                )
                last_method = method
                rtt2 = round(time.perf_counter() - t1, 3)
                sc2 = resp2.status_code

                if sc2 in expect:
                    activity = "Passing"  # green
                    add_log(name, "INFO", f"{method} auth OK {sc2} in {rtt2}s")
                else:
                    activity = "Failing"  # red
                    add_log(name, "ERROR", f"{method} auth FAIL {sc2} in {rtt2}s")

                # we still keep the health RTT series from the health probe
                activity_note = f"{method} → {sc2}"
            except requests.RequestException as e:
                activity = "Failing"
                activity_note = f"{type(e).__name__}"
                add_log(name, "ERROR", f"{method} exception: {str(e)[:120]}")

    avg = compute_average(name, history_rtt[name][-1])
    uptime = compute_uptime(name)

    return {
        "name": name,
        "icon": "📝",
        "category": item["category"],
        "status": health_status,              # Online/Degraded/Offline
        "response_time": history_rtt[name][-1],
        "average": avg,
        "uptime": uptime,
        "logs": logs_store[name][-6:],
        "history": list(history_rtt[name]),
        "activity": activity,                 # Idle/Passing/Failing
        "last_method": last_method,           # GET/POST/HEAD/...
        "activity_note": activity_note
    }

@app.route("/")
def home():
    print(f"[Monitor] Target base = {BASE_URL}", flush=True)
    return render_template("index.html")

@app.route("/api/target")
def show_target():
    return {"base_url": BASE_URL}

@app.route("/api/status")
def api_status():
    items = []
    with ThreadPoolExecutor(max_workers=min(8, len(ENDPOINTS))) as ex:
        futures = [ex.submit(check_one, it) for it in ENDPOINTS]
        for f in as_completed(futures):
            items.append(f.result())
    resp = make_response(jsonify(items))
    resp.headers["Cache-Control"] = "no-store"
    return resp

if __name__ == "__main__":
    print(f"[Monitor] Target base = {BASE_URL}", flush=True)
    app.run(debug=True)
