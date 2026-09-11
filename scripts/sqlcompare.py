"""원본 SQL vs 개선 SQL — 속도와 결과 동일성 비교(읽기 전용).
사용: python scripts/sqlcompare.py old.sql new.sql [--params 7] [--runs 2]
  - 결과는 행 전체를 집합으로 비교(순서 무시). 동일할 때만 채택 가능.
  - 결론 몇 줄만 출력 — 사용량 절약용.
"""
import json, os, re, sys, time
import psycopg2

sys.stdout.reconfigure(encoding='utf-8')
a = sys.argv[1:]
params = a[a.index('--params') + 1].split(',') if '--params' in a else []
runs = int(a[a.index('--runs') + 1]) if '--runs' in a else 2

url = json.load(open(os.path.join(os.environ['TEMP'], 'pgvars.json'), encoding='utf-8'))
conn = psycopg2.connect(url.get('DATABASE_PUBLIC_URL') or url['DATABASE_URL'], sslmode='require')
conn.set_session(readonly=True, autocommit=True)
cur = conn.cursor()

def run(f):
    q = open(f, encoding='utf-8').read()
    n = max([int(x) for x in re.findall(r'\$(\d+)', q)] or [0])
    sql = re.sub(r'\$(\d+)', r'%(p\1)s', q.replace('%', '%%'))
    args = {f'p{k + 1}': params[k] for k in range(n)}
    best, rows = 1e9, []
    for _ in range(runs):
        t = time.time(); cur.execute(sql, args); rows = cur.fetchall()
        best = min(best, time.time() - t)
    return best, sorted(tuple(str(x) for x in r) for r in rows)

t1, r1 = run(a[0]); t2, r2 = run(a[1])
print(f'원본   {t1:6.2f}초  {len(r1)}행')
print(f'개선안 {t2:6.2f}초  {len(r2)}행')
if r1 == r2:
    print(f'결과 동일 ✔  ({t1 / max(t2, 1e-3):.1f}배 빠름)')
else:
    s1, s2 = set(r1), set(r2)
    print(f'★불일치 — 원본에만 {len(s1 - s2)}행, 개선안에만 {len(s2 - s1)}행')
    for r in list(s1 - s2)[:2]: print('  원본만:', r[:4])
    for r in list(s2 - s1)[:2]: print('  개선만:', r[:4])
