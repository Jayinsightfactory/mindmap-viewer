/**
 * src/tracker/categories.js
 * ─────────────────────────────────────────────────────────────────
 * 프로그램 & 파일 카테고리 분류 시스템 (30개 이상)
 *
 * 기능:
 *   - 애플리케이션명 → 카테고리 매핑 (Windows/Mac/Linux)
 *   - 파일 확장자 → 카테고리 매핑
 *   - 브라우저 URL → 카테고리 매핑
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * 프로그램 카테고리 정의 (30개 이상)
 * 각 카테고리는 programs, extensions, patterns로 구성
 */
const PROGRAM_CATEGORIES = {
  // Office & Productivity (8개)
  office: {
    name: 'Office',
    description: '문서 & 스프레드시트',
    programs: ['Word', 'Excel', 'PowerPoint', 'Pages', 'Numbers', 'Keynote'],
    extensions: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'],
    patterns: /\b(word|excel|powerpoint|pages|numbers|keynote|docx?|xlsx?|pptx?)\b/i,
  },

  knowledge_base: {
    name: 'Knowledge Base',
    description: '노션, 옵시디언 등 지식 관리',
    programs: ['Notion', 'Obsidian', 'OneNote', 'Evernote', 'Roam Research'],
    extensions: ['.md', '.markdown'],
    patterns: /\b(notion|obsidian|onenote|evernote|roam)\b/i,
  },

  google_workspace: {
    name: 'Google Workspace',
    description: '구글 Docs, Sheets, Slides',
    programs: ['Google Docs', 'Google Sheets', 'Google Slides'],
    extensions: [],
    patterns: /\b(google\s+(docs?|sheets?|slides?))\b/i,
  },

  // Development (8개)
  development_ide: {
    name: 'Development IDE',
    description: '코드 에디터 (VS Code, Cursor, PyCharm 등)',
    programs: ['VS Code', 'Cursor', 'Windsurf', 'PyCharm', 'IntelliJ', 'WebStorm', 'Xcode', 'Sublime Text'],
    extensions: ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.go', '.rs', '.php', '.rb'],
    patterns: /\b(vscode?|code|cursor|windsurf|pycharm|intellij|webstorm|xcode|sublime)\b/i,
  },

  terminal_shell: {
    name: 'Terminal/Shell',
    description: '터미널, 콘솔, 셸',
    programs: ['Terminal', 'iTerm2', 'PowerShell', 'CMD', 'Bash', 'Git Bash', 'Zsh'],
    extensions: ['.sh', '.bash', '.zsh', '.ps1'],
    patterns: /\b(terminal|iterm|powershell|cmd|bash|shell|zsh|git\s+bash)\b/i,
  },

  version_control: {
    name: 'Version Control',
    description: 'Git, GitHub Desktop 등',
    programs: ['GitHub Desktop', 'GitLab', 'Bitbucket', 'SourceTree', 'GitKraken'],
    extensions: ['.git'],
    patterns: /\b(github|gitlab|bitbucket|sourcetree|gitkraken|git)\b/i,
  },

  sql_database: {
    name: 'SQL Database',
    description: 'MySQL Workbench, Postgres, DBeaver 등',
    programs: ['MySQL Workbench', 'Postgres', 'DataGrip', 'DBeaver', 'SQLiteStudio', 'MongoDB Compass'],
    extensions: ['.sql', '.db', '.sqlite'],
    patterns: /\b(mysql|postgres|sqlite|mongodb|dbeaver|workbench|datagrip|compass)\b/i,
  },

  // Design (6개)
  graphic_design: {
    name: 'Graphic Design',
    description: 'Figma, Sketch, Photoshop, Illustrator 등',
    programs: ['Figma', 'Sketch', 'Photoshop', 'Illustrator', 'Affinity Designer', 'Adobe XD'],
    extensions: ['.psd', '.ai', '.sketch', '.fig', '.xd', '.afdesign'],
    patterns: /\b(figma|sketch|photoshop|illustrator|affinity|adobe\s+xd)\b/i,
  },

  video_editing: {
    name: 'Video Editing',
    description: 'Premiere Pro, Final Cut Pro, DaVinci Resolve 등',
    programs: ['Premiere Pro', 'Final Cut Pro', 'DaVinci Resolve', 'Vegas Pro', 'Camtasia'],
    extensions: ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.webm', '.prproj', '.fcpxml'],
    patterns: /\b(premiere|final\s+cut|davinci|vegas|camtasia|kdenlive)\b/i,
  },

  audio_editing: {
    name: 'Audio Editing',
    description: 'Audition, Logic Pro, GarageBand, Audacity 등',
    programs: ['Audition', 'Logic Pro', 'GarageBand', 'Audacity', 'Reaper', 'Ableton Live'],
    extensions: ['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg'],
    patterns: /\b(audition|logic\s+pro|garageband|audacity|reaper|ableton)\b/i,
  },

  cad_3d: {
    name: 'CAD/3D',
    description: 'AutoCAD, SketchUp, Blender 등',
    programs: ['AutoCAD', 'SketchUp', 'Blender', 'Fusion 360', 'Cinema 4D', '3ds Max'],
    extensions: ['.dwg', '.dxf', '.skp', '.blend', '.f3d', '.c4d', '.max'],
    patterns: /\b(autocad|sketchup|blender|fusion|cinema|3ds)\b/i,
  },

  // Project Management (5개)
  project_management: {
    name: 'Project Management',
    description: 'Jira, Asana, Linear, Monday.com 등',
    programs: ['Jira', 'Asana', 'Linear', 'Monday.com', 'Trello', 'ClickUp', 'Notion'],
    extensions: [],
    patterns: /\b(jira|asana|linear|monday|trello|clickup|notion)\b/i,
  },

  issue_tracking: {
    name: 'Issue Tracking',
    description: 'GitHub Issues, GitLab Issues 등',
    programs: ['GitHub', 'GitLab', 'Jira'],
    extensions: [],
    patterns: /\b(github|gitlab|jira)\b/i,
  },

  documentation: {
    name: 'Documentation',
    description: 'Confluence, ReadMe, Wiki 등',
    programs: ['Confluence', 'ReadMe', 'GitBook', 'Notion'],
    extensions: ['.md', '.markdown', '.wiki'],
    patterns: /\b(confluence|readme|gitbook|wiki)\b/i,
  },

  // ERP/CRM (4개)
  salesforce: {
    name: 'Salesforce',
    description: 'Salesforce CRM',
    programs: ['Salesforce'],
    extensions: [],
    patterns: /\b(salesforce|sfdc)\b/i,
  },

  sap: {
    name: 'SAP',
    description: 'SAP ERP',
    programs: ['SAP', 'SAP GUI'],
    extensions: [],
    patterns: /\b(sap|sap\s+gui)\b/i,
  },

  oracle_erp: {
    name: 'Oracle ERP',
    description: 'Oracle NetSuite, Oracle EBS',
    programs: ['Oracle', 'NetSuite', 'Oracle NetSuite'],
    extensions: [],
    patterns: /\b(oracle|netsuite)\b/i,
  },

  dynamics: {
    name: 'Microsoft Dynamics',
    description: 'Dynamics 365, Dynamics AX',
    programs: ['Dynamics 365', 'Dynamics AX'],
    extensions: [],
    patterns: /\b(dynamics|ax|crm)\b/i,
  },

  // Communication (4개)
  communication: {
    name: 'Communication',
    description: 'Slack, Teams, Discord, Zoom (메시지 추적별도)',
    programs: ['Slack', 'Teams', 'Discord', 'Zoom', 'Skype', 'WebEx'],
    extensions: [],
    patterns: /\b(slack|teams|discord|zoom|skype|webex)\b/i,
  },

  email_client: {
    name: 'Email',
    description: 'Outlook, Apple Mail, Thunderbird (메시지 추적별도)',
    programs: ['Outlook', 'Apple Mail', 'Thunderbird', 'Gmail'],
    extensions: ['.msg', '.eml', '.mbox'],
    patterns: /\b(outlook|mail|thunderbird|gmail)\b/i,
  },

  video_conference: {
    name: 'Video Conference',
    description: 'Zoom, Teams, Meet',
    programs: ['Zoom', 'Microsoft Teams', 'Google Meet', 'Jitsi'],
    extensions: [],
    patterns: /\b(zoom|teams|meet|jitsi)\b/i,
  },

  // Analytics & BI (3개)
  analytics_bi: {
    name: 'Analytics/BI',
    description: 'Tableau, Power BI, Looker 등',
    programs: ['Tableau', 'Power BI', 'Looker', 'Qlik', 'Apache Superset'],
    extensions: ['.twb', '.twbx', '.pbix'],
    patterns: /\b(tableau|power\s+bi|looker|qlik|superset)\b/i,
  },

  data_science: {
    name: 'Data Science',
    description: 'Jupyter, RStudio, DataSpell 등',
    programs: ['Jupyter', 'RStudio', 'DataSpell', 'Anaconda'],
    extensions: ['.ipynb', '.R', '.r', '.Rmd'],
    patterns: /\b(jupyter|rstudio|dataspell|anaconda)\b/i,
  },

  business_intelligence: {
    name: 'Business Intelligence',
    description: 'Metabase, Sisense, Microstrategy 등',
    programs: ['Metabase', 'Sisense', 'Microstrategy', 'IBM Cognos'],
    extensions: [],
    patterns: /\b(metabase|sisense|microstrategy|cognos)\b/i,
  },

  // Browser (2개)
  web_browser: {
    name: 'Web Browser',
    description: 'Chrome, Firefox, Safari, Edge',
    programs: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'Brave'],
    extensions: ['.html', '.htm', '.url'],
    patterns: /\b(chrome|firefox|safari|edge|opera|brave)\b/i,
  },

  research_tools: {
    name: 'Research Tools',
    description: '검색, 학술 자료 등',
    programs: ['Google Search', 'Stack Overflow', 'MDN', 'Wikipedia'],
    extensions: [],
    patterns: /\b(stackoverflow|mdn|wikipedia|scholar|arxiv)\b/i,
  },

  // Utilities & Others (5개+)
  file_manager: {
    name: 'File Manager',
    description: 'Finder, Explorer, Nautilus 등',
    programs: ['Finder', 'Explorer', 'Nautilus', 'Total Commander'],
    extensions: [],
    patterns: /\b(finder|explorer|nautilus|total\s+commander)\b/i,
  },

  text_editor: {
    name: 'Text Editor',
    description: 'Notepad++, TextEdit, Vim 등',
    programs: ['Notepad++', 'TextEdit', 'Vim', 'Nano', 'Sublime Text', 'UltraEdit'],
    extensions: ['.txt', '.log', '.conf', '.ini', '.json', '.yaml', '.xml'],
    patterns: /\b(notepad|textedit|vim|nano|sublime|ultraedit)\b/i,
  },

  productivity_tools: {
    name: 'Productivity Tools',
    description: '시간 추적, 메모, 요약 등',
    programs: ['Toggl', 'RescueTime', 'Apple Notes', 'Microsoft OneNote'],
    extensions: [],
    patterns: /\b(toggl|rescuetime|notes|onenote)\b/i,
  },

  media_player: {
    name: 'Media Player',
    description: 'VLC, Spotify, Apple Music 등',
    programs: ['VLC', 'Spotify', 'Apple Music', 'YouTube Music', 'Plex'],
    extensions: ['.mp3', '.mp4', '.flac', '.m4a'],
    patterns: /\b(vlc|spotify|apple\s+music|youtube|plex)\b/i,
  },

  development_tools: {
    name: 'Development Tools',
    description: 'Docker, Postman, Insomnia 등',
    programs: ['Docker', 'Postman', 'Insomnia', 'Swagger Editor', 'Thunder Client'],
    extensions: ['.dockerfile', '.compose', '.yml', '.yaml'],
    patterns: /\b(docker|postman|insomnia|swagger|thunder)\b/i,
  },

  virtualization: {
    name: 'Virtualization',
    description: 'VirtualBox, VMware, Parallels',
    programs: ['VirtualBox', 'VMware', 'Parallels', 'Hyper-V'],
    extensions: ['.vmdk', '.vdi', '.vhd'],
    patterns: /\b(virtualbox|vmware|parallels|hyper-v)\b/i,
  },

  other: {
    name: 'Other',
    description: '기타',
    programs: [],
    extensions: [],
    patterns: /^/,  // 모든 것과 매칭 (기본값)
  },
};

/**
 * 프로그램명으로 카테고리 찾기
 * @param {string} appName - 애플리케이션 이름 (프로세스명 또는 윈도우 타이틀)
 * @returns {{category: string, program: string}} 카테고리 및 프로그램명
 */
function categorizeProgram(appName) {
  if (!appName) return { category: 'other', program: 'Unknown' };

  for (const [categoryKey, categoryData] of Object.entries(PROGRAM_CATEGORIES)) {
    if (categoryKey === 'other') continue;  // other는 마지막에 처리

    // 패턴 매칭
    if (categoryData.patterns.test(appName)) {
      // 정확한 프로그램명 찾기
      const program = categoryData.programs.find(p => appName.toLowerCase().includes(p.toLowerCase())) || categoryData.programs[0];
      return { category: categoryKey, program: program || appName };
    }
  }

  return { category: 'other', program: appName };
}

/**
 * 파일 확장자로 카테고리 찾기
 * @param {string} filePath - 파일 경로
 * @returns {{category: string, ext: string}}
 */
function getFileCategoryByExtension(filePath) {
  if (!filePath) return { category: 'other', ext: '' };

  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')).toLowerCase() : '';
  if (!ext) return { category: 'other', ext: '' };

  for (const [categoryKey, categoryData] of Object.entries(PROGRAM_CATEGORIES)) {
    if (categoryData.extensions.includes(ext)) {
      return { category: categoryKey, ext };
    }
  }

  return { category: 'other', ext };
}

/**
 * 특정 카테고리의 모든 프로그램 반환
 * @param {string} category - 카테고리 키
 * @returns {string[]} 프로그램명 배열
 */
function getProgramsByCategory(category) {
  return PROGRAM_CATEGORIES[category]?.programs || [];
}

/**
 * 모든 카테고리 목록 반환
 * @returns {{key: string, name: string, count: number}[]}
 */
function getAllCategories() {
  return Object.entries(PROGRAM_CATEGORIES)
    .filter(([key]) => key !== 'other')
    .map(([key, data]) => ({
      key,
      name: data.name,
      count: data.programs.length,
    }));
}

/**
 * 카테고리 통계
 * @returns {Object}
 */
function getCategoryStats() {
  const stats = {};
  for (const [key, data] of Object.entries(PROGRAM_CATEGORIES)) {
    stats[key] = {
      name: data.name,
      description: data.description,
      programs: data.programs.length,
      extensions: data.extensions.length,
    };
  }
  return stats;
}

module.exports = {
  PROGRAM_CATEGORIES,
  categorizeProgram,
  getFileCategoryByExtension,
  getProgramsByCategory,
  getAllCategories,
  getCategoryStats,
};
