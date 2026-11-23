# gunicorn config for yatterra (Flask-SocketIO + threading)
bind = "127.0.0.1:8090"
workers = 1           # SocketIO needs 1 worker (no sticky-session LB)
worker_class = "gthread"
threads = 32           # concurrent request handling
# 4 线程时: 上游 LLM(api.ssemarket.cn) 慢/超时会一次占满所有请求线程(read timeout
# 90s x 重试), 于是连 / 和 push-to-deploy 的 webhook(GitHub 只等 10s) 一起被饿死。
# 单 worker 下把线程加到 8 留出余量 —— LLM 调用是 IO-bound, 不会互相拖慢。
timeout = 120
keepalive = 5
preload_app = False  # metrics background thread must start in worker, not master
# max_requests = 0: worker 回收会杀掉所有 PTY 终端会话和内存中的 AI run
# (journal 里 "Autorestarting worker" 两次都伴随终端集体掉线)。
# 内存泄漏风险接受,靠日常发布重启自然回收。
max_requests = 0
