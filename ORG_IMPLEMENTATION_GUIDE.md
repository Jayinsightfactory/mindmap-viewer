# 4단계 조직 계층 구조 구현 가이드

## 🎯 개요

2026년 3월 12일 구현된 4단계 조직 계층 구조:
- **회사** (Company) - Level 3
- **부서** (Department) - Level 2
- **팀** (Team) - Level 1
- **개인** (Member) - Level 0

---

## 📋 완료된 작업

### 1. 데이터베이스 스키마 업데이트 ✅
**파일**: `/src/db.js`

새 테이블 추가:
```sql
-- 회사 (Level 3)
org_companies (id, workspace_id, name, status)

-- 부서 (Level 2)
org_departments (id, company_id, name, head_id, status)

-- 팀 (Level 1)
org_teams (id, department_id, name, leader_id, status)

-- 개인/멤버 (Level 0)
org_members (id, team_id, user_id, role, position, status, joined_at)
```

### 2. 권한 제어 시스템 재정의 ✅
**파일**: `/routes/multilevel-auth.js`

#### 역할 정의
| 역할 | 접근 | 수정 | 멤버관리 | 설명 |
|------|------|------|---------|------|
| **owner** | 0,1,2,3 | 0,1,2,3 | ✅ | 회사 전체 관리 |
| **admin** | 0,1,2 | 1,2 | ✅ | 부서/팀 관리 |
| **lead** | 0,1 | 0,1 | ✅ | 팀 리더 (팀 관리) |
| **member** | 0 | 0 | ❌ | 팀 멤버 (개인만) |

#### 개발환경 권한 자동승인
```bash
# 활성화: 개발환경에서 권한 검증 비활성화
export AUTO_PERMISSION=true
# 또는
export NODE_ENV=development
```

- 모든 권한 검증 자동 통과
- 토큰 없이 API 호출 가능
- **프로덕션에서는 자동으로 비활성화**

### 3. 조직 계층 API 구현 ✅
**파일**: `/routes/org-api.js`

#### 엔드포인트 목록
```
GET    /api/org/:workspaceId/hierarchy           - 전체 조직 구조 조회
POST   /api/org/:workspaceId/companies            - 회사 생성 (Owner/Admin)
GET    /api/org/:workspaceId/companies            - 회사 목록

POST   /api/org/:companyId/departments            - 부서 생성
GET    /api/org/:companyId/departments            - 부서 목록
PUT    /api/org/departments/:id                   - 부서 수정

POST   /api/org/:deptId/teams                     - 팀 생성
GET    /api/org/:deptId/teams                     - 팀 목록
PUT    /api/org/teams/:id                         - 팀 수정

POST   /api/org/:teamId/members                   - 멤버 추가 (Lead 이상)
GET    /api/org/:teamId/members                   - 멤버 목록
PUT    /api/org/members/:id                       - 멤버 수정
DELETE /api/org/members/:id                       - 멤버 제거

POST   /api/org/:workspaceId/migrate              - 마이그레이션 (개발환경만)
```

### 4. 마이그레이션 유틸리티 구현 ✅
**파일**: `/src/org-migration.js`

기존 `workspace_members` → 새로운 `org_members` 마이그레이션:
```javascript
const { migrateWorkspaceMembers } = require('./src/org-migration');

// 자동으로 다음을 처리:
// 1. org_companies 생성 (없으면)
// 2. org_departments 생성
// 3. org_teams 생성 (team_name 기반)
// 4. org_members로 데이터 이전
```

### 5. 서버 통합 ✅
**파일**: `/server.js`
- org-api 라우터 require 추가
- `/api` 경로에 마운트

---

## 🚀 사용 방법

### 개발환경 시작
```bash
# 환경 변수 설정
export NODE_ENV=development
export AUTO_PERMISSION=true

# 서버 시작
npm start
```

### 기본 워크플로우

#### 1️⃣ 회사 생성
```bash
curl -X POST http://localhost:4747/api/org/ws-123/companies \
  -H "Content-Type: application/json" \
  -d '{"name": "테스트 회사"}'

# 응답:
# {"ok": true, "companyId": "01ARZ3NDEKTSV4RRFFQ"}
```

#### 2️⃣ 부서 생성
```bash
curl -X POST http://localhost:4747/api/org/cmp-123/departments \
  -H "Content-Type: application/json" \
  -d '{"name": "개발부", "headId": "user-123"}'

# 응답:
# {"ok": true, "departmentId": "01ARZ3NDEKTSV4RRFFQ"}
```

#### 3️⃣ 팀 생성
```bash
curl -X POST http://localhost:4747/api/org/dept-123/teams \
  -H "Content-Type: application/json" \
  -d '{"name": "백엔드팀", "leaderId": "user-456"}'

# 응답:
# {"ok": true, "teamId": "01ARZ3NDEKTSV4RRFFQ"}
```

#### 4️⃣ 멤버 추가
```bash
curl -X POST http://localhost:4747/api/org/team-123/members \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-789", "role": "member", "position": "Senior Developer"}'

# 응답:
# {"ok": true, "memberId": "01ARZ3NDEKTSV4RRFFQ"}
```

#### 5️⃣ 조직 계층 전체 조회
```bash
curl http://localhost:4747/api/org/ws-123/hierarchy

# 응답:
{
  "ok": true,
  "hierarchy": [
    {
      "id": "cmp-123",
      "name": "테스트 회사",
      "departments": [
        {
          "id": "dept-123",
          "name": "개발부",
          "teams": [
            {
              "id": "team-123",
              "name": "백엔드팀",
              "members": [
                {
                  "id": "mem-456",
                  "userId": "user-789",
                  "role": "member",
                  "position": "Senior Developer"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### 마이그레이션 (개발환경만)
```bash
curl -X POST http://localhost:4747/api/org/ws-123/migrate

# 응답:
{
  "ok": true,
  "companyId": "cmp-123",
  "departmentId": "dept-123", 
  "teamId": "team-123",
  "migratedCount": 10  # 마이그레이션된 멤버 수
}
```

---

## 📝 API 권한 예시

### Owner (회사 전체 접근)
```javascript
// req.wsContext.role === 'owner'
// 가능한 작업:
// - 모든 Level 조회 (0, 1, 2, 3)
// - 모든 Level 수정
// - 회사 삭제
// - 모든 유저 데이터 조회
```

### Admin (부서/팀 관리)
```javascript
// req.wsContext.role === 'admin'
// 가능한 작업:
// - Level 0, 1, 2 조회
// - Level 1, 2 수정
// - 부서/팀 생성 및 수정
// - 부서/팀 내 사용자 관리
```

### Lead (팀 리더)
```javascript
// req.wsContext.role === 'lead'
// 가능한 작업:
// - 팀 레벨 (1) 데이터 조회/수정
// - 개인 레벨 (0) 데이터 조회
// - 팀원 초대/관리
```

### Member (팀 멤버)
```javascript
// req.wsContext.role === 'member'
// 가능한 작업:
// - 자신의 데이터만 (Level 0)
// - 수정 불가능
```

---

## 🔒 보안 모범 사례

### 1. 프로덕션에서 권한 검증 필수
```javascript
// AUTO_PERMISSION은 개발환경에서만 활성화
if (process.env.NODE_ENV === 'production') {
  // 항상 권한 검증 수행
}
```

### 2. API 호출 시 토큰 포함
```bash
curl -H "Authorization: Bearer token-123" \
  http://localhost:4747/api/org/:workspaceId/hierarchy
```

### 3. 레벨별 권한 검증
```javascript
// 특정 레벨에 대한 접근만 허용
router.post('/api/org/:deptId/teams',
  authWorkspaceLevel,
  requireLevelModify(1),  // Level 1(팀)만 수정 가능
  handler
);
```

---

## 📋 체크리스트

- [x] DB 스키마 업데이트
- [x] org_companies, org_departments, org_teams, org_members 테이블 생성
- [x] 권한 제어 시스템 재정의 (4가지 역할)
- [x] 개발환경 권한 자동승인 구현
- [x] org-api.js 라우터 구현
- [x] org-migration.js 마이그레이션 유틸 구현
- [x] server.js 통합
- [x] API 엔드포인트 문서화
- [x] ORG_HIERARCHY.md 생성

---

## 🔧 다음 단계

### 현재 상태
- ✅ 4단계 계층 구조 설계 완료
- ✅ 권한 제어 시스템 구현 완료
- ✅ API 엔드포인트 구현 완료

### 추가 개발 항목 (선택사항)
- [ ] 프론트엔드 UI 구현 (조직도 뷰)
- [ ] 대량 초대 (CSV 업로드)
- [ ] 권한 감시 / 감사 로그
- [ ] 조직 변경 알림 (WebSocket)
- [ ] 부서/팀 간 협업 메커니즘
- [ ] 역할 기반 대시보드

---

## 📞 문제 해결

### "workspace_id_required" 에러
```
POST 요청에 workspaceId 파라미터 또는 본문에 포함해야 함
```

### "not_workspace_member" 에러
```
사용자가 해당 workspace의 멤버가 아님
→ workspace_members 테이블에서 확인
```

### "level_access_denied" 에러
```
현재 역할이 해당 레벨에 접근할 수 없음
→ 역할과 권한을 다시 확인
```

---

**최종 업데이트**: 2026년 3월 12일  
**작성자**: GitHub Copilot  
**상태**: 🟢 완료
