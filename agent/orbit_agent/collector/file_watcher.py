"""
collector/file_watcher.py
파일 변경 감시 — 생성/수정/삭제 + diff 추적

수집 데이터:
  - 파일 생성/수정/삭제 이벤트
  - 파일 내용 diff (텍스트 파일만)
  - 원본 vs 생성 파일 비교
"""
import os
import logging
import difflib
from datetime import datetime
from pathlib import Path

logger = logging.getLogger('orbit.file_watcher')

# 감시 대상 확장자
TEXT_EXTENSIONS = {
    '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml',
    '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss',
    '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php',
    '.sql', '.sh', '.bat', '.ps1', '.vue', '.svelte',
    '.doc', '.docx',  # diff는 못 하지만 변경 감지는 가능
    '.xls', '.xlsx', '.ppt', '.pptx',
    '.hwp', '.hwpx',
}

# 무시할 패턴
IGNORE_PATTERNS = {
    'node_modules', '.git', '__pycache__', '.venv', 'venv',
    '.idea', '.vscode', '.DS_Store', 'Thumbs.db',
    '~$', '.tmp', '.temp', '.swp', '.lock',
}

# diff 가능한 확장자 (텍스트 파일)
DIFFABLE_EXTENSIONS = {
    '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
    '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css',
    '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php',
    '.sql', '.sh', '.bat', '.ps1', '.vue', '.svelte', '.toml',
}


def should_ignore(filepath):
    """무시할 파일인지 확인"""
    fp = str(filepath)
    for pattern in IGNORE_PATTERNS:
        if pattern in fp:
            return True
    return False


def compute_diff(old_content, new_content, filepath=''):
    """두 텍스트의 diff 계산"""
    if not old_content and not new_content:
        return None

    old_lines = (old_content or '').splitlines(keepends=True)
    new_lines = (new_content or '').splitlines(keepends=True)

    diff = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f'a/{filepath}',
        tofile=f'b/{filepath}',
        lineterm=''
    ))

    if not diff:
        return None

    # diff 요약
    added = sum(1 for l in diff if l.startswith('+') and not l.startswith('+++'))
    removed = sum(1 for l in diff if l.startswith('-') and not l.startswith('---'))

    return {
        'diff_text': '\n'.join(diff[:500]),  # 최대 500줄
        'lines_added': added,
        'lines_removed': removed,
        'total_changes': added + removed,
    }


class FileWatcher:
    """파일 시스템 감시기 — watchdog 기반"""

    def __init__(self, watch_dirs=None, on_event=None):
        self._watch_dirs = watch_dirs or []
        self._on_event = on_event
        self._observers = []
        self._file_cache = {}  # filepath → 마지막 내용 (diff용)
        self._running = False

    def start(self):
        """감시 시작"""
        if not self._watch_dirs:
            logger.warning("감시할 디렉토리가 설정되지 않았습니다")
            return

        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except ImportError:
            logger.error("watchdog 패키지 필요: pip install watchdog")
            return

        watcher = self

        class Handler(FileSystemEventHandler):
            def on_created(self, event):
                if event.is_directory or should_ignore(event.src_path):
                    return
                watcher._handle_event('create', event.src_path)

            def on_modified(self, event):
                if event.is_directory or should_ignore(event.src_path):
                    return
                watcher._handle_event('modify', event.src_path)

            def on_deleted(self, event):
                if event.is_directory or should_ignore(event.src_path):
                    return
                watcher._handle_event('delete', event.src_path)

            def on_moved(self, event):
                if event.is_directory or should_ignore(event.src_path):
                    return
                watcher._handle_event('move', event.src_path,
                                      extra={'dest_path': event.dest_path})

        handler = Handler()
        self._running = True

        for dir_path in self._watch_dirs:
            if not os.path.isdir(dir_path):
                logger.warning(f"디렉토리 없음: {dir_path}")
                continue

            observer = Observer()
            observer.schedule(handler, dir_path, recursive=True)
            observer.daemon = True
            observer.start()
            self._observers.append(observer)
            logger.info(f"파일 감시 시작: {dir_path}")

        # 초기 파일 캐시 (diff용)
        self._cache_existing_files()

    def stop(self):
        """감시 중지"""
        self._running = False
        for observer in self._observers:
            observer.stop()
        for observer in self._observers:
            observer.join(timeout=5)
        self._observers.clear()
        logger.info("파일 감시 중지")

    def _cache_existing_files(self):
        """기존 파일 내용 캐시 (diff 비교용)"""
        for dir_path in self._watch_dirs:
            for root, dirs, files in os.walk(dir_path):
                # 무시 패턴 디렉토리 스킵
                dirs[:] = [d for d in dirs if not should_ignore(d)]
                for f in files[:100]:  # 디렉토리당 최대 100파일
                    fp = os.path.join(root, f)
                    ext = Path(fp).suffix.lower()
                    if ext in DIFFABLE_EXTENSIONS and not should_ignore(fp):
                        try:
                            with open(fp, 'r', encoding='utf-8', errors='ignore') as fh:
                                self._file_cache[fp] = fh.read()[:50000]  # 50KB 제한
                        except Exception:
                            pass

    def _handle_event(self, operation, filepath, extra=None):
        """파일 이벤트 처리"""
        ext = Path(filepath).suffix.lower()
        now = datetime.utcnow().isoformat() + 'Z'

        event = {
            'type': 'file.change',
            'timestamp': now,
            'operation': operation,
            'filepath': filepath,
            'filename': os.path.basename(filepath),
            'extension': ext,
            'is_text': ext in DIFFABLE_EXTENSIONS,
        }

        # diff 계산 (텍스트 파일 수정 시)
        if operation == 'modify' and ext in DIFFABLE_EXTENSIONS:
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    new_content = f.read()[:50000]

                old_content = self._file_cache.get(filepath, '')
                diff = compute_diff(old_content, new_content, os.path.basename(filepath))
                if diff:
                    event['diff'] = diff

                # 캐시 업데이트
                self._file_cache[filepath] = new_content
            except Exception as e:
                logger.debug(f"Diff 계산 실패: {filepath}: {e}")

        elif operation == 'create' and ext in DIFFABLE_EXTENSIONS:
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()[:50000]
                event['content_preview'] = content[:1000]
                event['line_count'] = content.count('\n') + 1
                self._file_cache[filepath] = content
            except Exception:
                pass

        elif operation == 'delete':
            old = self._file_cache.pop(filepath, None)
            if old:
                event['deleted_line_count'] = old.count('\n') + 1

        if extra:
            event.update(extra)

        # 파일 크기
        try:
            if os.path.exists(filepath):
                event['size_bytes'] = os.path.getsize(filepath)
        except Exception:
            pass

        if self._on_event:
            self._on_event(event)
