"""느린 API 원인 찾기 — JS 파일 안의 SQL을 뽑아 각각 시간 측정(읽기 전용).
사용: python scripts/sqlprobe.py routes/x.js 100 300 [--params 30,48] [--runs 2]
  - 줄 범위 안의 query(`...`) 템플릿만 대상. ${...} 보간이 있으면 건너뜀.
  - $1,$2.. 는 --params 값으로 채움(부족하면 건너뜀). SELECT/WITH 외는 거부.
  - 결론(느린 순 상위 5개)만 출력 — 사용량 절약용.
DB 접속: %TEMP%/pgvars.json 의 DATABASE_PUBLIC_URL
"""
import json, os, re, sys, time
import psycopg2

a = sys.argv[1:]
path, lo, hi = a[0], int(a[1]), int(a[2])
params = []
runs = 2
if '--params' in a: params = a[a.index('--params') + 1].split(',')
if '--runs' in a: runs = int(a[a.index('--runs') + 1])

src = open(path, encoding='utf-8').read().split('\n')[lo - 1:hi]
body = '\n'.join(src)
sqls = re.findall(r'query\(\s*`([\s\S]*?)`', body)

url = json.load(open(os.path.join(os.environ['TEMP'], 'pgvars.json'), encoding='utf-8'))
conn = psycopg2.connect(url.get('DATABASE_PUBLIC_URL') or url['DATABASE_URL'], sslmode='require')
conn.set_session(readonly=True, autocommit=True)
cur = conn.cursor()

res, skipped = [], 0
sys.stdout.reconfigure(encoding='utf-8')
for i, q in enumerate(sqls, 1):
    # ${cond ? '...' : ''} 같은 선택 조건은 '없음' 쪽으로 간주
    q = re.sub(r"\$\{[^}]*\?\s*'[^']*'\s*:\s*''\s*\}", '', q)
    if '${' in q or not re.match(r'\s*(SELECT|WITH)\b', q, re.I):
        skipped += 1; continue
    n = max([int(x) for x in re.findall(r'\$(\d+)', q)] or [0])
    if n > len(params):
        skipped += 1; continue
    sql = re.sub(r'\$(\d+)', r'%(p\1)s', q.replace('%', '%%'))
    args = {f'p{k + 1}': params[k] for k in range(n)}
    ms, rows, err = [], 0, ''
    for _ in range(runs):
        t = time.time()
        try:
            cur.execute(sql, args); rows = cur.rowcount
        except Exception as e:
            err = str(e).split('\n')[0][:60]; break
        ms.append(time.time() - t)
    head = ' '.join(q.split())[:70]
    res.append((min(ms) if ms else 0, i, rows, err or head))

res.sort(reverse=True)
tot = sum(r[0] for r in res)
print(f'쿼리 {len(sqls)}개 (측정 {len(res)}, 건너뜀 {skipped}) · 합계 {tot:.1f}초')
for s, i, rows, h in res[:5]:
    print(f'  #{i:<3}{s:6.2f}초 {rows:>6}행  {h}')
