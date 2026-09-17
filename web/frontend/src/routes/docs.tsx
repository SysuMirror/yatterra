import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  BookOpen, Terminal, Database, Globe, Bot, Folder, Shield, Code,
  Server, HardDrive, Key, Users, Activity, ChevronRight, ArrowRight,
  Cpu, Container, Cloud, Lock, Webhook, FileText, Layers,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { cn } from '@/lib/cn'
import { useAuth } from '@/hooks/useAuth'
import { DOMAIN } from '@/lib/site'

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

interface DocSection {
  id: string
  title: string
  icon: React.ReactNode
  items: DocItem[]
  /** 仅管理员（infra.* / ops.* / * 权限）可见的章节 */
  staffOnly?: boolean
}

interface DocItem {
  title: string
  content: React.ReactNode
}

const CODE = (s: string) => <code className="px-1.5 py-0.5 rounded bg-black/[0.05] text-[13px] font-mono text-ink">{s}</code>
const PRE = (s: string) => (
  <pre className="mb-3 overflow-x-auto rounded-lg bg-black/[0.04] px-4 py-3 text-[12.5px] leading-relaxed font-mono text-ink whitespace-pre">{s}</pre>
)
const LINK = (label: string, href: string) => <a href={href} className="text-accent hover:underline inline-flex items-center gap-1">{label}<ArrowRight size={12} /></a>
const P = (...children: React.ReactNode[]) => <p className="text-sm text-ink-2 leading-relaxed mb-3">{children}</p>
const H4 = (s: string) => <h4 className="text-sm font-semibold text-ink mb-2 mt-4">{s}</h4>
const UL = (...items: React.ReactNode[]) => <ul className="list-disc list-inside text-sm text-ink-2 space-y-1 mb-3 ml-1">{items.map((i, idx) => <li key={idx}>{i}</li>)}</ul>
const TB = ({ headers, rows }: { headers: string[]; rows: string[][] }) => (
  <div className="overflow-x-auto mb-3 -mx-1 px-1">
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-black/[0.06]">
          {headers.map((h, i) => <th key={i} className="text-left py-2 pr-4 text-xs font-semibold text-muted whitespace-nowrap">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} className="border-b border-black/[0.03]">
            {row.map((cell, ci) => <td key={ci} className="py-1.5 pr-4 text-ink-2 whitespace-nowrap">{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const sections: DocSection[] = [
  /* ================================================================ */
  /*  1. 快速开始                                                      */
  /* ================================================================ */
  {
    id: 'quickstart',
    title: '快速开始',
    icon: <BookOpen size={16} />,
    items: [
      {
        title: '登录',
        content: (
          <>
            {P('平台支持三种登录方式：')}
            {UL(
              <>用户名 + 密码 — 管理员分配的本地账号</>,
              <>SSE Market OAuth — 通过 {DOMAIN} 账号登录</>,
              <>UniSSO OAuth — 通过统一身份认证登录</>,
              <>游客访问 — 只读权限，无需账号</>,
            )}
            {P('登录后进入概览仪表盘，展示集群运行状态、资源使用和最近活动。')}
          </>
        ),
      },
      {
        title: '创建 Pod',
        content: (
          <>
            {P('Pod 是平台的基本运行单元，对应一个 K3s 上的容器环境。')}
            {H4('操作步骤')}
            {UL(
              <>进入 {LINK('Pod 列表', '/pods')}，点击「创建 Pod」</>,
              <>填写名称（小写字母、数字、短横线）</>,
              <>配置资源：CPU 核数、内存 (GB)、GPU 数量、存储 (GB)</>,
              <>点击创建，自动跳转到 Pod 详情页</>,
            )}
            {H4('资源规格说明')}
            {TB({
              headers: ['参数', '说明', '默认值'],
              rows: [
                ['CPU', '分配的 CPU 核数', '2'],
                ['内存', '分配的内存 (GB)', '4'],
                ['GPU', '挂载的 GPU 数量 (0=无)', '0'],
                ['存储', '持久化存储大小 (GB)', '20'],
              ],
            })}
          </>
        ),
      },
      {
        title: '连接 Pod',
        content: (
          <>
            {P('进入 Pod 详情页后，可通过以下方式连接：')}
            {UL(
              <>Web 终端 — 点击「终端」标签页，直接在浏览器中打开 Shell</>,
              <>SSH — 在「凭证」标签页查看 SSH 连接信息和密码</>,
              <>文件管理 — 在「文件」标签页浏览、编辑、上传文件</>,
            )}
            {P('终端基于 Socket.IO 实时连接，支持多会话。')}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  2. Pod 管理                                                      */
  /* ================================================================ */
  {
    id: 'pods',
    title: 'Pod 管理',
    icon: <Container size={16} />,
    items: [
      {
        title: 'Pod 生命周期',
        content: (
          <>
            {P('Pod 有以下状态：')}
            {TB({
              headers: ['状态', '说明', '可执行操作'],
              rows: [
                ['Running', '容器运行中', '停止 / 重启'],
                ['Stopped', '容器已停止', '启动 / 删除'],
                ['Pending', '正在创建或调度', '—'],
                ['Failed', '启动失败', '启动 / 删除'],
                ['Succeeded', '任务完成（一次性 Pod）', '—'],
              ],
            })}
          </>
        ),
      },
      {
        title: 'Pod 详情标签页',
        content: (
          <>
            {P('每个 Pod 包含 8 个标签页：')}
            {TB({
              headers: ['标签', '功能'],
              rows: [
                ['监控', 'CPU / 内存实时曲线，历史指标图表'],
                ['终端', 'Web Shell 终端（Socket.IO）'],
                ['文件', '文件浏览器 + 代码编辑器'],
                ['日志', '容器标准输出日志流'],
                ['凭证', '数据库 / MinIO 连接信息'],
                ['部署', '应用部署配置与运行管理'],
                ['成员', 'Pod 成员邀请 / 审批 / 移除'],
                ['设置', 'Pod 配置、资源调整、重置密码'],
              ],
            })}
          </>
        ),
      },
      {
        title: '成员与权限',
        content: (
          <>
            {P('Pod 支持多人协作，角色分为：')}
            {TB({
              headers: ['角色', '权限'],
              rows: [
                ['owner（负责人）', '全部操作，包括删除 Pod、管理成员'],
                ['member（成员）', '使用 Pod（终端、文件、查看凭证）'],
                ['admin / super', '平台级管理权限，可操作所有 Pod'],
              ],
            })}
            {P('负责人可通过「成员」标签页邀请其他用户，被邀请人需在成员列表中审批加入。')}
          </>
        ),
      },
      {
        title: '部署管理',
        content: (
          <>
            {P('每个 Pod 支持多个部署（Deploy），每个部署定义一个应用运行配置：')}
            {UL(
              <>名称 + 启动命令 + 端口映射</>,
              <>支持启动 / 停止 / 查看日志 / 浏览文件</>,
              <>部署独立于 Pod 生命周期，可单独启停</>,
            )}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  3. 基础设施                                                      */
  /* ================================================================ */
  {
    id: 'infra',
    title: '基础设施',
    icon: <Database size={16} />,
    items: [
      {
        title: '主机监控',
        content: (
          <>
            {P(LINK('主机健康', '/infra/host') + ' 页面展示集群节点实时状态：')}
            {UL(
              <>主机名 / 操作系统 / 内核版本 / 架构</>,
              <>CPU 核数与负载（1 分钟 / 5 分钟 / 15 分钟）</>,
              <>内存使用率与总量、Swap</>,
              <>磁盘分区使用率</>,
              <>GPU 型号、显存、温度、利用率</>,
              <>K3s 节点数与版本、Pod 总数与运行数</>,
              <>远程主机状态监控（经 SSH 中继采集，不参与 k3s 调度）</>,
            )}
            {P('数据每 10 秒自动刷新。')}
            {H4('主机集群（多机总览）')}
            {P(LINK('主机集群', '/infra/fleet') + ' 页面把本机与所有远程主机汇总成一张总览：')}
            {UL(
              <>每台主机的在线 / 离线 / 数据陈旧状态</>,
              <>CPU 使用率、内存使用率、系统负载的时序曲线（15m / 1h / 6h / 24h / 7d）</>,
              <>单机 GPU 利用率 / 显存 / 温度曲线，可按 GPU 筛选</>,
              <>采样由 {CODE('yatterra-fleet-sampler')} 服务每 15 秒写入 SQLite，保留 7 天</>,
            )}
            {P('页面顶部有「集群健康洞察」AI 摘要，由后台线程预计算并缓存，打开即见。')}
          </>
        ),
      },
      {
        title: '对象存储 (MinIO)',
        content: (
          <>
            {P(LINK('对象存储', '/infra/storage') + ' 提供 S3 兼容的对象存储服务：')}
            {UL(
              <>创建 / 删除 Bucket</>,
              <>管理 Access Key / Secret Key</>,
              <>连接信息自动注入 Pod 凭证</>,
            )}
            {P('MinIO 控制台可通过独立端口访问，平台内可管理 Bucket 和密钥。')}
          </>
        ),
      },
      {
        title: '数据库服务',
        content: (
          <>
            {P(LINK('数据库', '/infra/databases') + ' 支持三种数据库服务：')}
            {TB({
              headers: ['服务', '默认端口', '用途'],
              rows: [
                ['MySQL', '3306', '关系型数据存储'],
                ['Redis', '6379', '缓存 / 消息队列'],
                ['Qdrant', '6333', '向量数据库（RAG / 嵌入检索）'],
              ],
            })}
            {P('可创建独立凭证，连接字符串自动生成。Pod 内可通过服务名 + 端口直连。')}
          </>
        ),
      },
      {
        title: '子域名反代',
        content: (
          <>
            {P(`子域名反代把 {前缀}.${DOMAIN} 映射到某个 Pod 的公网端口，外部可直接通过域名访问 Pod 内运行的 Web 服务。当前为 Pod 绑定模式：每条映射归属于一个 Pod。`)}
            {H4('自助管理（Pod 成员即可）')}
            {UL(
              <>进入自己的 Pod 详情页，切换到「子域名」标签页</>,
              <>点击「添加子域名」，只填一个前缀 —— 端口自动绑定到本 Pod 的公网端口（优先 Web 端口）</>,
              <>已有映射可「改前缀」（重命名）而无需删除重建，端口与归属保持不变</>,
              <>可停用 / 启用、删除自己的映射</>,
              <>只能看到并管理本 Pod 的映射，看不到别人的</>,
              <>保留前缀（ssemarket、www、cloud、sso、admin、iwiki）不可占用；前缀仅允许小写字母、数字、连字符</>,
            )}
            {H4('管理员全局管理')}
            {UL(
              <>管理员在 {LINK('子域名反代', '/infra/proxy')} 页面可查看并管理所有映射</>,
              <>未绑定到任何 Pod 的历史映射仅管理员可见和编辑</>,
              <>底层由平台通过 SSH 重写公网服务器 nginx_proxy 容器配置并自动 reload，配置校验失败会自动回滚</>,
            )}
            {P(`格式：{前缀}.${DOMAIN} → Pod 公网端口。`)}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  4. 开发工具                                                      */
  /* ================================================================ */
  {
    id: 'dev',
    title: '开发工具',
    icon: <Bot size={16} />,
    items: [
      {
        title: 'AI 助手（悬浮窗）',
        content: (
          <>
            {P('右下角的悬浮按钮打开 AI 助手，可在对话中直接执行工具（跑命令、读写文件、查 K8s、联网搜索）。')}
            {H4('助手类型')}
            {TB({
              headers: ['助手', '运行位置', '用途'],
              rows: [
                ['运维助手', '平台宿主机 (root)', 'K3s 运维、日志排查、资源监控'],
                ['编程助手', '组容器内 (cloud)', '代码开发调试、构建、测试'],
                ['数据库助手', '平台宿主机 (root)', 'MySQL / Redis / Qdrant 运维'],
                ['存储助手', '平台宿主机 (root)', 'MinIO 桶、密钥、容量'],
                ['网络助手', '平台宿主机 (root)', 'frp 隧道、端口连通性'],
                ['GPU 助手', '平台宿主机 (root)', 'GPU 利用率、显存、占用'],
                ['Web 助手', '组容器内 (cloud)', 'Web 应用开发调试'],
                ['训练助手', '组容器内 (cloud)', '模型训练、loss、checkpoint'],
              ],
            })}
            {H4('在 Pod 内运行的助手需要先选 Pod')}
            {UL(
              <>编程 / Web / 训练助手运行在你的组容器里，顶部会出现 Pod 下拉框</>,
              <>下拉框只列出你有权限访问的 Pod，默认选中第一个运行中的</>,
              <>没有可用 Pod 时无法发送，会提示先选择 Pod</>,
            )}
            {H4('能力')}
            {UL(
              <>并行子任务（spawn）—— 多文件 / 多目标时自动拆分成子 agent 并发执行</>,
              <>跨会话记忆（memory_save / memory_load）—— 记住项目结构、上次排查结论</>,
              <>联网搜索与网页抓取（web_search / fetch_url）</>,
              <>图片理解（vision）—— 可直接粘贴截图提问</>,
              <>长会话自动压缩上下文，避免超出模型窗口</>,
            )}
            {P('会话可保存 / 切换 / 删除，历史记录按助手类型与用户隔离。')}
          </>
        ),
      },
      {
        title: 'Agent 编排',
        content: (
          <>
            {P(LINK('Agent 编排', '/dev/harness') + ' 管理和运行 AI Agent：')}
            {UL(
              <>查看已配置的 Agent 列表及其定义</>,
              <>选择 Agent + Harness 运行</>,
              <>支持流式输出（SSE）</>,
              <>查看 / 删除历史会话</>,
            )}
            {P('Agent 定义保存在服务端 agents.json，包括提示词、工具开关、runner（宿主机 / Pod）与挂载的 MCP 服务。')}
            {P('自定义提示词会替换内置提示词，平台会自动把内置的工具清单与 ACTION 输出协议追加在后面，因此自定义提示词不必重复写工具说明。')}
          </>
        ),
      },
      {
        title: 'MCP 服务器',
        content: (
          <>
            {P(LINK('MCP 服务器', '/dev/mcp') + ' 管理 Model Context Protocol 服务器：')}
            {UL(
              <>添加 MCP 服务器（名称 + 命令 + 参数 + 环境变量）</>,
              <>启用 / 禁用服务器</>,
              <>编辑服务器配置</>,
              <>删除服务器</>,
            )}
            {P('MCP 服务器为 AI Agent 提供外部工具和数据访问能力。')}
          </>
        ),
      },
      {
        title: '共享目录',
        content: (
          <>
            {P(LINK('共享目录', '/ops/shared') + ' 提供跨 Pod 的文件共享：')}
            {UL(
              <>根目录：/mnt/sdb/shared</>,
              <>浏览目录、查看文件内容（代码编辑器）</>,
              <>面包屑导航 + 返回上级</>,
              <>创建子目录</>,
              <>上传文件</>,
            )}
            {P('典型用途：存放模型权重文件、数据集、配置文件等需要跨 Pod 共享的资源。')}
            {P('Pod 内可通过挂载路径直接访问共享目录。')}
          </>
        ),
      },
      {
        title: 'LLM 服务',
        content: (
          <>
            {P(LINK('LLM 服务', '/dev/llm') + ' 管理平台所有 AI 能力背后的模型提供方：')}
            {UL(
              <>添加 / 编辑 / 删除 Provider（名称、Base URL、API Key、模型名、上下文长度）</>,
              <>设置默认 Provider —— 平台所有 AI 功能（洞察、助手、编排）都用它</>,
              <>启用 / 禁用 Provider，禁用后不会被选中</>,
              <>查看用量统计（按天、按组件、按用户）</>,
            )}
            {H4('兼容性')}
            {P('Provider 需兼容 OpenAI 的 ' + CODE('/v1/chat/completions') + ' 接口（流式 SSE）。平台会读取 ' + CODE('delta.reasoning') + ' 作为思考过程单独展示，' + CODE('delta.content') + ' 作为正式回答。')}
            {H4('上下文长度')}
            {P('请如实填写模型的真实上下文窗口 —— 平台据此决定何时压缩长会话。填大了会导致长对话被上游拒绝（400 超出上下文）。')}
            {H4('并发与重试')}
            {UL(
              <>环境变量 {CODE('LLM_MAX_CONCURRENCY')} 限制同时进行的模型调用数（默认 4），避免并行子 agent 压垮推理服务</>,
              <>环境变量 {CODE('LLM_MAX_RETRIES')} 控制连接失败 / 5xx 的重试次数（默认 4，指数退避）</>,
              <>流式传输中途断开不会重试（避免重复输出），会提示「LLM 流中断，自动重试」</>,
            )}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  5. 运维管理                                                      */
  /* ================================================================ */
  {
    id: 'ops',
    title: '运维管理',
    icon: <Shield size={16} />,
    items: [
      {
        title: '审计日志',
        content: (
          <>
            {P(LINK('审计日志', '/ops/audit') + ' 记录平台所有操作：')}
            {UL(
              <>操作类型：create / start / stop / delete / login / mkdir / update …</>,
              <>记录操作者、时间、详情</>,
              <>支持按操作者、操作类型筛选</>,
              <>时间范围：今天 / 7 天 / 30 天 / 全部</>,
              <>分页浏览</>,
            )}
          </>
        ),
      },
      {
        title: '用户管理',
        content: (
          <>
            {P(LINK('用户管理', '/users') + ' 管理平台用户账号：')}
            {TB({
              headers: ['角色', '说明'],
              rows: [
                ['super', '超级管理员，拥有全部权限'],
                ['admin', '管理员，可管理用户和 Pod'],
                ['owner', 'Pod 负责人'],
                ['user', '普通用户'],
                ['guest', '访客，只读权限'],
              ],
            })}
            {P('可创建 / 编辑 / 删除用户，分配角色。')}
          </>
        ),
      },
      {
        title: '威胁地图',
        content: (
          <>
            {P(LINK('威胁地图', '/threat-map') + ' 展示安全威胁实时态势：')}
            {UL(
              <>攻击来源分布（按国家/地区柱状图）</>,
              <>蜜罐统计：攻击 IP / 正常访问 / 已封禁 / 连接总数</>,
              <>攻击模式分布（暴力破解、扫描、注入等）</>,
              <>威胁事件列表：IP / 城市 / 次数 / 模式 / 入口 / 响应 / 时间</>,
              <>时间窗口：1h / 3h / 1d / 3d / 7d / 全部</>,
            )}
            {P('数据每 30 秒自动刷新。')}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  6. 运维知识（仅管理员参考）                                        */
  /* ================================================================ */
  {
    id: 'ops-knowledge',
    title: '运维知识（仅管理员参考）',
    icon: <Terminal size={16} />,
    staffOnly: true,
    items: [
      {
        title: `中继网络架构（${DOMAIN} 公网中继）`,
        content: (
          <>
            {P(`集群内各机器分布在不同内网，互相直连不通，统一通过公网服务器 ${DOMAIN} 做中继：SSH 跳板和 frp 隧道都走 ${DOMAIN} 的公网端口转发。`)}
            {H4('要点')}
            {UL(
              <>连接内部机器一律走 {DOMAIN} 中继（SSH 经跳板端口、frp 经公网端口），不要使用 Tailscale 的 100.x 地址——Tailscale 网络在节点间经常不通，只作为备用</>,
              <>DGX 服务器（主机名 spark-b973）通过 {DOMAIN}:2223 端口 SSH 登录</>,
              <>公网服务器上有 fail2ban 和云镜防火墙（YJ-FIREWALL），两者都有 IP 白名单：换办公网络或新增出口 IP 后连不上 SSH，先检查是否被 fail2ban 封禁、再把新 IP 加入白名单</>,
            )}
            {H4('排障思路')}
            {P('SSH 连接超时/拒绝：先确认本机出口 IP 是否在 fail2ban 与云镜白名单内；再确认中继端口（如 2223）是否可达；最后才排查目标机器本身。不要一上来就怀疑 Tailscale 或目标机配置。')}
          </>
        ),
      },
      {
        title: '公网入口 nginx（nginx_proxy 容器）',
        content: (
          <>
            {P(`所有 *.${DOMAIN} 公网入口由公网服务器上的 nginx_proxy 容器承担，平台相关的子域名配置写在 custom.conf 中，由平台通过 SSH 远程管理。`)}
            {H4('关键坑：sed -i 换 inode')}
            {P('如果在容器宿主机上用 sed -i 直接修改挂载进容器的配置文件，sed 会创建新文件再改名，inode 发生变化；容器内进程仍持有旧 inode 的文件句柄，看到的内容不会更新，reload 也不会生效。')}
            {H4('正确做法')}
            {UL(
              <>改完配置后必须重启容器（docker restart），而不是只 reload nginx</>,
              <>或者使用不换 inode 的原地写法（如 echo 重定向、vim 保存）</>,
              <>平台自身的子域名映射由 /proxy 页面自动管理，会整段重写标记区内的配置并校验后 reload，无需手工编辑</>,
            )}
          </>
        ),
      },
      {
        title: 'frp 0.68 配置语法',
        content: (
          <>
            {P('内网服务的公网暴露大量使用 frp（frpc/frps），当前版本 0.68。该版本的配置语法与老版本差异较大，照抄网上旧教程会直接启动失败。')}
            {H4('要点')}
            {UL(
              <>连接池参数是 transport.poolCount（客户端）和 transport.maxPoolCount（服务端），不是老版本的 pool.count——用旧写法 frpc 会报未知字段拒绝启动</>,
              <>建议启用 transport.tls 和 transport.tcpMux，公网传输加密且复用单条 TCP 连接</>,
              <>改完配置先 frpc verify（或看启动日志）确认无未知字段报错，再正式运行</>,
            )}
          </>
        ),
      },
      {
        title: '组容器自愈机制',
        content: (
          <>
            {P('cloud-ubuntu 类组容器内部用 supervisord 管理常驻服务，配置位于 deploy/supervisord.conf。容器重启后 supervisord 由入口进程自动拉起，再把各服务（SSH、应用等）按配置自动启动，实现“Pod 重启即恢复”。')}
            {H4('维护要点')}
            {UL(
              <>要让组容器内某服务开机自启，把它加进 deploy/supervisord.conf 即可，不要依赖手工 nohup</>,
              <>gpt-proxy、sseapi 等服务使用 compose.sh 启动脚本和 wrapper 包装，存在权限坑：脚本/wrapper 的属主与可执行位不对时启动静默失败，排查时先 ls -l 检查脚本权限</>,
              <>服务没起来时先看 supervisord 日志和各服务自己的日志文件，再决定是否重启 Pod</>,
            )}
          </>
        ),
      },
      {
        title: 'Pod requests 自动估算（EWMA）',
        content: (
          <>
            {P('问题背景：如果 Pod 的 k8s requests 直接取用户填写的资源值，大量闲置 Pod 会把节点 CPU 预留耗尽，导致新 Pod 一直 Pending，报 "Insufficient cpu"，而节点实际几乎空闲。')}
            {H4('平台方案')}
            {UL(
              <>limits 保留用户设定的值（硬上限，允许突发）</>,
              <>requests 按实际用量的 EWMA（指数加权滑动平均）自动估算：CPU 为 EWMA × 1.3，内存为 EWMA × 1.4（内存不可压缩，留更多余量），下限 0.5 核 / 512Mi，无历史数据时取 limits 的一半</>,
              <>自动调和只降不升：稳态运行会逐步下调闲置 Pod 的 requests 释放调度空间；上调发生在用户 resize/重启时按最新 EWMA 重新计算</>,
              <>状态持久化在 /opt/yatterra/req_estimates.json</>,
            )}
            {H4('判断与处理')}
            {P('新 Pod 卡 Pending 且事件显示 Insufficient cpu：这是旧的 requests 过高预留导致的，等估算循环下调即可恢复；不要通过删除别的 Pod 来腾位置。')}
          </>
        ),
      },
      {
        title: '压力降级分层（terra → sdpy → app）',
        content: (
          <>
            {P('主机高负载时按三层协作降级，避免整机卡死：terra 层写压力信号，sdpy 层应用自降级，app 层兜底驱逐。')}
            {H4('机制')}
            {UL(
              <>压力信号：pressure_writer 每 2 秒把主机 CPU/GPU/内存/带宽压力写入 hostPath 共享文件 /mnt/sdb/shared/pressure/pressure.json</>,
              <>应用自降级：应用读取压力文件，压力升高时主动降低自己的吞吐（sdpy 层）</>,
              <>兜底驱逐：priority_kill 循环按 PRIORITY 环境变量驱逐低优先级程序。每个程序组部署时带 PRIORITY=critical / normal / best_effort；压力越过高阈值（默认 0.80）先停 best_effort，越过临界阈值（默认 0.92）再停 normal，critical 永不动</>,
              <>驱逐打分：priority_weight × (0.1 + 资源占比)，低优先级且占用大的先被停；压力回落并稳定 30 秒后按相反顺序自动恢复（带回滞与冷却）</>,
              <>非 GPU 程序忽略 GPU 压力，只受 CPU/内存/带宽压力驱逐</>,
            )}
            {H4('使用')}
            {P('部署新程序时在组的环境变量里声明 PRIORITY，可牺牲的服务标 best_effort。驱逐状态与日志在 /opt/yatterra/priority_kill_state.json 和 priority_kill.log。')}
          </>
        ),
      },
      {
        title: 'Service Worker 与 OAuth 登录回调的坑',
        content: (
          <>
            {P('平台是 PWA，前端 Service Worker 用 Workbox 的 NavigationRoute 拦截页面导航请求并回退到 SPA 入口（index.html）。')}
            {H4('问题')}
            {P('OAuth 登录回调（/oauth/...）和 API 请求（/api/...）本质是“导航/请求”路径，如果被 NavigationRoute 拦截，会被当成 SPA 路由吞掉，返回前端 404 页面，表现为“OAuth 登录后跳到 404”。')}
            {H4('处理')}
            {UL(
              <>Service Worker 的 NavigationRoute 必须把 /api/ 和 /oauth/ 加入 denylist，让这些请求直接穿透到后端</>,
              <>修改 sw.ts 后要注意 SW 更新有缓存延迟，验证时可先 unregister 旧 SW 再刷新</>,
              <>以后新增后端页面型路径（非 SPA 路由）时，同样要评估是否需要加进 denylist</>,
            )}
          </>
        ),
      },
      {
        title: 'MinIO 对象存储使用规范',
        content: (
          <>
            {P('集群内 MinIO 服务端点为 http://minio.platform-infra.svc.cluster.local:9000（仅集群内可访问），Pod 内程序用这个地址连接。')}
            {H4('凭证规范')}
            {UL(
              <>组内一律使用桶级 access key（一个 key 只授权一个桶），由平台在存储页/凭证页发放</>,
              <>严禁把 MinIO root 凭证下发给普通用户或写进用户代码——root 凭证能读写所有桶</>,
              <>root 凭证仅管理员使用，存放在服务器 /opt/yatterra/minio.conf</>,
            )}
            {H4('排障')}
            {P('Pod 内连不上 MinIO：先确认 Pod 与 MinIO 在同一集群且用集群内服务名（不要用公网地址或 127.0.0.1）；再确认 access key 对应的桶名没写错。')}
          </>
        ),
      },
      {
        title: '子域名反代与 Pod 绑定',
        content: (
          <>
            {P(`{子域}.${DOMAIN} 由平台自动映射到对应 Pod 的公网端口。映射采用 Pod 绑定模式：每条映射归属于一个 Pod。`)}
            {H4('自助管理（成员/owner）')}
            {UL(
              <>进入自己 Pod 的详情页，在「子域名」标签页添加/删除映射，需要 owner 权限</>,
              <>选择要暴露的端口，填写子域前缀即可，平台自动生成 nginx 配置并 reload</>,
            )}
            {H4('全局管理（管理员）')}
            {UL(
              <>所有映射（含未绑定 Pod 的历史映射）在 /infra/proxy 页面统一查看和管理</>,
              <>底层实现：平台通过 SSH 重写公网服务器 nginx_proxy 容器配置文件中固定标记段内的 server 块，nginx -t 校验通过才 reload，失败自动回滚</>,
              <>权威状态文件为 /opt/yatterra/proxy_mappings.json</>,
            )}
          </>
        ),
      },
      {
        title: 'MySQL 连接坑（REPEATABLE READ 与连接池）',
        content: (
          <>
            {P('MySQL 默认隔离级别是 REPEATABLE READ：事务内第一条查询会建立一致性快照，之后不 commit 就一直读旧快照。pymysql 连接池里的连接是复用的，如果某次使用后没有 commit，该连接会带着旧快照回到池里，之后借出时读到的是陈旧数据，表现为“明明写入了却查不到新数据”。')}
            {H4('平台处理')}
            {P('平台已全局设置连接参数 autocommit=True，池内连接不会持有旧快照。')}
            {H4('自己写脚本连库时')}
            {UL(
              <>连接参数加 autocommit=True，或者严格保证每次查询后 commit/rollback</>,
              <>出现“读不到刚写入的数据”时，先怀疑连接池快照问题，换新连接或 commit 后重试即可验证</>,
            )}
          </>
        ),
      },
      {
        title: 'API Bearer Token（脚本调用 API）',
        content: (
          <>
            {P('除浏览器 Session Cookie 外，平台支持个人 API Token，适合脚本、CI、命令行调用 REST API。')}
            {H4('获取与使用')}
            {UL(
              <>在「用户管理」页面的 Token 面板生成个人 Token（任何登录用户均可管理自己的 Token）</>,
              <>API 端点：GET/POST /api/tokens 列出与创建，DELETE /api/tokens/:id 删除</>,
              <>调用时在请求头带 {CODE('Authorization: Bearer <token>')}</>,
            )}
            {H4('注意')}
            {P('Token 只在创建时完整显示一次，请立即保存；泄露的 Token 直接删除重建即可。')}
          </>
        ),
      },
      {
        title: '权限体系',
        content: (
          <>
            {P('平台角色分四级：super（超级管理员）、admin（管理员）、user（普通用户）、guest（游客，只读）。每个角色对应的具体权限组可在个人管理页查看。')}
            {H4('可见性规则')}
            {UL(
              <>基础设施页面（存储 /infra/storage、数据库 /infra/databases、子域名 /infra/proxy、主机 /infra/host）仅管理员可见</>,
              <>普通用户只能看到自己的 Pod，不能看到他人 Pod 和基础设施</>,
              <>Pod 级另有 owner / member 之分：owner 可删除 Pod、管理成员和子域名，member 只能使用</>,
            )}
            {H4('排障')}
            {P('用户反馈“看不到某页面”：先确认其角色是否达到该页面的权限要求，再检查是否被降级为 guest。')}
          </>
        ),
      },
      {
        title: '已知模型问题：Ling-3.0-tiny-int4 在 4090 上损坏',
        content: (
          <>
            {P('Ling-3.0-tiny-int4 模型在 RTX 4090（Ada 架构）上运行时前向传播结果损坏，输出恒定为乱码 token。这是该模型 fork 结构与 Ada 架构的兼容性问题，不是配置、量化或驱动问题。')}
            {H4('判断特征')}
            {UL(
              <>模型能正常加载、显存占用正常、不报任何错误</>,
              <>但无论输入什么 prompt，输出都是固定的乱码 token</>,
            )}
            {H4('处理')}
            {P('避免在 4090（Ada）机器上部署 Ling-3.0-tiny-int4；换其他模型或其他架构的 GPU。遇到“加载正常但输出恒定乱码”的现象，可优先怀疑模型与 GPU 架构不兼容，不要在配置上浪费时间。')}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  6.5 知识库与 AI 沉淀（仅管理员）                                   */
  /* ================================================================ */
  {
    id: 'ai-kb',
    title: '知识库与 AI 沉淀',
    icon: <Layers size={16} />,
    staffOnly: true,
    items: [
      {
        title: '概念：RAG 知识库',
        content: (
          <>
            {P('平台 AI 助手自带知识库检索（RAG）：对话时自动检索与问题相关的知识片段，注入到回答中，让 AI 能引用平台沉淀的运维经验和文档。')}
            {H4('两个知识库')}
            {UL(
              <>公共库 — 全员可检索，内容来自平台文档</>,
              <>运维库 — 仅具有 infra.* / ops.* 权限的用户可检索，存放排障经验、配置写法等运维知识</>,
            )}
            {P('AI 对话时无需手动指定库：助手会按当前用户权限自动检索相关片段并引用到回答里。')}
          </>
        ),
      },
      {
        title: '方式一：对话中让 AI 自动总结入库（推荐）',
        content: (
          <>
            {P('排障结束或写完一段配置后，直接对 AI 助手说一句话即可，例如：')}
            {PRE('把我们刚才排查 MinIO 连接超时的过程总结进知识库')}
            {P('AI 会自动把对话提炼成结构化文档（问题现象 / 定位过程 / 处理命令 / 结论），并调用 save_knowledge 工具写入知识库。之后所有人问相关问题时，AI 都能检索并引用这段经验。')}
            {H4('权限要求')}
            {P('入库操作需要 infra.host 或 ops.audit 权限。')}
          </>
        ),
      },
      {
        title: '方式二：API 上传',
        content: (
          <>
            {P('通过 REST 接口上传文档到知识库：')}
            {PRE(`POST /api/ai/kb/docs
Content-Type: application/json

{"title": "...", "content": "...", "kb": "ops"|"public", "summarize": true|false}`)}
            {UL(
              <>summarize=true 时，服务端 AI 会先自动总结内容再入库</>,
              <>kb=public（写入公共库）需要管理员权限；kb=ops 需 infra/ops 权限</>,
            )}
            {H4('curl 示例')}
            {PRE(`curl -X POST /api/ai/kb/docs \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "MinIO 连接超时排查",
    "content": "（原始排障笔记全文……）",
    "kb": "ops",
    "summarize": true
  }'`)}
            {P('Token 在个人页通过 /api/tokens 生成，调用时放在 Authorization: Bearer 请求头中。上面的例子即「上传原始排障笔记、让服务端 AI 总结后入库」的典型用法。')}
            {H4('配套接口')}
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['GET', '/api/ai/kb/docs', '查看知识库文档列表'],
                ['DELETE', '/api/ai/kb/docs/:id', '删除指定文档'],
                ['POST', '/api/ai/kb/ingest', '全量重建索引'],
                ['GET', '/api/ai/kb/status', '查看知识库状态'],
              ],
            })}
          </>
        ),
      },
      {
        title: '入库后何时生效',
        content: (
          <>
            {UL(
              <>通过 API 或对话增量上传的文档立即生效，上传完即可被检索</>,
              <>docs 页「平台文档」部分的内容改动后，需要调用一次 POST /api/ai/kb/ingest 重建索引才会生效</>,
            )}
          </>
        ),
      },
      {
        title: '写好知识的小建议',
        content: (
          <>
            {UL(
              <>一段只讲一个主题，标题写清问题本身</>,
              <>带上具体的命令、路径和配置片段，而不是只写描述</>,
              <>写清「怎么判断」和「怎么处理」：先给判断特征，再给处理步骤</>,
            )}
            {P('按这些习惯写，AI 的检索命中率和总结质量都会明显更好。')}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  7. 个人管理                                                      */
  /* ================================================================ */
  {
    id: 'profile',
    title: '个人管理',
    icon: <Users size={16} />,
    items: [
      {
        title: '账户设置',
        content: (
          <>
            {P(LINK('个人管理', '/profile') + ' 页面提供：')}
            {UL(
              <>查看用户名、角色、权限数</>,
              <>修改登录密码</>,
              <>身份绑定 — 关联 SSE Market 或 UniSSO 账号</>,
              <>解绑已关联的身份</>,
            )}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  7. API 参考                                                      */
  /* ================================================================ */
  {
    id: 'api',
    title: 'API 参考',
    icon: <Code size={16} />,
    items: [
      {
        title: '认证',
        content: (
          <>
            {P('所有 API 端点以 /api 前缀开头，支持两种认证方式：')}
            {UL(
              <>Session Cookie — 登录后自动设置，浏览器请求默认携带</>,
              <>Bearer Token — 在 Authorization 头传入 {CODE('Bearer <token>')}</>,
            )}
            {H4('认证端点')}
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['POST', '/api/auth/login', '用户名密码登录'],
                ['POST', '/api/auth/guest', '游客登录'],
                ['POST', '/api/auth/logout', '登出'],
                ['GET', '/api/auth/me', '获取当前用户信息'],
                ['GET', '/api/auth/oauth/ssemarket', 'SSE Market OAuth 登录'],
                ['GET', '/api/auth/oauth/unisso', 'UniSSO OAuth 登录'],
              ],
            })}
          </>
        ),
      },
      {
        title: 'Pod',
        content: (
          <>
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['GET', '/api/pods', 'Pod 列表（?search=&status=&per_page=）'],
                ['POST', '/api/pods', '创建 Pod {name,cpu,mem,gpus,storage}'],
                ['GET', '/api/pods/:name', 'Pod 详情'],
                ['DELETE', '/api/pods/:name', '删除 Pod'],
                ['POST', '/api/pods/:name/start', '启动 Pod'],
                ['POST', '/api/pods/:name/stop', '停止 Pod'],
                ['POST', '/api/pods/:name/restart', '重启 Pod'],
                ['POST', '/api/pods/:name/resize', '调整资源规格'],
                ['POST', '/api/pods/:name/reset-pw', '重置 SSH 密码'],
                ['GET', '/api/pods/:name/metrics', '实时指标'],
                ['GET', '/api/pods/:name/metrics/history', '历史指标'],
                ['GET', '/api/pods/:name/logs', '容器日志'],
                ['GET', '/api/pods/:name/logs/stream', '日志流 (SSE)'],
                ['GET', '/api/pods/:name/files', '文件列表'],
                ['GET', '/api/pods/:name/files/content', '文件内容'],
                ['POST', '/api/pods/:name/files/create', '创建文件/目录'],
                ['DELETE', '/api/pods/:name/files', '删除文件'],
                ['PUT', '/api/pods/:name/files/save', '保存文件'],
                ['GET', '/api/pods/:name/credentials', '凭证列表'],
                ['POST', '/api/pods/:name/credentials/apply', '应用凭证到 Pod'],
              ],
            })}
          </>
        ),
      },
      {
        title: 'Pod 成员与部署',
        content: (
          <>
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['GET', '/api/pods/:name/members', '成员列表'],
                ['POST', '/api/pods/:name/members/invite', '邀请成员'],
                ['POST', '/api/pods/:name/members/approve', '审批加入'],
                ['DELETE', '/api/pods/:name/members/:user', '移除成员'],
                ['GET', '/api/pods/:name/deploys', '部署列表'],
                ['POST', '/api/pods/:name/deploys', '添加部署'],
                ['DELETE', '/api/pods/:name/deploys', '删除部署'],
                ['POST', '/api/pods/:name/deploys/:id/run', '运行部署'],
                ['POST', '/api/pods/:name/deploys/:id/stop', '停止部署'],
                ['GET', '/api/pods/:name/deploys/:id/logs', '部署日志'],
                ['GET', '/api/pods/:name/deploys/:id/logs/stream', '部署日志流'],
              ],
            })}
          </>
        ),
      },
      {
        title: '基础设施',
        content: (
          <>
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['GET', '/api/infra/host', '主机状态'],
                ['GET', '/api/infra/remote-hosts', '远程主机列表'],
                ['GET', '/api/infra/metrics', '集群指标'],
                ['GET', '/api/infra/storage', 'MinIO 状态'],
                ['POST', '/api/infra/storage/ensure', '确保 MinIO 运行'],
                ['POST', '/api/infra/storage/buckets', '创建 Bucket'],
                ['DELETE', '/api/infra/storage/buckets/:name', '删除 Bucket'],
                ['POST', '/api/infra/storage/keys', '创建 Access Key'],
                ['DELETE', '/api/infra/storage/keys/:id', '删除 Key'],
                ['GET', '/api/infra/databases', '数据库服务列表'],
                ['POST', '/api/infra/databases/ensure', '确保数据库运行'],
                ['POST', '/api/infra/databases/creds', '创建数据库凭证'],
                ['DELETE', '/api/infra/databases/creds/:id', '删除凭证'],
                ['GET', '/api/infra/proxy', '反代映射列表'],
                ['POST', '/api/infra/proxy', '添加反代映射'],
              ],
            })}
          </>
        ),
      },
      {
        title: '开发工具 & 运维',
        content: (
          <>
            {TB({
              headers: ['方法', '路径', '说明'],
              rows: [
                ['GET', '/api/agents', 'Agent 列表'],
                ['GET', '/api/agents/:id', 'Agent 详情'],
                ['PUT', '/api/agents/:id', '更新 Agent'],
                ['POST', '/api/agents/run', '运行 Agent'],
                ['GET', '/api/agents/stream', 'Agent 输出流 (SSE)'],
                ['POST', '/api/agents/stop', '停止 Agent'],
                ['GET', '/api/agents/sessions', '会话列表'],
                ['GET', '/api/mcp', 'MCP 服务器列表'],
                ['POST', '/api/mcp', '添加 MCP 服务器'],
                ['PUT', '/api/mcp/:id', '更新 MCP 服务器'],
                ['DELETE', '/api/mcp/:id', '删除 MCP 服务器'],
                ['POST', '/api/mcp/:id/toggle', '启用/禁用 MCP 服务器'],
                ['GET', '/api/shared', '共享目录列表 (?path=)'],
                ['POST', '/api/shared/mkdir', '创建目录 {path,name}'],
                ['POST', '/api/shared/upload', '上传文件 (multipart)'],
                ['DELETE', '/api/shared', '删除文件/目录'],
                ['GET', '/api/audit', '审计日志 (?actor=&action=&since=)'],
                ['GET', '/api/users', '用户列表'],
                ['POST', '/api/users', '创建用户'],
                ['PUT', '/api/users/:name', '更新用户'],
                ['DELETE', '/api/users/:name', '删除用户'],
                ['GET', '/api/tokens', '列出我的 API Token'],
                ['POST', '/api/tokens', '创建 API Token'],
                ['DELETE', '/api/tokens/:id', '删除 API Token'],
                ['GET', '/api/threat-map', '威胁地图数据 (?window=)'],
                ['GET', '/api/profile', '个人信息'],
                ['POST', '/api/profile/password', '修改密码'],
                ['POST', '/api/profile/unbind', '解绑身份'],
              ],
            })}
          </>
        ),
      },
    ],
  },

  /* ================================================================ */
  /*  8. PWA & 移动端                                                  */
  /* ================================================================ */
  {
    id: 'pwa',
    title: 'PWA 与移动端',
    icon: <Cloud size={16} />,
    items: [
      {
        title: 'PWA 安装',
        content: (
          <>
            {P('平台支持 PWA（Progressive Web App），可安装到桌面：')}
            {UL(
              <>Chrome / Edge — 地址栏右侧出现安装图标，或菜单中选择「安装应用」</>,
              <>Safari — 分享菜单中选择「添加到主屏幕」</>,
              <>安装后以独立窗口运行，无浏览器地址栏</>,
            )}
            {P('Service Worker 由 Workbox 自动管理，缓存静态资源实现秒开。')}
          </>
        ),
      },
      {
        title: '移动端适配',
        content: (
          <>
            {P('平台已针对移动端全面优化：')}
            {UL(
              <>768px 断点响应式布局，手机自动切换卡片视图</>,
              <>安全区域适配（iPhone X+ 刘海屏 / 底部横条）</>,
              <>触摸目标 ≥ 44×44px，符合无障碍标准</>,
              <>侧边栏自动收起，点击汉堡按钮展开</>,
              <>表格自动切换为卡片式布局</>,
              <>操作按钮始终可见（不依赖 hover）</>,
            )}
          </>
        ),
      },
    ],
  },
]

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Docs() {
  const { perms } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const [activeItem, setActiveItem] = useState<string | null>(null)
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // 管理员章节（运维知识、知识库与 AI 沉淀）仅对具有
  // 任一 infra.* / ops.* 权限（或 "*" 超级权限）的用户可见
  const canViewStaffDocs =
    perms.has('*') ||
    Array.from(perms).some((p) => p.startsWith('infra.') || p.startsWith('ops.'))
  const visibleSections = sections.filter(
    (s) => !s.staffOnly || canViewStaffDocs,
  )

  const toggleSection = (id: string) => {
    setActiveSection(prev => prev === id ? null : id)
    setActiveItem(null)
  }

  const toggleItem = (key: string) => {
    setActiveItem(prev => prev === key ? null : key)
  }

  // Deep link: /docs?s=<sectionId>&i=<itemIndex> (set by the "查看文档" hints
  // scattered across the app). Opens the section + item and scrolls to it.
  useEffect(() => {
    const sid = searchParams.get('s')
    if (!sid) return
    const idx = Number(searchParams.get('i') ?? '0')
    const section = visibleSections.find(s => s.id === sid)
    if (!section) return
    const key = `${sid}-${Number.isFinite(idx) ? idx : 0}`
    setActiveSection(sid)
    setActiveItem(key)
    // wait for the section body to render before scrolling
    const t = setTimeout(() => {
      itemRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => clearTimeout(t)
  // re-run once perms arrive: a staff-only section is invisible until then
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, canViewStaffDocs])

  // Keep the URL in sync when the user opens an item, so the address bar is
  // always a shareable deep link.
  const openItem = (key: string, sectionId: string, itemIdx: number) => {
    const willOpen = activeItem !== key
    toggleItem(key)
    if (willOpen) {
      setSearchParams({ s: sectionId, i: String(itemIdx) }, { replace: true })
    } else {
      setSearchParams({}, { replace: true })
    }
  }

  return (
    <>
      <PageHeader title="文档" description="平台使用指南与 API 参考">
        <PageAiAssistant page="docs" context={`文档目录: ${visibleSections.length} 个章节\n${visibleSections.map(s => `  ${s.title}: ${s.items.map(i => i.title).join(', ')}`).join('\n')}`} />
      </PageHeader>

      <div className="space-y-3">
        {visibleSections.map((section) => (
          <Card key={section.id} padding="none">
            {/* Section header */}
            <button
              onClick={() => toggleSection(section.id)}
              className="w-full flex items-center gap-2.5 px-5 py-3.5 text-sm font-semibold text-ink hover:bg-black/[0.02] transition-colors"
            >
              <span className="text-muted">{section.icon}</span>
              {section.title}
              <Badge variant="muted" className="ml-1">{section.items.length}</Badge>
              <ChevronRight
                size={16}
                className={cn(
                  'ml-auto text-muted transition-transform duration-200',
                  activeSection === section.id && 'rotate-90',
                )}
              />
            </button>

            {/* Section body */}
            {activeSection === section.id && (
              <div className="border-t border-black/[0.06]">
                {section.items.map((item, itemIdx) => {
                  const key = `${section.id}-${itemIdx}`
                  const isOpen = activeItem === key
                  return (
                    <div
                      key={key}
                      ref={(el) => { itemRefs.current[key] = el }}
                      className={cn(itemIdx > 0 && 'border-t border-black/[0.04]')}
                    >
                      <button
                        onClick={() => openItem(key, section.id, itemIdx)}
                        className="w-full flex items-center gap-2 px-5 py-2.5 text-sm text-ink-2 hover:bg-black/[0.015] transition-colors"
                      >
                        <ChevronRight
                          size={14}
                          className={cn(
                            'text-muted/60 transition-transform duration-200 flex-shrink-0',
                            isOpen && 'rotate-90',
                          )}
                        />
                        <span className="font-medium text-ink">{item.title}</span>
                      </button>
                      {isOpen && (
                        <div className="px-5 pb-4 pl-9">
                          {item.content}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  )
}
