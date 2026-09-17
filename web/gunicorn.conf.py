# gunicorn config for yatterra (Flask-SocketIO + threading)
bind = "127.0.0.1:8090"
workers = 1           # SocketIO needs 1 worker (no sticky-session LB)
worker_class = "gthread"
threads = 4           # concurrent request handling
timeout = 120
keepalive = 5
preload_app = False  # metrics background thread must start in worker, not master
max_requests = 5000   # recycle worker to prevent memory leaks
max_requests_jitter = 500
