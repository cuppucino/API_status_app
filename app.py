from flask import Flask, render_template, jsonify
import random
from datetime import datetime

app = Flask(__name__)

# --- Seed data with categories ---
apis = [
    {"name": "User Service", "icon": "👤", "category": "System A"},
    {"name": "Payment Gateway", "icon": "💳", "category": "System B"},
    {"name": "Notification Service", "icon": "🔔", "category": "System C"},
    {"name": "Report Service", "icon": "📊", "category": "System A"},
    {"name": "Inventory API", "icon": "📦", "category": "System B"},
    {"name": "Auth Provider", "icon": "🛡️", "category": "System D"},
]

# In-memory rolling logs per API
logs_store = {a["name"]: [] for a in apis}

def _add_log(api_name, level, message):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = {"ts": now, "level": level, "message": message}
    logs_store[api_name].append(entry)
    # Keep last 30 logs
    if len(logs_store[api_name]) > 30:
        logs_store[api_name] = logs_store[api_name][-30:]

INFO_MSGS = [
    "Health check passed.",
    "Background sync completed.",
    "Cache warmed successfully.",
    "No anomalies detected."
]
WARN_MSGS = [
    "Latency above SLO threshold.",
    "Increased error rate observed.",
    "Retrying upstream dependency.",
]
ERR_MSGS = [
    "Database connection pool exhausted.",
    "Timeout contacting upstream.",
    "Auth token validation failed.",
    "Queue backlog growing."
]

def maybe_generate_log(name, status):
    r = random.random()
    if status == "Offline":
        level, msg = "ERROR", random.choice(ERR_MSGS)
    elif status == "Degraded":
        level, msg = ("WARN", random.choice(WARN_MSGS)) if r < 0.7 else ("ERROR", random.choice(ERR_MSGS))
    else:
        if r < 0.15:
            level, msg = "WARN", random.choice(WARN_MSGS)
        else:
            level, msg = "INFO", random.choice(INFO_MSGS)

    if status != "Online" or random.random() < 0.35:
        _add_log(name, level, msg)

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/api/status")
def api_status():
    data = []
    for api in apis:
        status = random.choice(["Online", "Offline", "Degraded"])
        response_time = round(random.uniform(0.1, 1.5), 2)
        uptime = round(random.uniform(98.5, 99.99), 2)

        # evolve logs with current status
        maybe_generate_log(api["name"], status)

        data.append({
            "name": api["name"],
            "icon": api["icon"],
            "category": api["category"],
            "status": status,
            "response_time": response_time,
            "average": round(response_time * random.uniform(0.5, 1.0), 2),
            "uptime": uptime,
            "logs": logs_store[api["name"]][-6:],   # last few for UI
        })
    return jsonify(data)

if __name__ == "__main__":
    app.run(debug=True)
