#!/usr/bin/env python3
"""ClickHouse shared database service (wraps the existing langfuse-clickhouse pod).

The langfuse-clickhouse pod is already deployed in platform-infra; this module
adds per-group credential management (CREATE USER + DATABASE) on top of it.

Pods reach:
  clickhouse : clickhouse.platform-infra.svc.cluster.local:8123  (HTTP API)
              clickhouse.platform-infra.svc.cluster.local:9000  (native TCP)

Root creds stored in /opt/yatterra/clickhouse.conf (root 600).
Per-group creds in /opt/yatterra/db_creds.json (same store as db_svc).
"""
import json
import os
import secrets
import subprocess
import time

import audit
import siteconf

NS = siteconf.INFRA_NS
CONF_FILE = siteconf.path("clickhouse.conf")
CREDS_FILE = siteconf.path("db_creds.json")  # shared with db_svc

POD_LABEL = "app=langfuse-clickhouse"
SERVICE_NAME = "langfuse-clickhouse"
SERVICE = "clickhouse"  # short name used in creds store

# The pod lives on the node that owns DATA_ROOT (hostPath). Pin it so a stray
# scheduling decision can't land on another node and serve an empty database.
INFRA_NODE = os.environ.get("YATTERRA_INFRA_NODE", "wz8")
CH_IMAGE = os.environ.get("YATTERRA_CLICKHOUSE_IMAGE", "clickhouse/clickhouse-server:26.4")
DATA_ROOT = siteconf.DB_DATA_ROOT
DATA_DIR = f"{DATA_ROOT}/langfuse-clickhouse"


def _kubectl(*args, check=False, timeout=30):
    cmd = ["kubectl", "-n", NS] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r


# --- root creds ---
def conf():
    """Read root creds: env vars first, then conf file."""
    c = {}
    if os.environ.get("CLICKHOUSE_PASSWORD"):
        c["password"] = os.environ["CLICKHOUSE_PASSWORD"]
    if os.environ.get("CLICKHOUSE_USER"):
        c["user"] = os.environ["CLICKHOUSE_USER"]
    try:
        with open(CONF_FILE) as f:
            fc = json.load(f)
        c.setdefault("password", fc.get("password"))
        c.setdefault("user", fc.get("user", "clickhouse"))
    except Exception:
        pass
    return c or None


def _ensure_conf():
    c = conf()
    if c and c.get("password"):
        c.setdefault("user", "clickhouse")
        return c
    # Try reading from the existing k8s secret
    try:
        r = _kubectl("get", "secret", "langfuse-secrets",
                      "-o", "jsonpath={.data.CLICKHOUSE_PASSWORD}")
        if r.returncode == 0 and r.stdout:
            import base64
            pw = base64.b64decode(r.stdout).decode()
            c = {"user": "clickhouse", "password": pw}
            with open(CONF_FILE, "w") as f:
                json.dump(c, f)
            try:
                os.chmod(CONF_FILE, 0o600)
            except OSError:
                pass
            return c
    except Exception:
        pass
    # Fallback: generate a new password (won't match existing, but lets API work)
    c = {"user": "clickhouse", "password": secrets.token_urlsafe(18)}
    with open(CONF_FILE, "w") as f:
        json.dump(c, f)
    try:
        os.chmod(CONF_FILE, 0o600)
    except OSError:
        pass
    return c


# --- ClickHouse query helper ---
def _ch_exec(sql, timeout=20):
    """Run SQL via clickhouse-client in the langfuse-clickhouse pod."""
    c = _ensure_conf()
    r = subprocess.run(
        ["kubectl", "-n", NS, "exec", "-i", "deploy/langfuse-clickhouse", "--",
         "clickhouse-client", "-u", c["user"], "--password", c["password"],
         "--format", "JSONEachRow"],
        input=sql, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"clickhouse exec failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def _ch_query(sql, timeout=20):
    """Run a query and return parsed JSON rows."""
    out = _ch_exec(sql, timeout=timeout)
    rows = []
    for line in out.strip().split("\n"):
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


# --- manifest (same hostPath + Secret + ClusterIP pattern as db_svc) ---
def manifest(creds):
    user = creds.get("user", "clickhouse")
    pw = creds["password"]
    return f"""apiVersion: v1
kind: Secret
metadata:
  name: langfuse-secrets
  namespace: {NS}
type: Opaque
stringData:
  CLICKHOUSE_USER: "{user}"
  CLICKHOUSE_PASSWORD: "{pw}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {SERVICE_NAME}
  namespace: {NS}
  labels:
    app: {SERVICE_NAME}
spec:
  replicas: 1
  strategy:
    type: Recreate          # hostPath data dir is single-writer
  selector:
    matchLabels:
      app: {SERVICE_NAME}
  template:
    metadata:
      labels:
        app: {SERVICE_NAME}
    spec:
      nodeSelector:
        kubernetes.io/hostname: {INFRA_NODE}
      containers:
      - name: clickhouse
        image: {CH_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - name: CLICKHOUSE_USER
          valueFrom:
            secretKeyRef:
              name: langfuse-secrets
              key: CLICKHOUSE_USER
        - name: CLICKHOUSE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: langfuse-secrets
              key: CLICKHOUSE_PASSWORD
        - name: CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT
          value: "1"
        ports:
        - containerPort: 8123
        - containerPort: 9000
        readinessProbe:
          httpGet:
            path: /ping
            port: 8123
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/clickhouse
      volumes:
      - name: data
        hostPath:
          path: {DATA_DIR}
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: {SERVICE_NAME}
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: {SERVICE_NAME}
  ports:
  - name: http
    port: 8123
    targetPort: 8123
  - name: native
    port: 9000
    targetPort: 9000
"""


def apply_manifest(creds):
    m = manifest(creds)
    r = subprocess.run(["kubectl", "apply", "-f", "-"],
                       input=m, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"apply clickhouse manifest: {r.stderr.strip()}")
    return r.stdout


# --- status ---
def status():
    """Return {deployed, phase, ready} for the existing langfuse-clickhouse."""
    r = _kubectl("get", "pod", "-l", POD_LABEL,
                  "-o", "jsonpath={.items[0].status.phase}")
    phase = r.stdout if r.returncode == 0 and r.stdout else ""
    if not phase:
        return {"deployed": False, "phase": "", "ready": False}
    r2 = _kubectl("get", "pod", "-l", POD_LABEL,
                   "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
    ready = phase == "Running" and r2.stdout == "true"
    return {"deployed": True, "phase": phase, "ready": ready}


def _wait_ready(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = status()
        if st["ready"]:
            return True
        time.sleep(3)
    return False


def ensure():
    """Idempotent: make sure a langfuse-clickhouse pod is running.

    If a pod labelled app=langfuse-clickhouse already exists (e.g. deployed by
    a real langfuse stack) we just wait for it. If it is absent we deploy one
    ourselves — same Secret + hostPath + ClusterIP pattern as db_svc — so the
    board recovers after the pod is deleted.
    """
    creds = _ensure_conf()
    applied = False
    if not status()["deployed"]:
        apply_manifest(creds)
        applied = True
    ready = _wait_ready(timeout=180 if applied else 60)
    audit.record("ch_ensure", detail=f"applied={applied} ready={ready}",
                 module="clickhouse_svc")
    if ready:
        return True, "ClickHouse 就绪"
    return False, ("已部署,仍在启动(可能还在拉镜像)" if applied else "ClickHouse pod 未就绪")


# --- creds store (shared with db_svc) ---
def _creds_load():
    try:
        with open(CREDS_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def _creds_save(creds):
    with open(CREDS_FILE, "w") as f:
        json.dump(creds, f, indent=2)
    try:
        os.chmod(CREDS_FILE, 0o600)
    except OSError:
        pass


def list_creds():
    return [c for c in _creds_load() if c.get("service") == SERVICE]


# --- issue / revoke per-group credentials ---
def _san(s):
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == "-")[:24] or "grp"


def add_cred(service, label):
    """Create a ClickHouse user + database for a group."""
    if service != SERVICE:
        raise ValueError("未知服务")
    _ensure_conf()
    kid = secrets.token_hex(4)
    base = _san(label) if label else "grp"
    uname = "u" + secrets.token_hex(5)
    dbname = "db_" + secrets.token_hex(4)
    pw = secrets.token_urlsafe(16)

    # ClickHouse syntax (different from MySQL — no @host, IDENTIFIED comes first)
    sql = (
        f"CREATE USER IF NOT EXISTS '{uname}' IDENTIFIED WITH plaintext_password BY '{pw}' HOST ANY; "
        f"CREATE DATABASE IF NOT EXISTS `{dbname}`; "
        f"GRANT ALL ON `{dbname}`.* TO '{uname}';"
    )
    _ch_exec(sql)

    rec = {"id": kid, "service": SERVICE, "label": label or base,
           "username": uname, "secret": pw, "database": dbname,
           "created": int(time.time())}
    creds = _creds_load()
    creds.append(rec)
    _creds_save(creds)
    return rec


def remove_cred(kid):
    """Drop a ClickHouse user + database."""
    creds = _creds_load()
    rec = next((c for c in creds if c["id"] == kid and c.get("service") == SERVICE), None)
    if not rec:
        raise ValueError("凭证不存在")
    try:
        _ch_exec(
            f"DROP DATABASE IF EXISTS `{rec['database']}`; "
            f"DROP USER IF EXISTS '{rec['username']}';"
        )
    except Exception:
        pass  # best-effort
    _creds_save([c for c in creds if c["id"] != kid])
