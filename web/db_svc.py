#!/usr/bin/env python3
"""Shared database service: MySQL + Redis + Qdrant (namespace platform-infra).

One instance of each, shared across groups. Per-group credentials:
  - mysql : a dedicated database + user (password) scoped to that db only.  (real isolation)
  - redis : an ACL user (password) restricted to a key prefix `<prefix>:*`.   (real isolation)
  - qdrant: the shared api key + a collection-name prefix convention.          (convention only)

Pods reach:
  mysql  : mysql.platform-infra.svc.cluster.local:3306
  redis  : redis.platform-infra.svc.cluster.local:6379
  qdrant : http://qdrant.platform-infra.svc.cluster.local:6333  (gRPC :6334)

Root creds in /opt/yatterra/db.conf (root 600). Issued per-group creds
in /opt/yatterra/db_creds.json (root 600).
"""
import json
import os
import secrets
import subprocess
import time

import audit

import siteconf

NS = siteconf.INFRA_NS
CONF_FILE = siteconf.path("db.conf")
CREDS_FILE = siteconf.path("db_creds.json")

DATA_ROOT = siteconf.DB_DATA_ROOT
MYSQL_IMAGE = "mysql:8.0"
REDIS_IMAGE = "redis:7-alpine"
QDRANT_IMAGE = "qdrant/qdrant:latest"

SERVICES = ("mysql", "redis", "qdrant")


def _kubectl(*args, check=False, timeout=60):
    cmd = ["kubectl", "-n", NS] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r


# --- root creds (prefer env vars, fallback to db.conf) ---
def conf():
    c = {}
    if os.environ.get("MYSQL_ROOT_PASSWORD"):
        c["mysql_root_password"] = os.environ["MYSQL_ROOT_PASSWORD"]
    if os.environ.get("REDIS_PASSWORD"):
        c["redis_password"] = os.environ["REDIS_PASSWORD"]
    if os.environ.get("QDRANT_API_KEY"):
        c["qdrant_api_key"] = os.environ["QDRANT_API_KEY"]
    # fill gaps from file
    try:
        with open(CONF_FILE) as f:
            fc = json.load(f)
        for k in ("mysql_root_password", "redis_password", "qdrant_api_key"):
            c.setdefault(k, fc.get(k))
    except Exception:
        pass
    return c or None


def _ensure_conf():
    c = conf()
    if c and c.get("mysql_root_password") and c.get("redis_password") and c.get("qdrant_api_key"):
        return c
    c = {
        "mysql_root_password": secrets.token_urlsafe(18),
        "redis_password": secrets.token_urlsafe(18),
        "qdrant_api_key": secrets.token_urlsafe(24),
    }
    with open(CONF_FILE, "w") as f:
        json.dump(c, f)
    try:
        os.chmod(CONF_FILE, 0o600)
    except OSError:
        pass
    return c


# --- manifest ---
def manifest(creds):
    mrp = creds["mysql_root_password"]
    rp = creds["redis_password"]
    qk = creds["qdrant_api_key"]
    return f"""apiVersion: v1
kind: Namespace
metadata:
  name: {NS}
---
apiVersion: v1
kind: Secret
metadata:
  name: db-creds
  namespace: {NS}
type: Opaque
stringData:
  MYSQL_ROOT_PASSWORD: "{mrp}"
  REDIS_PASSWORD: "{rp}"
  QDRANT_API_KEY: "{qk}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: {NS}
  labels:
    app: mysql
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
      - name: mysql
        image: {MYSQL_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-creds
              key: MYSQL_ROOT_PASSWORD
        ports:
        - containerPort: 3306
        readinessProbe:
          exec:
            command: ["sh", "-c", "mysqladmin ping -h 127.0.0.1 -uroot -p$MYSQL_ROOT_PASSWORD --silent"]
          initialDelaySeconds: 20
          periodSeconds: 10
          timeoutSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
      volumes:
      - name: data
        hostPath:
          path: {DATA_ROOT}/mysql
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: mysql
  ports:
  - port: 3306
    targetPort: 3306
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: {NS}
  labels:
    app: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: {REDIS_IMAGE}
        imagePullPolicy: IfNotPresent
        command: ["redis-server", "--aclfile", "/data/users.acl"]
        env:
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-creds
              key: REDIS_PASSWORD
        ports:
        - containerPort: 6379
        readinessProbe:
          exec:
            command: ["sh", "-c", "redis-cli -a $REDIS_PASSWORD ping | grep -q PONG"]
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 4
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        hostPath:
          path: {DATA_ROOT}/redis
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qdrant
  namespace: {NS}
  labels:
    app: qdrant
spec:
  replicas: 1
  selector:
    matchLabels:
      app: qdrant
  template:
    metadata:
      labels:
        app: qdrant
    spec:
      containers:
      - name: qdrant
        image: {QDRANT_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - name: QDRANT__SERVICE__API_KEY
          valueFrom:
            secretKeyRef:
              name: db-creds
              key: QDRANT_API_KEY
        ports:
        - containerPort: 6333
        - containerPort: 6334
        readinessProbe:
          httpGet:
            path: /healthz
            port: 6333
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 4
        volumeMounts:
        - name: data
          mountPath: /qdrant/storage
      volumes:
      - name: data
        hostPath:
          path: {DATA_ROOT}/qdrant
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: qdrant
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: qdrant
  ports:
  - name: rest
    port: 6333
    targetPort: 6333
  - name: grpc
    port: 6334
    targetPort: 6334
"""


def apply_manifest(creds):
    m = manifest(creds)
    r = subprocess.run(["kubectl", "apply", "-f", "-"],
                       input=m, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"apply db manifest: {r.stderr.strip()}")
    return r.stdout


def _pod_phase(app):
    r = _kubectl("get", "pod", "-l", f"app={app}",
                 "-o", "jsonpath={.items[0].status.phase}")
    return r.stdout if r.returncode == 0 and r.stdout else ""


def _wait_ready(app, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _pod_phase(app) == "Running":
            # also check Ready condition
            r = _kubectl("get", "pod", "-l", f"app={app}",
                         "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
            if r.stdout == "true":
                return True
        time.sleep(3)
    return False


def ensure():
    """Idempotent deploy of all three. Returns (ok, msg)."""
    creds = _ensure_conf()
    # pre-write the redis ACL file (default user + stored per-group users) so the
    # readiness probe (which authenticates) works from first boot.
    try:
        _redis_write_aclfile()
    except Exception as e:
        audit.record("db_ensure", detail=f"redis_aclfile_write_failed: {e}", module="db_svc")
    apply_manifest(creds)
    results = {}
    for app in SERVICES:
        results[app] = _wait_ready(app)
    ok = all(results.values())
    audit.record("db_ensure", detail=str(results), module="db_svc")
    return ok, "已部署" if ok else "已 apply 但部分 pod 未就绪(可能仍在拉镜像)"


def status():
    """Per-service {deployed, phase, ready}."""
    out = {}
    for app in SERVICES:
        phase = _pod_phase(app)
        if not phase:
            out[app] = {"deployed": False, "phase": "", "ready": False}
            continue
        r = _kubectl("get", "pod", "-l", f"app={app}",
                     "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
        ready = phase == "Running" and r.stdout == "true"
        out[app] = {"deployed": True, "phase": phase, "ready": ready}
    return out


# --- creds store ---
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
    return _creds_load()


# --- mysql helpers ---
def _mysql_exec(sql, timeout=30):
    """Run a SQL statement via the mysql CLI in the mysql pod (root, password from env)."""
    # sql goes to stdin; root password is read from the pod's env, not argv
    r = subprocess.run(
        ["kubectl", "-n", NS, "exec", "-i", "deploy/mysql", "--",
         "sh", "-c", "mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\""],
        input=sql, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"mysql exec failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


# --- redis helpers ---
def _redis_exec(*args, timeout=20):
    c = _ensure_conf()
    cmd = ["kubectl", "-n", NS, "exec", "-i", "deploy/redis", "--",
           "redis-cli", "-a", c["redis_password"]] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"redis exec failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def _redis_write_aclfile():
    """Declaratively write <DATA_ROOT>/redis/users.acl with default user + all
    stored redis per-group users. Redis loads this at start; we ACL LOAD it live."""
    c = _ensure_conf()
    os.makedirs(f"{DATA_ROOT}/redis", exist_ok=True)
    lines = [f"user default on >{c['redis_password']} ~* +@all"]
    for cr in _creds_load():
        if cr.get("service") == "redis":
            lines.append(
                f"user {cr['username']} on >{cr['secret']} resetkeys ~{cr['prefix']}:* +@all"
            )
    path = f"{DATA_ROOT}/redis/users.acl"
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o644)
    except OSError:
        pass


def _redis_reload():
    """Tell a running redis to reload the aclfile (best-effort)."""
    try:
        _redis_exec("ACL", "LOAD")
    except Exception:
        pass


# --- issue / revoke per-group credentials ---
def _san(s):
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == "-")[:24] or "grp"


def add_cred(service, label):
    if service not in SERVICES:
        raise ValueError("未知服务")
    c = _ensure_conf()
    kid = secrets.token_hex(4)
    base = _san(label) if label else "grp"
    rec = {"id": kid, "service": service, "label": label or base, "created": int(time.time())}

    if service == "mysql":
        uname = "u" + secrets.token_hex(5)
        dbname = "db_" + secrets.token_hex(4)
        pw = secrets.token_urlsafe(16)
        sql = (
            f"CREATE DATABASE IF NOT EXISTS `{dbname}`; "
            f"CREATE USER IF NOT EXISTS '{uname}'@'%'; "
            f"ALTER USER '{uname}'@'%' IDENTIFIED BY '{pw}'; "
            f"GRANT ALL PRIVILEGES ON `{dbname}`.* TO '{uname}'@'%'; "
            f"FLUSH PRIVILEGES;"
        )
        _mysql_exec(sql)
        rec.update({"username": uname, "secret": pw, "database": dbname})

    elif service == "redis":
        uname = "u" + secrets.token_hex(5)
        pw = secrets.token_urlsafe(16)
        prefix = "g" + secrets.token_hex(4)
        rec.update({"username": uname, "secret": pw, "prefix": prefix})
        creds = _creds_load()
        creds.append(rec)
        _creds_save(creds)
        _redis_write_aclfile()
        _redis_reload()
        return rec

    elif service == "qdrant":
        prefix = "g" + secrets.token_hex(4)
        rec.update({"secret": c["qdrant_api_key"], "prefix": prefix})

    creds = _creds_load()
    creds.append(rec)
    _creds_save(creds)
    return rec


def remove_cred(kid):
    creds = _creds_load()
    rec = next((x for x in creds if x["id"] == kid), None)
    if not rec:
        raise ValueError("凭证不存在")
    svc = rec["service"]
    if svc == "mysql":
        try:
            _mysql_exec(
                f"DROP USER IF EXISTS '{rec['username']}'@'%'; "
                f"DROP DATABASE IF EXISTS `{rec['database']}`; FLUSH PRIVILEGES;"
            )
        except Exception:
            pass  # best-effort
    elif svc == "redis":
        _creds_save([x for x in creds if x["id"] != kid])
        try:
            _redis_write_aclfile()
            _redis_reload()
        except Exception:
            pass
        return
    _creds_save([x for x in creds if x["id"] != kid])
