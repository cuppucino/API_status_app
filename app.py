from flask import Flask, render_template, jsonify, make_response
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import os, time, requests

app = Flask(__name__)

# -------- Config --------
BASE_URL = os.environ.get("TARGET_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
TIMEOUT_S = float(os.environ.get("HTTP_TIMEOUT_S", "5"))
LATENCY_SLA_S = float(os.environ.get("LATENCY_DEGRADED_S", "1.0"))

# -------- Endpoints --------
ENDPOINTS = [
    {"label": "DB-Connection", "path": "/test-db", "category": "HR Management System", "method": "GET"},
]

# -------- Rolling stores --------
history_rtt = defaultdict(lambda: deque(maxlen=60))    # response times
history_ts = defaultdict(lambda: deque(maxlen=60))     # timestamps
history_ok_flags = defaultdict(lambda: deque(maxlen=60))  # 1=ok,0=fail
history_ok = defaultdict(lambda: deque(maxlen=200))    # uptime window
history_status = defaultdict(lambda: deque(maxlen=60))
logs_store = defaultdict(list)


def add_log(name: str, level: str, message: str):
    entry = {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "level": level,
        "message": message,
    }
    logs_store[name].append(entry)
    if len(logs_store[name]) > 60:
        logs_store[name] = logs_store[name][-60:]


def compute_average(name: str, fallback: float) -> float:
    series = history_rtt[name]
    return round(sum(series) / len(series), 3) if series else round(fallback, 3)


def compute_uptime(name: str) -> float:
    series = history_ok[name]
    return round(100.0 * sum(series) / len(series), 2) if series else 0.0


def classify_health(sc: int):
    if 200 <= sc < 400:
        return "Online", "INFO"
    return "Offline", "ERROR"


def check_one(item: dict) -> dict:
    name = item["label"]
    url = BASE_URL + item["path"]
    method = item.get("method", "GET").upper()

    t0 = time.perf_counter()
    now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        resp = requests.request(
            method,
            url,
            timeout=TIMEOUT_S,
            allow_redirects=False,
        )
        rtt = round(time.perf_counter() - t0, 3)
        status_code = resp.status_code
        health_status, health_level = classify_health(status_code)

        ok_flag = 1 if 200 <= status_code < 400 else 0
        history_rtt[name].append(rtt)
        history_ts[name].append(now_ts)
        history_ok_flags[name].append(ok_flag)
        history_ok[name].append(ok_flag)
        history_status[name].append(status_code)

        add_log(name, health_level, f"HEALTH {status_code} in {rtt}s")
    except requests.RequestException as e:
        rtt = round(time.perf_counter() - t0, 3)
        history_rtt[name].append(rtt)
        history_ts[name].append(now_ts)
        history_ok_flags[name].append(0)
        history_ok[name].append(0)
        history_status[name].append(0)  # 0 = no response / error

        health_status, health_level = "Offline", "ERROR"
        add_log(name, health_level, f"{type(e).__name__}: {str(e)[:120]}")

    avg = compute_average(name, history_rtt[name][-1])
    uptime = compute_uptime(name)

    logs = logs_store[name][-30:]
    last_checked = logs[-1]["ts"] if logs else ""

    return {
        "name": name,
        "icon": "📝",
        "category": item["category"],
        "status": health_status,
        "response_time": rtt,
        "average": avg,
        "uptime": uptime,
        "logs": logs,
        "history": list(history_rtt[name]),
        "history_ts": list(history_ts[name]),
        "history_ok": list(history_ok_flags[name]),
        "history_status": list(history_status[name]),
        "last_method": method,
        "last_checked": last_checked,
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
