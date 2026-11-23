#!/usr/bin/env python3
"""一次性种子：把已知的「平台内部组」标记为 ``internal``（不计费）。

口径（黑名单）：**默认所有组都计费**；这里显式列出的，是平台自己搭建、
自己消费的服务组，标成 ``internal=True`` 后结算 / 提醒都会跳过
（见 ``billing_settle.settle_hours`` / ``enforce``）。

用法::

    # 预览（不改任何东西）
    sudo -E YATTERRA_ROOT=/opt/yatterra python3 web/scripts/mark_internal_groups.py

    # 落库
    sudo -E YATTERRA_ROOT=/opt/yatterra python3 web/scripts/mark_internal_groups.py --apply

清单是「人工可复核」的默认值：mark 错只是免了计费（可在
``/ops/pricing`` 页面一键切回外部），漏 mark 的内部组则会短暂产生账单。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import groups  # noqa: E402  (path set above)

# 平台自建 / 自消费的服务组。判定依据：由平台运维(admin/mony)持有，
# 且是给平台自身或其他服务用的基础设施（网关、镜像、索引、模型、SSO…），
# 而不是某个租户/学院的业务组。
INTERNAL = [
    "deploy", "mirror", "operator", "unisso",        # 平台运维 / 发布链路 / SSO
    "gpt-proxy", "sub2api", "gpt-sovits",            # 网关 / 合成
    "embedding", "embeding", "reranker", "ocr",      # 向量 / 识别 依赖
    "db-minio", "zap", "qiuqiu", "tuling",           # 存储 / 扫描 / 支撑
    "octop", "artex", "but",                         # 平台自建应用
    "qwen", "qwen-3-8-flash-next", "qwen38-27b-awq-int4",
    "spark-x2-5-4b",                                 # 平台自托管模型
    "sdpy-ai-platform-p", "sdpy-ai-platform-t", "sdpy-developer-p",
    "sdpy-dshm-p", "sdpy-image-p", "sdpy-image-t",
    "sdpy-join-p", "sdpy-quest-t", "sdpy-test-join-p",  # SDPY 学院平台实例
]


def main():
    apply = "--apply" in sys.argv
    state = groups.load_state()
    have = state.get("groups", {})

    want = [n for n in INTERNAL if n in have]
    missing = [n for n in INTERNAL if n not in have]
    external = sorted(n for n in have if n not in set(want))

    print(f"groups.json: {len(have)} 组；拟标为内部 {len(want)} 个"
          f"{'（未找到: ' + ', '.join(missing) + '）' if missing else ''}")
    print(f"  internal → {' '.join(want)}")
    print(f"  保持计费 → {' '.join(external)}")
    if missing:
        print(f"  !! 清单里这些组不存在，已跳过: {' '.join(missing)}")

    if not apply:
        print("\n(dry-run: 未写入。加 --apply 落库)")
        return 0

    changed = []
    for name in want:
        if groups.set_internal(name, True):
            changed.append(name)
    print(f"\n已写入 internal=True: {len(changed)} 个 → {' '.join(changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
