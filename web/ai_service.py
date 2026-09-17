"""Unified AI service layer for YatTerra.

Wraps llm.chat / llm.stream_chat with task-specific prompts and post-processing.
All calls go through the active LLM provider (Qwen on platform.ssemarket.cn).
"""
import json
import llm
import siteconf

# ── Task-specific system prompts ──────────────────────────────

_SYS_SUMMARIZE = """你是一个精准的摘要助手。用简洁的中文总结输入内容，保留关键信息，去掉冗余。输出1-3段。"""

_SYS_CLASSIFY = """你是一个分类助手。根据输入内容，从给定类别中选择最匹配的，只输出类别名。"""

_SYS_EXTRACT = """你是一个信息提取助手。从输入中提取指定类型的信息，以 JSON 数组输出。"""

_SYS_TRANSLATE = """你是一个翻译助手。将输入翻译为目标语言，保持原文格式和术语。只输出翻译结果。"""

_SYS_EXPLAIN = """你是一个技术解释助手。用通俗易懂的中文解释输入内容（可能是错误信息、日志、代码片段）。
先给出简短的一句话解释，然后给出详细分析和可能的解决方案。"""

_SYS_CODE = """你是一个代码助手。根据要求生成、解释或审查代码。
- 生成代码：输出完整可运行的代码，带注释
- 解释代码：逐段解释，说明关键逻辑
- 审查代码：指出问题（bug/安全/性能），给出修改建议
输出用 markdown 代码块包裹。"""

_SYS_COMPLETE = """你是一个智能补全助手。根据上下文和部分输入，补全剩余内容。
只输出补全部分，不要重复已有内容。"""

_SYS_WEB_QA = """你是一个联网问答助手。你会收到搜索结果和用户问题，基于搜索结果回答问题。
如果搜索结果不足以回答，明确说明。引用来源时标注 [1][2] 等。"""

_SYS_VISION = """你是一个视觉理解助手。分析图片内容，回答用户关于图片的问题。
用中文回答，详细描述你看到的内容。"""


def quick_chat(prompt, system="", context=None, max_tokens=4096, caller="ai_chat", user=None):
    """General-purpose chat. Returns full text."""
    messages = []
    if context:
        if isinstance(context, str):
            messages.append({"role": "user", "content": context})
        elif isinstance(context, list):
            messages.extend(context)
    messages.append({"role": "user", "content": prompt})
    return llm.chat(messages, system=system, max_tokens=max_tokens, caller=caller, user=user)


def stream_chat(prompt, system="", context=None, max_tokens=4096, caller="ai_chat", user=None):
    """General-purpose streaming chat. Yields (kind, text) chunks."""
    messages = []
    if context:
        if isinstance(context, str):
            messages.append({"role": "user", "content": context})
        elif isinstance(context, list):
            messages.extend(context)
    messages.append({"role": "user", "content": prompt})
    yield from llm.stream_chat(messages, system=system, max_tokens=max_tokens, caller=caller, user=user)


def analyze_text(text, task="summarize", categories=None, extract_type=None, target=None, user=None):
    """Analyze text: summarize, classify, extract, translate, explain.

    task: summarize | classify | extract | translate | explain
    categories: list of category names (for classify)
    extract_type: what to extract (for extract)
    target: target language code for translate (zh, en, ja, ko)
    """
    if task == "summarize":
        return llm.chat(
            [{"role": "user", "content": f"请总结以下内容：\n\n{text}"}],
            system=_SYS_SUMMARIZE, max_tokens=2048, caller="ai_analyze", user=user)
    elif task == "classify":
        cats = "、".join(categories or ["技术", "业务", "运维", "安全"])
        return llm.chat(
            [{"role": "user", "content": f"类别：{cats}\n\n请分类：\n\n{text}"}],
            system=_SYS_CLASSIFY, max_tokens=256, caller="ai_analyze", user=user)
    elif task == "extract":
        et = extract_type or "关键信息"
        return llm.chat(
            [{"role": "user", "content": f"提取{text}：\n\n{text}"}],
            system=_SYS_EXTRACT, max_tokens=2048, caller="ai_analyze", user=user)
    elif task == "translate":
        lang_map = {"zh": "中文", "en": "英文", "ja": "日文", "ko": "韩文"}
        target_name = lang_map.get(target or "zh", target or "中文")
        return llm.chat(
            [{"role": "user", "content": f"翻译为{target_name}：\n\n{text}"}],
            system=_SYS_TRANSLATE, max_tokens=4096, caller="ai_analyze", user=user)
    elif task == "explain":
        return llm.chat(
            [{"role": "user", "content": f"请解释以下内容：\n\n{text}"}],
            system=_SYS_EXPLAIN, max_tokens=4096, caller="ai_analyze", user=user)
    else:
        return quick_chat(text, caller="ai_analyze", user=user)


def analyze_image(image_base64, prompt, user=None):
    """Vision: analyze an image with a prompt.

    image_base64: base64-encoded image data (without data: prefix)
    prompt: question about the image
    """
    messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}},
            {"type": "text", "text": prompt},
        ],
    }]
    return llm.chat(messages, system=_SYS_VISION, max_tokens=4096, caller="ai_vision", user=user)


def stream_vision(image_base64, prompt, user=None):
    """Streaming vision analysis. Yields (kind, text) chunks."""
    messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}},
            {"type": "text", "text": prompt},
        ],
    }]
    yield from llm.stream_chat(messages, system=_SYS_VISION, max_tokens=4096, caller="ai_vision", user=user)


def generate_code(prompt, language="python", task="generate", user=None):
    """Code generation, explanation, or review.

    task: generate | explain | review
    """
    task_desc = {"generate": "生成", "explain": "解释", "review": "审查"}
    full_prompt = f"请{task_desc.get(task, '生成')}{language}代码：\n\n{prompt}"
    return llm.chat(
        [{"role": "user", "content": full_prompt}],
        system=_SYS_CODE, max_tokens=8192, caller="ai_code", user=user)


def stream_code(prompt, language="python", task="generate", user=None):
    """Streaming code generation. Yields (kind, text) chunks."""
    task_desc = {"generate": "生成", "explain": "解释", "review": "审查"}
    full_prompt = f"请{task_desc.get(task, '生成')}{language}代码：\n\n{prompt}"
    yield from llm.stream_chat(
        [{"role": "user", "content": full_prompt}],
        system=_SYS_CODE, max_tokens=8192, caller="ai_code", user=user)


def web_qa(question, search_results=None, user=None):
    """Answer a question using search results (web-use pattern).

    search_results: list of {title, url, snippet} dicts
    """
    if search_results:
        refs = []
        for i, r in enumerate(search_results, 1):
            refs.append(f"[{i}] {r.get('title', '')}\n{r.get('url', '')}\n{r.get('snippet', '')}")
        context = "搜索结果：\n\n" + "\n\n".join(refs)
    else:
        context = "（无搜索结果，请基于自身知识回答）"
    return llm.chat(
        [{"role": "user", "content": f"{context}\n\n问题：{question}"}],
        system=_SYS_WEB_QA, max_tokens=4096, caller="ai_web_qa", user=user)


def stream_web_qa(question, search_results=None, user=None):
    """Streaming web QA. Yields (kind, text) chunks."""
    if search_results:
        refs = []
        for i, r in enumerate(search_results, 1):
            refs.append(f"[{i}] {r.get('title', '')}\n{r.get('url', '')}\n{r.get('snippet', '')}")
        context = "搜索结果：\n\n" + "\n\n".join(refs)
    else:
        context = "（无搜索结果，请基于自身知识回答）"
    yield from llm.stream_chat(
        [{"role": "user", "content": f"{context}\n\n问题：{question}"}],
        system=_SYS_WEB_QA, max_tokens=4096, caller="ai_web_qa", user=user)


def smart_complete(partial, schema=None, context="", user=None):
    """Smart completion for forms, commands, configs.

    partial: the partial input to complete
    schema: optional JSON schema hint for structured completion
    context: additional context (e.g. current page, form type)
    """
    prompt = f"上下文：{context}\n\n补全：{partial}"
    if schema:
        prompt += f"\n\n期望格式：{json.dumps(schema, ensure_ascii=False)}"
    return llm.chat(
        [{"role": "user", "content": prompt}],
        system=_SYS_COMPLETE, max_tokens=2048, caller="ai_complete", user=user)


# ── Tool-use support for page assistant ─────────────────────────

import shlex
import subprocess

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_pods",
            "description": "列出所有 Pod 及其状态(名称、阶段、重启次数)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_pod",
            "description": "获取 Pod 详细信息(状态、资源、事件)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Pod 名称"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pod_logs",
            "description": "获取 Pod 最近日志",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Pod 名称"},
                    "tail": {"type": "integer", "description": "最后 N 行", "default": 50},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cluster_status",
            "description": "获取集群整体状态(节点、资源用量、事件摘要)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_exec",
            "description": "执行安全的只读命令(kubectl get/describe/logs, cat, ls, df, free, nvidia-smi 等)",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取服务器上文件的内容(限制 4000 字符)",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "文件绝对路径"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_gpu_status",
            "description": "获取 GPU 详细状态(每块 GPU 的利用率、显存、温度、功耗)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_resource_usage",
            "description": "获取集群资源使用详情(各 Pod 的 CPU/内存占用排名)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_services",
            "description": "列出集群中所有 Service 和端口映射(用于网络/代理分析)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployments",
            "description": "列出所有 Deployment 及其可用副本数和状态",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_configmaps",
            "description": "列出集群中的 ConfigMap 名称(用于配置分析)",
            "parameters": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": f"命名空间(默认 {siteconf.GROUP_NS})", "default": siteconf.GROUP_NS},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_yaml",
            "description": "分析 Kubernetes YAML 配置文件内容，给出优化建议",
            "parameters": {
                "type": "object",
                "properties": {
                    "yaml": {"type": "string", "description": "YAML 配置内容"},
                },
                "required": ["yaml"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_audit_events",
            "description": "查询最近的审计事件(用户操作、登录、资源变更等)",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "返回条数(默认20)", "default": 20},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_users",
            "description": "列出平台所有用户及其角色",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_pod_events",
            "description": "获取 Pod 的事件信息(调度、健康检查、警告等)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Pod 名称"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_storage_buckets",
            "description": "列出 MinIO/S3 存储桶及访问密钥状态",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_proxy_mappings",
            "description": "列出所有反向代理子域名映射及启用状态",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_gpu_per_pod",
            "description": "获取各 Pod 的 GPU 使用明细(哪个 Pod 用了哪块 GPU、显存占用)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_scheduler_state",
            "description": "获取调度器状态快照(部署任务、训练队列、GPU 分配)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_host_health",
            "description": "获取主机综合健康状态(CPU/内存/磁盘/swap/负载/k3s/frpc/nvidia)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_threat_data",
            "description": "获取安全威胁数据(攻击源IP、模式、封禁状态、地理信息)",
            "parameters": {
                "type": "object",
                "properties": {
                    "window": {"type": "string", "description": "时间窗口: 1h/3h/1d/3d/7d/all", "default": "3d"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_pressure_state",
            "description": "获取资源压力状态(CPU/内存/GPU 压力指标、被驱逐的 Pod、压力降级层级)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_group_events",
            "description": "获取组/Pod 的生命周期事件(调度、健康检查、OOM、重启等)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "组名或 Pod 名"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_metrics",
            "description": "获取集群实时指标快照(CPU/内存/GPU 利用率历史序列)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_llm_usage",
            "description": "获取 LLM token 用量统计(按天/按组件/按用户汇总,用于成本分析和优化建议)",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "统计天数(默认7)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_agent_sessions",
            "description": "获取 AI 助手的会话历史列表(可用于排查 agent 行为、回顾过往对话)",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "description": "agent 模式(如 ops, build, db 等),留空返回所有"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_deploy_tasks",
            "description": "获取部署任务配置(组的自动部署脚本、仓库地址、分支等 CI/CD 配置)",
            "parameters": {
                "type": "object",
                "properties": {
                    "group": {"type": "string", "description": "组名,留空返回所有组的部署任务"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_groups",
            "description": "获取组列表及其配置(成员、GPU 分配、Pod 状态、资源配额等)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_db_status",
            "description": "获取平台数据库服务状态(运行状态、连接信息、版本等)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_mcp_servers",
            "description": "获取 MCP (Model Context Protocol) 服务器列表及配置(名称、命令、传输方式、启用状态、环境变量)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_shared_files",
            "description": "获取共享目录文件列表(用于查看用户共享的模型权重、数据集等文件)",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "子目录路径(默认根目录)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_push_status",
            "description": "获取 PWA 推送通知状态(订阅数量、VAPID 配置等)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_remote_hosts",
            "description": "获取远程主机状态(经 SSH 中继采集的主机: 磁盘/内存/GPU/vLLM 等)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_pod_env",
            "description": "获取 Pod 环境变量(用于调试配置问题)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Pod 名称"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "检索平台文档与运维知识库(平台使用方法、API 用法、连接方式、排障知识等)。当问题涉及平台自身用法或运维知识时优先使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索查询词"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_knowledge",
            "description": "把本次对话中值得沉淀的知识(排障过程、配置方法、结论)总结成文档存入平台知识库，供之后 AI 检索",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "文档标题(简明扼要，如「XX 服务排障记录」)"},
                    "content": {"type": "string", "description": "要沉淀的知识内容(排障过程、配置方法、结论等)"},
                    "kb": {"type": "string", "description": "目标知识库: ops(运维库,默认) 或 public(公开库,需更高权限)"},
                },
                "required": ["title", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_llm_providers",
            "description": "获取 LLM Provider 配置列表(名称/类型/Base URL/是否默认/是否启用)",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

# ── Tool → permission mapping ─────────────────────────────────
# Every AGENT_TOOLS entry must have an entry here ("" = login only).
# The list exposed to the LLM is filtered by these perms (stream_agent),
# AND _execute_tool re-checks before running (defense in depth against
# forged tool calls / prompt injection).
TOOL_PERMS = {
    "list_pods":          "group.view",
    "get_pod":            "group.view",        # + pod member check
    "pod_logs":           "group.view",        # + pod member check
    "get_pod_events":     "group.view",        # + pod member check
    "get_pod_env":        "group.view",        # + pod member check
    "get_group_events":   "group.view",        # + pod member check
    "get_groups": "group.view",
    "cluster_status":     "infra.host",
    "shell_exec":         "infra.host",
    "read_file":          "infra.host",
    "get_gpu_status":     "infra.host",
    "get_resource_usage": "infra.host",
    "list_services":      "infra.host",
    "get_deployments":    "infra.host",
    "get_configmaps":     "infra.host",
    "get_gpu_per_pod":    "infra.host",
    "get_host_health":    "infra.host",
    "get_pressure_state": "infra.host",
    "get_metrics":        "infra.host",
    "get_push_status":    "infra.host",
    "get_remote_hosts":   "infra.host",
    "get_storage_buckets": "infra.storage.read",
    "get_db_status":      "infra.db.read",
    "get_proxy_mappings": "infra.proxy",
    "get_scheduler_state": "infra.scheduler",
    "get_audit_events":   "ops.audit",
    "get_threat_data":    "ops.threat",
    "get_shared_files":   "ops.shared.read",
    "get_deploy_tasks":   "ops.deploy",
    "list_users":         "admin.users",
    "get_llm_usage":      "dev.llm",
    "get_llm_providers":  "dev.llm",
    "get_agent_sessions": "dev.agent",
    "get_mcp_servers":    "dev.mcp",
    "analyze_yaml":       "",                  # pure LLM, no data access
    "search_knowledge":   "",                  # kb_service routes by perms
    # tuple = any-of; plus a min-role floor (see _TOOL_MIN_ROLE) so the
    # guest role (which carries infra.host for viewing) cannot write KB docs
    "save_knowledge":     ("infra.host", "ops.audit"),
}

# Tools that target a specific pod/group: beyond the global perm, the caller
# must have member+ access to that pod (users.pod_role). Pods that are not
# groups (platform-infra pods) require infra.host instead.
_POD_TARGET_TOOLS = {"get_pod", "pod_logs", "get_pod_events",
                     "get_pod_env", "get_group_events"}

# Host-command tools run as root on the server (shell_exec/read_file).
# The guest role carries infra.host for *viewing* host health, but must not
# get root shell/file access through the AI — enforce a minimum account role.
_ROLE_RANK = {"guest": 0, "user": 1, "admin": 2, "super": 3}
_TOOL_MIN_ROLE = {"shell_exec": 1, "read_file": 1, "save_knowledge": 1}


def _expand_perms(perms):
    """Normalize a perms argument into a set of permission strings.

    Accepts: user dict (expanded via users.expanded_perms), a set/list of
    perm strings, or None (→ empty set = login-only tools).
    """
    if perms is None:
        return set()
    if isinstance(perms, (set, frozenset, list, tuple)):
        return set(perms)
    if isinstance(perms, dict):
        try:
            import users
            return users.expanded_perms(perms)
        except Exception:
            return set()
    return set()


def _tool_allowed(name, perms, user=None):
    """True if this perm set grants tool `name`."""
    req = TOOL_PERMS.get(name)
    if req is None:
        return False   # unknown tool — never expose
    if not req:
        return True    # login-only tool
    if isinstance(req, (tuple, list)):
        # any-of permission set
        if not ("*" in perms or any(r in perms for r in req)):
            return False
    elif not ("*" in perms or req in perms):
        return False
    floor = _TOOL_MIN_ROLE.get(name)
    if floor is not None:
        rank = _ROLE_RANK.get((user or {}).get("role", "guest"), 0) \
            if isinstance(user, dict) else 0
        if rank < floor:
            return False
    return True


def tools_for(perms=None):
    """AGENT_TOOLS filtered to what the caller may use."""
    p = _expand_perms(perms)
    u = perms if isinstance(perms, dict) else None
    return [t for t in AGENT_TOOLS
            if _tool_allowed(t["function"]["name"], p, user=u)]


def _check_pod_access(arguments, user, perms):
    """Pod-targeted tools: caller must be member+ of the target pod.

    Returns an error string, or None if allowed. Non-group pods
    (platform infra) require infra.host. This is checked server-side
    against the real user dict, so prompt injection cannot bypass it.
    """
    target = (arguments.get("name") or "").strip()
    if not target:
        return None
    try:
        import groups as groups_mod
        pod = groups_mod.load_state()["groups"].get(target)
    except Exception:
        return "权限校验失败(无法加载组状态)"
    if pod is None:
        # not a group pod → platform infra pod, host-level access
        if not ("*" in perms or "infra.host" in perms):
            return f"权限不足: 无权查看非组资源 {target} (需要 infra.host)"
        return None
    # group pod → member+ access required
    try:
        import users as users_mod
        if isinstance(user, dict) and users_mod.pod_role(user, pod):
            return None
    except Exception:
        pass
    return f"权限不足: 无权访问 Pod {target} (需要组成员权限)"


# Safe command prefixes for shell_exec
_SHELL_SAFE_PREFIXES = (
    "kubectl get ", "kubectl describe ", "kubectl logs ", "kubectl top ",
    "k3s ", "cat ", "head ", "tail ", "ls ", "df ", "free ",
    "top -bn1", "nvidia-smi", "hostname", "uptime", "whoami",
)


def _is_shell_safe(cmd):
    """Check that every segment of a compound command starts with a safe prefix.
    Splits on ;, &&, ||, |, and rejects $() subshells."""
    if '$(' in cmd or '`' in cmd:
        return False
    import re as _re
    segments = _re.split(r'\s*(?:;|&&|\|\|)\s*', cmd)
    expanded = []
    for seg in segments:
        expanded.extend(_re.split(r'\s*\|\s*', seg))
    for seg in expanded:
        seg = seg.strip()
        if not seg:
            continue
        if not any(seg.startswith(p) or seg == p.strip() for p in _SHELL_SAFE_PREFIXES):
            return False
    return True


def _execute_tool(name, arguments, user=None):
    """Execute a tool call and return the result string.

    `user` is the caller's user dict (or a perm set). Permission is
    re-checked here even though the tool list given to the LLM was already
    filtered — a forged/hallucinated tool call must not bypass perms.
    """
    try:
        perms = _expand_perms(user)
        if not _tool_allowed(name, perms, user=user):
            req = TOOL_PERMS.get(name)
            if isinstance(req, (tuple, list)):
                req = " 或 ".join(req)
            return (f"权限不足: 工具 {name} 需要 {req} 权限" if req
                    else f"权限不足: 未知工具 {name}")
        if name in _POD_TARGET_TOOLS:
            denied = _check_pod_access(arguments, user, perms)
            if denied:
                return denied

        if name == "list_pods":
            r = subprocess.run(
                ["kubectl", "get", "pods", "-o", "wide", "--no-headers"],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout[:3000] if r.returncode == 0 else f"错误: {r.stderr[:500]}"

        elif name == "get_pod":
            pod_name = arguments.get("name", "")
            r = subprocess.run(
                ["kubectl", "get", "pod", pod_name, "-o", "json"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode != 0:
                return f"错误: {r.stderr[:500]}"
            try:
                d = json.loads(r.stdout)
                status = d.get("status", {})
                spec = d.get("spec", {})
                info = (
                    f"名称: {d['metadata']['name']}\n"
                    f"状态: {status.get('phase', '?')}\n"
                    f"节点: {spec.get('nodeName', '?')}\n"
                    f"容器: {len(spec.get('containers', []))}\n"
                    f"重启: {sum(c.get('restartCount', 0) for c in status.get('containerStatuses', []))}\n"
                )
                conditions = status.get("conditions", [])
                for c in conditions:
                    if c.get("status") != "True":
                        info += f"⚠ {c.get('type')}: {c.get('message', '')[:200]}\n"
                return info
            except Exception:
                return r.stdout[:3000]

        elif name == "pod_logs":
            pod_name = arguments.get("name", "")
            tail = arguments.get("tail", 50)
            r = subprocess.run(
                ["kubectl", "logs", pod_name, f"--tail={tail}"],
                capture_output=True, text=True, timeout=15,
            )
            output = r.stdout[:4000]
            if r.stderr and "error" not in r.stdout.lower():
                output += f"\nSTDERR: {r.stderr[:500]}"
            return output or "(无日志)"

        elif name == "cluster_status":
            parts = []
            for cmd in [
                ["kubectl", "get", "nodes", "-o", "wide", "--no-headers"],
                ["kubectl", "top", "nodes"],
                ["kubectl", "get", "events", "--field-selector", "type=Warning",
                 "--sort-by=-lastTimestamp", "--no-headers"],
            ]:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if r.returncode == 0 and r.stdout.strip():
                    parts.append(r.stdout[:2000])
            return "\n---\n".join(parts) if parts else "无法获取集群状态"

        elif name == "shell_exec":
            cmd = arguments.get("command", "").strip()
            if not cmd:
                return "空命令"
            # Security check: validate each segment of compound commands
            if not _is_shell_safe(cmd):
                return "安全限制: 仅允许只读命令 (kubectl get/describe/logs/top, cat, ls, head, tail, df, free, nvidia-smi); 禁止命令链(;, &&, ||, |)和子shell"
            r = subprocess.run(
                shlex.split(cmd), shell=False, capture_output=True, text=True, timeout=15,
            )
            output = r.stdout[:4000]
            if r.stderr:
                output += f"\nSTDERR: {r.stderr[:500]}"
            return output or "(无输出)"

        elif name == "read_file":
            path = arguments.get("path", "").strip()
            if not path:
                return "空路径"
            # Security: no path traversal
            if ".." in path or not path.startswith("/"):
                return "安全限制: 仅允许绝对路径且不含 .."
            try:
                with open(path) as f:
                    return f.read(4000)
            except OSError as e:
                return f"读取失败: {e}"

        elif name == "get_gpu_status":
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode != 0:
                return f"GPU 查询失败: {r.stderr[:300]}"
            lines = r.stdout.strip().split("\n")
            result = []
            for line in lines:
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 7:
                    result.append(f"GPU {parts[0]}: {parts[1]}, 利用率 {parts[2]}%, 显存 {parts[3]}/{parts[4]} MB, 温度 {parts[5]}°C, 功耗 {parts[6]}/{parts[7]} W")
            return "\n".join(result) if result else "无 GPU 数据"

        elif name == "get_resource_usage":
            parts = []
            r = subprocess.run(["kubectl", "top", "pods", "--sort-by=cpu", "--no-headers"],
                               capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                parts.append("Pod 资源占用排名(CPU):\n" + r.stdout[:2000])
            r = subprocess.run(["kubectl", "top", "nodes", "--no-headers"],
                               capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                parts.append("节点资源使用:\n" + r.stdout[:1000])
            return "\n---\n".join(parts) if parts else "无法获取资源使用数据"

        elif name == "list_services":
            r = subprocess.run(
                ["kubectl", "get", "svc", "-o", "wide", "--no-headers"],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout[:3000] if r.returncode == 0 else f"错误: {r.stderr[:500]}"

        elif name == "get_deployments":
            r = subprocess.run(
                ["kubectl", "get", "deployments", "-o", "wide", "--no-headers"],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout[:3000] if r.returncode == 0 else f"错误: {r.stderr[:500]}"

        elif name == "get_configmaps":
            ns = arguments.get("namespace", siteconf.GROUP_NS)
            r = subprocess.run(
                ["kubectl", "get", "configmaps", "-n", ns, "--no-headers"],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout[:3000] if r.returncode == 0 else f"错误: {r.stderr[:500]}"

        elif name == "analyze_yaml":
            yaml_content = arguments.get("yaml", "")
            if not yaml_content.strip():
                return "空 YAML 内容"
            # Use LLM to analyze the YAML
            try:
                result = llm.chat(
                    f"分析以下 Kubernetes YAML 配置，给出优化建议（资源限制、安全性、健康检查、副本数等）：\n\n{yaml_content[:3000]}",
                    system="你是 K8s 配置专家。分析 YAML 配置的问题和优化建议。简洁输出。",
                    max_tokens=1024, caller="ai_tool_yaml",
                )
                return result
            except Exception as e:
                return f"分析失败: {e}"

        elif name == "get_audit_events":
            limit = arguments.get("limit", 20)
            try:
                import audit as audit_mod
                entries = audit_mod.audit_entries(limit=limit)
                if not entries:
                    return "暂无审计事件"
                lines = []
                for e in entries:
                    ts = e.get("ts", e.get("time", ""))
                    actor = e.get("actor", e.get("user", "?"))
                    action = e.get("action", "?")
                    target = e.get("target", "")
                    ok = "✓" if e.get("ok", True) else "✗"
                    detail = f"{ts} [{ok}] {actor} {action}"
                    if target:
                        detail += f" {target}"
                    lines.append(detail)
                return "\n".join(lines)
            except Exception as e:
                return f"查询审计失败: {e}"

        elif name == "list_users":
            try:
                import users as users_mod
                ulist = users_mod.list_users()
                if not ulist:
                    return "暂无用户"
                lines = []
                for u in ulist:
                    uname = u.get("username", u.get("user", "?"))
                    role = u.get("role", "?")
                    lines.append(f"{uname} (角色: {role})")
                return "\n".join(lines)
            except Exception as e:
                return f"查询用户失败: {e}"

        elif name == "get_pod_events":
            pname = arguments.get("name", "")
            if not pname:
                return "缺少 Pod 名称"
            out = subprocess.run(
                ["kubectl", "get", "events", "-n", siteconf.GROUP_NS,
                 "--field-selector", f"involvedObject.name={pname}",
                 "--sort-by", ".lastTimestamp"],
                capture_output=True, text=True, timeout=15,
            )
            if out.returncode != 0:
                return f"kubectl 失败: {out.stderr.strip()}"
            return out.stdout.strip() or "无事件"

        elif name == "get_storage_buckets":
            try:
                import minio_svc
                bs = minio_svc.buckets()
                if not bs:
                    return "暂无存储桶"
                lines = []
                for b in bs:
                    if isinstance(b, dict):
                        lines.append(f"  {b.get('name', '?')}: {b.get('size', '?')} 对象 {b.get('objects', '?')}")
                    else:
                        lines.append(f"  {b}")
                try:
                    keys = minio_svc.list_keys()
                    if isinstance(keys, list):
                        lines.append(f"访问密钥: {len(keys)} 个")
                        for k in keys[:5]:
                            if isinstance(k, dict):
                                lines.append(f"    {k.get('label', k.get('id', '?'))}: bucket={k.get('bucket', '?')}, perm={k.get('perm', '?')}")
                            else:
                                lines.append(f"    {k}")
                except Exception:
                    pass
                return "\n".join(lines)
            except Exception as e:
                return f"查询存储失败: {e}"

        elif name == "get_proxy_mappings":
            try:
                import proxy_map
                maps = proxy_map.list_mappings()
                if not maps:
                    return "暂无代理映射"
                lines = []
                for m in maps:
                    en = "✓" if m.get("enabled", True) else "✗"
                    lines.append(f"  {m.get('subdomain', '?')} → :{m.get('port', '?')} [{en}] {m.get('note', '')}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询代理失败: {e}"

        elif name == "get_gpu_per_pod":
            try:
                import gpu_stats
                usage = gpu_stats.per_pod_usage()
                if not usage:
                    return "暂无 Pod GPU 使用数据"
                lines = []
                if isinstance(usage, dict):
                    for pod, info in usage.items():
                        if isinstance(info, dict):
                            # {gpu_id: mem_used_mb}
                            for gpu_id, mem in info.items():
                                lines.append(f"  {pod}: GPU {gpu_id}, 显存 {mem} MB")
                        elif isinstance(info, list):
                            for g in info:
                                if isinstance(g, dict):
                                    lines.append(f"  {pod}: GPU {g.get('gpu', g.get('gpu_id', '?'))}, 显存 {g.get('mem_used', '?')}/{g.get('mem_total', '?')} MB")
                                else:
                                    lines.append(f"  {pod}: {g}")
                        else:
                            lines.append(f"  {pod}: {info}")
                elif isinstance(usage, list):
                    for u in usage:
                        if isinstance(u, dict):
                            lines.append(f"  {u.get('pod', '?')}: GPU {u.get('gpu', u.get('gpu_id', '?'))}, 显存 {u.get('mem_used', '?')}/{u.get('mem_total', '?')} MB")
                        else:
                            lines.append(f"  {u}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询 GPU 使用失败: {e}"

        elif name == "get_scheduler_state":
            try:
                import scheduler
                snap = scheduler.snapshot()
                deps = snap.get("deploys", []) if isinstance(snap, dict) else []
                trains = snap.get("queued_trains", []) if isinstance(snap, dict) else []
                gpus = snap.get("gpus", []) if isinstance(snap, dict) else []
                lines = []
                lines.append(f"部署任务: {len(deps)} 个")
                lines.append(f"训练队列: {len(trains)} 个")
                lines.append(f"GPU 分配: {len(gpus)} 块")
                for d in deps[:10]:
                    lines.append(f"  部署 {d.get('name', '?')}: {d.get('status', '?')}")
                for t in trains[:10]:
                    lines.append(f"  训练 {t.get('name', '?')}: {t.get('status', '?')}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询调度器失败: {e}"

        elif name == "get_host_health":
            try:
                import host_health
                h = host_health.host_health()
                if not isinstance(h, dict):
                    return str(h)[:2000]
                lines = []
                mem = h.get("mem", {})
                if isinstance(mem, dict):
                    lines.append(f"内存: {mem.get('used_pct', '?')}% ({mem.get('used_h', mem.get('used', '?'))}/{mem.get('total_h', mem.get('total', '?'))})")
                load = h.get("load", {})
                if isinstance(load, dict):
                    lines.append(f"负载: {load.get('load1', '?')} {load.get('load5', '?')} {load.get('load15', '?')}")
                swap = h.get("swap", {})
                if isinstance(swap, dict):
                    lines.append(f"Swap: {swap.get('used_pct', '?')}%")
                disk = h.get("disk", [])
                if isinstance(disk, list):
                    for d in disk[:4]:
                        if isinstance(d, dict):
                            lines.append(f"磁盘 {d.get('mount', '?')}: {d.get('used_pct', '?')}% ({d.get('used_h', '?')}/{d.get('total_h', '?')})")
                elif isinstance(disk, dict):
                    lines.append(f"磁盘: {disk.get('used_pct', '?')}%")
                uptime = h.get("uptime", {})
                if isinstance(uptime, dict):
                    lines.append(f"运行: {uptime.get('human', '?')}")
                k3s = h.get("k3s", {})
                if isinstance(k3s, dict):
                    nodes = k3s.get("nodes", [])
                    if isinstance(nodes, list):
                        lines.append(f"K3s: {len(nodes)} 节点")
                    else:
                        lines.append(f"K3s: {k3s.get('count', '?')} 节点")
                frpc = h.get("frpc", {})
                if isinstance(frpc, dict) and frpc:
                    lines.append(f"FRP: {frpc.get('running', '?')}/{frpc.get('total', '?')} 隧道")
                nv = h.get("nvidia", {})
                if isinstance(nv, dict) and nv.get("count", 0):
                    lines.append(f"GPU: {nv.get('count', '?')} 块, 驱动 {nv.get('driver_version', '?')}")
                return "\n".join(lines) if lines else "暂无主机健康数据"
            except Exception as e:
                return f"查询主机健康失败: {e}"

        elif name == "get_threat_data":
            window = arguments.get("window", "3d")
            if window not in ("1h", "3h", "1d", "3d", "7d", "all"):
                window = "3d"
            try:
                import json as _json
                path = os.path.join(siteconf.HONEYPOT_DIR, f"feed_{window}.json")
                with open(path) as f:
                    data = _json.load(f)
                attacks = data.get("attacks", [])
                stats = data.get("stats", {})
                lines = [f"攻击总数: {stats.get('total_attacks', 0)}, 封禁: {stats.get('total_banned', 0)}"]
                for a in attacks[:20]:
                    lines.append(f"  {a.get('ip', '?')} ({a.get('city', '?')}, {a.get('country', '?')}): {a.get('pattern', '?')}, {a.get('count', 0)} 次{' [封禁]' if a.get('banned') else ''}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询威胁数据失败: {e}"

        elif name == "get_pressure_state":
            try:
                import priority_kill
                st = priority_kill.read_pressure()
                if not st:
                    return "暂无压力数据"
                lines = []
                if isinstance(st, dict):
                    for key, val in st.items():
                        if isinstance(val, dict):
                            lines.append(f"{key}:")
                            for k2, v2 in val.items():
                                lines.append(f"  {k2}: {v2}")
                        else:
                            lines.append(f"{key}: {val}")
                else:
                    lines.append(str(st)[:2000])
                return "\n".join(lines)
            except Exception as e:
                return f"查询压力状态失败: {e}"

        elif name == "get_group_events":
            gname = arguments.get("name", "")
            if not gname:
                return "缺少组名"
            try:
                import lifecycle
                events = lifecycle.group_events(gname)
                if not events:
                    return f"组 {gname} 无事件"
                lines = []
                for ev in events[:30]:
                    if isinstance(ev, dict):
                        lines.append(f"  {ev.get('ts', '?')} {ev.get('type', '?')} {ev.get('message', '')}")
                    else:
                        lines.append(f"  {ev}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询组事件失败: {e}"

        elif name == "get_metrics":
            try:
                import metrics
                snap = metrics.metrics_now()
                if not snap:
                    return "暂无指标数据"
                lines = []
                if isinstance(snap, dict):
                    for key, val in snap.items():
                        if isinstance(val, (int, float)):
                            lines.append(f"{key}: {val}")
                        elif isinstance(val, dict):
                            lines.append(f"{key}: {', '.join(f'{k}={v}' for k, v in val.items())}")
                else:
                    lines.append(str(snap)[:2000])
                return "\n".join(lines)
            except Exception as e:
                return f"查询指标失败: {e}"

        elif name == "get_llm_usage":
            days = arguments.get("days", 7)
            try:
                import llm_usage
                lines = []
                # Total summary
                total = llm_usage.total_summary(days=days)
                lines.append(f"=== 总计({days}天) ===")
                if isinstance(total, dict):
                    for k, v in total.items():
                        lines.append(f"  {k}: {v}")
                # Per-day breakdown
                day_data = llm_usage.day_summary(days=days)
                lines.append(f"\n=== 按天 ===")
                if isinstance(day_data, list):
                    for d in day_data[:days]:
                        lines.append(f"  {d}")
                elif isinstance(day_data, dict):
                    for k, v in list(day_data.items())[:days]:
                        lines.append(f"  {k}: {v}")
                # Top users
                top = llm_usage.top_users(days=days, limit=10)
                lines.append(f"\n=== Top 用户 ===")
                if isinstance(top, list):
                    for u in top[:10]:
                        if isinstance(u, dict):
                            lines.append(f"  {u.get('user', u.get('username', '?'))}: {u.get('total', u.get('tokens', '?'))} tokens, {u.get('calls', '?')} calls")
                        else:
                            lines.append(f"  {u}")
                # Component breakdown
                comp = llm_usage.component_summary(days=days)
                lines.append(f"\n=== 按组件 ===")
                if isinstance(comp, list):
                    for c in comp[:10]:
                        lines.append(f"  {c}")
                elif isinstance(comp, dict):
                    for k, v in list(comp.items())[:10]:
                        lines.append(f"  {k}: {v}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询 LLM 用量失败: {e}"

        elif name == "get_agent_sessions":
            mode = arguments.get("mode", "")
            try:
                import agent_runs
                lines = []
                modes = [mode] if mode else ["ops", "build", "db", "storage", "net", "gpu", "web", "train"]
                for m in modes:
                    try:
                        sessions = agent_runs.list_sessions(m)
                        if sessions:
                            lines.append(f"=== {m} ===")
                            if isinstance(sessions, list):
                                for s in sessions[:10]:
                                    if isinstance(s, dict):
                                        lines.append(f"  {s.get('id', s.get('session_id', '?'))}: {s.get('title', s.get('name', '?'))} ({s.get('turns', '?')} turns)")
                                    else:
                                        lines.append(f"  {s}")
                    except Exception:
                        pass
                return "\n".join(lines) if lines else "暂无 agent 会话"
            except Exception as e:
                return f"查询 agent 会话失败: {e}"

        elif name == "get_deploy_tasks":
            group = arguments.get("group", "")
            try:
                import deploys
                lines = []
                if group:
                    tasks = deploys.list_for(group)
                    lines.append(f"=== 组 {group} 的部署任务 ===")
                    if isinstance(tasks, list):
                        for t in tasks:
                            if isinstance(t, dict):
                                lines.append(f"  {t.get('id', t.get('name', '?'))}: repo={t.get('repo', '?')}, branch={t.get('branch', '?')}, script={t.get('script', t.get('script_path', '?'))}, enabled={t.get('enabled', '?')}")
                            else:
                                lines.append(f"  {t}")
                else:
                    state = deploys.load()
                    lines.append("=== 所有部署任务 ===")
                    if isinstance(state, dict):
                        for g, tasks in state.items():
                            if isinstance(tasks, list):
                                lines.append(f"  组 {g}: {len(tasks)} 个任务")
                                for t in tasks[:5]:
                                    if isinstance(t, dict):
                                        lines.append(f"    {t.get('id', t.get('name', '?'))}: repo={t.get('repo', '?')}, branch={t.get('branch', '?')}")
                    elif isinstance(state, list):
                        for t in state[:20]:
                            lines.append(f"  {t}")
                return "\n".join(lines) if lines else "暂无部署任务"
            except Exception as e:
                return f"查询部署任务失败: {e}"

        elif name == "get_groups":
            try:
                import groups as groups_mod
                state = groups_mod.load_state()
                lines = []
                if isinstance(state, dict):
                    groups_list = state.get("groups", state)
                    if isinstance(groups_list, list):
                        for g in groups_list:
                            if isinstance(g, dict):
                                name = g.get("name", g.get("group", "?"))
                                members = g.get("members", [])
                                gpu = g.get("gpu_ids", g.get("gpus", []))
                                cpu = g.get("cpu", g.get("millicpu", "?"))
                                mem = g.get("memory", g.get("mem", "?"))
                                lines.append(f"  {name}: 成员 {len(members) if isinstance(members, list) else members}, GPU {gpu}, CPU {cpu}, 内存 {mem}")
                    elif isinstance(groups_list, dict):
                        for name, g in groups_list.items():
                            if isinstance(g, dict):
                                members = g.get("members", [])
                                gpu = g.get("gpu_ids", g.get("gpus", []))
                                lines.append(f"  {name}: 成员 {len(members) if isinstance(members, list) else members}, GPU {gpu}")
                # Pod statuses
                try:
                    statuses = groups_mod.all_pod_statuses()
                    if statuses:
                        lines.append("\n=== Pod 状态 ===")
                        if isinstance(statuses, list):
                            for s in statuses[:20]:
                                if isinstance(s, dict):
                                    lines.append(f"  {s.get('name', '?')}: {s.get('phase', s.get('status', '?'))}")
                                else:
                                    lines.append(f"  {s}")
                except Exception:
                    pass
                return "\n".join(lines) if lines else "暂无组"
            except Exception as e:
                return f"查询组失败: {e}"

        elif name == "get_db_status":
            try:
                import db_svc
                st = db_svc.status()
                lines = []
                if isinstance(st, dict):
                    for k, v in st.items():
                        lines.append(f"  {k}: {v}")
                else:
                    lines.append(str(st)[:2000])
                return "\n".join(lines) if lines else "暂无数据库状态"
            except Exception as e:
                return f"查询数据库状态失败: {e}"

        elif name == "get_mcp_servers":
            try:
                import json as _json
                mcp_file = siteconf.path("mcp_servers.json")
                try:
                    with open(mcp_file) as f:
                        servers = _json.load(f)
                except FileNotFoundError:
                    servers = []
                if not servers:
                    return "暂无 MCP 服务器"
                lines = []
                if isinstance(servers, dict):
                    servers = servers.get("servers", list(servers.values()))
                for s in servers:
                    if isinstance(s, dict):
                        name = s.get("name", s.get("id", "?"))
                        cmd = s.get("command", "?")
                        transport = s.get("transport", "stdio")
                        enabled = s.get("enabled", True)
                        args = s.get("args", [])
                        env_keys = list(s.get("env", {}).keys()) if isinstance(s.get("env"), dict) else []
                        lines.append(f"  {name}: cmd={cmd}, transport={transport}, enabled={enabled}, args={args}, env_keys={env_keys}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询 MCP 服务器失败: {e}"

        elif name == "get_shared_files":
            path = arguments.get("path", "")
            try:
                import shared as shared_mod
                entries, cur = shared_mod.list_dir(path)
                lines = [f"当前目录: {cur}"]
                if isinstance(entries, list):
                    for e in entries[:50]:
                        if isinstance(e, dict):
                            is_dir = e.get("is_dir", e.get("type") == "dir")
                            name = e.get("name", "?")
                            size = e.get("size", "")
                            lines.append(f"  {'📁' if is_dir else '📄'} {name} {f'({size})' if size else ''}")
                        else:
                            lines.append(f"  {e}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询共享文件失败: {e}"

        elif name == "get_push_status":
            try:
                import json as _json
                subs_file = siteconf.web_path("push_subscriptions.json")
                try:
                    with open(subs_file) as f:
                        subs = _json.load(f)
                except FileNotFoundError:
                    subs = []
                count = len(subs) if isinstance(subs, list) else len(subs) if isinstance(subs, dict) else 0
                vapid_ok = False
                try:
                    with open(siteconf.web_path("vapid.json")) as f:
                        vapid_ok = True
                except FileNotFoundError:
                    pass
                return f"推送通知: {count} 个订阅, VAPID {'已配置' if vapid_ok else '未配置'}"
            except Exception as e:
                return f"查询推送状态失败: {e}"

        elif name == "get_remote_hosts":
            try:
                import remote_hosts
                hosts = remote_hosts.all_hosts()
                if not hosts:
                    return "暂无远程主机"
                lines = [f"远程主机: {len(hosts)} 台"]
                for h in hosts:
                    if isinstance(h, dict):
                        d = h.get("data", h)
                        name = h.get("name", h.get("host", "?"))
                        err = d.get("error") if isinstance(d, dict) else None
                        if err:
                            lines.append(f"  {name}: 采集失败 - {err}")
                            continue
                        kernel = d.get("kernel_os", {}) if isinstance(d, dict) else {}
                        load = d.get("load", {}) if isinstance(d, dict) else {}
                        mem = d.get("mem", {}) if isinstance(d, dict) else {}
                        nvidia = d.get("nvidia", {}) if isinstance(d, dict) else {}
                        vllm = d.get("vllm") if isinstance(d, dict) else None
                        uptime = d.get("uptime", {}) if isinstance(d, dict) else {}
                        lines.append(f"  {name}: {kernel.get('os_pretty', '?')}, 内核 {kernel.get('release', '?')}")
                        lines.append(f"    负载: {load.get('load1', '?')} / {load.get('load5', '?')} / {load.get('load15', '?')}")
                        lines.append(f"    内存: {mem.get('used_h', '?')} / {mem.get('total_h', '?')} ({mem.get('used_pct', '?')}%)")
                        lines.append(f"    运行: {uptime.get('human', '?')}")
                        if nvidia.get("count"):
                            lines.append(f"    GPU: {nvidia.get('count')} 块, 驱动 {nvidia.get('driver_version', '?')}")
                        if vllm:
                            lines.append(f"    vLLM: {'healthy' if vllm.get('healthy') else 'down'}, 模型 {vllm.get('model', '?')}")
                    else:
                        lines.append(f"  {h}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询远程主机失败: {e}"

        elif name == "get_pod_env":
            pname = arguments.get("name", "")
            if not pname:
                return "缺少 Pod 名称"
            try:
                import subprocess as _sp
                result = _sp.run(
                    ["kubectl", "get", "pod", pname, "-n", siteconf.GROUP_NS, "-o", "jsonpath={.spec.containers[0].env}"],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode != 0:
                    return f"获取 Pod {pname} 环境变量失败: {result.stderr.strip()}"
                env_str = result.stdout.strip()
                if not env_str:
                    return f"Pod {pname} 无环境变量"
                # Parse JSON array of env vars
                import json as _json
                try:
                    envs = _json.loads(env_str)
                    lines = [f"Pod {pname} 环境变量:"]
                    for e in envs:
                        if isinstance(e, dict):
                            name_e = e.get("name", "?")
                            value = e.get("value", "")
                            if not value and "valueFrom" in e:
                                value = "[from ref]"
                            # Mask sensitive values
                            if any(s in name_e.upper() for s in ["KEY", "SECRET", "PASS", "TOKEN", "CRED"]):
                                value = "***" if value else "[from ref]"
                            lines.append(f"  {name_e}={value}")
                    return "\n".join(lines)
                except _json.JSONDecodeError:
                    return f"Pod {pname} 环境变量(原始): {env_str[:2000]}"
            except Exception as e:
                return f"获取 Pod 环境变量失败: {e}"

        elif name == "get_llm_providers":
            try:
                import llm
                conf = llm.load_conf()
                providers = conf.get("providers", []) if isinstance(conf, dict) else []
                if not providers:
                    return "暂无 LLM Provider"
                lines = [f"LLM Providers: {len(providers)} 个"]
                for p in providers:
                    if isinstance(p, dict):
                        name_p = p.get("name", "?")
                        ptype = p.get("type", p.get("model", "?"))
                        base_url = p.get("base_url", "?")
                        is_default = p.get("is_default", False)
                        enabled = p.get("enabled", True)
                        lines.append(f"  {name_p} [{ptype}] {base_url} {'(默认)' if is_default else ''} {'(禁用)' if not enabled else ''}")
                    else:
                        lines.append(f"  {p}")
                return "\n".join(lines)
            except Exception as e:
                return f"查询 LLM Providers 失败: {e}"

        elif name == "search_knowledge":
            query = (arguments.get("query") or "").strip()
            if not query:
                return "缺少 query 参数"
            try:
                import kb_service
                hits = kb_service.retrieve(query, user, k=5)
                if not hits:
                    return "知识库中未找到相关内容"
                lines = []
                for i, h in enumerate(hits, 1):
                    lines.append(f"[{i}] 来源: {h['source']} | {h['title']} "
                                 f"(相关度 {h['score']})\n{h['text']}")
                return "\n\n".join(lines)
            except Exception as e:
                return f"知识库检索失败: {e}"

        elif name == "save_knowledge":
            title = (arguments.get("title") or "").strip()
            content = (arguments.get("content") or "").strip()
            kb = arguments.get("kb", "ops") or "ops"
            if not title or not content:
                return "缺少 title 或 content 参数"
            try:
                import kb_service
                # content is auto-summarized into structured markdown,
                # then stored + indexed via the same path as POST /api/ai/kb/docs
                r = kb_service.save_doc(title, content, kb=kb,
                                        summarize=True, user=user)
                return (f"已存入知识库: 《{r['title']}》 (id={r['id']}, "
                        f"kb={r['kb']}, {r['chunks']} 个块, "
                        f"{'AI 总结后' if r['summarized'] else '原文'}入库)。"
                        "之后 AI 检索知识库时即可命中该文档。")
            except PermissionError as e:
                return f"权限不足: {e}"
            except ValueError as e:
                return f"参数错误: {e}"
            except Exception as e:
                return f"知识库入库失败: {e}"

        else:
            return f"未知工具: {name}"
    except subprocess.TimeoutExpired:
        return "命令超时"
    except Exception as e:
        return f"执行失败: {e}"


def stream_agent(messages, system="", max_tokens=4096, max_iterations=6,
                 caller="ai_agent", user=None, perms=None):
    """Agentic loop: stream LLM with tools, execute tools, continue.

    Yields (kind, data) chunks where kind is:
      - "reasoning": thinking text (incremental)
      - "content": response text (incremental)
      - "tool_call": complete tool call {"id", "name", "arguments"}
      - "tool_result": tool execution result {"tool_call_id", "name", "result"}

    perms: the caller's user dict (recommended — enables pod-level checks)
    or an iterable of permission strings. Tools are filtered by TOOL_PERMS
    before being offered to the LLM, and re-checked in _execute_tool.
    With perms=None only login-free tools are available.
    """
    allowed_tools = tools_for(perms)
    for iteration in range(max_iterations):
        tool_calls_pending = []
        content_parts = []

        try:
            stream = llm.stream_chat_with_tools(
                messages, system=system, max_tokens=max_tokens,
                tools=allowed_tools, caller=caller, user=user,
            )
        except llm.LLMError as e:
            # Fallback: if tools not supported, use regular stream
            try:
                stream = llm.stream_chat(
                    messages, system=system, max_tokens=max_tokens,
                    caller=caller, user=user,
                )
            except llm.LLMError:
                yield ("content", f"LLM 错误: {e}")
                return

        has_tool_calls = False
        for kind, data in stream:
            if kind == "reasoning":
                yield ("reasoning", data)
            elif kind == "content":
                content_parts.append(data)
                yield ("content", data)
            elif kind == "tool_call_done":
                has_tool_calls = True
                tool_calls_pending.append(data)
                yield ("tool_call", data)

        # If no tool calls, the agent is done
        if not has_tool_calls:
            break

        # Build assistant message with tool_calls for history
        assistant_msg = {"role": "assistant", "content": "".join(content_parts)}
        if tool_calls_pending:
            assistant_msg["tool_calls"] = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": json.dumps(tc["arguments"], ensure_ascii=False),
                    },
                }
                for tc in tool_calls_pending
            ]
        messages.append(assistant_msg)

        # Execute each tool call and yield results
        for tc in tool_calls_pending:
            result = _execute_tool(tc["name"], tc["arguments"], user=perms)
            result_data = {
                "tool_call_id": tc["id"],
                "name": tc["name"],
                "result": result,
            }
            yield ("tool_result", result_data)
            # Add tool result to messages for next iteration
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })
