# 4단계 조직 계층 구조 (Org Hierarchy)

## 개요
현재 시스템은 회사 → 부서 → 팀 → 개인 의 4단계 계층으로 구성되어 있습니다.

---

## 계층 정의

### Level 3: 회사 (Company)
- **테이블**: `org_companies`
- **설명**: 최상위 조직 단위
- **주요 필드**:
  - `id`: 고유 ID
  - `workspace_id`: 워크스페이스 참조
  - `name`: 회사명
  - `status`: active/inactive

### Level 2: 부서 (Department)
- **테이블**: `org_departments`
- **설명**: 회사 하위 조직 단위
- **관계**: Company 1:N Department
- **주요 필드**:
  - `id`: 고유 ID
  - `company_id`: 회사 참조
  - `name`: 부서명
  - `head_id`: 부서장

### Level 1: 팀 (Team)
- **테이블**: `org_teams`
- **설명**: 부서 하위 실무 단위
- **관계**: Department 1:N Team
- **주요 필드**:
  - `id`: 고유 ID
  - `department_id`: 부서 참조
  - `name`: 팀명
  - `leader_id`: 팀리더

### Level 0: 개인/멤버 (Member/Individual)
- **테이블**: `org_members`
- **설명**: 팀의 최하위 사용자 단위
- **관계**: Team 1:N Member
- **주요 필드**:
  - `id`: 고유 ID
  - `team_id`: 팀 참조
  - `user_id`: 사용자 계정 참조
  - `role`: owner/admin/lead/member
  - `position`: 직책

---

## 권한 (Role) 정의

### Owner (회사 소유자)
- **접근 레벨**: 0, 1, 2, 3 (모두)
- **수정 레벨**: 0, 1, 2, 3 (모두)
- **기능**:
  - 전사 데이터 조회/수정
  - 사용자 관리
  - 부서/팀 구조 변경

### Admin (부서/팀 관리자)
- **접근 레벨**: 0, 1, 2 (개인~부서)
- **수정 레벨**: 1, 2 (팀~부서)
- **기능**:
  - 부서 이하 데이터 조회/수정
  - 팀 내 사용자 관리
  - 팀 구조 변경

### Lead (팀 리더)
- **접근 레벨**: 0, 1 (개인~팀)
- **수정 레벨**: 0, 1 (개인~팀)
- **기능**:
  - 팀 내 데이터 조회/수정
  - 팀원 정보 관리
  - 팀 내 멤버 초대

### Member (팀 멤버)
- **접근 레벨**: 0 (개인만)
- **수정 레벨**: 0 (개인만)
- **기능**:
  - 자신의 데이터만 조회/수정
  - 타인 데이터 조회 불가

---

## 개발환경 권한 자동승인

### 활성화 조건
```bash
export AUTO_PERMISSION=true
# 또는
export NODE_ENV=development
```

### 동작
- 모든 권한 검증 자동 통과
- 개발/테스트할 때 토큰 없이 API 호출 가능
- 프로덕션에서는 자동으로 비활성화

---

## 마이그레이션 경로

### 기존 시스템과의 호환성
```
workspace_members (기존)
         ↓
org_members (새로운)
    ↑ ↑ ↑ ↑
  Team Department Company Workspace
```

### 마이그레이션 순서
1. `workspaces` 테이블 유지 (기존 호환성)
2. `org_companies` 생성 (workspace 단위)
3. `org_departments` 생성
4. `org_teams` 생성
5. `org_members` 생성 및 `workspace_members` 데이터 마이그레이션

---

## 권한 미들웨어 사용법

### 기본 인증
```javascript
const { authWorkspaceLevel } = require('./routes/multilevel-auth');

router.get('/api/data/:workspaceId', 
  authWorkspaceLevel,
  (req, res) => {
    // req.wsContext 사용
    console.log(req.wsContext.role);
    console.log(req.wsContext.permissions);
  }
);
```

### 레벨별 접근 제어
```javascript
const { requireLevelAccess } = require('./routes/multilevel-auth');

// 팀(Level 1) 이상의 데이터만 접근
router.get('/api/team-data', 
  authWorkspaceLevel,
  requireLevelAccess(1),
  (req, res) => { ... }
);
```

### 역할별 권한
```javascript
const { requireOwnerOrAdmin, requireMemberManagement } = require('./routes/multilevel-auth');

// Owner/Admin만 실행
router.delete('/api/company/:id',
  authWorkspaceLevel,
  requireOwnerOrAdmin,
  (req, res) => { ... }
);
```

---

## API 엔드포인트 패턴

### 회사(Company) 관련
```
POST   /api/org/companies              - 회사 생성
GET    /api/org/companies              - 회사 목록
GET    /api/org/companies/:id          - 회사 상세
PUT    /api/org/companies/:id          - 회사 수정
DELETE /api/org/companies/:id          - 회사 삭제
```

### 부서(Department) 관련
```
POST   /api/org/companies/:cId/departments       - 부서 생성
GET    /api/org/companies/:cId/departments       - 부서 목록
PUT    /api/org/departments/:id                  - 부서 수정
DELETE /api/org/departments/:id                  - 부서 삭제
```

### 팀(Team) 관련
```
POST   /api/org/departments/:dId/teams           - 팀 생성
GET    /api/org/departments/:dId/teams           - 팀 목록
PUT    /api/org/teams/:id                        - 팀 수정
DELETE /api/org/teams/:id                        - 팀 삭제
```

### 멤버(Member) 관련
```
POST   /api/org/teams/:tId/members               - 멤버 초대
GET    /api/org/teams/:tId/members               - 멤버 목록
PUT    /api/org/members/:id                      - 멤버 정보 수정
DELETE /api/org/members/:id                      - 멤버 제거
```

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTO_PERMISSION` | false | 권한 자동승인 활성화 |
| `NODE_ENV` | production | development면 자동승인 활성화 |
| `DATABASE_URL` | (없음) | PostgreSQL 사용 시 설정 |
| `AUTH_DISABLED` | (없음) | 인증 미들웨어 비활성화 |

