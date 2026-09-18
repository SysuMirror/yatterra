#!/usr/bin/env python3
"""MinIO in-cluster S3 (namespace platform-infra).

Pods access the API at http://minio.platform-infra.svc.cluster.local:9000.
Console exposed via NodePort 30091 -> frpc -> public 24001 (needs security group).
Root creds in /opt/yatterra/minio.conf (root 600). Bucket/key management
is done in the MinIO console; the platform only deploys + wires access + shows info.
"""
import json
import os
import secrets
import subprocess
import time

import audit

import siteconf

NS = siteconf.INFRA_NS
IMAGE = "minio/minio:latest"
CONF_FILE = siteconf.path("minio.conf")
DATA_HOSTPATH = siteconf.MINIO_DATA_ROOT
CONSOLE_NODEPORT = 30091
CONSOLE_PUBLIC = 24001
API_PORT = 9000
CONSOLE_PORT = 9001


def _kubectl(*args, check=False):
    cmd = ["kubectl", "-n", NS] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r


# --- creds (prefer env vars, fallback to minio.conf) ---
def conf():
    c = {}
    if os.environ.get("MINIO_ACCESS_KEY"):
        c["access_key"] = os.environ["MINIO_ACCESS_KEY"]
    if os.environ.get("MINIO_SECRET"):
        c["secret"] = os.environ["MINIO_SECRET"]
    try:
        with open(CONF_FILE) as f:
            fc = json.load(f)
        c.setdefault("access_key", fc.get("access_key"))
        c.setdefault("secret", fc.get("secret"))
    except Exception:
        pass
    return c or None


def _ensure_conf():
    c = conf()
    if c and c.get("access_key") and c.get("secret"):
        return c
    c = {
        "access_key": "admin-" + secrets.token_hex(6),
        "secret": secrets.token_hex(16),
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
    ak, sk = creds["access_key"], creds["secret"]
    return f"""apiVersion: v1
kind: Namespace
metadata:
  name: {NS}
---
apiVersion: v1
kind: Secret
metadata:
  name: minio-creds
  namespace: {NS}
type: Opaque
stringData:
  MINIO_ROOT_USER: "{ak}"
  MINIO_ROOT_PASSWORD: "{sk}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: {NS}
  labels:
    app: minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
      - name: minio
        image: {IMAGE}
        imagePullPolicy: IfNotPresent
        command: ["minio", "server", "/data"]
        env:
        - name: MINIO_ROOT_USER
          valueFrom:
            secretKeyRef:
              name: minio-creds
              key: MINIO_ROOT_USER
        - name: MINIO_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: minio-creds
              key: MINIO_ROOT_PASSWORD
        ports:
        - containerPort: {API_PORT}
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        hostPath:
          path: {DATA_HOSTPATH}
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: minio
  ports:
  - name: api
    port: {API_PORT}
    targetPort: {API_PORT}
"""


def apply_manifest(creds):
    m = manifest(creds)
    r = subprocess.run(["kubectl", "apply", "-f", "-"],
                       input=m, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"apply minio manifest: {r.stderr.strip()}")
    return r.stdout


def _wait_ready(timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = _kubectl("get", "pod", "-l", "app=minio",
                     "-o", "jsonpath={.items[0].status.phase}")
        if r.stdout == "Running":
            return True
        time.sleep(2)
    return False


def ensure():
    """Idempotent: gen creds -> apply -> wait ready -> rewrite frpc. Returns (ok, msg)."""
    creds = _ensure_conf()
    apply_manifest(creds)
    ready = _wait_ready()
    # wire frpc public console
    try:
        import groups
        groups.rewrite_frpc(groups.load_state())
        groups.reload_frpc()
    except Exception as e:
        return ready, f"已 apply 但 frpc 重载失败: {e}"
    audit.record("minio_ensure", detail=f"ready={ready}", module="minio_svc")
    return ready, "已部署" if ready else "已 apply 但 pod 未就绪(可能仍在拉镜像)"


def status():
    """Return {deployed, phase, ready}."""
    r = _kubectl("get", "pod", "-l", "app=minio",
                 "-o", "jsonpath={.items[0].status.phase}")
    phase = r.stdout if r.returncode == 0 and r.stdout else ""
    if not phase:
        return {"deployed": False, "phase": "", "ready": False}
    return {"deployed": True, "phase": phase, "ready": phase == "Running"}


def cluster_ip():
    r = _kubectl("get", "service", "minio",
                 "-o", "jsonpath={.spec.clusterIP}")
    return r.stdout if r.returncode == 0 else ""


# --- bucket management (via minio SDK; platform IS the console) ---
def _client():
    c = conf()
    ip = cluster_ip()
    if not c or not ip:
        return None
    from minio import Minio
    return Minio(f"{ip}:{API_PORT}", access_key=c["access_key"],
                 secret_key=c["secret"], secure=False)


def buckets():
    """Return list of bucket names, or None if not deployed."""
    c = _client()
    if not c:
        return None
    try:
        return sorted(b.name for b in c.list_buckets())
    except Exception as e:
        raise RuntimeError(f"列桶失败: {e}")


def make_bucket(name):
    c = _client()
    if not c:
        raise RuntimeError("MinIO 未部署")
    from minio.error import S3Error
    try:
        c.make_bucket(name)
    except S3Error as e:
        raise RuntimeError(f"建桶失败: {e}")


def remove_bucket(name, force=False):
    c = _client()
    if not c:
        raise RuntimeError("MinIO 未部署")
    objs = list(c.list_objects(name))
    if objs and not force:
        raise ValueError(f"桶非空({len(objs)} 个对象),先清空或勾选强制删除")
    for o in objs:
        c.remove_object(name, o.object_name)
    c.remove_bucket(name)


# --- access keys + bucket-scoped policies (via mc admin) ---
KEYS_FILE = siteconf.path("minio_keys.json")
import tempfile


def _keys_load():
    try:
        with open(KEYS_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def _keys_save(keys):
    with open(KEYS_FILE, "w") as f:
        json.dump(keys, f, indent=2)
    try:
        os.chmod(KEYS_FILE, 0o600)
    except OSError:
        pass


def _ensure_alias():
    c = conf()
    ip = cluster_ip()
    if not c or not ip:
        raise RuntimeError("MinIO 未部署")
    r = subprocess.run(
        ["mc", "alias", "set", "plat", f"http://{ip}:{API_PORT}",
         c["access_key"], c["secret"]],
        capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(f"mc alias set 失败: {r.stderr.strip()}")


def _mc(*args):
    _ensure_alias()
    return subprocess.run(["mc"] + list(args), capture_output=True, text=True, timeout=30)


def _policy_json(bucket, perm):
    obj_actions = []
    if perm in ("readwrite", "readonly"):
        obj_actions.append("s3:GetObject")
    if perm in ("readwrite", "writeonly"):
        obj_actions += ["s3:PutObject", "s3:DeleteObject"]
    stmt = [{"Effect": "Allow",
             "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
             "Resource": [f"arn:aws:s3:::{bucket}"]}]
    if obj_actions:
        stmt.append({"Effect": "Allow", "Action": obj_actions,
                     "Resource": [f"arn:aws:s3:::{bucket}/*"]})
    return json.dumps({"Version": "2012-10-17", "Statement": stmt})


def list_keys():
    return _keys_load()


def add_key(label, bucket, perm):
    if perm not in ("readwrite", "readonly", "writeonly"):
        raise ValueError("权限非法")
    if not bucket:
        raise ValueError("要选桶")
    kid = secrets.token_hex(4)
    ak = "key-" + secrets.token_hex(6)      # 16 chars, within 3-20
    sk = secrets.token_hex(16)              # 32 chars, within 8-40
    pol = f"pol-{kid}"
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write(_policy_json(bucket, perm))
        polfile = f.name
    try:
        r = _mc("admin", "policy", "create", "plat", pol, polfile)
        if r.returncode != 0 and "already exist" not in (r.stderr + r.stdout).lower():
            raise RuntimeError(f"建策略失败: {(r.stderr or r.stdout).strip()}")
        r = _mc("admin", "user", "add", "plat", ak, sk)
        if r.returncode != 0:
            raise RuntimeError(f"建用户失败: {(r.stderr or r.stdout).strip()}")
        r = _mc("admin", "policy", "attach", "plat", pol, "--user", ak)
        if r.returncode != 0:
            raise RuntimeError(f"挂策略失败: {(r.stderr or r.stdout).strip()}")
    finally:
        try:
            os.unlink(polfile)
        except OSError:
            pass
    rec = {"id": kid, "label": label or ak, "access_key": ak, "secret": sk,
           "bucket": bucket, "perm": perm, "created": int(time.time())}
    keys = _keys_load()
    keys.append(rec)
    _keys_save(keys)
    return rec


def remove_key(kid):
    keys = _keys_load()
    rec = next((k for k in keys if k["id"] == kid), None)
    if not rec:
        raise ValueError("密钥不存在")
    _mc("admin", "user", "remove", "plat", rec["access_key"])   # best-effort
    _mc("admin", "policy", "remove", "plat", f"pol-{kid}")      # best-effort
    _keys_save([k for k in keys if k["id"] != kid])

