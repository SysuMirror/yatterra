# gunicorn config for yatterra (Flask-SocketIO + threading)
bind = "127.0.0.1:8090"
workers = 1           # SocketIO needs 1 worker (no sticky-session LB)
worker_class = "gthread"
threads = 4           # concurrent request handling
timeout = 120
keepalive = 5
preload_app = False  # metrics background thread must start in worker, not master
# max_requests = 0: worker 回收会杀掉所有 PTY 终端会话和内存中的 AI run
# (journal 里 "Autorestarting worker" 两次都伴随终端集体掉线)。
# 内存泄漏风险接受,靠日常发布重启自然回收。
max_requests = 0
