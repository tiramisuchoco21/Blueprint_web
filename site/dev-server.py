# 로컬 개발용 서버 (Node 없이 확인용)
#   python dev-server.py            → 정적 서빙만. /api 없음 = 실제 배포 전 상태와 동일
#   python dev-server.py --mock-ai  → /api/config, /api/ai 를 가짜로 응답해 AI 배선을 검증
#
# 배포는 Vercel이 public/ 을 서빙하고 api/*.js 를 서버리스로 실행하므로
# 이 파일은 개발 편의용입니다. --mock-ai 응답은 절대 실제 AI가 아닙니다.
import http.server, json, os, re, sys, urllib.parse, urllib.request

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PORT = 8777
MOCK_AI = "--mock-ai" in sys.argv

# 로컬에서 정책 API 를 실제로 붙여보려면 키를 환경변수로 넘긴다 (파일에 저장하지 않는다)
#   YOUTH_API_KEY=... python dev-server.py --mock-ai
YOUTH_API_KEY = os.environ.get("YOUTH_API_KEY", "")
YC_ENDPOINT = "https://www.youthcenter.go.kr/go/ythip/getPlcy"
PERIOD_LABEL = {"0057001": "특정기간", "0057002": "상시", "0057003": "마감"}


def _s(v):
    if v is None:
        return None
    t = str(v).strip()
    return None if t == "" else t


def _n(v):
    t = _s(v)
    if t is None:
        return None
    d = re.sub(r"[^\d]", "", t)
    return int(d) if d else None


def _list(v):
    t = _s(v)
    return [x.strip() for x in t.split(",") if x.strip()] if t else []


def _ymd(v):
    t = _s(v)
    if not t:
        return None
    d = re.sub(r"[^\d]", "", t)
    return f"{d[0:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else t


def _yc_normalize(it):
    """api/policies.js 의 normalize() 와 같은 결과를 낸다 (로컬 개발용)"""
    code = _s(it.get("aplyPrdSeCd"))
    raw = _s(it.get("aplyYmd"))
    parts = [x.strip() for x in raw.split("~")] if raw else []
    earn = _s(it.get("earnCndSeCd"))
    emax = _n(it.get("earnMaxAmt"))
    return {
        "plcy_no": _s(it.get("plcyNo")),
        "name": _s(it.get("plcyNm")),
        "explain": _s(it.get("plcyExplnCn")),
        "support": _s(it.get("plcySprtCn")),
        "keywords": _list(it.get("plcyKywdNm")),
        "lclsf": _list(it.get("lclsfNm")),
        "mclsf": _list(it.get("mclsfNm")),
        "provider": _s(it.get("sprvsnInstCdNm")) or _s(it.get("operInstCdNm")),
        "eligibility": {
            "age": {"min": _n(it.get("sprtTrgtMinAge")), "max": _n(it.get("sprtTrgtMaxAge")),
                    "limited": it.get("sprtTrgtAgeLmtYn") == "Y"},
            "income_cond_code": earn,
            "income_max": None if (earn == "0043001" or emax == 0) else emax,
            "marriage_code": _s(it.get("mrgSttsCd")),
            "job_codes": _list(it.get("jobCd")),
            "school_codes": _list(it.get("schoolCd")),
            "sbiz_codes": _list(it.get("sBizCd")),
            "zip_cds": _list(it.get("zipCd")),
            "extra_note": _s(it.get("addAplyQlfcCndCn")),
            "exclude_note": _s(it.get("ptcpPrpTrgtCn")),
        },
        "apply_period": {
            "code": code, "label": PERIOD_LABEL.get(code), "raw": raw,
            "start": _ymd(parts[0]) if parts else None,
            "end": _ymd(parts[1]) if len(parts) > 1 else None,
            "biz_start": _ymd(it.get("bizPrdBgngYmd")), "biz_end": _ymd(it.get("bizPrdEndYmd")),
        },
        "action": {
            "apply_url": _s(it.get("aplyUrlAddr")),
            "documents": _s(it.get("sbmsnDcmntCn")),
            "apply_method": _s(it.get("plcyAplyMthdCn")),
        },
        "source": {
            "name": _s(it.get("sprvsnInstCdNm")) or "온통청년",
            "url": _s(it.get("refUrlAddr1")) or _s(it.get("aplyUrlAddr")) or "https://www.youthcenter.go.kr",
            "based_on": ((_s(it.get("lastMdfcnDt")) or _s(it.get("frstRegDt")) or "")[:10]) or None,
        },
    }

MOCK_TEXT = {
    "explain_blueprint": (
        "[MOCK] 목표 1억 원을 전부 현금으로 모을 필요는 없습니다. "
        "정책금융 8,000만 원을 상품상 최대한도 기준으로 활용하면 필요한 자기자본은 2,000만 원이고, "
        "이미 600만 원을 확보하셨으니 남은 1,400만 원을 24개월간 월 583,000원씩 모으는 것이 핵심 과제입니다. "
        "실제 한도는 신청 시점의 심사 기준에 따라 달라질 수 있습니다."
    ),
    "explain_verdict": (
        "[MOCK] 연령·소득·무주택·자산 요건을 모두 충족해 1차 자격검토를 통과했습니다. "
        "다만 이는 승인 확정이 아니라 상품 기준에 비추어 검토가 가능하다는 의미입니다. "
        "신청 전에 임차할 주택의 보증금 한도와 순자산 기준을 다시 확인하시는 것이 좋습니다."
    ),
    "explain_fintox": (
        "[MOCK] 이번 결제는 평소 결제액보다 크고 야간에 이루어졌습니다. "
        "금액 자체는 월 저축목표의 일부에 그치지만, 같은 패턴이 반복되면 목표 도달 시점이 뒤로 밀립니다. "
        "소비를 줄이기보다 지역화폐나 K-패스처럼 같은 소비를 더 싸게 하는 수단을 먼저 적용해 보세요."
    ),
}


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            if not MOCK_AI and not YOUTH_API_KEY:
                return self._json({"error": "not_found"}, 404)
            return self._json({
                "supabaseUrl": None, "supabaseAnonKey": None,
                "hasAI": bool(MOCK_AI), "hasPolicyApi": bool(YOUTH_API_KEY),
                "policyDbBasedOn": "2026-09-03", "mock": True,
            })
        if path == "/api/policies":
            if not YOUTH_API_KEY:
                return self._json({"error": "no_api_key",
                                   "message": "YOUTH_API_KEY 환경변수가 없습니다. 정형 정책 DB로 동작합니다."}, 503)
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            params = {"apiKeyNm": YOUTH_API_KEY, "rtnType": "json", "pageType": "1",
                      "pageNum": qs.get("pageNum", ["1"])[0], "pageSize": qs.get("pageSize", ["50"])[0]}
            for k in ("zipCd", "lclsfNm", "mclsfNm", "plcyKywdNm", "plcyNm", "plcyNo"):
                if qs.get(k):
                    params[k] = qs[k][0]
            url = YC_ENDPOINT + "?" + urllib.parse.urlencode(params)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                result = data.get("result") or {}
                lst = result.get("youthPolicyList") or []
                return self._json({
                    "count": len(lst), "paging": result.get("pagging"),
                    "policies": [_yc_normalize(x) for x in lst],
                })
            except Exception as e:
                return self._json({"error": "proxy_failed", "message": str(e)}, 502)
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/ai":
            return self._json({"error": "not_found"}, 404)
        if not MOCK_AI:
            return self._json({"error": "no_api_key"}, 503)
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        task = body.get("task")
        if task == "parse_goal":
            return self._json({})   # 규칙 파서 결과를 그대로 쓰게 둔다
        if task in MOCK_TEXT:
            return self._json({"text": MOCK_TEXT[task], "model": "mock-model"})
        return self._json({"error": "unknown_task"}, 400)


print("serving %s at http://127.0.0.1:%d%s" % (DIR, PORT, "  [MOCK AI 켜짐]" if MOCK_AI else ""))
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
