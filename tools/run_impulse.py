# -*- coding: utf-8 -*-
"""fixtures/tx_dummy.json 을 충동성 스코어러에 통과시키고 결과 리포트를 쓴다."""
from __future__ import annotations
import json, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.engine.impulse import Tx, score_all, BANDS  # noqa: E402

rows = json.loads((ROOT / "fixtures" / "tx_dummy.json").read_text(encoding="utf-8"))
txs = [Tx(id=r["id"], at=datetime.fromisoformat(r["at"]), amount=r["amount"],
          merchant_raw=r["merchant_raw"], brand=r["brand"], category=r["category"],
          is_recurring=r["is_recurring"], pg=r["pg"]) for r in rows]
by_id = {t.id: t for t in txs}
results = score_all(txs)

L: list[str] = []
L.append(f"거래 {len(txs)}건 / {min(t.at for t in txs):%Y-%m-%d} ~ {max(t.at for t in txs):%Y-%m-%d}")
L.append("")

dist = {b: 0 for _, _, b in BANDS}
for r in results:
    dist[r.band] += 1
L.append("── 밴드 분포 ──")
for _, _, b in BANDS:
    L.append(f"  {b:<10} {dist[b]:3d}건")
L.append("")

L.append("── 충동 패턴 지표 상위 12건 ──")
for r in sorted(results, key=lambda x: -x.score)[:12]:
    t = by_id[r.tx_id]
    L.append(f"[{r.score:3d} {r.band}] {t.at:%m/%d %H:%M} {t.merchant_raw[:34]:<34} {t.amount:>9,}원")
    L.append(f"        {t.brand} / {t.category}")
    for e in r.evidence:
        L.append(f"        · {e}")
    L.append("        " + "  ".join(f"{k}={v}" for k, v in r.parts.items() if v > 0))
    L.append("")

L.append("── 고액인데 충동으로 잡히지 않은 건 (planned gate 검증) ──")
big = sorted(results, key=lambda x: -by_id[x.tx_id].amount)[:10]
for r in big:
    t = by_id[r.tx_id]
    flag = " ← 상한 적용" if r.planned_capped else ""
    L.append(f"[{r.score:3d} {r.band:<9}] {t.amount:>9,}원  {t.merchant_raw[:38]:<38} ({t.category}){flag}")

(ROOT / "fixtures" / "_impulse_report.txt").write_text("\n".join(L), encoding="utf-8")
print("ok")
