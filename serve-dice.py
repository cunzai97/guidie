#!/usr/bin/env python3
"""大话骰竞技场：静态页 + 同源代理（支持 SSE 流式透传）+ 模型预设存储。
   /oa/...  -> 由 X-Base 请求头指定的任意 OpenAI 兼容端点（页面配置模型用）
   /a/...   -> http://127.0.0.1:1235/...    /b/... -> 1236（旧版固定端口）
   /wb/...  -> 本地 OpenAI 兼容网关（默认 127.0.0.1:8791，可用 DICE_WB_BASE 覆盖）
   /api/presets  GET/PUT -> presets.json（模型预设与全局设置，跨浏览器保留）
   /api/matches  GET/POST -> runs/matches.jsonl（每局一条战绩，排名用；只走 API）
   其余路径按静态文件从本目录提供（页面在 web/arena.html，共享模块在 src/）。
   presets.json 与 runs/ 不允许静态直出：前者含本机端点与密钥，只走 /api/presets。
   请求体带 "stream": true 时按 text/event-stream 边收边发，模型的思考过程实时可见；
   每个 chunk 同时解析一遍用于落盘 calls.jsonl。
环境变量:
   DICE_WB_BASE  网关根地址（默认 http://127.0.0.1:8791）
   DICE_WB_KEY   网关 api_key；不设则尝试读取本机 workbuddy 设置（公开部署请用这个）
用法: python3 serve-dice.py [port]   默认 8899
"""
import http.server, urllib.request, urllib.error, urllib.parse, os, sys, json, time

ROOT = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(ROOT, 'runs')        # 实验产物：调用流水 / 服务日志（gitignore）
os.makedirs(RUNS_DIR, exist_ok=True)
CALL_LOG = os.path.join(RUNS_DIR, 'calls.jsonl')   # 每次模型调用都落盘，便于复盘
MATCH_LOG = os.path.join(RUNS_DIR, 'matches.jsonl')  # 每局一条战绩（双方/指纹/胜负/过程指标），排名用
PRESETS_FILE = os.path.join(ROOT, 'presets.json')
PORTS = {'a': 1235, 'b': 1236}
WB_BASE = os.environ.get('DICE_WB_BASE', 'http://127.0.0.1:8791')   # 本地 OpenAI 兼容网关
TIMEOUT = 1800          # 思考模式下单步可能很慢

def wb_key():
    """读取网关 api_key。优先用环境变量 DICE_WB_KEY；
    没有则尝试从本地 workbuddy 设置里找（仅本机开发便利，公开部署请用环境变量）。"""
    env = os.environ.get('DICE_WB_KEY')
    if env:
        return env
    try:
        p = os.path.join(os.path.expanduser('~'), 'work/wb-api/hub/accounts/settings.json')
        d = json.load(open(p))
        for x in (d.get('api_keys') or []):
            if x and x.get('key') and not x.get('deleted_at') and x.get('enabled') is not False:
                return x['key']
    except Exception:
        pass
    return None
WB_KEY = wb_key()

def log_call(slot, t0, code, rq, content, reason_chars, finish, comp, error=None, meta=None):
    try:
        rec = {
            't': time.strftime('%H:%M:%S'), 'slot': slot, 'ms': int((time.time() - t0) * 1000),
            'http': code, 'sys': (rq.get('messages') or [{}])[0].get('content', ''),
            'user': (rq.get('messages') or [{}])[-1].get('content', ''),
            'mt': rq.get('max_tokens'),
            'think': (rq.get('chat_template_kwargs') or {}).get('enable_thinking'),
            # 本次请求实际生效的思考强度；复盘请求是 off，与座位配置分开记（seat_effort）。
            'effort': rq.get('reasoning_effort') or 'off',
            'think_budget': (rq.get('chat_template_kwargs') or {}).get('thinking_budget'),
            'content': content, 'reason_chars': reason_chars,
            'finish': finish, 'comp': comp, 'error': error,
        }
        # 竞技场页面会把 run_id / 座位 / 轮次 / 阶段放在请求头里，落盘后可与真值按主键对齐
        for k, v in (meta or {}).items():
            if v: rec[k] = v
        with open(CALL_LOG, 'a') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass

def arena_meta(headers):
    return {
        'run_id': headers.get('X-Arena-Run'), 'seat': headers.get('X-Arena-Seat'),
        'round': headers.get('X-Arena-Round'), 'phase': headers.get('X-Arena-Phase'),
        'model': headers.get('X-Arena-Model'),
        'ruleset_hash': headers.get('X-Arena-Ruleset'),
        'seat_effort': headers.get('X-Arena-Effort'),
    }

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def _is_api(self):
        return self.path.startswith('/a/') or self.path.startswith('/b/') or self.path.startswith('/wb/') or self.path.startswith('/oa/')

    def _is_local_api(self):
        return urllib.parse.urlsplit(self.path).path == '/api/presets'

    def _is_matches_api(self):
        return urllib.parse.urlsplit(self.path).path == '/api/matches'

    # 静态直出禁区：presets.json 含本机端点与 API Key（只走 /api/presets），
    # runs/ 是实验流水，隐藏文件（.git 等）一律不暴露。
    def _static_blocked(self):
        p = urllib.parse.urlsplit(self.path).path
        return p == '/presets.json' or p.startswith('/runs/') or any(s.startswith('.') for s in p.split('/') if s)

    # ---------- 模型预设：GET 读取 / PUT 原子写回 presets.json ----------
    def _serve_presets(self, method):
        if method == 'GET':
            try:
                with open(PRESETS_FILE, 'r', encoding='utf-8') as f:
                    data = f.read()
                json.loads(data)
            except Exception:
                data = '{"presets":[],"settings":{},"seat":{}}'
            return self._send_buffered(200, 'application/json; charset=utf-8',
                                       data.encode('utf-8'), method)
        n = int(self.headers.get('Content-Length') or 0)
        if not n or n > 512 * 1024:
            return self._send_buffered(400, 'application/json', b'{"error":"bad body size"}', method)
        try:
            obj = json.loads(self.rfile.read(n).decode('utf-8'))
            if not isinstance(obj, dict) or not isinstance(obj.get('presets'), list):
                raise ValueError('presets must be a list')
            payload = json.dumps({'presets': obj['presets'], 'settings': obj.get('settings') or {},
                                  'seat': obj.get('seat') or {}}, ensure_ascii=False, indent=2)
            tmp = PRESETS_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(payload)
            os.replace(tmp, PRESETS_FILE)
            return self._send_buffered(200, 'application/json; charset=utf-8', b'{"ok":true}', method)
        except Exception as e:
            return self._send_buffered(400, 'application/json',
                                       json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), method)

    # ---------- 对局战绩：GET 全量读取 / POST 追加一局（runs/matches.jsonl） ----------
    def _serve_matches(self, method):
        if method == 'GET':
            matches = []
            try:
                with open(MATCH_LOG, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            matches.append(json.loads(line))
                        except ValueError:
                            pass
            except FileNotFoundError:
                pass
            return self._send_buffered(200, 'application/json; charset=utf-8',
                                       json.dumps({'matches': matches}, ensure_ascii=False).encode('utf-8'), method)
        n = int(self.headers.get('Content-Length') or 0)
        if not n or n > 64 * 1024:
            return self._send_buffered(400, 'application/json', b'{"error":"bad body size"}', method)
        try:
            obj = json.loads(self.rfile.read(n).decode('utf-8'))
            if not isinstance(obj, dict) or not isinstance(obj.get('seats'), dict):
                raise ValueError('seats required')
            if not all(k in obj['seats'] for k in ('A', 'B')) or not isinstance(obj.get('points'), dict):
                raise ValueError('seats.A/B and points required')
            if not obj.get('ruleset_hash') or not obj.get('prompt_hash'):
                raise ValueError('fingerprints required')
            with open(MATCH_LOG, 'a', encoding='utf-8') as f:
                f.write(json.dumps(obj, ensure_ascii=False) + '\n')
            return self._send_buffered(200, 'application/json; charset=utf-8', b'{"ok":true}', method)
        except Exception as e:
            return self._send_buffered(400, 'application/json',
                                       json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'), method)

    # ---------- 工具 ----------
    def _headers(self, code, ctype, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Access-Control-Allow-Origin', '*')

    def _send_buffered(self, code, ctype, data, method='GET'):
        self._headers(code, ctype, {'Content-Length': str(len(data))})
        self.end_headers()
        if method != 'HEAD':
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _chunk(self, data):
        self.wfile.write(('%x\r\n' % len(data)).encode() + data + b'\r\n')
        self.wfile.flush()

    # ---------- 代理 ----------
    def _proxy(self, method):
        u = urllib.parse.urlsplit(self.path)
        slot = self.path.split('/')[1]
        rest = '/' + '/'.join(self.path.split('/')[2:])
        if u.query:
            rest += '?' + u.query
        if slot == 'oa':
            base = (self.headers.get('X-Base') or '').rstrip('/')
            if not base:
                return self._send_buffered(400, 'application/json', b'{"error":{"message":"missing X-Base header"}}', method)
            url = base + rest
        elif slot == 'wb':
            url = WB_BASE + rest
        else:
            url = 'http://127.0.0.1:%d' % PORTS[slot] + rest
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        rq = {}
        if body:
            try:
                rq = json.loads(body.decode('utf-8'))
            except Exception:
                rq = {}
        t0 = time.time()
        req = urllib.request.Request(url, data=body, method=method)
        if self.headers.get('Content-Type'):
            req.add_header('Content-Type', self.headers['Content-Type'])
        if slot == 'oa':
            key = self.headers.get('X-Key') or ''
            if not key and ('127.0.0.1:8791' in url or 'localhost:8791' in url):
                key = WB_KEY or ''            # WorkBuddy 网关：服务端注入，页面无需暴露密钥
            if key:
                req.add_header('Authorization', 'Bearer ' + key)
        elif slot == 'wb' and WB_KEY:
            req.add_header('Authorization', 'Bearer ' + WB_KEY)   # 密钥仅服务端注入

        if 'chat/completions' in rest and rq.get('stream'):
            return self._proxy_stream(req, slot, rq, t0)

        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data, code = r.read(), r.status
                ctype = r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            data, code, ctype = e.read(), e.code, e.headers.get('Content-Type', 'application/json')
        except Exception as e:
            data = ('{"error":{"message":"proxy 转发失败: %s"}}' % str(e).replace('"', "'")).encode()
            code, ctype = 502, 'application/json'
        if 'chat/completions' in rest:
            # 解析失败也要落盘（把原始错误体记下来）；log_call 放在 try 外，避免它被静默吞掉
            try:
                rs = json.loads(data.decode('utf-8', 'replace'))
                ch = (rs.get('choices') or [{}])[0]
                msg = ch.get('message') or {}
                content = msg.get('content')
                reason_chars = len(msg.get('reasoning_content') or '')
                finish = ch.get('finish_reason')
                comp = (rs.get('usage') or {}).get('completion_tokens')
                err = rs.get('error')
            except Exception:
                content, reason_chars, finish, comp = None, 0, None, None
                err = {'message': data.decode('utf-8', 'replace')[:200]}
            log_call(slot, t0, code, rq, content, reason_chars, finish, comp, err,
                     meta=arena_meta(self.headers))
        self._send_buffered(code, ctype, data, method)

    # ---------- 流式透传 ----------
    def _proxy_stream(self, req, slot, rq, t0):
        meta = arena_meta(self.headers)
        try:
            up = urllib.request.urlopen(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
            ctype = e.headers.get('Content-Type', 'application/json')
            log_call(slot, t0, code, rq, None, 0, None, None, data.decode('utf-8', 'replace')[:200], meta=meta)
            return self._send_buffered(code, ctype, data, 'POST')
        except Exception as e:
            data = ('{"error":{"message":"proxy 转发失败: %s"}}' % str(e).replace('"', "'")).encode()
            log_call(slot, t0, 502, rq, None, 0, None, None, str(e)[:200], meta=meta)
            return self._send_buffered(502, 'application/json', data, 'POST')

        ctype = up.headers.get('Content-Type', '')
        if 'event-stream' not in ctype:          # 后端没走 SSE（比如直接报错）→ 当普通响应
            data = up.read()
            try:
                rs = json.loads(data.decode('utf-8', 'replace'))
                msg = (rs.get('choices') or [{}])[0].get('message') or {}
                log_call(slot, t0, 200, rq, msg.get('content'),
                         len(msg.get('reasoning_content') or ''), None,
                         (rs.get('usage') or {}).get('completion_tokens'), rs.get('error'), meta=meta)
            except Exception:
                pass
            return self._send_buffered(200, ctype or 'application/json', data, 'POST')

        self._headers(200, 'text/event-stream; charset=utf-8',
                      {'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
                       'Transfer-Encoding': 'chunked'})
        self.end_headers()

        acc = {'content': [], 'reason': 0, 'finish': None, 'comp': None, 'done': False}

        def scan(line):
            s = line.decode('utf-8', 'replace').strip()
            if not s.startswith('data:'):
                return
            pl = s[5:].strip()
            if pl == '[DONE]':
                acc['done'] = True
                return
            if not pl:
                return
            try:
                j = json.loads(pl)
            except Exception:
                return
            if j.get('usage'):
                acc['comp'] = j['usage'].get('completion_tokens')
            ch = (j.get('choices') or [{}])[0]
            if ch.get('finish_reason'):
                acc['finish'] = ch['finish_reason']
            d = ch.get('delta') or {}
            if d.get('reasoning_content'):
                acc['reason'] += len(d['reasoning_content'])
            if d.get('content'):
                acc['content'].append(d['content'])

        buf = b''
        sent_done = False
        grace = 0
        try:
            while True:
                chunk = up.read1(8192)
                if not chunk:
                    break
                buf += chunk
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    if line.strip() == b'data: [DONE]':
                        sent_done = True
                    scan(line)
                self._chunk(chunk)
                # llama-server 把 usage 放在 finish 之后单独一帧，见 finish 就断会把 token 数吞掉；
                # 等到 [DONE]、或 finish 且已拿到 usage，再给几块宽限后收尾。
                if acc['done']:
                    break
                if acc['finish'] and acc['comp'] is not None:
                    break
                if acc['finish']:
                    grace += 1
                    if grace > 4:
                        break
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._chunk(('data: {"error":{"message":"%s"}}\n\n' % str(e).replace('"', "'")[:180]).encode())
            except Exception:
                pass
        finally:
            try:
                up.close()
            except Exception:
                pass
            if not sent_done:
                try:
                    self._chunk(b'data: [DONE]\n\n')
                except Exception:
                    pass
            try:
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
            except Exception:
                pass
        log_call(slot, t0, 200, rq, ''.join(acc['content']).strip(), acc['reason'],
                 acc['finish'], acc['comp'], meta=meta)

    def do_GET(self):
        if self._is_local_api(): return self._serve_presets('GET')
        if self._is_matches_api(): return self._serve_matches('GET')
        if self._is_api(): return self._proxy('GET')
        if self._static_blocked(): return self.send_error(404)
        super().do_GET()

    def do_HEAD(self):
        if self._is_api(): return self._proxy('HEAD')
        if self._static_blocked(): return self.send_error(404)
        super().do_HEAD()

    def do_POST(self):
        if self._is_matches_api(): return self._serve_matches('POST')
        self._proxy('POST') if self._is_api() else self.send_error(405)

    def do_PUT(self):
        if self._is_local_api(): return self._serve_presets('PUT')
        self.send_error(405)

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print('大话骰竞技场: http://127.0.0.1:%d/web/arena.html' % port, flush=True)
    Server(('127.0.0.1', port), Handler).serve_forever()
