export type KakaoWorkStatus = "운영" | "구축" | "설계";

export type KakaoWorkFlow = {
  step: string;
  title: string;
  owner: string;
  status: KakaoWorkStatus;
  summary: string;
  input: string;
  output: string;
};

export type KakaoWorkContract = {
  name: string;
  method: "GET" | "POST";
  path: string;
  purpose: string;
  request: string[];
  result: string[];
};

export type KakaoWorkDataMap = {
  source: string;
  nenovaEntity: string;
  fields: string[];
  rule: string;
};

export type KakaoWorkEnvVar = {
  key: string;
  required: boolean;
  purpose: string;
};

export const KAKAOWORK_METRICS = [
  { label: "업무 진입점", value: "1", detail: "카카오워크 대화와 nenovaweb 업무 데이터를 단일 게이트로 연결" },
  { label: "초기 API", value: "4", detail: "messages.send, messages.send_by_email, conversations.open, callback receiver" },
  { label: "업무 흐름", value: "6", detail: "요청 수집, 분류, 생성, 배정, 알림, 감사 로그" },
  { label: "보안 단계", value: "3", detail: "Bot App Key 서버 보관, 콜백 시크릿, 사용자 권한 매핑" },
];

export const KAKAOWORK_FLOWS: KakaoWorkFlow[] = [
  {
    step: "01",
    title: "대화 수집",
    owner: "업무 게이트",
    status: "설계",
    summary: "카카오워크 Bot 대화, 버튼, 명령어, 관리자 채널 알림을 nenovaweb 수신 이벤트로 표준화합니다.",
    input: "카카오워크 메시지, 사용자 ID, 대화방 ID, 첨부/버튼 액션",
    output: "work_event 원본 로그와 normalized event",
  },
  {
    step: "02",
    title: "의도 분류",
    owner: "AI 비서",
    status: "구축",
    summary: "요청을 주문, 견적, 프로젝트, 할 일, 재고, 회계, 일반 질문으로 분류하고 필요한 추가 질문을 만듭니다.",
    input: "원문 메시지, 사용자 권한, 최근 프로젝트/고객 컨텍스트",
    output: "intent, confidence, missing_fields, suggested_action",
  },
  {
    step: "03",
    title: "업무 생성",
    owner: "각 업무 모듈",
    status: "설계",
    summary: "분류 결과에 따라 주문, 견적 초안, 프로젝트 카드, 할 일, 일정, 미수금 팔로업을 생성합니다.",
    input: "intent payload, 고객/품목/담당자/마감일",
    output: "order_id, quote_id, project_id, task_id, schedule_id",
  },
  {
    step: "04",
    title: "담당자 알림",
    owner: "카카오워크 Bot",
    status: "구축",
    summary: "담당자에게 1:1 메시지 또는 프로젝트 채널 메시지를 보내고 확인 버튼 액션을 남깁니다.",
    input: "conversation_id, email, user_id, text, blocks",
    output: "message_id, send_time, delivery status",
  },
  {
    step: "05",
    title: "상태 회수",
    owner: "업무 게이트",
    status: "설계",
    summary: "카카오워크 답장이나 버튼 액션을 받아 업무 상태, 코멘트, 파일 첨부를 nenovaweb에 반영합니다.",
    input: "done, hold, approve, reject, comment, attachment",
    output: "status update, timeline comment, audit log",
  },
  {
    step: "06",
    title: "일일 보고",
    owner: "AI 비서",
    status: "설계",
    summary: "하루 동안 생성/처리/지연된 업무를 팀별로 요약해 관리자 채널과 첫 화면에 표시합니다.",
    input: "work_event, task, project, order, revenue, inventory",
    output: "daily_digest, risk_list, next_actions",
  },
];

export const KAKAOWORK_CONTRACTS: KakaoWorkContract[] = [
  {
    name: "연동 상태",
    method: "GET",
    path: "/api/kakaowork/notify",
    purpose: "서버에 카카오워크 Bot App Key와 관리자 대화방 값이 설정됐는지 확인합니다.",
    request: ["요청 바디 없음"],
    result: ["configured", "supportedTargets", "requiredEnv"],
  },
  {
    name: "업무 알림 발송",
    method: "POST",
    path: "/api/kakaowork/notify",
    purpose: "conversationId, email, userId 중 하나로 카카오워크 메시지를 보냅니다.",
    request: ["text", "conversationId | email | userId", "blocks?", "dryRun?"],
    result: ["mode: live | demo", "targetType", "message 또는 preview payload"],
  },
  {
    name: "워크 이벤트 수신",
    method: "POST",
    path: "/api/kakaowork/callback",
    purpose: "카카오워크 또는 중계 서버에서 들어온 메시지/액션 이벤트를 표준 이벤트로 바꿉니다.",
    request: ["event", "user", "conversation", "message", "actions", "syncWorkUnit?"],
    result: ["normalized", "workUnitSync", "nextPipeline", "receivedAt"],
  },
  {
    name: "AI 업무 질의",
    method: "POST",
    path: "/api/assistant",
    purpose: "카카오워크에서 들어온 질문을 기존 Claude/GPT 업무 질의 라우터와 같은 맥락으로 처리합니다.",
    request: ["provider", "question"],
    result: ["answer", "mode", "model"],
  },
];

export const KAKAOWORK_DATA_MAPS: KakaoWorkDataMap[] = [
  {
    source: "KakaoWork user",
    nenovaEntity: "employee",
    fields: ["kakaowork_user_id", "email", "display_identifier", "name", "team", "role"],
    rule: "email을 1차 키로 매칭하고, user_id는 메시지 발송용 외부 키로 보관합니다.",
  },
  {
    source: "KakaoWork conversation",
    nenovaEntity: "work_channel",
    fields: ["conversation_id", "type", "name", "project_id", "team_id", "owner_id"],
    rule: "프로젝트/팀 채널은 conversation_id와 내부 project_id를 1:1 또는 1:N으로 연결합니다.",
  },
  {
    source: "KakaoWork message",
    nenovaEntity: "work_event",
    fields: ["event_id", "raw_payload", "text", "sender_id", "conversation_id", "received_at"],
    rule: "원문은 삭제하지 않고 보관하며, 분류 결과와 실제 생성 업무를 별도 필드로 연결합니다.",
  },
  {
    source: "KakaoWork action",
    nenovaEntity: "task_update",
    fields: ["action_type", "task_id", "actor_id", "comment", "status", "acted_at"],
    rule: "완료/보류/승인/반려 같은 액션은 권한 확인 후 업무 타임라인에 기록합니다.",
  },
];

export const KAKAOWORK_ENV_VARS: KakaoWorkEnvVar[] = [
  {
    key: "KAKAOWORK_BOT_APP_KEY",
    required: true,
    purpose: "카카오워크 Bot 생성 시 발급되는 App Key. 서버에서 Authorization Bearer 값으로만 사용합니다.",
  },
  {
    key: "KAKAOWORK_ADMIN_CONVERSATION_ID",
    required: false,
    purpose: "관리자/운영 채널에 시스템 알림을 보낼 때 사용할 기본 대화방 ID입니다.",
  },
  {
    key: "KAKAOWORK_CALLBACK_SECRET",
    required: true,
    purpose: "수신 콜백이 nenovaweb이 허용한 중계에서 온 것인지 확인하는 내부 시크릿입니다.",
  },
  {
    key: "NENOVA_PUBLIC_BASE_URL",
    required: false,
    purpose: "카카오워크 메시지 버튼이 이동할 nenovaweb 공개 URL입니다.",
  },
];

export const KAKAOWORK_SECURITY_CHECKS = [
  "카카오워크 Bot App Key는 브라우저 번들, localStorage, 화면 소스에 절대 노출하지 않습니다.",
  "수신 이벤트는 원문 payload를 보관하되, 개인정보 필드는 권한이 있는 사용자에게만 표시합니다.",
  "업무 생성/승인/삭제 액션은 카카오워크 사용자 ID와 nenovaweb 직원 권한을 매핑한 뒤 실행합니다.",
  "AI 비서가 답변할 때는 질문자의 역할에 맞는 프로젝트, 고객, 매출 데이터만 컨텍스트로 붙입니다.",
  "카카오워크 메시지 전송 실패는 업무 실패로 처리하지 않고 재시도 큐와 관리자 알림으로 분리합니다.",
];

export const KAKAOWORK_TEST_PAYLOAD = {
  text: "[테스트] 견적서 발송 후 3일 무응답 고객 팔로업 생성",
  email: "worker@example.com",
  dryRun: true,
};

export const KAKAOWORK_SUMMARY = `
Nenova KakaoWork 업무 게이트 목표:
- 회사 직원은 카카오워크에서 질문, 요청, 승인, 완료 보고를 하고 nenovaweb은 이를 업무 데이터로 저장한다.
- nenovaweb은 주문, 견적, 프로젝트, 할 일, 일정, 매출, 재고 이벤트를 카카오워크 담당자/채널로 다시 알린다.
- 카카오워크 Bot은 단순 알림봇이 아니라 AI 비서와 업무 모듈을 호출하는 입구가 된다.
- 모든 대화 원문, 분류 결과, 생성 업무, 상태 변경은 work_event와 audit log에 남긴다.
`;
