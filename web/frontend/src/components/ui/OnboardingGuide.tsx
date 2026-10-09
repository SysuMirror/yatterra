import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useLocation } from 'react-router'
import { useAuthStore } from '@/stores/auth'
import { Portal } from '@/components/ui/Portal'

type Step = {
  target: string
  title: string
  description: string
  optional?: boolean
  lesson?: string
  fallbackTarget?: string
  // Completion is checked against a real rendered control/state marker when available.
  doneTarget?: string
}
const step = (target: string, title: string, description: string, optional = false, doneTarget?: string, fallbackTarget?: string, lesson?: string): Step => ({ target, title, description, optional, doneTarget, fallbackTarget, lesson })
const docs = (description: string, lesson = 'concepts') => step('page-docs', '打开对应文档', description, true, undefined, undefined, lesson)
const lessonHref = (lesson: string) => `/docs?lesson=${encodeURIComponent(lesson)}`

// A short, task-based path. Targets are real controls; optional items disappear when
// the current account or resource has no such capability.
const guides: Record<string, Step[]> = {
  '/console': [
    step('dashboard-insight', '查看集群概览洞察', '页面顶部的 AI 洞察面板会自动分析集群的 Pod 状态、资源水位和威胁情况，给出异常提示和建议。数据变化后可点击刷新重新分析。', false, undefined, undefined, 'concepts'),
    step('dashboard-error', '加载失败时重试', '概览数据加载失败时顶部会出现红色错误条，说明接口暂时不可达。点击右侧「重试」重新拉取集群数据，通常网络恢复后即可正常显示。', true, undefined, undefined, 'troubleshooting'),
    step('dashboard-stats', '看懂核心指标', '指标卡显示运行 Pod 数、CPU 1 分钟负载、内存和根磁盘使用率、GPU 数量。内存或磁盘超过 90% 时顶部会出现红色告警条。', false, undefined, undefined, 'monitoring'),
    step('dashboard-alert', '处理平台告警', '出现失败 Pod 或磁盘使用超 90% 时，这里会显示红色告警条；点击右侧「查看详情」跳到 Pod 列表并自动筛选 Failed 状态。', true, undefined, undefined, 'troubleshooting'),
    step('dashboard-cluster', '查看集群信息', '集群卡汇总运行/总计 Pod、已停止数、分组数、K3s 节点数和版本。失败数量会以红色徽标突出显示。', false, undefined, undefined, 'infra'),
    step('dashboard-modules', '通过模块芯片导航', '四个模块芯片分别是基础设施、开发、运维和攻防，各带健康状态圆点和摘要（如节点数、Agent 数、今日审计事件数、攻击/封禁数）。点击芯片直接进入对应模块页面。', false, undefined, undefined, 'concepts'),
    step('dashboard-modules', '关注攻防态势', '攻防芯片显示最近 24 小时的攻击次数和封禁 IP 数；有攻击时圆点会变黄。需要 ops.threat 权限的用户点击可进入威胁地图查看详情。', false, undefined, undefined, 'security'),
    step('dashboard-gpu', '查看 GPU 概览', '每块 GPU 一张卡：利用率徽标、显存进度条、温度和功耗，底部显示占用它的分组，空闲则标绿。想看历史曲线可稍后前往基础设施的 GPU / 集群页面。', true, undefined, undefined, 'infra'),
    step('dashboard-pods', '浏览 Pod 列表', '表格列出所有 Pod 的名称、类型、GPU、状态、你的角色和规格。点击行进入 Pod 详情；还不是成员的 Pod 可点「申请加入」并填写理由，等待 owner 审批。', false, undefined, undefined, 'pod'),
    step('dashboard-quick', '使用快捷操作', '三个快捷入口：创建 Pod 跳转 Pod 列表、AI 对话进入开发工具的编排会话、查看攻防打开威胁地图。', false, undefined, undefined, 'concepts'),
    step('dashboard-quick', '开始创建第一个环境', '点击「创建 Pod」快捷卡进入 Pod 页面，按向导填写名称、类型（CPU/GPU）和规格即可创建容器开发环境。', false, undefined, undefined, 'pod'),
    step('goto-/pods', '进入 Pod 管理', '点击这里前往 Pod 页面，创建、搜索和管理你的容器开发环境。', false, undefined, undefined, 'pod'),
    docs('概览页没有单独文档章节时，可从「学习路径」的「先建立模型」开始建立平台整体认知。', 'concepts'),
  ],
  '/pods': [
    step('pods-create', '创建 Pod', '点击「创建 Pod」打开向导：填写小写名称（大写自动转小写），选择 CPU 或 GPU 类型；GPU 类型会列出每块 GPU 的占用情况供多选。规格按类型预填（CPU 2核/4GB，GPU 4核/16GB），可再调整 CPU、内存和存储。创建成功后自动跳转到 Pod 详情。', false, 'pods-created', undefined, 'pod'),
    step('pods-stats', '查看状态汇总', '顶部指标卡统计运行、已停止、失败和「我的」Pod 数量。失败数不为零时建议先处理失败的环境。', false, undefined, undefined, 'pod'),
    step('pods-failed-hint', '用 AI 诊断失败 Pod', '有 Pod 失败时会出现提示条，点击「查看失败 Pod → AI 诊断」自动按 Failed 状态筛选，并配合页面 AI 助手分析失败原因。', true, undefined, undefined, 'troubleshooting'),
    step('pods-search', '搜索 Pod', '按名称关键字实时过滤列表。列表为空时先清空搜索词再检查状态筛选。', false, undefined, undefined, 'access'),
    step('pods-status', '按状态筛选', '状态下拉可筛选运行中、已停止、等待中或失败的 Pod。Pending 表示仍在调度，Failed 请进入详情看日志。', false, undefined, undefined, 'troubleshooting'),
    step('pods-view-toggle', '切换列表/卡片视图', '桌面端可在紧凑表格和卡片视图之间切换；手机默认卡片。表格行内有启动/停止、重启和删除按钮，点击行进入详情。删除需二次确认且不可撤销。', true, undefined, undefined, 'pod'),
    step('pods-insight', '查看 AI 集群洞察', '有 Pod 时页面顶部显示 AI 洞察面板，自动分析 Pod 分布、资源规格和失败原因，给出建议。', true, undefined, undefined, 'dev'),
    docs('创建、连接和部署 Pod 的完整流程，见学习路径的「创建 Pod」「运行第一个应用」两节。', 'pod'),
  ],
  '/pods/:name': [
    step('pod-header', '认识 Pod 详情', '标题区显示 Pod 名称、状态徽标、所有者和你的角色。旁边的「新手部署文档」可直达对应文档章节。', false, undefined, undefined, 'pod'),
    step('pod-actions', '启动/停止/重启', '右侧按钮组控制整个 Pod：运行中显示「停止」，未运行显示「启动」；「重启」会重启容器，运行中的进程和环境会被重置。', false, undefined, undefined, 'pod'),
    step('pod-insight', '查看 AI Pod 洞察', 'AI 洞察面板基于当前 Pod 的状态、规格、GPU 和成员信息自动生成分析与建议，是排查资源问题的第一站。', false, undefined, undefined, 'dev'),
    step('pod-tab-monitor', '监控资源用量', '监控标签页显示 CPU、内存和 GPU 的实时指标（每 5 秒刷新）和历史曲线（每 30 秒拉取），用于判断规格是否充足。', false, undefined, undefined, 'monitoring'),
    step('pod-tab-connect', '获取连接信息', '连接页显示实际分配的 SSH 命令、密码和 Web 地址，可展开 SSH Config 片段复制到本地 ~/.ssh/config 直连。只复制界面显示的值，不要自行拼接主机或端口；使用说明里还列出了 /shared 只读权重、MinIO 端点和公共数据库地址。', false, undefined, undefined, 'connect'),
    step('pod-tab-terminal', '使用在线终端', '终端标签页提供浏览器内的 SSH 会话，无需本地工具即可在 Pod 内执行命令。需 Pod 处于运行状态。', false, undefined, undefined, 'connect'),
    step('pod-tab-files', '管理文件', '文件页浏览、编辑和上传工作区内的文件。代码放在 /home/cloud，不要把密码或 Token 写进文件。', false, undefined, undefined, 'services'),
    step('pod-tab-logs', '查看容器日志', '日志标签页实时流式输出容器 stdout/stderr，用于确认进程是否启动、端口是否监听。', false, undefined, undefined, 'logs'),
    step('pod-tab-app-logs', '查看应用日志', '应用日志标签页查看部署的应用输出。没有日志时先确认应用已启动且写到标准输出或 LOG_DIR。', true, undefined, undefined, 'logs'),
    step('pod-tab-creds', '申请数据库/存储凭证', '凭证页点击「应用凭证」可为 Pod 申请 MySQL、Redis、Qdrant 或 MinIO 的访问权限；MinIO 可指定桶和读写/只读/只写权限。凭证以卡片展示，可随时撤销，撤销后立即失效。', false, undefined, undefined, 'database'),
    step('pod-tab-domains', '绑定子域名', '子域名页为 Pod 的公网端口绑定自定义前缀，访问 <前缀>.ssemarket.cn 即可打开你的应用。可改前缀、停用或删除映射。', false, undefined, undefined, 'proxy'),
    step('pod-tab-deploys', '管理部署', '部署页管理应用部署：快速模板会立即创建并运行；自定义部署先保存配置再手动启动。', false, undefined, undefined, 'deploy'),
    step('deploy-create', '创建部署', '点击「创建部署」打开表单。仓库来源填写 repo、分支等字段；本地来源只填 deploy.sh 路径。私有仓库 Token 只填密码字段，不要写进脚本。', false, undefined, 'pod-tab-deploys', 'deploy'),
    step('deploy-script', '填写 deploy.sh', 'deploy.sh 需保持前台进程（用 exec），不要 nohup 或 &。服务模式配健康路径 /health；一次性任务退出码 0 即成功。', true, undefined, 'pod-tab-deploys', 'deploy'),
    step('deploy-submit', '保存并启动', '普通创建只保存配置，需再点启动/Deploy 才运行；保存环境变量后也要重新 Deploy 才会注入新环境。', false, undefined, 'pod-tab-deploys', 'deploy'),
    step('pod-tab-profile', '查看项目画像', '项目画像 tab 由 podwatch 每 10 分钟巡检 /home/cloud 的代码变更，用平台 LLM 自动维护一份「这个容器在跑什么」的档案。', false, undefined, undefined, 'pod'),
    step('profile-header', '了解画像机制', '画像头卡显示最近更新时间。首次使用或画像为空时，页面会提示建档方式。', false, undefined, 'pod-tab-profile', 'pod'),
    step('profile-scan', '立即扫描', '点击「立即扫描」手动触发一次巡检：检测到变更会显示 +新增/~修改/-删除 的数量；平台 LLM 暂不可用时稍后会自动重试。', false, undefined, 'pod-tab-profile', 'pod'),
    step('profile-content', '查看用途与技术栈', '画像卡整理项目用途、技术栈、入口和主要模块，帮助新成员快速理解代码结构。', true, undefined, 'pod-tab-profile', 'pod'),
    step('profile-changes', '追踪变更历史', '变更历史列出每次巡检检测到的代码变更摘要和增删改数量，可当作轻量版的提交记录。', true, undefined, 'pod-tab-profile', 'pod'),
    step('pod-tab-members', '管理团队成员', '成员页查看成员列表；owner/admin 可审批加入申请、移除成员和调整角色。', false, undefined, undefined, 'collaboration'),
    step('pod-tab-settings', '调整设置', '设置页修改资源规格和环境变量。环境变量保存会触发 Pod 重启，重启后需重新运行部署才能注入新环境。', false, undefined, undefined, 'environment'),
    step('pod-resources', '查看资源配额', '设置页上方显示当前 CPU、内存、存储和 GPU 配额；owner/admin 可调整规格。', false, undefined, 'pod-tab-settings', 'environment'),
    step('pod-env', '管理环境变量', '环境变量区添加/修改变量，保存后重启生效。PORT 由平台提供（默认 8080），不要写死；秘密值不要截图或入库。', false, undefined, 'pod-tab-settings', 'environment'),
    docs('从创建到发布的完整流程，见学习路径「运行第一个应用」「保存、启动与重新部署」两节。', 'first-app'),
  ],
  '/docs': [
    step('docs-learning', '按学习路径入门', '默认视图是 13 节的引导式学习路径，每节包含目标、步骤、验收标准和常见错误。从「先建立模型」开始，理解 Pod、部署、服务和健康检查的分工。', false, undefined, undefined, 'concepts'),
    step('docs-learning', '用课程目录跳转', '右侧课程目录列出全部章节，点击任意一节直接切换；当前节高亮显示。也可以用底部的「上一节 / 下一节」顺序学习。', false, undefined, undefined, 'concepts'),
    step('docs-learning', '动手做第一节应用', '「运行第一个应用」一节提供完整的 app.py 和 deploy.sh 示例（可一键复制），照做即可在 Pod 里跑起一个带 /health 的 HTTP 服务。', false, undefined, undefined, 'first-app'),
    step('docs-nav', '切换功能参考', '页面顶部导航可在「学习路径」「功能参考」「管理员参考」之间切换。功能参考是按章节折叠的完整手册；管理员参考需要 infra.* / ops.* 权限才可见。', true, undefined, undefined, 'concepts'),
    step('docs-section', '展开参考章节', '功能参考视图中，点击章节标题展开该章的条目列表；徽标显示条目数量。管理员专属章节（运维知识、知识库）仅对有相应权限的用户显示。', true, undefined, undefined, 'ops'),
    step('docs-item', '打开具体条目', '点击章节内的条目展开正文。打开后地址栏会变成 /docs?s=章节&i=序号 的深链，可直接分享或从其他页面的「查看文档」提示直达。', true, undefined, undefined, 'troubleshooting'),
  ],
  '/infra': [
    step('infra-insight', 'AI 基础设施洞察', '基于当前主机/存储/数据库/反代状态生成的 AI 摘要，可点开追问，比如“磁盘快满了吗”。', false, undefined, undefined, 'infra'),
    step('infra-stats', '核心指标', '一眼看清集群负载、内存占用、GPU 数量和 K3s 节点数，数据每 10 秒自动刷新。', false, undefined, undefined, 'infra'),
    step('infra-requests', 'CPU / 内存 request 饼图', '展示各 Pod 申请(request)的 CPU 与内存配额占比，判断资源预留是否被少数组占满。', false, undefined, undefined, 'infra'),
    step('infra-services', '服务状态卡', '四张卡分别对应主机、存储、数据库、子域名反代，绿色圆点表示服务正常，卡内还有磁盘水位、桶数量等摘要。', false, undefined, undefined, 'infra'),
    step('infra-gpu', 'GPU 摘要卡', '有 GPU 时页面下方汇总每块卡的温度徽标（超 65°C 变黄）、利用率和显存进度条，右上角标注驱动版本。想看历史趋势可前往 GPU 监控页。', true, undefined, undefined, 'monitoring'),
    step('infra-quick', '快捷初始化入口', '底部三个快捷卡分别跳转存储、数据库和反代页面，用于首次部署 MinIO、四个数据库服务或添加子域名映射。', false, undefined, undefined, 'infra'),
    step('goto-/infra/host', '进入主机详情', '点击“主机”卡跳转到主机健康页，查看系统信息、磁盘、K3s 节点与 GPU 详情。', false, undefined, undefined, 'infra'),
    docs('想了解基础设施各子系统的定位与用法？可打开基础设施文档对照阅读。', 'infra'),
  ],
  '/infra/host': [
    step('host-insight', 'AI 主机健康洞察', 'AI 根据主机 CPU、内存、磁盘与 Pod 数量生成健康摘要，可直接向它提问排查问题。', false, undefined, undefined, 'monitoring'),
    step('host-stats', '主机指标卡', '负载、内存占用、GPU 数、K3s 节点数四项核心指标，每 10 秒自动刷新。', false, undefined, undefined, 'monitoring'),
    step('host-info', '系统信息', '操作系统、内核版本、CPU 核数、Pod 数、运行时长，以及 1/5/15 分钟负载均值和 Swap 用量。', false, undefined, undefined, 'monitoring'),
    step('host-metrics', '集群指标图表', '以图表展示集群 CPU、内存等指标的历史走势，比数字更直观。', false, undefined, undefined, 'monitoring'),
    step('host-disks', '磁盘使用', '每个挂载点的用量百分比进度条，超过 70% 变黄、超过 90% 变红，是扩容前的预警信号。', false, undefined, undefined, 'storage'),
    step('host-gpu', 'GPU 详情', '每块 GPU 的温度、功耗、利用率与显存进度条；温度超过 65°C 会变黄预警。', true, undefined, undefined, 'monitoring'),
    step('host-frp', 'FRP 连接', '显示内网穿透隧道的运行/总数比例，全部在线为绿色，有离线会提示数量。', true, undefined, undefined, 'proxy'),
    step('host-remote', '远程主机', '经 SSH 中继采集的远程机器状态（含 vLLM 与 GPU 信息）；没有配置远程主机时这里会显示“暂无远程主机”。', true, undefined, undefined, 'monitoring'),
    docs('主机监控各项指标的含义可参考监控文档。', 'monitoring'),
  ],
  '/infra/gpu': [
    step('gpu-insight', 'AI GPU 洞察', 'AI 汇总 GPU 总数、平均利用率、显存与温度生成摘要，可直接追问“哪块卡被谁占用”。', true, undefined, undefined, 'monitoring'),
    step('gpu-error', '加载失败重试', 'GPU 数据加载失败时会出现红色提示条，点击「重试」重新拉取；通常是采集组件或网络暂时异常。', true, undefined, undefined, 'troubleshooting'),
    step('gpu-stats', 'GPU 汇总指标', 'GPU 总数、平均利用率、总显存已用/总量、最高温度四张卡，快速判断算力水位。', false, undefined, undefined, 'monitoring'),
    step('gpu-cards', '每块 GPU 详情', '每张卡展示温度/功耗、利用率与显存进度条，下方还有利用率趋势和显存趋势历史曲线，以及“已分配 Pod”标签——能看到哪组正在用这块卡。', false, undefined, undefined, 'monitoring'),
    step('gpu-trend', '看温度与显存历史曲线', '每块 GPU 卡内的「利用率趋势」「显存趋势」面积图展示近期走势：蓝色为利用率（0-100%），橙色为显存（MB）。悬停可查看具体数值，用于判断负载是持续高还是瞬时尖峰。', true, undefined, 'gpu-cards', 'monitoring'),
    step('gpu-assigned', '确认 GPU 占用方', '「已分配 Pod」区列出正在使用这块卡的分组徽标；没有徽标时显示“无 Pod 占用”，说明该卡空闲可分配。', true, undefined, 'gpu-cards', 'infra'),
    docs('GPU 分配与占用规则详见监控文档。', 'monitoring'),
  ],
  '/infra/fleet': [
    step('fleet-insight', 'AI 集群洞察', 'AI 汇总各节点 CPU、内存、负载与在线状态生成健康摘要。', false, undefined, undefined, 'monitoring'),
    step('fleet-hosts', '主机卡网格', '每台主机一张卡：在线/离线/数据陈旧状态徽标加 CPU、内存、负载三项读数，点击可选中该主机查看其 GPU 详情。', false, undefined, undefined, 'monitoring'),
    step('fleet-view', '图表 / 表格切换', '点击按钮在折线图视图和纯表格视图之间切换，表格适合快速抄录数值。', false, undefined, undefined, 'monitoring'),
    step('fleet-charts', 'CPU / 内存 / 负载曲线', '所有主机的历史曲线叠加在同一张图上对比，每条线一种颜色，鼠标悬停可看具体数值。', false, undefined, undefined, 'monitoring'),
    step('fleet-range', '时间范围', '选择 15m 到 7d 的历史范围，切换后下方 GPU 详情曲线也随之更新。', false, undefined, undefined, 'monitoring'),
    step('fleet-host', '单主机 GPU 详情', '选中主机后，下方展示该机每块 GPU 的利用率、显存(GiB)与温度曲线，可按 GPU 编号单独筛选。', true, undefined, undefined, 'monitoring'),
  ],
  '/infra/storage': [
    step('storage-ensure', '初始化 MinIO', '首次使用点击“初始化”部署 MinIO 服务，部署后状态徽标变为“运行中”。需要 infra.storage 权限。', true, undefined, undefined, 'storage'),
    step('storage-create', '创建桶', '点击“创建桶”弹出对话框，输入符合 DNS 规范的桶名（小写字母、数字、连字符）即可创建。需要 infra.storage 权限。', true, undefined, undefined, 'storage'),
    step('storage-insight', 'AI 存储洞察', 'AI 汇总 MinIO 状态、桶列表和密钥分布，可直接询问“哪个组有存储权限”。', false, undefined, undefined, 'storage'),
    step('storage-status', 'MinIO 运行状态', '页头上方的状态徽标显示 MinIO 当前处于运行中、启动中还是未部署；刚点初始化后会先显示启动中，就绪后才可建桶发密钥。', true, undefined, undefined, 'storage'),
    step('storage-endpoint-card', 'Pod 内连接端点', '集群内 Pod 访问 MinIO 用的地址，组内代码填这个端点。', true, undefined, undefined, 'storage'),
    step('storage-endpoint', '复制端点', '点击 ⧉ 把端点地址复制到剪贴板，直接粘进组内代码即可。', true, undefined, undefined, 'storage'),
    step('storage-root', 'Root 凭证', '管理员专属的 Access Key 与 Secret，Secret 默认打码，可点眼睛图标临时显示或一键复制。仅管理员可见。', true, undefined, undefined, 'storage'),
    step('storage-buckets', '存储桶列表', '所有桶以卡片展示；有桶才能发密钥，删除桶会连带清空数据且不可恢复。', false, undefined, undefined, 'storage'),
    step('storage-browse', '浏览桶', '点击某个桶的“浏览”打开文件浏览器：点目录展开、点文件在线预览、⤓ 图标下载对象。', true, undefined, undefined, 'storage'),
    step('storage-keys', '访问密钥', '每把密钥绑定一个桶和一种权限（读写/只读/只写），桶级隔离——组内代码用它而不是 root 凭证。', false, undefined, undefined, 'storage'),
    step('storage-key', '发密钥', '点击“发密钥”填写标签、选择桶和权限后创建，密钥会出现在下方列表。需要 infra.storage 权限。', true, undefined, undefined, 'storage'),
    step('storage-example', 'Python 连接示例', '页面底部的代码模板演示用 minio 库连接：填入端点、管理员发的 AK/SK 和授权的桶名即可上传对象，可直接复制到组内代码改写。', true, undefined, undefined, 'storage'),
    docs('MinIO 端点、密钥权限与 Python 连接示例可查阅存储文档。', 'storage'),
  ],
  '/infra/databases': [
    step('db-ensure', '初始化数据库', '首次使用点击“初始化”一键部署 MySQL / Redis / Qdrant / PostgreSQL 四个服务。需要 infra.db 权限。', true, undefined, undefined, 'database'),
    step('db-create', '创建凭证', '点击“创建凭证”，选择分组和服务类型后生成该组的专属账号，凭证按服务分组展示在页面底部。需要 infra.db 权限。', true, undefined, undefined, 'database'),
    step('db-create', '填写分组与服务类型', '弹窗里填分组名（如 my-group）并选择 MySQL/Redis/Qdrant/PostgreSQL 之一，创建后凭证按服务分组出现在页面底部。', true, undefined, undefined, 'database'),
    step('db-insight', 'AI 数据库洞察', 'AI 汇总四个服务的运行状态和凭证分布，可直接询问“redis 有哪些组的凭证”。', false, undefined, undefined, 'database'),
    step('db-status', '服务状态', 'MySQL / Redis / Qdrant / PostgreSQL 四张状态卡，徽标显示运行中/启动中/未部署，卡内标注服务端口。', false, undefined, undefined, 'database'),
    step('db-copy', '复制连接串', '点击状态卡里的“复制连接串”，把该服务的连接 URL 复制到剪贴板，填上凭证即可使用。', false, undefined, undefined, 'database'),
    step('db-incluster', 'Pod 内端点', '集群内 Pod 访问各数据库的完整服务地址，每行右侧的复制按钮可单独复制。服务就绪后才显示。', true, undefined, undefined, 'database'),
    step('db-frp', 'FRP 本机端点', '中继主机上 127.0.0.1 的隧道端口，仅该机上的应用可连，公网不可达。服务就绪后才显示。', true, undefined, undefined, 'database'),
    step('db-root', 'Root 凭证', '各服务的 root 密码/API key，默认打码显示，仅供管理员排障，请勿分享给组员。仅管理员可见。', true, undefined, undefined, 'database'),
    step('db-examples', '连接示例', '四种数据库的 Python 连接代码模板，含 Redis 键前缀、Qdrant 集合名前缀等平台约定，照抄即可跑通。服务就绪后才显示。', true, undefined, undefined, 'database'),
    step('db-creds', '凭证列表', '按服务分组的凭证（用户名、库名、打码的密码），每行可复制完整连接串；管理员可删除凭证，删除后使用方立即失联。', false, undefined, undefined, 'database'),
    step('db-creds', '按服务折叠与删除确认', '每个服务的凭证放在可折叠的分组里，标题标注数量；删除凭证会弹确认框并提示使用方立即失去访问权限，确认前先和组内确认无人使用。', false, undefined, undefined, 'database'),
    docs('各数据库的连接方式、前缀约定与凭证申请流程详见数据库文档。', 'database'),
  ],
  '/infra/proxy': [
    step('proxy-create', '添加映射', '点击“添加映射”填写子域名、端口（可选备注和所属 Pod），“所属 Pod”填了 Pod 名后该 Pod 的 owner 可自行管理这条映射。', false, undefined, undefined, 'proxy'),
    step('proxy-insight', 'AI 反代洞察', 'AI 汇总映射数量、启用状态、FRP 隧道健康度，可直接询问“哪些子域名指向 8080”。', false, undefined, undefined, 'proxy'),
    step('proxy-stats', '映射与隧道指标', '映射总数、FRP 隧道运行/总数、远程主机台数、已禁用映射数四张卡。', false, undefined, undefined, 'proxy'),
    step('proxy-frp', 'FRP 连接状态', '隧道的运行数、总数、健康率和反代容器运行状态；有 frpc 数据才显示。', true, undefined, undefined, 'proxy'),
    step('proxy-remote', '远程主机状态', '配置了远程主机时，这里以卡片展示每台的在线状态、磁盘/内存水位、负载、运行时长，以及 vLLM 服务健康度和 GPU/驱动信息，用于巡检中继机器。', true, undefined, undefined, 'monitoring'),
    step('proxy-table', '映射表格', '每行一条映射：子域名、端口、所属 Pod、状态开关和备注。拨动开关即时启用/禁用该子域名，垃圾桶图标删除映射（删除后子域名立即不可访问）。', false, undefined, undefined, 'proxy'),
    step('proxy-table', '删除前确认', '点击垃圾桶图标后会弹出确认框，明确提示删除后该子域名立即不可访问；确认才真正删除。误删只能重新添加映射恢复。', false, undefined, undefined, 'proxy'),
    docs('子域名反代的申请与管理规则见代理文档。', 'proxy'),
  ],
  '/threat-map': [
    step('threat-stats', '威胁统计', '攻击连接数、攻击源 IP 数、主要攻击模式和已封禁 IP 四张卡，数字带滚动动画，副标题给出拦截率等细节。', false, undefined, undefined, 'security'),
    step('threat-globe', '攻击来源地图', '3D 地球实时标注攻击来源位置，红色弧线飞向平台目标；左上角 HUD 显示实时连接、来源与封禁数。', false, undefined, undefined, 'security'),
    step('threat-gauge', '威胁态势仪表', '综合攻击源数量、攻击量和封禁比例算出 0-100 威胁分，按低/中/高/严重四档着色，下方附四项明细。', false, undefined, undefined, 'security'),
    step('threat-window', '时间窗口', '选择 1 小时到全部的时间窗口，地图、统计和事件列表都会随之刷新，数据每 30 秒自动更新。', false, undefined, undefined, 'security'),
    step('threat-pattern-dist', '攻击模式分布', '各攻击模式（如 SSH 爆破、Web 扫描）的次数与占比进度条，一眼看出当前主要威胁类型。', false, undefined, undefined, 'security'),
    step('threat-ai-brief', 'AI 态势简报', 'AI 定期生成的安全简报，总结当前窗口的威胁态势；带紫色星标的模式表示经过 AI 归类。有简报数据才显示。', true, undefined, undefined, 'security'),
    step('threat-events', '威胁事件列表', '按攻击次数排序的事件表格：IP、城市、次数、模式、入口、响应动作和时间，可点击表头排序。', false, undefined, undefined, 'security'),
    step('threat-status-filter', '事件筛选', '用“全部/活跃/已封禁”按钮和模式下拉框过滤事件列表；想追查操作记录，稍后可前往 /ops/audit 查看审计日志。', false, undefined, undefined, 'security'),
    docs('威胁等级评分与封禁机制详见安全文档。', 'security'),
  ],
  '/dev': [
    step('dev-insight', 'AI 开发洞察', '页面顶部的 AI 洞察面板会汇总 Agent、MCP、LLM 与编排的当前状态和用量，自动给出异常提示与配置建议。', false, undefined, undefined, 'dev'),
    step('dev-stats', '核心指标', '四张指标卡分别显示 Agent 总数（含运行中数量）、编排流程数、MCP 服务器数（含启用数）和 LLM Provider 数（标注默认 Provider）。', false, undefined, undefined, 'dev'),
    step('dev-agents', '查看 Agent 概况', 'Agent 卡片列出各 Agent 的图标、名称和运行状态（运行中/空闲）。点击右上角「查看全部」可稍后前往编排页面管理。', false, undefined, undefined, 'dev'),
    step('dev-sessions', '最近会话', '有历史会话时显示最近 5 条，含模式图标（ops/build/agent）、标题和更新时间。点击「查看全部」稍后可前往编排页查看完整列表。', true, undefined, undefined, 'dev'),
    step('dev-mcp', 'MCP 服务器状态', '已配置 MCP 时显示前 6 台服务器的启用/禁用状态和传输方式。添加或测试 MCP 需稍后前往 MCP 管理页。', true, undefined, undefined, 'dev'),
    step('dev-llm-usage', 'LLM 用量摘要', '有调用记录时显示总 Token、Prompt/Completion Token 和总费用（¥）。点击「查看详情」稍后可前往 LLM 页查看趋势与排行。', true, undefined, undefined, 'dev'),
    step('dev-harnesses', '编排流程摘要', '列出已有编排流程名称。运行、查看定义或从商店导入编排，稍后可前往 Agent 编排页面操作。', false, undefined, undefined, 'dev'),
    step('dev-quick', '快捷操作', '底部三个快捷入口：新建会话（与 Agent 对话）、添加 MCP（连接外部工具）、添加 LLM（配置模型服务）。点击即跳转对应页面。', false, undefined, undefined, 'dev'),
    step('goto-/dev/harness', '进入 Agent 编排', '点击「新建会话」跳转到编排页面：那里可以运行 Agent、管理会话、运行编排流程和从商店导入模板。', false, undefined, undefined, 'dev'),
    docs('各摘要卡的「查看全部」链接与快捷操作指向同一批子页面：编排、MCP、LLM。', 'dev'),
  ],
  '/dev/harness': [
    step('harness-insight', 'AI 编排洞察', '顶部洞察面板汇总 Agent 运行状态、编排与会话数量及商店库存，自动分析是否有 Agent 异常或编排失败。', false, undefined, undefined, 'dev'),
    step('harness-agents', 'Agent 列表', '表格列出每个 Agent 的名称、ID 和运行状态。运行环境列区分「Pod 内」和「主机」两种执行位置。', false, undefined, undefined, 'dev'),
    step('harness-agents', '运行与停止 Agent', '点击行内「运行」启动 Agent；运行中的 Agent 会出现停止按钮，点击即停止该运行实例，结果以 toast 提示。', false, undefined, undefined, 'dev'),
    step('harness-sessions', '展开 Agent 会话', '点击「Agent 会话」折叠按钮展开会话表，显示会话 ID、模式（agent/harness）和创建时间。', false, undefined, undefined, 'dev'),
    step('harness-session', '新建会话', '点击「新建会话」并在弹窗中选择模式（Agent 或 Harness），确认后创建一个新会话并出现在列表中。', false, undefined, undefined, 'dev'),
    step('harness-sessions', '删除会话', '会话表每行有删除按钮，删除前会弹出确认框；会话历史将永久丢失，不可撤销。', false, undefined, undefined, 'dev'),
    step('harness-list', '编排流程列表', '列出所有编排流程。点击「运行」立即启动该编排，启动结果以 toast 提示。', false, undefined, undefined, 'dev'),
    step('harness-list', '查看编排定义', '点击编排名称展开详情区，显示该编排的 JSON 定义；展开后还可再次运行或删除该编排（删除需确认）。', false, undefined, undefined, 'dev'),
    step('harness-detail', '读懂编排 JSON', '展开后的定义区以等宽字体显示该编排的完整 JSON 定义（步骤、Agent 分工等），是排查编排行为的第一手材料。', true, undefined, 'harness-list', 'dev'),
    step('harness-list', '删除编排', '展开详情后点垃圾桶图标删除编排，会先弹确认框；编排定义将永久删除且不可撤销，删除前确认没有会话依赖它。', false, undefined, undefined, 'dev'),
    step('harness-store', '编排商店', '商店列出已发布的编排模板，含名称和描述。暂无可用编排时显示空状态。', false, undefined, undefined, 'dev'),
    step('harness-import', '导入商店模板', '点击模板卡上的「导入」把商店编排复制到本地编排列表，导入后即可像自有编排一样运行。', true, undefined, undefined, 'dev'),
    docs('会话按模式区分：Agent 会话用于对话调试，Harness 会话用于编排流程执行。删除会话或编排都会先弹确认框且不可撤销，删除前先确认没有正在运行的任务依赖它。', 'dev'),
  ],
  '/dev/mcp': [
    step('mcp-add', '添加 MCP 服务器', '点击「添加」打开表单：填写名称、启动命令，选择传输方式（stdio/SSE/Streamable HTTP），可选填参数和环境变量（每行 KEY=VALUE）。', false, undefined, undefined, 'dev'),
    step('mcp-insight', 'AI 服务洞察', '已配置服务器时，面板会分析启用/禁用比例和传输方式分布，提示可能的连接问题。', true, undefined, undefined, 'dev'),
    step('mcp-table', '服务器列表', '表格显示每台 MCP 服务器的名称、传输方式和启用开关；行内可编辑、测试或删除。', false, undefined, undefined, 'dev'),
    step('mcp-table', '启用与禁用', '用行内开关切换服务器启用状态，切换立即生效；禁用后依赖它的 Agent 工具调用会失败。', false, undefined, undefined, 'dev'),
    step('mcp-test', '测试连接', '点击行内烧瓶图标发起连接测试，成功或失败都会以 toast 提示。', true, undefined, undefined, 'dev'),
    step('mcp-catalog', 'MCP 目录', '目录列出平台预置的 MCP 服务器模板，含名称、传输方式和功能描述。', false, undefined, undefined, 'dev'),
    step('mcp-install', '一键安装目录项', '点击目录项的「安装」会打开预填好命令和参数的添加表单，确认后即完成注册。', true, undefined, undefined, 'dev'),
    docs('MCP 服务器为 Agent 提供外部工具能力；配置后可在 Agent 会话中直接调用。', 'dev'),
  ],
  '/dev/llm': [
    step('llm-add', '添加 Provider', '点击「添加」打开表单：填写名称、类型（OpenAI/Anthropic/Ollama/vLLM）、Base URL 和 API Key，并至少选择一个模型后才能提交。', false, undefined, undefined, 'dev'),
    step('llm-insight', 'AI 用量洞察', '面板汇总各 Provider 状态、默认 Provider、Token 用量、费用和 Top 用户，自动发现异常消耗。', false, undefined, undefined, 'dev'),
    step('llm-table', 'Provider 列表', '表格显示名称（默认 Provider 有星标）、类型、Base URL；行内可设为默认、编辑、测试或删除。', false, undefined, undefined, 'dev'),
    step('llm-table', '设为默认与编辑', '点击行内星形把该 Provider 设为默认；铅笔图标打开编辑弹窗，API Key 留空则保持不变，避免覆盖已存密钥。', false, undefined, undefined, 'dev'),
    step('llm-test', '测试连通性', '点击行内烧瓶图标向该 Provider 发送测试请求，结果以 toast 提示。', true, undefined, undefined, 'dev'),
    step('llm-usage-stats', '用量汇总', '有调用记录时显示总 Token、Prompt/Completion Token 和总费用四张指标卡。', true, undefined, undefined, 'dev'),
    step('llm-trend', '每日用量趋势', '按天展示 Token 消耗面积图，用于观察用量增长或异常尖峰。', true, undefined, undefined, 'dev'),
    step('llm-components', '按组件分布', '横向柱状图显示各平台组件（如助手、洞察等）的 Token 消耗占比。', true, undefined, undefined, 'dev'),
    step('llm-top-users', '用量排行', '列出 Token 消耗最多的用户及其费用，便于定位配额大户。', true, undefined, undefined, 'dev'),
    step('llm-recent', '最近请求', '显示最近 20 条调用记录：时间、用户、模型和 Token 数。', true, undefined, undefined, 'dev'),
    docs('删除 Provider 前先确认没有组件依赖它，删除后使用该 Provider 的调用会立即失败。', 'dev'),
  ],
  '/ops': [
    step('ops-insight', 'AI 运维洞察', '面板汇总今日审计、威胁态势、主机负载和最近操作，自动给出异常结论和运维建议。', false, undefined, undefined, 'ops'),
    step('ops-stats', '核心指标', '四张指标卡：今日审计事件数、共享文件数、攻击源数量和已封禁数量。', false, undefined, undefined, 'ops'),
    step('ops-health', '系统健康', '显示 K3s 集群是否正常、内存和根磁盘使用率进度条（超 70% 变黄、超 90% 变红）以及系统负载。点击「查看详情」稍后可前往主机页。', false, undefined, undefined, 'ops'),
    step('ops-services', '服务状态', 'MinIO、MySQL、Redis、Qdrant 四个平台服务的运行状态：运行中/启动中/未部署。', false, undefined, undefined, 'ops'),
    step('ops-llm', 'LLM 用量摘要', '有调用记录时显示总 Token、Prompt/Completion 和总费用。点击「查看详情」稍后可前往 LLM 页看趋势与排行。', true, undefined, undefined, 'ops'),
    step('ops-recent-audit', '最近审计', '列出今日最新 5 条审计事件：时间、操作者和操作类型（失败/删除类标红）。点击「查看全部」稍后可前往审计页。', true, undefined, undefined, 'ops'),
    step('ops-threat', '攻防态势', '汇总攻击连接、正常访问、封禁数和威胁等级（高/中/低）。点击「查看地图」稍后可前往威胁地图。', false, undefined, undefined, 'security'),
    step('goto-/ops/audit', '查看完整审计', '点击「查看审计」快捷卡进入审计日志页面：可按操作者、操作类型、时间范围筛选，并导出 CSV 或让 AI 总结。', false, undefined, undefined, 'ops'),
    docs('「审批队列」快捷卡仅对有 infra.host 权限或管理员角色显示，用于审批 AI 的高危写动作。', 'ops'),
  ],
  '/ops/audit': [
    step('audit-insight', 'AI 审计洞察', '面板基于当前筛选结果分析失败/删除、登录事件、活跃用户和操作分布，自动标记可疑活动。', true, undefined, undefined, 'ops'),
    step('audit-stats', '统计指标', '四张指标卡：事件总数、失败/删除数、登录事件数和活跃用户数，均按当前筛选条件统计。', false, undefined, undefined, 'ops'),
    step('audit-dist', '操作类型分布', '横向柱状图显示当前范围内最多的 8 类操作及次数，快速看出平台近期的主要行为。', false, undefined, undefined, 'ops'),
    step('audit-heatmap', '24 小时热力图', '按小时展示事件密度，颜色越深活动越集中；悬停可查看该小时的精确事件数，适合发现深夜异常操作。', false, undefined, undefined, 'ops'),
    step('audit-search', '按操作者筛选', '输入用户名或模块名实时过滤日志；子系统产生的记录会以模块名作为操作者并标注「模块」徽标。', false, undefined, undefined, 'ops'),
    step('audit-action', '按操作类型筛选', '选择具体操作如下创建/删除 Pod、登录、创建用户等，只看关心的动作。', false, undefined, undefined, 'ops'),
    step('audit-range', '按时间范围筛选', '切换「今天」「最近 7 天」或全部时间，缩小排查窗口。', false, undefined, undefined, 'ops'),
    step('audit-limit', '调整条数', '选择加载最近 50/100/200/500 条；条数越多统计图越完整，但加载稍慢。', false, undefined, undefined, 'ops'),
    step('audit-table', '审计日志表格', '每条记录显示时间、操作者（或模块）、操作类型徽标和详情，可按时间或操作者排序。', false, undefined, undefined, 'ops'),
    step('audit-count', '区分总数与显示数', '表格下方显示筛选范围内的总条数；上方统计图只基于当前加载的条数计算，条数上限由「最近 N 条」控制，两者可能不一致。', false, undefined, undefined, 'ops'),
    step('audit-export', '导出 CSV', '把当前筛选结果导出为 CSV 文件（含时间、操作者、操作、详情），便于离线分析或归档。无记录时按钮禁用。', false, undefined, undefined, 'ops'),
    step('audit-summarize', '让运维助手总结', '点击后自动把最近 80 条日志发给页面 AI 助手，生成趋势、异常和运维建议的中文总结。', false, undefined, undefined, 'ops'),
    docs('筛选条件组合使用：先定时间范围，再按操作类型聚焦，最后用操作者搜索定位具体账号。审计记录不可篡改；发现异常登录或删除操作时，可结合威胁地图交叉确认来源 IP。', 'ops'),
  ],
  '/ops/shared': [
    step('shared-insight', 'AI 共享洞察', '有文件时面板会分析目录/文件构成和大小分布，提示可清理或归档的内容。', false, undefined, undefined, 'services'),
    step('shared-tree', '共享文件树', '左侧文件树展示 /shared 根目录；点击目录展开懒加载子项，点击文件在右侧查看器中打开内容。', false, undefined, undefined, 'services'),
    step('shared-path', '认清根路径', '文件树顶部的 /shared 是共享根目录，所有 Pod 内挂载的路径一致；树中展开的目录层级就是它在 /shared 下的相对路径。', false, undefined, undefined, 'services'),
    step('shared-mkdir', '新建目录', '点击「新目录」输入子目录名称创建；目录用于按项目或团队组织共享文件。', false, undefined, undefined, 'services'),
    step('shared-upload', '上传文件', '点击「上传」选择本地文件，上传到 /shared 根目录，成功后文件树自动刷新。', false, undefined, undefined, 'services'),
    step('shared-viewer', '文件查看器', '选中文件后右侧以只读编辑器显示内容，可关闭返回空状态；手机上会自动收起文件树，点悬浮按钮恢复。', true, undefined, undefined, 'services'),
    step('shared-tree', '下载文件', '文件树中每个文件行带 ⤓ 下载图标，点击通过 /api/shared/download 把该文件保存到本地，适合取共享权重或数据集。', false, undefined, undefined, 'services'),
    docs('共享目录跨 Pod 可见；不要把密码、Token 等敏感信息放进共享文件。', 'security'),
  ],
  '/ops/approvals': [
    step('approvals-list', '审批队列', 'AI agent 的高危写动作（执行命令、写文件等）会在这里排队等待人工确认；页面每 15 秒自动刷新。', false, undefined, undefined, 'ops'),
    step('approvals-filter', '状态筛选', '在「待审批」「全部」「已处理」之间切换；默认只看待审批，处理过的记录在「已处理」中回溯。', false, undefined, undefined, 'ops'),
    step('approvals-mode', '当前模式', '右上角徽标显示平台当前的审批模式；不同模式下高危动作是直接执行、排队审批还是仅记录。', false, undefined, undefined, 'ops'),
    step('approvals-record', '审批记录卡片', '每条记录含状态徽标（待审批/已执行/执行失败/已拒绝）、来源（podwatch 的 AI 建议会标注）、相对时间和记录编号。', true, undefined, undefined, 'ops'),
    step('approvals-action', '待执行命令', '记录中的代码块显示将要执行的具体命令或写入的文件路径，以及目标环境（宿主机/Pod/远程主机）和发起 agent。', true, undefined, undefined, 'ops'),
    step('approvals-approve', '批准执行', '点击「批准」弹出确认框，再次确认后会立即在目标环境执行该命令，并显示执行结果。', true, undefined, undefined, 'ops'),
    step('approvals-reject', '拒绝动作', '点击「拒绝」确认后该动作作废，agent 不会执行它。对来源不明的命令优先拒绝。', true, undefined, undefined, 'ops'),
    step('approvals-verify', '重新核验', '点击页头「重新核验」对已执行的记录批量复核（最多 5 条），核对执行结果是否符合预期。', true, undefined, undefined, 'ops'),
    docs('批准前务必看清命令内容和目标环境；执行失败或核验失败的记录会标红，需人工跟进。', 'security'),
  ],
  '/users': [
    step('users-insight', 'AI 用户洞察', '面板汇总用户总数、角色分布和 API Token 数量，帮助发现权限过高或闲置账号。', false, undefined, undefined, 'admin'),
    step('users-create', '创建用户', '点击「创建用户」填写用户名、密码并选择角色（不可选超级管理员），提交后新用户立即出现在列表。', true, undefined, undefined, 'admin'),
    step('users-search', '搜索用户', '按昵称、用户名或 OAuth 身份实时过滤列表，快速定位账号。', false, undefined, undefined, 'admin'),
    step('users-table', '用户列表', '表格显示每个用户的头像、昵称（外部登录账号昵称优先，下方保留真实用户名）和角色；当前账号带「你」徽标。', false, undefined, undefined, 'admin'),
    step('users-role', '调整角色', '行内角色下拉可直接切换超级管理员/管理员/普通用户/访客，选择后立即生效，请谨慎授予管理员以上角色。', true, undefined, undefined, 'admin'),
    step('users-reset', '重置密码', '点击行内钥匙图标为该用户设置新密码，重置后需通知对方使用新密码登录。', true, undefined, undefined, 'admin'),
    step('users-delete', '删除用户', '点击行内垃圾桶图标删除账号，删除不可撤销；当前登录账号不显示删除按钮。', true, undefined, undefined, 'admin'),
    step('users-tokens', 'API Token 卡', '下方 Token 区管理你自己的 API Token，所有有权限的用户都可使用，与用户管理相互独立。', false, undefined, undefined, 'admin'),
    step('users-tokens', 'Token 列表', '每个 Token 显示描述、前缀、创建时间和最后使用时间，便于识别长期未用的 Token 并清理。', false, undefined, undefined, 'admin'),
    step('users-token', '创建 Token', '点击「创建」输入描述（如 CI/CD 部署）后生成 Token。', false, undefined, undefined, 'admin'),
    step('users-token', '妥善保存 Token', '创建成功后 Token 完整值只显示一次，请立即复制保存；之后列表里只能看到前缀。', false, undefined, undefined, 'admin'),
    step('users-token-delete', '删除 Token', '点击行内删除按钮移除 Token，使用它的应用会立即失去访问权限，操作不可撤销。', true, undefined, undefined, 'admin'),
    docs('没有 admin.users 权限时只能管理自己的 API Token，用户列表区域不会显示。', 'admin'),
  ],
  '/profile': [
    step('profile-account', '账户信息', '显示你的用户名、角色、权限数量；OAuth 登录的账号还会显示登录方式、显示名和邮箱。', false, undefined, undefined, 'concepts'),
    step('profile-update', '检查版本更新', '点击「检查更新」检测前端新版本：有更新会提示并自动刷新，无更新则提示已是最新。', false, undefined, undefined, 'concepts'),
    step('profile-password', '修改密码', '点击「修改」输入当前密码和新密码确认后生效；本地密码登录的账号应定期更换。', false, undefined, undefined, 'security'),
    step('profile-oauth', '身份绑定', '列出已绑定的 OAuth 身份（SSE Market / UniSSO），每条可单独解绑；解绑前确保还有其他登录方式。', false, undefined, undefined, 'security'),
    step('profile-oauth-bind', '绑定登录方式', '点击对应按钮跳转到 OAuth 授权页完成绑定；已绑定的提供商按钮置灰并显示「已绑定」。', true, undefined, undefined, 'security'),
    step('profile-theme', '外观主题', '选择白天、黑夜或自动跟随浏览器；偏好保存在当前浏览器，不影响其他设备。', false, undefined, undefined, 'concepts'),
    step('profile-security', '账户安全体检', '基于你当前的账户状态（角色、权限数、绑定身份、推送开关等）让 AI 现场生成安全评估和改进建议。', false, undefined, undefined, 'security'),
    step('profile-security-run', '开始体检', '点击「开始体检」，AI 会给出一句话总体结论和 2-4 条可执行的改进建议，结果显示在卡片内。', false, undefined, undefined, 'security'),
    step('profile-install', '安装应用', '把平台安装到桌面或主屏幕，以独立窗口快速打开；iOS 需在 Safari 中「添加到主屏幕」。', true, undefined, undefined, 'concepts'),
    step('profile-install-btn', '安装', '浏览器支持时显示「安装应用」按钮，点击后按系统提示确认安装。', true, undefined, undefined, 'concepts'),
    step('profile-push', '推送通知', '开启后平台会向你推送 11 类事件通知，如 Pod 故障、部署结果、审批待审、配额预警等。', false, undefined, undefined, 'monitoring'),
    step('profile-push-toggle', '推送总开关', '打开开关会请求浏览器通知权限并完成订阅；关闭则取消订阅。权限被拒时需到浏览器设置中开启。', false, undefined, undefined, 'monitoring'),
    step('profile-push-kinds', '通知类型偏好', '按需勾选 7 类推送：故障告警、恢复通知、部署结果、审批待审、AI 任务完成、配额预警、平台广播；默认全部开启。', false, undefined, undefined, 'monitoring'),
    step('profile-push-save', '保存偏好', '修改勾选后点击「保存偏好」生效；未保存前按钮处于可用状态，保存后恢复禁用。', false, undefined, undefined, 'monitoring'),
    docs('顶栏铃铛是站内通知中心，可筛选类型和全部已读；推送偏好只控制浏览器 Web Push。', 'monitoring'),
  ],
}

const STORAGE_KEY = 'sseinfra_onboarding_v6'

function completed(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`) === 'done' } catch { return false }
}
function finish(user: string, page: string) {
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`, 'done') } catch { /* private browsing / quota */ }
}
function skippedIndex(user: string, page: string, length: number): number {
  try {
    const value = Number(localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`))
    return Number.isFinite(value) ? Math.min(length - 1, Math.max(0, Math.floor(value))) : 0
  } catch { return 0 }
}
function wasSkipped(user: string, page: string): boolean {
  try { return localStorage.getItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`) === '1' } catch { return false }
}
function restart(user: string, page: string) {
  try { localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}`); localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`); localStorage.removeItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`) } catch { /* private browsing / quota */ }
}
function saveIndex(user: string, page: string, index: number) {
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`, String(index)) } catch { /* private browsing / quota */ }
}
function skip(user: string, page: string, index: number) {
  // Closing or skipping is not completion: replay from the saved point later.
  try { localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:skipped`, '1'); localStorage.setItem(`${STORAGE_KEY}:${encodeURIComponent(user)}:${page}:index`, String(index)) } catch { /* private browsing / quota */ }
}

function rendered(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
  }
  return true
}
function viewport() {
  const v = window.visualViewport
  return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight }
}
// Intersect overflow ancestors as well as the viewport (main and horizontal tabs scroll independently).
function visibleRect(el: HTMLElement) {
  const r = el.getBoundingClientRect(), v = viewport()
  let left = Math.max(r.left, v.left), right = Math.min(r.right, v.left + v.width)
  let top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.top + v.height)
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p), b = p.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right) }
    if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) }
  }
  return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
type Geometry = { left: number; top: number; width: number; height: number; x: number; y: number; arrow: number; above: boolean; maxHeight: number }

export function OnboardingGuide() {
  const { pathname, key } = useLocation()
  const user = useAuthStore(s => s.user)
  const loggedIn = useAuthStore(s => s.isLoggedIn)
  const path = pathname.replace(/\/$/, '') || '/'
  const page = /^\/pods\/[^/]+$/.test(path) ? '/pods/:name' : path
  if (!loggedIn || !user || !guides[page]) return null
  // A keyed instance synchronously discards bubbles, timers and progress on navigation / identity change.
  return <PageGuide key={`${user}:${pathname}:${key}`} user={user} page={page} pathname={pathname} steps={guides[page]!} />
}

function PageGuide({ user, page, pathname, steps }: { user: string; page: string; pathname: string; steps: Step[] }) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(() => skippedIndex(user, page, steps.length))
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const scrollRequested = useRef(true)
  const current = steps[index]!
  const close = (completed = false) => {
    if (bubble.current?.contains(document.activeElement)) document.querySelector<HTMLButtonElement>('[data-onboarding-launcher]')?.focus({ preventScroll: true })
    if (completed) finish(user, page)
    else { skip(user, page, index); setOpen(false) }
    setOpen(false)
  }
  const advance = (next: number) => {
    saveIndex(user, page, next)
    scrollRequested.current = true
    setGeometry(null)
    setIndex(next)
  }

  useLayoutEffect(() => {
    let frame = 0, target: HTMLElement | null = null, missingSince = performance.now()
    let disposed = false
    const ro = new ResizeObserver(() => schedule())
    const update = () => {
      if (disposed) return
      const root = Array.from(document.querySelectorAll<HTMLElement>('[data-onboarding-page]')).find(el => el.dataset.onboardingPage === pathname)
      const suppressed = !!root?.querySelector('[data-onboarding-unavailable]')
      setUnavailable(suppressed)
      if (suppressed || !open) { setGeometry(prev => prev === null ? prev : null); return }
      const done = current.doneTarget && root?.querySelector(`[data-onboarding-state=\"${current.doneTarget}\"]`)
      if (done && rendered(done as HTMLElement)) {
        if (index < steps.length - 1) { scrollRequested.current = true; setIndex(index + 1) }
        else { finish(user, page); setOpen(false) }
        return
      }
      const targetRoot = current.target.startsWith('deploy-') ? document : (root || document)
      const candidates = Array.from(targetRoot.querySelectorAll<HTMLElement>(`[data-onboarding-target="${current.target}"]`)).filter(rendered)
      const fallbackCandidates = current.fallbackTarget
        ? Array.from((root || document).querySelectorAll<HTMLElement>(`[data-onboarding-target="${current.fallbackTarget}"]`)).filter(rendered)
        : []
      // Contextual controls mount only after their owning tab/modal is opened. While
      // absent, anchor the explanation to that real tab rather than hiding the bubble.
      const usable = candidates.length ? candidates : fallbackCandidates
      const next = usable.find(el => { const r = visibleRect(el); return r.width > 4 && r.height > 4 }) ?? usable[0] ?? null
      if (target !== next) {
        if (target) ro.unobserve(target)
        target = next
        if (target) ro.observe(target)
      }
      // Let dialogs, menus, drawers and the assistant own their interaction surface.
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="listbox"], [role="menu"], [data-onboarding-overlay]')).some(rendered)
      // The guide is below modal/popover layers; hide it while any overlay owns focus.
      if (!target || overlay) {
        setGeometry(prev => prev === null ? prev : null)
        if (!target && current.optional && performance.now() - missingSince > 2200) {
          if (index < steps.length - 1) {
            scrollRequested.current = true
            setIndex(index + 1)
          } else {
            finish(user, page)
            setOpen(false)
          }
        }
        return
      }
      missingSince = performance.now()
      let r = visibleRect(target)
      if (scrollRequested.current) {
        scrollRequested.current = false
        const full = target.getBoundingClientRect()
        if (r.width < full.width - 2 || r.height < full.height - 2) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = visibleRect(target)
      }
      if (r.width < 4 || r.height < 4) { setGeometry(prev => prev === null ? prev : null); return }
      const v = viewport(), margin = 12, gap = 14
      const width = Math.min(320, v.width - margin * 2)
      const below = v.top + v.height - margin - r.bottom - gap
      const aboveSpace = r.top - v.top - margin - gap
      const naturalHeight = (bubble.current?.lastElementChild?.scrollHeight ?? 0) + 2
      const above = below < naturalHeight && aboveSpace > below
      const maxHeight = Math.max(0, above ? aboveSpace : below)
      // If the keyboard / a giant target leaves no usable space, don't cover the control.
      if (maxHeight < 110) { setGeometry(prev => prev === null ? prev : null); return }
      const height = Math.min(naturalHeight, maxHeight)
      const x = Math.max(v.left + margin, Math.min(v.left + v.width - margin - width, r.left + r.width / 2 - width / 2))
      const y = above ? r.top - gap - height : r.bottom + gap
      const nextGeometry = { left: r.left, top: r.top, width: r.width, height: r.height, x, y, arrow: Math.max(14, Math.min(width - 14, r.left + r.width / 2 - x)), above, maxHeight }
      setGeometry(prev => prev && Object.keys(nextGeometry).every(k => prev[k as keyof Geometry] === nextGeometry[k as keyof Geometry]) ? prev : nextGeometry)
    }
    function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    if (bubble.current) ro.observe(bubble.current)
    const mo = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-onboarding-ui]'))) schedule()
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'aria-expanded'] })
    // A low-frequency check handles late mounts, CSS transitions and missing optional controls.
    const timer = open ? window.setInterval(schedule, 250) : undefined
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearInterval(timer); mo.disconnect(); ro.disconnect()
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, index, current, pathname, steps, user, page])

  useEffect(() => {
    const onToggle = () => {
      if (open) {
        // Treat the launcher as pause: persist the current point and resume later.
        close(false)
        return
      }
      // An explicit replay after completion starts from the beginning; a skipped
      // tour resumes its saved index rather than silently resetting it.
      if (completed(user, page)) { restart(user, page); setIndex(0) }
      setGeometry(null)
      scrollRequested.current = true
      setOpen(true)
    }
    window.addEventListener('yatterra:onboarding-toggle', onToggle)
    return () => window.removeEventListener('yatterra:onboarding-toggle', onToggle)
  }, [open, user, page])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // No global arrow shortcuts: inputs, terminals, selects and editors retain their keys.
      if (event.key !== 'Escape' || event.defaultPrevented || !geometry) return
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (unavailable) return null

  return <Portal>
    {open && <>
      {geometry && <div data-onboarding-ui aria-hidden="true" className="pointer-events-none fixed rounded-lg border-2 border-accent/70 shadow-[0_0_0_4px_rgba(10,132,255,0.12)]" style={{ zIndex: 'var(--z-popover)', left: geometry.left - 3, top: geometry.top - 3, width: geometry.width + 6, height: geometry.height + 6 }} />}
      <div ref={bubble} data-onboarding-ui data-onboarding-active-target={current.target} role="dialog" aria-modal="false" aria-labelledby="onboarding-title" aria-describedby="onboarding-description"
        className="fixed rounded-2xl border border-white/70 bg-white/80 text-ink shadow-[0_12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl"
        style={{ zIndex: 'var(--z-popover)', width: Math.min(320, viewport().width - 24), left: geometry?.x ?? 0, top: geometry?.y ?? 0, visibility: geometry ? 'visible' : 'hidden', pointerEvents: geometry ? 'auto' : 'none' }}>
        {geometry && <span data-onboarding-arrow aria-hidden="true" className="pointer-events-none absolute h-3 w-3 rotate-45 border-white/70 bg-white/80" style={{ left: geometry.arrow - 6, [geometry.above ? 'bottom' : 'top']: -7, borderWidth: geometry.above ? '0 1px 1px 0' : '1px 0 0 1px' }} />}
        <div className="relative overflow-y-auto p-4" style={{ maxHeight: geometry ? geometry.maxHeight - 2 : undefined }}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-accent">新手指引 · {index + 1} / {steps.length}</span>
            <button type="button" aria-label="关闭新手指引" onClick={() => close(false)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/5"><X size={15} /></button>
          </div>
          <div aria-live="polite" aria-atomic="true">
            <h2 id="onboarding-title" className="mt-1 text-base font-bold">{current.title}</h2>
            <p id="onboarding-description" className="mt-2 text-xs leading-5 text-ink-2">{current.description}</p>
            {current.lesson && <a href={lessonHref(current.lesson)} className="mt-2 inline-flex text-xs text-accent hover:underline">查看课程：{current.lesson}</a>}
          </div>
          {(current.target === 'pod-tab-deploys' || current.target.startsWith('deploy-')) && (
            <button type="button" onClick={() => {
              document.querySelector<HTMLElement>('[data-onboarding-target="pod-tab-deploys"]')?.click()
              if (current.target !== 'pod-tab-deploys') {
                const deadline = performance.now() + 2000
                const openForm = () => {
                  const create = document.querySelector<HTMLElement>('[data-onboarding-target="deploy-create"]')
                  if (create && rendered(create)) create.click()
                  else if (performance.now() < deadline) window.setTimeout(openForm, 50)
                }
                openForm()
              }
            }} className="mb-3 w-full rounded-lg border border-accent/30 px-2 py-2 text-xs text-accent hover:bg-accent/5">
              {current.target === 'pod-tab-deploys' ? '打开部署标签（不会提交）' : '打开部署表单（不会提交）'}
            </button>
          )}
          <button type="button" onClick={() => { restart(user, page); advance(0) }} className="mt-3 rounded-lg px-2 py-2 text-xs text-muted hover:bg-black/5">重新开始</button>
          <div className="mt-4 flex items-center justify-between gap-2">
            <button type="button" onClick={() => close(false)} className="rounded-lg px-2 py-2 text-xs text-muted">跳过本页</button>
            <div className="flex gap-1">
              {index > 0 && <button type="button" onClick={() => advance(index - 1)} className="rounded-lg px-2 py-2 text-xs hover:bg-black/5">上一步</button>}
              <button type="button" onClick={() => index === steps.length - 1 ? close(true) : advance(index + 1)} className="rounded-lg bg-accent/85 glass-blur px-3 py-2 text-xs font-semibold text-white">{index === steps.length - 1 ? '已读' : '下一步'}</button>
            </div>
          </div>
        </div>
      </div>
    </>}
  </Portal>
}
