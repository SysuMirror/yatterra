#!/usr/bin/env python3
"""Kafka shared messaging service (KRaft mode, no ZooKeeper, namespace platform-infra).

Deploys a single-node Kafka broker+controller using the apache/kafka image.
Pods reach the broker at kafka.platform-infra.svc.cluster.local:9092 (PLAINTEXT,
ClusterIP-only — same network isolation model as the other db services).

Per-group isolation is convention-based (like Qdrant): each issued credential
carries a topic prefix; the group's topics must be named `<prefix>_...`.

Creds in /opt/yatterra/kafka_creds.json (root 600).
"""
import json
import os
import secrets
import subprocess
import time

import audit
import siteconf

NS = siteconf.INFRA_NS
IMAGE = "apache/kafka:latest"
CREDS_FILE = siteconf.path("kafka_creds.json")
DATA_ROOT = siteconf.DB_DATA_ROOT
KAFKA_PORT = 9092
KAFKA_SERVICE_NAME = "kafka"
BIN = "/opt/kafka/bin"


def _kubectl(*args, check=False, timeout=30):
    cmd = ["kubectl", "-n", NS] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r


# --- manifest ---
def manifest():
    return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: {KAFKA_SERVICE_NAME}
  namespace: {NS}
  labels:
    app: {KAFKA_SERVICE_NAME}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {KAFKA_SERVICE_NAME}
  template:
    metadata:
      labels:
        app: {KAFKA_SERVICE_NAME}
    spec:
      containers:
      - name: kafka
        image: {IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - name: KAFKA_NODE_ID
          value: "1"
        - name: KAFKA_PROCESS_ROLES
          value: "broker,controller"
        - name: KAFKA_CONTROLLER_QUORUM_VOTERS
          value: "1@127.0.0.1:9093"
        - name: KAFKA_LISTENERS
          value: "PLAINTEXT://:9092,CONTROLLER://:9093"
        - name: KAFKA_ADVERTISED_LISTENERS
          value: "PLAINTEXT://{KAFKA_SERVICE_NAME}.{NS}.svc.cluster.local:9092"
        - name: KAFKA_CONTROLLER_LISTENER_NAMES
          value: "CONTROLLER"
        - name: KAFKA_INTER_BROKER_LISTENER_NAME
          value: "PLAINTEXT"
        - name: KAFKA_LISTENER_SECURITY_PROTOCOL_MAP
          value: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT"
        - name: KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR
          value: "1"
        - name: KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR
          value: "1"
        - name: KAFKA_TRANSACTION_STATE_LOG_MIN_ISR
          value: "1"
        - name: KAFKA_LOG_DIRS
          value: "/var/lib/kafka/data"
        - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
          value: "true"
        ports:
        - containerPort: {KAFKA_PORT}
        readinessProbe:
          exec:
            command:
            - sh
            - -c
            - "{BIN}/kafka-broker-api-versions.sh --bootstrap-server localhost:{KAFKA_PORT} >/dev/null 2>&1"
          initialDelaySeconds: 20
          periodSeconds: 10
          timeoutSeconds: 8
        resources:
          limits:
            memory: "2Gi"
          requests:
            memory: "1Gi"
        volumeMounts:
        - name: data
          mountPath: /var/lib/kafka/data
      volumes:
      - name: data
        hostPath:
          path: {DATA_ROOT}/kafka
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: {KAFKA_SERVICE_NAME}
  namespace: {NS}
spec:
  type: ClusterIP
  selector:
    app: {KAFKA_SERVICE_NAME}
  ports:
  - name: kafka
    port: {KAFKA_PORT}
    targetPort: {KAFKA_PORT}
"""


def apply_manifest():
    m = manifest()
    r = subprocess.run(["kubectl", "apply", "-f", "-"],
                       input=m, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"apply kafka manifest: {r.stderr.strip()}")
    return r.stdout


def _wait_ready(timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = _kubectl("get", "pod", "-l", f"app={KAFKA_SERVICE_NAME}",
                     "-o", "jsonpath={.items[0].status.phase}")
        if r.stdout == "Running":
            r2 = _kubectl("get", "pod", "-l", f"app={KAFKA_SERVICE_NAME}",
                          "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
            if r2.stdout == "true":
                return True
        time.sleep(3)
    return False


def ensure():
    """Idempotent: apply -> wait ready. Returns (ok, msg)."""
    apply_manifest()
    ready = _wait_ready()
    audit.record("kafka_ensure", detail=f"ready={ready}", module="kafka_svc")
    return ready, "已部署" if ready else "已 apply 但 pod 未就绪"


def status():
    """Return {deployed, phase, ready, service}."""
    svc = f"{KAFKA_SERVICE_NAME}.{NS}.svc.cluster.local"
    r = _kubectl("get", "pod", "-l", f"app={KAFKA_SERVICE_NAME}",
                 "-o", "jsonpath={.items[0].status.phase}")
    phase = r.stdout if r.returncode == 0 and r.stdout else ""
    if not phase:
        return {"deployed": False, "phase": "", "ready": False, "service": svc}
    r2 = _kubectl("get", "pod", "-l", f"app={KAFKA_SERVICE_NAME}",
                  "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}")
    ready = phase == "Running" and r2.stdout == "true"
    return {"deployed": True, "phase": phase, "ready": ready, "service": svc}


# --- creds store (convention-based topic prefixes, like qdrant) ---
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


def _san(s):
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == "-")[:24] or "grp"


def add_cred(service, label):
    """Issue a topic-prefix credential for a group (convention-based isolation)."""
    if service != "kafka":
        raise ValueError("未知服务: 仅支持 kafka")
    kid = secrets.token_hex(4)
    base = _san(label) if label else "grp"
    prefix = "g" + secrets.token_hex(4)
    rec = {"id": kid, "service": "kafka", "label": label or base,
           "prefix": prefix, "created": int(time.time())}
    creds = _creds_load()
    creds.append(rec)
    _creds_save(creds)
    return rec


def remove_cred(kid):
    """Remove a topic-prefix credential."""
    creds = _creds_load()
    rec = next((c for c in creds if c["id"] == kid and c.get("service") == "kafka"), None)
    if not rec:
        raise ValueError("凭证不存在")
    _creds_save([c for c in creds if c["id"] != kid])


# --- topic helpers (admin/CLI use) ---
def _kafka_exec(*args, timeout=30):
    cmd = ["kubectl", "-n", NS, "exec", "deploy/kafka", "--"] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"kafka exec: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def create_topic(name, partitions=1, replication=1):
    return _kafka_exec(
        f"{BIN}/kafka-topics.sh",
        "--bootstrap-server", f"localhost:{KAFKA_PORT}",
        "--create", "--topic", name,
        "--partitions", str(partitions),
        "--replication-factor", str(replication),
    )


def list_topics():
    out = _kafka_exec(
        f"{BIN}/kafka-topics.sh",
        "--bootstrap-server", f"localhost:{KAFKA_PORT}",
        "--list",
    )
    return [t.strip() for t in out.strip().split("\n") if t.strip()]
