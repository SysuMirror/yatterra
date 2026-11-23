#!/usr/bin/env python3
"""一次性种子：上架默认充值档位（售价 = 到账）。

没有商品时，用户从余额提醒点进 ``/billing`` 只会看到「暂无可充值的金额档位」。
这里写入 ¥10 / 20 / 50 / 100 四档（``item_key=topup-<元>``），幂等
（``pay.upsert_item`` 按 item_key upsert），重复跑不会重复插行，
也不会覆盖之后在后台改过的价格 —— 会覆盖 title/amount/credit。

用法::

    sudo -E env $(sudo cat /opt/yatterra/.env | grep -v '^#' | xargs -d '\\n' | tr '\\n' ' ') \\
        python3 web/scripts/seed_pay_items.py --apply

（需要 DB 可达：走 ``users._conn()``，读 ``MYSQL_ROOT_PASSWORD`` / db.conf。）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 档位：元 → 元（售价 = 到账）。要改比例时把第二个数调大即可（如 100 送 10）。
TIERS = [(10, 10), (20, 20), (50, 50), (100, 100)]


def main():
    apply = "--apply" in sys.argv
    import pay

    for i, (price_yuan, credit_yuan) in enumerate(TIERS):
        key = f"topup-{price_yuan}"
        title = (f"充值 ¥{credit_yuan}" if credit_yuan == price_yuan
                 else f"充值 ¥{price_yuan}（到账 ¥{credit_yuan}）")
        print(f"{key:14s} {title:24s} amount={price_yuan * 100} 分  credit={credit_yuan * 100} 分")
        if apply:
            pay.upsert_item(key, title, price_yuan * 100, credit_yuan * 100,
                            description="预付费余额充值", sort_order=i, is_active=1)

    if not apply:
        print("\n(dry-run: 未写入。加 --apply 落库)")
        return 0
    print(f"\n已上架 {len(TIERS)} 个充值档位。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
