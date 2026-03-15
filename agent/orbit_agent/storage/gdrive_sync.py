"""
storage/gdrive_sync.py
Google Drive 동기화 — 사용자 데이터를 사용자의 드라이브에 저장

구조:
  Google Drive/
    OrbitAI/
      config.json          ← 에이전트 설정 (PC 간 공유)
      analysis/
        2026-03-15.json    ← 일별 분석 결과
      task_graphs/
        tasks.json         ← 학습된 작업 그래프
      feedback/
        pending.json       ← 미확인 피드백

동기화 타이밍:
  - 분석 완료 시 → analysis/ 업로드
  - 작업 그래프 변경 시 → task_graphs/ 업로드
  - 에이전트 시작 시 → 설정 + 기존 데이터 다운로드
"""
import json
import logging
from datetime import datetime

logger = logging.getLogger('orbit.gdrive')


class GDriveSync:
    """Google Drive 동기화 관리"""

    def __init__(self, credentials_path=None):
        self._service = None
        self._folder_id = None
        self._creds_path = credentials_path

    def connect(self):
        """Google Drive API 연결"""
        try:
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
            from google.auth.transport.requests import Request
            from googleapiclient.discovery import build
            import os

            creds = None
            token_path = os.path.expanduser('~/.orbit/gdrive-token.json')

            if os.path.exists(token_path):
                creds = Credentials.from_authorized_user_file(token_path)

            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    creds.refresh(Request())
                else:
                    logger.warning("Google Drive 인증 필요: orbit-agent --gdrive-auth")
                    return False

                # 갱신된 토큰 저장
                with open(token_path, 'w') as f:
                    f.write(creds.to_json())

            self._service = build('drive', 'v3', credentials=creds)
            self._ensure_folder()
            logger.info("Google Drive 연결 완료")
            return True

        except ImportError:
            logger.error("google-api-python-client 필요: pip install google-api-python-client")
            return False
        except Exception as e:
            logger.error(f"Google Drive 연결 실패: {e}")
            return False

    def _ensure_folder(self):
        """OrbitAI 폴더 생성 (없으면)"""
        if not self._service:
            return

        # 기존 폴더 검색
        results = self._service.files().list(
            q="name='OrbitAI' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            spaces='drive',
            fields='files(id, name)'
        ).execute()

        files = results.get('files', [])
        if files:
            self._folder_id = files[0]['id']
        else:
            # 새 폴더 생성
            metadata = {
                'name': 'OrbitAI',
                'mimeType': 'application/vnd.google-apps.folder'
            }
            folder = self._service.files().create(body=metadata, fields='id').execute()
            self._folder_id = folder['id']
            logger.info(f"OrbitAI 폴더 생성: {self._folder_id}")

        # 하위 폴더 생성
        for sub in ['analysis', 'task_graphs', 'feedback']:
            self._ensure_subfolder(sub)

    def _ensure_subfolder(self, name):
        """하위 폴더 생성"""
        if not self._service or not self._folder_id:
            return

        results = self._service.files().list(
            q=f"name='{name}' and '{self._folder_id}' in parents and "
              f"mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields='files(id)'
        ).execute()

        if not results.get('files'):
            metadata = {
                'name': name,
                'mimeType': 'application/vnd.google-apps.folder',
                'parents': [self._folder_id],
            }
            self._service.files().create(body=metadata, fields='id').execute()

    def upload_analysis(self, result, date_str=None):
        """분석 결과 업로드"""
        if not self._service:
            return False

        date_str = date_str or datetime.utcnow().strftime('%Y-%m-%d')
        filename = f'{date_str}.json'

        return self._upload_json(
            filename,
            result,
            parent_name='analysis'
        )

    def upload_task_graphs(self, tasks):
        """작업 그래프 업로드"""
        if not self._service:
            return False

        return self._upload_json(
            'tasks.json',
            tasks,
            parent_name='task_graphs'
        )

    def download_existing_data(self):
        """기존 데이터 다운로드 (다른 PC에서 수집한 데이터)"""
        if not self._service or not self._folder_id:
            return None

        try:
            # task_graphs/tasks.json 다운로드
            results = self._service.files().list(
                q=f"name='tasks.json' and trashed=false",
                spaces='drive',
                fields='files(id, name, modifiedTime)'
            ).execute()

            files = results.get('files', [])
            if files:
                from io import BytesIO
                from googleapiclient.http import MediaIoBaseDownload

                request = self._service.files().get_media(fileId=files[0]['id'])
                buf = BytesIO()
                downloader = MediaIoBaseDownload(buf, request)
                done = False
                while not done:
                    _, done = downloader.next_chunk()
                buf.seek(0)
                return json.loads(buf.read().decode('utf-8'))

        except Exception as e:
            logger.warning(f"기존 데이터 다운로드 실패: {e}")

        return None

    def _upload_json(self, filename, data, parent_name=None):
        """JSON 파일 업로드 (기존 파일 업데이트 or 새로 생성)"""
        if not self._service or not self._folder_id:
            return False

        try:
            from googleapiclient.http import MediaInMemoryUpload

            content = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
            media = MediaInMemoryUpload(content, mimetype='application/json')

            # 부모 폴더 ID 찾기
            parent_id = self._folder_id
            if parent_name:
                results = self._service.files().list(
                    q=f"name='{parent_name}' and '{self._folder_id}' in parents and "
                      f"mimeType='application/vnd.google-apps.folder' and trashed=false",
                    fields='files(id)'
                ).execute()
                if results.get('files'):
                    parent_id = results['files'][0]['id']

            # 기존 파일 검색
            existing = self._service.files().list(
                q=f"name='{filename}' and '{parent_id}' in parents and trashed=false",
                fields='files(id)'
            ).execute()

            if existing.get('files'):
                # 업데이트
                self._service.files().update(
                    fileId=existing['files'][0]['id'],
                    media_body=media
                ).execute()
            else:
                # 새로 생성
                metadata = {
                    'name': filename,
                    'parents': [parent_id],
                }
                self._service.files().create(
                    body=metadata,
                    media_body=media,
                    fields='id'
                ).execute()

            return True

        except Exception as e:
            logger.error(f"Google Drive 업로드 실패: {e}")
            return False
