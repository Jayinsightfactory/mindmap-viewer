export type OpsMetric = {
  label: string;
  value: string;
  detail: string;
};

export type OpsModule = {
  id: string;
  title: string;
  status: "운영" | "구축" | "설계";
  owner: string;
  summary: string;
  inputs: string[];
  outputs: string[];
};

export type OpsAction = {
  title: string;
  due: string;
  owner: string;
  source: string;
};

export const OPS_METRICS: OpsMetric[] = [
  { label: "녹음 기록", value: "700+", detail: "미팅/통화 요약이 자동 적재되는 지식 기반" },
  { label: "진행 프로젝트", value: "35", detail: "견적, 계약, 납품, 후속 할 일을 한 흐름으로 관리" },
  { label: "누적 프로젝트", value: "120+", detail: "프로젝트 히스토리와 산출물을 재사용" },
  { label: "AI 질의 채널", value: "2", detail: "Claude API와 GPT API를 업무 질문 라우터로 사용" },
  { label: "워크 게이트", value: "1", detail: "카카오워크 대화와 nenovaweb 업무 기록을 연결" },
];

export const OPS_MODULES: OpsModule[] = [
  {
    id: "recordings",
    title: "녹음 지식화",
    status: "구축",
    owner: "영업지원",
    summary: "Plaud 등 녹음 원문과 요약을 자동으로 가져와 프로젝트, 고객, 견적 근거로 연결합니다.",
    inputs: ["녹음 파일", "회의 요약", "참석자", "후속 요청"],
    outputs: ["미팅 로그", "견적 초안", "할 일 후보", "팔로업 일정"],
  },
  {
    id: "quote-contract",
    title: "견적-계약-프로젝트",
    status: "구축",
    owner: "영업팀",
    summary: "고객 미팅 내용에서 견적서를 만들고, 계약 확정 시 프로젝트와 납품 태스크를 생성합니다.",
    inputs: ["고객 정보", "품목/서비스", "단가", "미팅 메모"],
    outputs: ["견적서", "계약 상태", "프로젝트 카드", "담당자 할당"],
  },
  {
    id: "task-calendar",
    title: "할 일/일정 자동화",
    status: "운영",
    owner: "전 직원",
    summary: "업무 요청을 담당자 할 일로 바꾸고, 일정/마감/리마인드를 자동으로 묶습니다.",
    inputs: ["업무 요청", "마감일", "담당자", "Slack/Kakao 대화"],
    outputs: ["칸반 카드", "일정", "마감 알림", "일일 진행 보고"],
  },
  {
    id: "kakaowork-gateway",
    title: "카카오워크 업무 게이트",
    status: "설계",
    owner: "전 직원",
    summary: "카카오워크 메시지, 답장, 승인 액션을 업무 이벤트로 받아 주문, 견적, 프로젝트, 할 일로 연결합니다.",
    inputs: ["카카오워크 메시지", "사용자 ID", "대화방 ID", "버튼/답장 액션"],
    outputs: ["업무 이벤트", "담당자 알림", "AI 분류", "상태 업데이트"],
  },
  {
    id: "contacts",
    title: "명함-연락처 OCR",
    status: "설계",
    owner: "영업지원",
    summary: "명함 촬영 후 고객 DB와 Google Contacts에 자동 등록하고 프로젝트와 연결합니다.",
    inputs: ["명함 이미지", "OCR 결과", "회사명", "휴대폰/이메일"],
    outputs: ["고객 카드", "연락처", "담당자 매칭", "후속 연락"],
  },
  {
    id: "finance",
    title: "매출/세금계산서",
    status: "설계",
    owner: "관리팀",
    summary: "프로젝트 매출, 입금, 세금계산서 발행 요청, 비용 증빙을 한 화면에서 관리합니다.",
    inputs: ["매출 등록", "입금 알림", "사업자 정보", "영수증"],
    outputs: ["매출 집계", "홈택스 발행 요청", "세무 전달 자료", "미수금 알림"],
  },
  {
    id: "ai-secretary",
    title: "AI 업무 비서",
    status: "구축",
    owner: "관리자",
    summary: "직원이 Claude 또는 GPT에 질문하면 업무 데이터 맥락을 붙여 답변, 요약, 실행 초안을 만듭니다.",
    inputs: ["업무 질문", "권한", "프로젝트/고객/주문 데이터", "대화 기록"],
    outputs: ["분석 답변", "할 일 제안", "견적 초안", "리스크 체크"],
  },
];

export const OPS_ACTIONS: OpsAction[] = [
  {
    title: "녹음 로그에서 견적 후보 자동 추출",
    due: "오늘",
    owner: "영업지원",
    source: "녹음 지식화",
  },
  {
    title: "견적 발송 후 3일 무응답 팔로업 생성",
    due: "상시",
    owner: "영업팀",
    source: "견적-계약-프로젝트",
  },
  {
    title: "매일 18시 프로젝트 진행 요약 발행",
    due: "18:00",
    owner: "윤비서",
    source: "할 일/일정 자동화",
  },
  {
    title: "직원 질문을 Claude/GPT 중 적합한 모델로 라우팅",
    due: "상시",
    owner: "관리자",
    source: "AI 업무 비서",
  },
  {
    title: "카카오워크 요청을 주문/견적/할 일 후보로 분류",
    due: "상시",
    owner: "업무 게이트",
    source: "카카오워크 업무 게이트",
  },
];

export const KNOWLEDGE_SUMMARY = `
Nenova 업무 OS 목표:
- 첫 화면은 메뉴 목록이 아니라 운영 현황, 자동화 흐름, 직원 질문 창을 바로 보여준다.
- 700개 이상의 녹음/회의 기록을 고객, 견적, 계약, 프로젝트, 할 일로 연결한다.
- 견적서 발행 후 계약이 되면 프로젝트를 만들고 담당자 할 일을 자동 배정한다.
- 명함 촬영, Google Contacts, Google Drive, Calendar, Gmail, Slack/Kakao 알림을 업무 데이터와 연결한다.
- 매출, 입금, 세금계산서, 영수증을 관리하고 세무 전달 자료를 줄인다.
- Claude API와 OpenAI GPT API는 직원 질문에 답하고, 업무 데이터 기반 조언과 실행 초안을 만든다.
- 카카오워크는 회사 업무의 대화형 진입점으로 두고, nenovaweb은 원문/분류/실행 결과를 기록한다.
`;

export const PROMPT_TEMPLATES = [
  "이번 주 녹음 기록 중 견적서로 이어질 가능성이 높은 미팅을 골라줘.",
  "오늘 처리 대기 주문과 재고 부족 품목을 보고 먼저 할 일을 정리해줘.",
  "견적서를 보낸 뒤 답이 없는 고객에게 보낼 팔로업 문구를 작성해줘.",
  "이번 달 매출과 미수금 리스크를 직원이 이해하기 쉽게 요약해줘.",
];
