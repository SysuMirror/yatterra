# YatTerra P0+P1 统一实施方案（汇编 + 完备性批评）

> 本文件由 5 份设计规格（p0a-gpu-metering / p0b-feature-tables / p1a-time-axis-contract / p1b-forecast / p1c-defer-queue）合并、去重、裁决而成。**只读，不改任何文件。**
>
> **本章程的锚点分级**：标 `✓` 者为本轮本人 `sudo` 只读复核（DB 查询 / 文件读取 / 现场 `nvidia-smi`）确认；标 `(spec)` 者沿用设计规格所载 `file:line`，未逐条复核（实施前请按该锚点名核对）。

---

## 0. 事实校正（先接受，否则会误修）

| # | 命题 | 裁决 | 依据（本轮实测） |
|---|---|---|---|
| F1 | 背景称"`gpu_mem_gib_seconds` 与 `gpu_compute_card_seconds` 全为 0" | **半错。只有 `gccs` 死；`gpu_mem_gib_seconds` 是活的。** | ✓ 三表 `gccs` count(>0)=0、`max=0`；`mem_gib_seconds` `usage_samples` 253440 行全非零、`usage_hourly` 10114 行、`usage_daily` 466 行非零（`sum=49,185,452`）。P0-a 范围**收敛为 SM 链路一条**。 |
| F2 | 计量库是 `/opt/yatterra/web/usage_meter.db` | **错（陷阱）。** 真库 `/opt/yatterra/usage_meter.db`（35 MB, root:root 0640）；`web/usage_meter.db` 是 0 字节陈旧文件。 | ✓ `ls -la` 两处；一律用 `siteconf.path("usage_meter.db")`。 |
| F3 | 历史深度 | **确认 ~10 天** | ✓ `usage_hourly` hour_start ∈ [1793080800, 1793944800]，241 桶 / 45 组 → 恰 240h=10.0 天。**周节律不可估**（P1-b 只能用 24h 周期）。 |
| F4 | daemon 解释器 | **`/usr/bin/python3` = 3.12.3，无 numpy/pandas/scipy/statsmodels** | ✓ `import numpy` → ModuleNotFoundError；`which python3` 第一顺位是 miniconda 但 systemd 显式 `/usr/bin/python3`（`yatterra-usage-meter.service` ✓）。**forecast 必须纯 stdlib。** |
| F5 | 根因机制 | **确认成立** | ✓ 现场 `nvidia-smi pmon -c 1`：所有 pod 进程（strata/python）`sm` 列恒 `-`；唯一有值者是 `nvidia-cuda-mps`（本轮 gpu1 sm=0，规格记录过 99——数值随刻变化，机制不变）。`gpu_stats.py` `_pmon_sm()` 确在 `sm in ("-","")` 时 `continue` ✓；`per_pod_breakdown()` 用 `sm.get((idx,pid),0.0)`、`kvcache.set(...ttl=10)` ✓。 |
| F6 | `host_alerts.WATCHED_UNITS` 漏登记 `yatterra-usage-meter` | **确认** | ✓ `host_alerts.py` WATCHED_UNITS 列表无 `yatterra-usage-meter`；该键可经 `YATTERRA_ALERT_UNITS` 覆盖。 |

其余已复核锚点（供实施直接用）：`usage_store` 保留期 48h/400d/5y ✓、`hour_of/day_of = ts//3600|86400`（UTC，无时区换算）✓、`_read` 用 `as_uri()+"?mode=ro"` ✓、`usage_hourly` DDL **无 `gpu_util_sum`、无 min/max 峰谷** ✓、`pressure.json` 含 `stats.<dim>.{now,avg,peak,n}` + `level.<dim>` + `gpu_cards[].{index,util,mem,temp,power}` ✓、`gpu_loop.py:28 POLL_S=5` ✓、`req_loop.py:37 POLL_S=60` ✓、`deploys._scheduling_ctx` 硬编码 `base["preemptable"]=kind=="train"` ✓、`deploys.add` dep 字典无契约字段 ✓、`scheduler.{mark:121,all_deploys:145,_group_gpus:196,place_train:213,gpu_for_deploy:248}` ✓、`priority_kill.{group_priority:250,do_evict:430,deploys.stop:453,do_recover:512,supervisorctl_start:561}` ✓、`deploys.{migrate:970,park:997,stop:1024}` ✓、`gpu_loop.{handle_pressure:41(park:58),handle_queued:64(place_train:75)}` ✓、`tests/SKILL.md` 约定 ✓。

---

## 1. 依赖顺序与阶段划分

```
P0-a (GPU计量)  ──┐
                  ├─► P0-b (特征表) ──► P1-b (forecast) ──► P1-c (defer_queue)
P1-a (契约+时间轴骨架，no-op 缺省) ───────────────────────┘        ▲
                      (P1-a 须在 P1-c 布线前落地)                     │
                                        P1-b 冻结接口 ◄──────────────┘
```

| 阶段 | 交付 | 前置 | 为什么在此顺序 |
|---|---|---|---|
| **P0** | P0-a 修 SM 计量 | 无（纯读、单函数、无 DB 迁移） | 一切下游（特征表 gpu 列、forecast gpu 维、P1-c GPU 供给）的正信号来源；不修则 `gpu_util*` 全链恒 0。**最先。** |
| **P0** | P0-b 特征表 | 无（但 `gpu_util` 列在 P0-a 前无意义） | forecast 的读源；先有管道才能谈预测。与 P0-a 可并行开发，**合并上线时 P0-a 先于或同批于 P0-b**。 |
| **P1** | P1-a 契约 + 时间轴骨架 | 无（缺省=旧行为，纯 no-op） | P1-c 的准入判定与调度改判全靠契约读取器；须在 P1-c 布线前冻结。**可与 P0 并行。** |
| **P1** | P1-b forecast | P0-b（读源）+ P1-a（`timeline.json` schema） | 产 P1-c 的时间轴供给；其接口必须在 P1-c 编码前冻结。 |
| **P1** | P1-c defer_queue | P1-a + P1-b 接口 | 消费方，最后。可在 `forecast` 缺失下先做"降级=反应式"开发与测试。 |

**关键裁决**：P0-a 与 P0-b 同批上线；P1-a 可与 P0 并行但**合并门禁**是"契约缺省严格复现今日行为"（见 §3 矛盾 D2/D3）。

---

## 2. 各交付物

### 2.1 P0-a — 修复 GPU 计量（`gpu_compute_card_seconds` 恒 0）

**根因（已复核）**：MPS 平台级，`pmon` 只把 SM 记到 `nvidia-cuda-mps` 进程（cgroup 非 `kubepods-*` → `_pid_group` 返回 `""` → `if not group: continue` 丢弃），pod 进程 `sm` 恒 `-` → `sm.get((idx,pid),0.0)` 恒 miss → `util` 恒 0 → `gccs = util/100*dt = 0`；rollup 只是 SUM，不丢，0 在源头产生。

**最小修复：只改一个函数，签名不变。** 把每卡 pod `util` 改为"按该卡总归属显存份额分摊设备级 `utilization.gpu`"，`pmon` 结果为**覆盖项**（非 MPS 主机行为不变）。下游 `usage_meter.py:192-194`、`usage_store` 三表**零改动**。

- **文件变更清单**
  - 改 `/opt/yatterra/web/gpu_stats.py`：新增 `_device_util_by_index()` / `_share_device_util()`（放在 `_pmon_sm()` 后，约 `:207`）；改 `per_pod_breakdown()`（`:210-238`，core 改动 `:226-234`）；同步 docstring `:211-216`。
  - 新建 `/opt/yatterra/web/tests/test_gpu_stats.py`、`/opt/yatterra/web/tests/test_usage_meter.py`。
  - 无需改 `usage_meter.py:166-194`、`usage_store.py:48-97/148-167`、DB schema。
- **关键函数签名**
  ```python
  def _device_util_by_index() -> dict            # {gpu_index: utilization.gpu %}；失败→{}（自吞异常）
  def _share_device_util(out, dev, pmon_idx)     # in-place 按 mem 份额分摊；pmon 覆盖卡跳过；tot<=0 守卫
  def per_pod_breakdown() -> dict                # 签名不变 {group:{idx:{"mem":MiB,"util":pct}}}
  ```
- **数据结构**：**不改**；`util` **语义变更**——从"多进程 SM 之和（可 >100）"变为"设备利用率按显存份额分摊（每卡每 pod ≤100，多卡组可 >100）"。
- **接入点（精确）**：循环内 `sm = _pmon_sm()` 后加 `pmon_idx=set()`；`v = sm.get((idx,pid))` 判 `None`（区分"无"与"0"）以标记覆盖卡；末尾调 `_share_device_util(out, _device_util_by_index(), pmon_idx)`。保留 `kvcache` get/set(ttl=10) 与 never-raise。
- **上线**：`systemctl restart yatterra-usage-meter`；面板 `yatterra-web` 也 import（`_gpu_stats_raw`）须 restart 刷新 `pods[].util`。
- **验证（改完立即做）**：① `usage_meter.py --once` 或等一 tick，只读查 `usage_samples` GPU 组 `gpu_util_sum>0 且 gccs>0`；② 量纲核对 `Σ_group(util)≈该卡 utilization.gpu`，多卡组 `gccs>dt` 正确；③ 与 `nvidia-smi --query-gpu=index,utilization.gpu` 对照（±10s 缓存）；④ 回归：`gpu_mem_gib_seconds` 仍非零且量级不变、`per_pod_usage()` 仍 mem-only；⑤ rollup 通道：`usage_hourly/daily` 的 gccs SUM>0。
- **测试**：T1 MPS 份额分摊（`dev={0:100}`，mem 2000/6000 → 25/75）；T2 pmon 覆盖项优先；T3 部分覆盖；T4 除零守卫；T5 `_query_gpus` raise 仍返回 mem、util 0、不抛；T6 宿主进程跳过；T7 `_compute_apps` raise → `{}`；T8 `per_pod_usage` mem-only；T9/T10 端到端（临时 DB）证明 `gccs==0.5*dt` 且 rollup 通道。
- **工作量**：≈1 人日。**无 DB 迁移、无新依赖。**

### 2.2 P0-b — 时序特征表（预测地基）

**不往 `usage_meter.db` 加表**（`usage_meter` 独占其 `.lock`，第二写者破坏"单写者 per DB"不变量）→ **新建独立 DB + 独立单写者 daemon**，完全复用 `siteconf`/`logutil`/flock/WAL/`mode=ro` 约定。rollup 从源重算（`INSERT...SELECT...ON CONFLICT DO UPDATE`），幂等自愈（复刻 `usage_store.py:9-11`）。

- **文件变更清单**
  - 新建 `/opt/yatterra/web/feature_store.py`（`FeatureStore`，DDL+写+rollup+prune+只读读）
  - 新建 `/opt/yatterra/web/feat_loop.py`（30s 单写者 daemon，镜像 `usage_meter.py` 骨架）
  - 新建 `/opt/yatterra/systemd/yatterra-feat-loop.service` → 安装 `/etc/systemd/system/`
  - 改 `/opt/yatterra/web/host_alerts.py`（`WATCHED_UNITS` 追加 `yatterra-feat-loop`，并**回填** `yatterra-usage-meter`）
  - 新建 `/opt/yatterra/web/tests/test_feature_store.py`、`test_feat_loop.py`
  - 新建数据 `/opt/yatterra/features.db`（**经 `siteconf.path("features.db")`，禁用 `web_path`**）
- **关键函数签名**
  ```python
  # feature_store.py
  def db_path() -> str        # env YATTERRA_FEATURE_DB or siteconf.path("features.db")
  def hour_of(ts) -> int; def day_of(ts) -> int        # 复刻 usage_store.py:92-97（UTC）
  class FeatureStore:
      def initialize(self)
      def write_tick(self, group_rows: list[dict], platform_row: dict|None, now: float, prev_ts=None)
      def _rollup_group_hour(self, db, hour_start, now); def _rollup_group_day(...)
      def _rollup_pressure_hour(...); def _rollup_pressure_day(...)
      def _prune(self, db, now)
      def _read(self, query, args) -> list[dict]        # as_uri()+"?mode=ro", timeout=5
      def series(self, group, since, until, bucket="hour"); def pressure_series(...); def summary(...)
  # feat_loop.py
  def sample_platform(now) -> dict|None        # 读 pressure.json 取 stats.<dim>.{peak,avg} + level.<dim>
  def sample_groups(since_ts, now) -> list[dict]   # ro 读 usage_samples，cpu_cores=ccs/dt
  def main()                                    # umask 0o027; flock features.db.lock LOCK_EX|LOCK_NB
  ```
- **数据结构（表）**
  - `feat_samples`(raw 48h, PK `(group_name,ts)`)：`cpu_cores`(=ccs/dt)、`cpu_req_cores`、`mem_gib`、`gpu_util`、`gpu_mem_mib`。
  - `feat_hourly`(400d, PK `(group_name,hour_start)`)：供给 SUM 列（`cpu_core_seconds/cpu_req_core_seconds/mem_gib_seconds/gpu_mem_gib_seconds/gpu_compute_card_seconds`）+ **峰谷**列（`cpu_cores_{min,avg,max}`、`gpu_util_max`、`gpu_mem_mib_max`…）+ `cpu_utilization/gap_core_hours` + `meta`(JSON，给 P1-a 契约快照留位) + `n_samples/updated_at`。
  - `feat_pressure_hourly`(400d)：`cpu_avg/max`、`gpu_avg/max`、`gpu_mem_*`、`mem_*`、`psi_*_max`、`bw_*`、`disk_max`、**`level_seconds`**（JSON：该小时在 `level=high/med/low` 停留秒数，逐 sample 累加 `pressure_writer` 滞回 `level`——**P1 时间轴原语**）。
  - `feat_daily`/`feat_pressure_daily`(5y)：积分列 SUM、速率/峰值列 avg/max。
  - 保留期 `48h / 400d / 5y`（镜像 `usage_store.py:33-35` ✓）。
- **接入点**：`siteconf.path`、`siteconf.PRESSURE_DIR/pressure.json`、ro 读 `usage_samples`、flock（`usage_meter.py:221-225` 范式）、`logutil.write`、systemd 照抄 `yatterra-usage-meter.service` ✓、`host_alerts.WATCHED_UNITS`。
- **压力侧**：**只读** `pressure.json` 的 `stats.*`（每帧已带 30s 滑窗 peak/avg ✓）+ `level.*`，**零修改** `pressure_writer`（保持其"不 import 核心"的独立性）。
- **测试**：`test_initialize_creates_tables_indexes`、`write_tick_rollup_idempotent`、`hour/day_of_utc`、`prune_retention`、`read_readonly_missing_db_empty`、`level_seconds_accumulation`、`daily_from_hourly`；loop：`sample_platform` 缺文件/坏 JSON → None 不抛、`sample_groups` from temp DB。
- **工作量**：≈4–5 人日（不含读 API）。

### 2.3 P1-a — 时间轴 + 灵活性契约

核心是**规范化契约读取器**（新模块）+ **时间轴快照骨架**（新模块）+ 6 个语义插槽。

- **env 契约**（两级 KV，**不新增存储**，走现有通用 KV；`groups.ENV_RESERVED` 不含新键，无需改校验 ✓）
  | 键 | 语义 | 取值 |
  |---|---|---|
  | `DEFER_OK` | 允许被推迟（延迟启动/中途 parked），而非"立即跑或被杀" | `1/0/true/false` |
  | `PREEMPT_OK` | 运行中允许被抢占 | 同上 |
  | `DEADLINE` | 最晚可接受启动时刻 | epoch UTC 或 `+3600`/`+1h`；非法→None |
  | `EST_DURATION_S`（**P1-c 引入**） | 预估运行时（bin-packing 的 `n_j`） | 秒；缺省 `DEFAULT_TRAIN_VRAM_MB` 同级默认 |
  **时区强制**：`DEADLINE` 一律 epoch UTC（桶按 UTC 对齐 ✓）。
- **文件变更清单**
  - 新建 `/opt/yatterra/web/contract.py`、`/opt/yatterra/web/timeline.py`
  - 改 `deploys.py`（`add` dep 字典 `:109-138` 加键；`_scheduling_ctx :448-467` 加字段并保留 `preemptable`；`_write_deploy_json :538-562`；`_run_impl :781/:815`）
  - 改 `api/pods.py :1505-1517`、`api/__init__.py :289-294`（两处**必须同步**）
  - 改 `scheduler.py`（`place_train :213-238` 前置契约判定）、`gpu_loop.py :41-61/:64-81`、`priority_kill.py :339-340/:358/:430-468/:512-578`
  - 改 `pod_guide.py :126/:197`（文档化 env）
  - 新建 `tests/test_contract.py`、`tests/test_timeline.py`
- **关键函数签名**
  ```python
  # contract.py
  def parse_bool(v) -> bool; def parse_deadline(v, now=None) -> int|None
  def derive_defaults(kind, priority) -> dict
  def contract_for(group, dep=None, now=None) -> dict   # {'defer_ok','preempt_ok','deadline'}
  def preemptable(group, dep=None) -> bool; def deferable(...) -> bool; def deadline_ts(...) -> int|None
  # timeline.py
  TIMELINE_FILE = siteconf.path('timeline.json')
  def read() -> dict; def write(obj); def phase(now=None) -> str   # 'peak'|'shoulder'|'valley'
  def next_valley(now=None); def is_valley(now=None) -> bool
  ```
- **数据结构（`timeline.json`, schema=1）**：`generated_ts/horizon_s/phase/next_valley{start,end,confidence}/next_peak{...}/per_group{<group>:{phase,valley_until}}`。**单写者=forecast**；`read()` 只读。
- **缺省推导（裁决后，见 §3-D2/D3）**：`preempt_ok` 缺省 = `kind=="train"`（**精确复现 `deploys.py:456` 现状**）；`defer_ok` 缺省 **False（所有 kind）**；`deadline` 缺省 None。`critical` 对 `preempt_ok` **单向锁死 False**（安全侧，不可被 dep env 抬回）。
- **测试**：`derive_defaults` 真值表、覆盖优先级（dep>group>缺省）、`critical` 锁死、`parse_bool/parse_deadline`、`contract_for` 在 `groups.load_state` 抛异常时回落缺省（never-raises）；`timeline` 缺文件/坏 JSON → `{}`、原子替换、相位判定、`'shoulder'` 缺省。**不新起进程测试**（污染生产）。
- **工作量**：≈3–3.5 人日（插槽在 P1-b/c 前为 no-op）。

### 2.4 P1-b — forecast.py（谷值/峰值预测）

**硬约束**：`/usr/bin/python3` 无 numpy/statsmodels → **纯 stdlib**；真 STL 不可用 → 自带"经典加性分解 + Hampel 稳健化"（STL-lite，签名与真 STL 一致，留升级位）。**周期只能 24，禁 168**（10 天历史）✓。

- **文件变更清单**
  - 新建 `/opt/yatterra/web/forecast.py`（`--backtest` CLI）、`tests/test_forecast.py`
  - 改 `/opt/yatterra/web/req_loop.py`（`import forecast`，在 60s 主人加 `forecast.update_correction()`；`req_loop.py:37 POLL_S=60` ✓）
  - 可选 `api/billing.py` 只读暴露；可选 `yatterra-forecast.service`（**推荐不加**，见 §3-D4）
  - 运行时产物：`/opt/yatterra/forecast_state.json`（EWMA 内部态）、`/opt/yatterra/timeline.json`（**发布态，与 P1-a 合并**——见 §3-D2）
- **关键函数签名**
  ```python
  def load_series(group, metric="cpu", bucket="hour") -> list[dict]   # 优先读 P0-b feat_hourly，否则 usage_hourly
  def stl_decompose(values, period=PERIOD_H, robust=True) -> (trend, seasonal, resid)
  def predict_supply(group=None, horizon=24, metric="cpu", now=None) -> dict   # {slots:[...]}，never raises
  def valley_windows(result, frac=0.33, max_windows=3) -> list[dict]
  def update_correction(group, metric, observed, slot_start, now) -> dict
  def backtest(group=None, metric="cpu", holdout_h=24, folds=3) -> dict
  # 为 P1-c 冻结补充：
  def error_quantile(metric, eps) -> float; def age_s() -> float
  def supply(dim, horizon_bins, delta_s, group=None) -> list[dict]   # P1-c 兼容薄封装
  ```
- **数据结构**：`predict_supply` → `{group, metric, horizon_h, generated_at, history_hours, stale, confidence, slots:[{slot_start,hour_of_day,hour_local,mean,p10,p50,p90,n_obs,kind}]}`，`kind∈{seasonal,climatology,flat,none}`；`slot_start=ceil(now/3600)*3600+k*3600`，`hour_local=(hour_of_day+8)%24`。预测的是**每时段需求/负载信号**，谷值=预测 p50 低。
- **降级梯度**：空库/失败→`none`+`slots=[]`；6h<n<48h→`flat,low`；48h≤n<2×周期→`climatology,low`；n≥48h→`seasonal,med/high`；最近桶 > `STALE_H(3h)`→降档；**指列全 0（如当前 gccs）→拒建模**，提示改用 `gpu_mem`。
- **测试**：合成季节恢复、短序列不抛、稳健限尖峰、冷启动 `none`、climatology 降级、组聚合一致、分位单调、死列检测、`hour_local` 偏移、partial 桶剔除、backtest 形状（MAE≥0/coverage∈[0,1]/训练严格早于预测起点）、state roundtrip+损坏、写失败仍返回。**全部 stdlib。**
- **工作量**：≈3–4.5 人日。

### 2.5 P1-c — defer_queue.py（可延迟队列 + 谷值准入）

**只收 `train`**（`serve` 钉卡永不移，`scheduler.py:4-8`）；**不新增常驻 daemon**，宿主=既有 `gpu_loop` 5s 循环 ✓。准入=`deadline-aware temporal bin-packing + 分位安全裕度`。

- **文件变更清单**
  - 新建 `/opt/yatterra/web/defer_queue.py`、`tests/test_defer_queue.py`、`tests/test_forecast_contract.py`
  - 运行时 `/opt/yatterra/defer_queue.json`(+`.lock`)、`/opt/yatterra/defer_queue.log`
  - 改 `gpu_loop.py :64-81/:41-61`、`deploys.py :781/:815/:997/:1024`（park/stop 双写队列）、`priority_kill.py :430-468/:512-578`、`scheduler.py`（契约读取器，**直接复用 `contract.py`**）、`groups.py`/`api/pods.py`/`api/__init__.py`/`pod_guide.py`（透传）
- **关键函数签名**
  ```python
  def contract_of(group, dep=None) -> dict      # 【裁决：合并进 contract.contract_for，本处仅薄封装】
  def should_defer(group, dep) -> bool
  def enqueue(group, dep, *, by="api") -> item; def remove(deploy_id, reason="", state="cancelled")
  def pending() -> list; def admit(now=None) -> list[{"deploy_id","group","start_ts","reason"}]
  def mark_running(deploy_id, gpu); def mark_done(deploy_id); def mark_missed(deploy_id, reason)
  def snapshot() -> dict
  ```
- **数据结构（`defer_queue.json`, schema=1）**：`counters{}`（含 `forecast_fallback` 健康指标）、`items{<deploy_id>:{group,kind,vram_mb,est_dur_s,deadline_ts,deadline_kind,defer_ok,preempt_ok,priority,enqueued_ts,earliest_start,state∈{queued,deferred,running,done,missed,cancelled},attempts,last_decision{ts,action,bin_start,margin,reason}}}`、有界 `history` ring。**上限** `MAX_ITEMS=500/RING_LEN=200`。三存储双写（`gpu_alloc.json` 权威 / `defer_queue.json` 延迟生命周期权威 / `deploys.last_status` 人读镜像），顺序更新、以 `defer_queue.json` 为准。
- **准入算法**：`R_t`=已提交占用；bin 可行 ⇔ `q_ε(S_t) − R_t ≥ d_j`；窗口用联合界 `ε'=ε/n_j`；EDF 排序（deadline 升序、vram 降序）；`s*` 落在谷值且 `(s*+n_j)Δ ≤ deadline` 则 commit，否则 defer。**降级**：`forecast` 不可用/`age_s()>STALE` → 仅用当前帧（=今日行为），`forecast_fallback++`。
- **接入点（精确）**：`gpu_loop.handle_queued` 在 `:75 place_train` **前**插 `admit()` 放行者才 place，其余 `mark_deferred`（**不复用 `place_train→None` 混淆语义**）；`handle_pressure :58 park` 前判 `preempt_ok/defer_ok`；`deploys._run_impl :815` 创建期 `train+defer_ok` 且未放行 → 短路为 `queued/deferred`（修 `:815-817`"gpu=None 仍起在默认卡"漏洞）；`priority_kill.do_evict :453` `deploys.stop` 前改判 defer；`do_recover :561` 前过谷值闸门；`deploys.stop/delete` 走 `defer_queue.remove`（防孤儿）。
- **边界**：错过 hard deadline → `DEADLINE_MISS_POLICY`（默认 `run_anyway`，绝不无限期滞留）；soft → 记录不阻塞；`est_dur` 失准→运行中扩窗重排；重启对账（`running` 但 `scheduler.get` 空 → `mark_done`）；组卡限制先过 `scheduler._group_gpus` ✓。
- **测试**：`contract_of` 解析/覆盖、`admit` 谷值选择/分位裕度/deadline 过滤、幂等 enqueue/remove/mark_done、原子 roundtrip+损坏容错、并发（multiprocessing/flock）、降级计数、集成桩（monkeypatch `place_train`，断言仅对 `admit()` 放行者调用）。
- **工作量**：≈7–9 人日（不含 P1-a/P1-b 本体）。

---

## 3. 设计之间的矛盾 / 重复 —— 裁决

### 重复

| # | 重复项 | 裁决 |
|---|---|---|
| D1 | **契约读取器**：P1-a `contract_for()` vs P1-c `contract_of()` | **单一实现** `contract.contract_for(group, dep, now)`；`defer_queue.contract_of` 仅薄封装（保 API 稳定），P1-c 不再自实现解析。 |
| D2 | **发布产物三份**：P1-a `timeline.json` vs P1-b `forecast.json` vs P1-b `forecast_state.json` | **收敛为两份**：`timeline.json` = 唯一**发布态**（相位+谷值窗+per_group，P1-b `snapshot()` 写它，**废弃 `forecast.json`**）；`forecast_state.json` = **内部 EWMA 态**（不发布）。P1-c 经 `timeline.read()`/kvcache 消费，**不直连** forecast 内部。 |
| D3 | **WATCHED_UNITS 登记**：4 份规格各自提醒 | **一次动作**：`host_alerts.WATCHED_UNITS` 追加 `yatterra-feat-loop`，并**回填 `yatterra-usage-meter`**（F6 确认缺失）。若 P1-b 起 daemon 再补对应名。 |
| D4 | **daemon 决策**：P0-b 起 daemon vs P1-b/c "不加 daemon" | **不冲突，统一**：仅 **P0-b 新增 `yatterra-feat-loop.service`**；P1-b 走 kvcache+`req_loop` 内联（**不起 unit**）；P1-c 内联 `gpu_loop`。 |
| D5 | **STALE 闸门**范式（压力 `STALE_S:76`、forecast `STALE_H`、defer `FORECAST_STALE_S`） | 同一模式，各域各阈值，命名统一为 `*_STALE_(S|H)`，不合并实现。 |

### 矛盾（裁决）

| # | 冲突 | 裁决与理由 |
|---|---|---|
| **C1** | **默认值语义**：P1-a `derive_defaults` 表（train→`defer_ok=True`,`preempt_ok=True`）vs P1-c（`DEFER_OK/PREEMPT_OK` 默认均 `False`） | **`preempt_ok` 缺省 = `kind=="train"`**（P1-a 胜）：这是 `deploys.py:456` 现状 ✓，取 P1-c 的 `False` 会静默让所有 train 不可抢，**破坏现有 pressure→park 行为**。**`defer_ok` 缺省 = `False`（所有 kind）**（P1-c 胜）：P1-a 的"train→True"配其接入点 #6 会把**每个**无空卡 train 从"当前起默认卡（bug）"改判为新 `deferred` 态，**这是行为变更、不是零变更**；v1 取保守 False，按组 opt-in 启用（见 §4 待补）。**`DEADLINE` 缺省 None**。 |
| **C2** | **forecast 接口**：P1-b `predict_supply(group,horizon,metric)` vs P1-c `supply(dim,horizon_bins,delta_s,group)+error_quantile+age_s` | **以 P1-b 为准**（`predict_supply`/`valley_windows`/`error_quantile`/`age_s`）；新增 P1-c 兼容薄封装 `supply()`。P1-c 必须按此冻结接口编码，不得自造 `forecast.supply` 主名。 |
| **C3** | **供给 vs 需求语义**：P1-b 预测的是**负载/需求**（cpu/mem/gpu 用量）；P1-c 需要的是未来**可用供给** `S_t`（free VRAM bins） | **这是全案最大语义缺口，未在任何设计中闭合**（详见 §4-U1）。裁决：P1-c 的 `S_t` = `host_capacity(逐卡) − 预测需求 − serve 钉卡预留 − 在跑 train 占用`；需在 P1-b 增 `capacity()`/预留台账，**列为 P1-c 开工前置**，不可默认 `forecast.supply()==free VRAM`。 |
| **C4** | **`gpu_util` 语义**：P0-a 把 util 从"进程和（可>100）"改为"设备份额（每卡≤100，多卡组可>100）" | 下游 P0-b `feat_samples.gpu_util`（读 `gpu_util_sum`）与 P1-b `gpu_card` 维须**同刻知悉**多卡聚合可 >100；P0-a docstring 记录；P0-b/forecast 的 `meta`/列注释标注"改期"分界（历史 0→真值=基线突变）。 |
| **C5** | **`_run_impl :815` 短路**：P1-a 称"零行为变更"，P1-c 承认是"创建期新增排队路径" | 判为**行为变更（含修 bug）**：`deploys.py:815-817` 现状"gpu=None 仍起在默认卡"是真漏洞；改判 `deferred` 是修复但改变可观测状态。**须纳入回归测试**并灰度（先仅对显式 `DEFER_OK=true` 的 deploy 生效）。 |
| **C6** | **deadline 解析格式**：P1-a（epoch/`+Ns`/`+Nh`）vs P1-c（`+秒`/ISO8601） | **取并集解析器**：epoch | `+Ns` | `+Nh` | ISO8601，**一律归一到 epoch UTC**；非法→None（退化无期限）。 |
| **C7** | **background "gpu_mem 全 0"** vs 三份规格 | **background 错**（F1 实测）。P0-a 范围=SM 链路；所有"该列死"的表述作废。 |
| **C8** | **契约下发路径**：P1-a 含"group env 经 `groups.set_env`"暗示；P1-c 明确"经 dep 字段下发，避免 rollout restart" | **取 P1-c**：`groups.set_env` 触发 `rollout restart`（`groups.py:1111`），契约**优先经 dep 字段**（per-deploy env `deploys.py:942-943`）下发；group env 仅作组级缺省，明确"应用侧 env 仅下次重启刷新"。 |

---

## 4. 完备性批评 —— "待补"清单

**U1（阻塞级｜C3）**：**未来可用供给的建模缺失**。forecast 只产需求分位，`S_t`（free VRAM）未定义。缺：主机容量台账（逐卡 24GB）、serve 钉卡预留扣除、在跑 train 占用回填、`capacity()` 接口。**未闭合则 P1-c 准入无正确输入。**

**U2｜P0-a**：(a) 非 MPS 主机的 pmon pod 级 SM 是否可用**未实测**（spec 自认 scout gap）；覆盖路径 `pmon_idx` 保真但仅靠单测兜底。(b) 现场 MPS 进程 SM 值随刻在 `-`/`0`/`99` 间变化（本轮实测与规格记录不一致）——**机制成立但稳定性未证**，需观察多驱动版本。(c) NVML/MPS per-client/DCGM 高精度路径**未评估**，留 P0 后续。(d) `util` 语义变更**未与前端协同**（`gpu_stats.py:270` `pods[].util` 显示含义变化）——无前端改动计划。(e) 历史 gccs 不可回填（`usage_meter.py:19`），UI/API 未定义"无数据"标注；host 级 ≤7d 可用 `fleet_metrics.db` 对账但**不含 per-group 归属，禁写回三表**（会污染列语义）。

**U3｜P0-b**：(a) schema 为草案，**未验证** prune/rollup 在真实规模下的行为。(b) `feat_samples` 与 `usage_samples` **部分冗余**（前者多了瞬时速率+平台 JOIN）；group 级 **<30s 峰谷不可恢复**（`usage_samples` 已是 30s 粒度，`usage_hourly` 只有 SUM）——只有平台侧 2s 有细峰。(c) 新 DB 使 forecast 需读**第三个** store（`usage_meter.db`→`features.db`→`fleet_metrics.db`），读路径增多。(d) `n_samples` 语义三处不一致（scout4）。(e) 无读 API/可观测性/UI 计划（仅标记 P2 可选）。(f) 无"0→真值基线突变"的分段迁移方案。

**U4｜P1-a**：(a) C5 行为变更被包装为"零变更"。(b) **无权限模型**：谁能设契约 env（guest？min_role？）未定义。(c) `gpu_alloc.json` `status` 新增 `deferred` 的**消费者迁移清单缺失**（谁遍历该字段、旧值容错）。(d) 契约经 dep 字段下发时，**旧 deploy 记录无该字段**的读取兜底未测。(e) `timeline.json` 无 schema 版本迁移策略。

**U5｜P1-b**：(a) "STL-lite" **非真 STL**，除 holdout 外无统计校验（平稳性/自相关/残差正态性）。(b) 10 天历史 → 周周期**物理不可能**（需 ≥3–4 周）；日周期+EWMA 是上限，**已写在设计但未列"何时可解锁周周期"的触发条件**。(c) 分位校准（coverage≈0.80）**未经真实数据验证**。(d) 死列检测只覆盖全 0；对"接近 0 但非 0"的退化指标未定义。(e) 趋势阻尼系数（斜率×0.5）为拍脑袋常数，无调参计划。

**U6｜P1-c**：(a) C3 供给缺口（阻塞）。(b) 联合界 `ε'=ε/n_j` **假设各 bin 独立**，忽略时段相关性 → 实际违约率可能 >ε（须标注近似）。(c) `est_dur_s` 在 enqueue 时**未知**（无运行时估计器）。(d) 错过 deadline 的**通知接线**未定（`deploys._notify_event` vs `host_alerts._fire`）。(e) 准入算法**无回测**（仅合成 forecast 单测），无"准入 vs 反应式"的 A/B 评估。(f) 三存储**无事务**（设计承认分歧窗口，仅顺序更新+容错读）。

**U7（跨切面）**：(a) 无端到端**集成测试**（P0-a→P0-b→P1-b→P1-c 全链）。(b) 无 **5s 循环成本基线**（P1-c 每轮 O(pending×H) + forecast 查询）。(c) 新增 JSON/DB 文件的**权限/属主**（现有 `usage_meter.db` 0640 root ✓，新文件须对齐）。(d) 时区一致性在 3 份规格重复强调，**无强制校验点/单测**（仅 P1-a/b 各有一处）。(e) 无整体**回滚方案**。

---

## 5. 第一批可立即动手的最小切片

> 目标：**修 GPU 计量（P0-a 全量）+ 建特征表骨架（P0-b 最小子集）**。不碰 P1，不动任何调度行为，零 DB 迁移、零新依赖。预计 **3–4 人日**。

**切片 A — P0-a（1 人日，最高优先）**
1. 改 `/opt/yatterra/web/gpu_stats.py`：加 `_device_util_by_index()`/`_share_device_util()`，改 `per_pod_breakdown()`（core `:226-234`），改 docstring。
2. 加 `tests/test_gpu_stats.py`（T1–T8）、`tests/test_usage_meter.py`（T9–T10）。
3. `systemctl restart yatterra-usage-meter yatterra-web`。
4. 跑 §2.1 验证①–⑤，**重点回归 `gpu_mem_gib_seconds` 非零量级不变**（最重要回归点）。
5. UI/API 侧标注"`<2026-11-06` gccs 无数据"（不把 0 当零用量）。

**切片 B — P0-b 骨架（2–3 人日，A 之后或并行）**
1. 新建 `/opt/yatterra/web/feature_store.py`：**仅三表** `feat_samples` / `feat_hourly` / `feat_pressure_hourly` + `initialize/write_tick/_rollup_group_hour/_rollup_pressure_hour/_prune/_read`（**先不做 daily、不做 API**）。
2. 新建 `/opt/yatterra/web/feat_loop.py`：`sample_platform()`（读 `pressure.json` `stats.*`+`level.*`）、`sample_groups()`（ro 读 `usage_samples`）、`main()`（30s、flock、never-raise）。
3. 新建 `/opt/yatterra/systemd/yatterra-feat-loop.service`（照抄 `yatterra-usage-meter.service`）→ 安装、`enable --now`；改 `host_alerts.WATCHED_UNITS` 追加 `yatterra-feat-loop` **并回填 `yatterra-usage-meter`**。
4. DB 落 `/opt/yatterra/features.db`（`siteconf.path`）。
5. 加 `tests/test_feature_store.py` + `test_feat_loop.py`（幂等/UTC 桶/prune/`level_seconds`/坏 JSON）。
6. 验证：一小时后只读查 `feat_hourly`/`feat_pressure_hourly` 有行、`level_seconds` 合理、`gpu_util_max` 在切片 A 后非零。

**为什么是这个顺序**：A 是纯读单函数、无迁移、立即恢复最关键的 GPU 信号（解阻 B 的 `gpu_util` 列与所有下游）；B 只铺"从源重算的幂等管道"，schema 与 rollup 全是 `usage_store.py` 既有范式的平移，风险最低，且是 forecast 的唯一读源。**P1-a/b/c 一律缓到 A+B 的现场验证通过后再排期。**

---

### 附：文件变更总表（去重后）

| 动作 | 路径 | 归属 |
|---|---|---|
| 改 | `/opt/yatterra/web/gpu_stats.py` | P0-a |
| 新建 | `.../web/tests/test_gpu_stats.py`, `test_usage_meter.py` | P0-a |
| 新建 | `.../web/feature_store.py`, `.../web/feat_loop.py` | P0-b |
| 新建 | `.../systemd/yatterra-feat-loop.service` → `/etc/systemd/system/` | P0-b |
| 改 | `.../web/host_alerts.py`（WATCHED_UNITS，+feat-loop，回填 usage-meter） | P0-b |
| 新建 | `.../web/tests/test_feature_store.py`, `test_feat_loop.py` | P0-b |
| 新建 | `.../web/contract.py`, `.../web/timeline.py` | P1-a |
| 改 | `.../web/deploys.py`, `scheduler.py`, `gpu_loop.py`, `priority_kill.py`, `groups.py`, `api/pods.py`, `api/__init__.py`, `pod_guide.py` | P1-a/c |
| 新建 | `.../web/forecast.py`, `.../web/tests/test_forecast.py` | P1-b |
| 改 | `.../web/req_loop.py`（内联 EWMA 宿主） | P1-b |
| 新建 | `.../web/defer_queue.py`, `.../web/tests/test_defer_queue.py`, `test_forecast_contract.py` | P1-c |
| 数据 | `/opt/yatterra/features.db`, `defer_queue.json`(+lock), `timeline.json`, `forecast_state.json`, `*.log` | 各期 |

（`gpu_stats.py` 之外的 P1 文件路径均为 `/opt/yatterra/web/` 下，已在上表简写；实施时以绝对路径为准。本轮未修改任何文件。）