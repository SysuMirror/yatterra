#!/usr/bin/env python3
"""Browser-facing fallback page for a Pod's public Web entry.

When a Pod's web service is not answering, the relay nginx routes its public
``23xxx`` server block *here* instead of returning a bare ``502 Bad Gateway``
(see ``groups._web_ssl_block``).  The page mirrors the SPA 404 look, and when
the Pod was frozen because its own quota ran out — ``billing_accounts.status``
suspended/closed — it says so: 「资源已冻结」.

Public and read-only: no session, no auth, no writes.  Reading the Pod's billing
status is best-effort — any failure falls back to the generic "service not
started" copy, never to an error.
"""
import html


def _esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def _frozen(group):
    """True when the Pod is stopped because its billing account is blocked.

    ``billing_store.is_blocked`` already requires a *billable* account whose
    status is suspended/closed, so transient dips never read as frozen.
    """
    if not group:
        return False
    try:
        import billing_store
        return bool(billing_store.is_blocked(group))
    except Exception:
        return False


def _platform_base():
    try:
        import siteconf
        return (getattr(siteconf, "PLATFORM_URL", "") or "").rstrip("/")
    except Exception:
        return ""


_STYLE = """
:root{
  --bg:#0b0e14; --card:#11151e; --line:rgba(255,255,255,.08);
  --fg:#e6edf3; --mut:#8b96a5; --accent:#5c8bff; --warn:#f5a524;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; background:
    radial-gradient(1000px 500px at 50% -10%, rgba(92,139,255,.10), transparent 60%),
    var(--bg);
  color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",
       "PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;
  display:flex; align-items:center; justify-content:center; padding:24px;
}
.card{
  width:100%; max-width:440px; background:var(--card); border:1px solid var(--line);
  border-radius:16px; padding:32px 28px; text-align:center;
  box-shadow:0 24px 60px rgba(0,0,0,.45);
}
.brand{font-size:12px; letter-spacing:.22em; text-transform:uppercase; color:var(--mut); margin-bottom:14px}
.code{font-size:60px; font-weight:700; line-height:1; color:rgba(139,150,165,.28); margin:2px 0 10px}
.badge{
  display:inline-flex; align-items:center; gap:6px; margin-bottom:10px;
  padding:4px 12px; border-radius:999px; font-size:12.5px; font-weight:600;
  color:#1a1204; background:var(--warn);
}
h1{font-size:19px; font-weight:650; margin:0 0 8px}
.desc{margin:0 0 6px; color:var(--fg)}
.pod{margin:2px 0 8px; color:var(--mut); font-size:13px}
.pod code{background:rgba(127,127,127,.14); padding:1px 6px; border-radius:6px; color:var(--fg)}
.hint{margin:6px 0 20px; color:var(--mut); font-size:13px}
.actions{display:flex; gap:10px; justify-content:center; flex-wrap:wrap}
.btn{
  display:inline-block; padding:9px 18px; border-radius:10px; text-decoration:none;
  font-size:14px; font-weight:550; border:1px solid var(--line); color:var(--fg);
  background:rgba(255,255,255,.04); transition:background .15s,border-color .15s;
}
.btn:hover{background:rgba(255,255,255,.08)}
.btn.primary{background:var(--accent); border-color:var(--accent); color:#fff}
.btn.primary:hover{background:#4a7bf0}
.foot{margin-top:22px; color:var(--mut); font-size:11.5px}
"""


def render(group=""):
    """Return the full HTML page for a Pod whose web entry is unavailable."""
    group = (group or "").strip()
    frozen = _frozen(group)
    base = _platform_base()
    billing_url = f"{base}/billing" if base else ""
    home_url = base or "/"

    if frozen:
        badge = '<div class="badge">⚠ 资源已冻结</div>'
        title = "该资源已冻结"
        desc = "此 Pod 因额度耗尽（欠费）已停机，Web 服务暂不可用。"
        hint = "请先充值并把额度分配给该 Pod，再在控制台重新启动它，即可恢复访问。"
        extra = (f'<a class="btn primary" href="{_esc(billing_url)}">去充值 / 分配额度</a>'
                 if billing_url else "")
    else:
        badge = ""
        title = "页面未找到"
        desc = "该 Pod 的 Web 服务未启动或已停止。"
        hint = "请确认 Pod 正在运行，且已在 8080 端口启动了 Web 服务。"
        extra = ""

    pod_line = (f'<p class="pod">Pod：<code>{_esc(group)}</code></p>' if group else "")
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{_esc(title)} · YatTerra</title>
<style>{_STYLE}</style>
</head>
<body>
<main class="card">
  <div class="brand">YatTerra</div>
  <div class="code">404</div>
  {badge}
  <h1>{_esc(title)}</h1>
  <p class="desc">{_esc(desc)}</p>
  {pod_line}
  <p class="hint">{_esc(hint)}</p>
  <div class="actions">
    <a class="btn" href="javascript:history.back()">返回</a>
    <a class="btn{' primary' if not frozen else ''}" href="{_esc(home_url)}">打开控制台</a>
    {extra}
  </div>
  <div class="foot">YatTerra · Pod Web 入口</div>
</main>
</body>
</html>
"""
