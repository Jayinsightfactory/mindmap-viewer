# -*- coding: utf-8 -*-
"""
엑셀 → PPT 품목 카탈로그 생성기 (Orbit AI / nenova)

기능
  1. 엑셀(.xlsx) 불러오기  → 시트별 품목명 + 임베드 이미지 추출
  2. 영역(품목) 선택       → 포함할 품목 체크
  3. 품목 순서 / 슬라이드 순서 조정 (위/아래)
  4. PPT 내보내기          → 템플릿과 동일한 3열×2행 고정 위치로 배치

핵심 로직(load_items / build_pptx)은 GUI와 분리되어 단독 테스트 가능.
필요 패키지:  pip install openpyxl python-pptx pillow
"""

import io
import os
import sys

import openpyxl
from PIL import Image
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

# ------------------------------------------------------------------
# 슬라이드 / 그리드 기하 (템플릿에서 추출 — 위치·크기 고정)
# ------------------------------------------------------------------
SLIDE_W = 9906000          # 27.5 cm
SLIDE_H = 6858000          # 19.1 cm

IMG_BOX = 1812032          # 이미지 슬롯 한 변 (약 5.03 cm 정사각)
TXT_W   = 2990000          # 텍스트박스 너비
TXT_H   = 1300000          # 텍스트박스 높이
TXT_GAP = 40000            # 이미지와 텍스트 사이 간격

COL_X = [632520, 3919529, 7141669]      # 3열 가로 시작점
ROW_Y = [836712, 4182336]               # 2행 세로 시작점(이미지 top)

# 슬라이드당 슬롯(6개): (img_left, img_top, txt_left, txt_top)
def _slots():
    s = []
    for top in ROW_Y:
        for left in COL_X:
            s.append((left, top, left, top + IMG_BOX + TXT_GAP))
    return s

SLOTS = _slots()
PER_SLIDE = len(SLOTS)     # 6

# 슬라이드 상단 제목(선택) 위치
TITLE_BOX = (632520, 200000, 8640000, 560000)

# 헤더 자동 탐지 키워드
KW_NAME   = ("품목", "품명", "name", "item")
KW_ORIGIN = ("원산지", "origin")
KW_SEASON = ("공급", "기간", "시즌", "season")


# ==================================================================
# 데이터 모델
# ==================================================================
class Item:
    __slots__ = ("name", "origin", "season", "img_bytes", "sheet", "row")

    def __init__(self, name, origin, season, img_bytes, sheet, row):
        self.name = (name or "").strip()
        self.origin = (origin or "").strip()
        self.season = (season or "").strip()
        self.img_bytes = img_bytes        # PNG/JPEG bytes or None
        self.sheet = sheet
        self.row = row


def _find_col(ws, header_row, keywords):
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=header_row, column=c).value
        if v and any(k in str(v).lower() for k in [k.lower() for k in keywords]):
            return c
    return None


def _detect_header_row(ws):
    """'품목/품명' 헤더가 있는 행을 찾는다(1~5행 탐색)."""
    for r in range(1, min(6, ws.max_row + 1)):
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=r, column=c).value
            if v and any(k in str(v).lower() for k in [k.lower() for k in KW_NAME]):
                return r
    return 1


def list_sheets(path):
    wb = openpyxl.load_workbook(path, read_only=False)
    names = wb.sheetnames
    wb.close()
    return names


def load_items(path, sheet_name):
    """지정 시트에서 품목명 + 이미지 + 부가정보를 추출해 Item 리스트로 반환."""
    wb = openpyxl.load_workbook(path)
    ws = wb[sheet_name]

    header_row = _detect_header_row(ws)
    name_col   = _find_col(ws, header_row, KW_NAME)   or 1
    origin_col = _find_col(ws, header_row, KW_ORIGIN)
    season_col = _find_col(ws, header_row, KW_SEASON)

    # 행 → 이미지 bytes 매핑 (anchor._from.row 는 0-indexed)
    img_by_row = {}
    for im in getattr(ws, "_images", []):
        try:
            r = im.anchor._from.row + 1
            if r not in img_by_row:
                img_by_row[r] = im._data()
        except Exception:
            pass

    items = []
    for r in range(header_row + 1, ws.max_row + 1):
        name = ws.cell(row=r, column=name_col).value
        img  = img_by_row.get(r)
        if not name and not img:
            continue
        if not name:
            name = f"(이름없음 {r}행)"
        origin = ws.cell(row=r, column=origin_col).value if origin_col else None
        season = ws.cell(row=r, column=season_col).value if season_col else None
        items.append(Item(name, origin, season, img, sheet_name, r))

    wb.close()
    return items


# ==================================================================
# PPT 생성
# ==================================================================
def _fit(img_bytes, box):
    """정사각 box 안에 비율 유지로 들어가는 (w,h,offx,offy) 계산."""
    try:
        im = Image.open(io.BytesIO(img_bytes))
        iw, ih = im.size
    except Exception:
        return box, box, 0, 0
    scale = min(box / iw, box / ih)
    w, h = int(iw * scale), int(ih * scale)
    return w, h, (box - w) // 2, (box - h) // 2


def _text_for(item, mode):
    lines = [f"품목명 : {item.name}"]
    if mode in ("origin", "full") and item.origin:
        lines.append(f"원산지 : {item.origin}")
    if mode == "full" and item.season:
        lines.append(f"시즌 : {item.season}")
    return lines


def build_pptx(items, out_path, per_slide=PER_SLIDE,
               text_mode="origin", slide_titles=None, name_pt=14):
    """
    items      : 출력 순서대로 정렬된 Item 리스트
    per_slide  : 슬라이드당 품목 수(최대 6, 슬롯 수로 제한)
    text_mode  : 'name' | 'origin' | 'full'
    slide_titles: 슬라이드별 제목 리스트(None 이면 제목 없음)
    """
    per_slide = max(1, min(per_slide, len(SLOTS)))
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    blank = prs.slide_layouts[6]      # 빈 레이아웃

    n_slides = (len(items) + per_slide - 1) // per_slide
    for s in range(n_slides):
        slide = prs.slides.add_slide(blank)

        # 슬라이드 제목(선택)
        if slide_titles and s < len(slide_titles) and slide_titles[s]:
            l, t, w, h = TITLE_BOX
            tb = slide.shapes.add_textbox(Emu(l), Emu(t), Emu(w), Emu(h))
            p = tb.text_frame.paragraphs[0]
            run = p.add_run()
            run.text = str(slide_titles[s])
            run.font.size = Pt(20)
            run.font.bold = True

        chunk = items[s * per_slide:(s + 1) * per_slide]
        for idx, item in enumerate(chunk):
            img_l, img_t, txt_l, txt_t = SLOTS[idx]

            # 이미지
            if item.img_bytes:
                w, h, ox, oy = _fit(item.img_bytes, IMG_BOX)
                try:
                    slide.shapes.add_picture(
                        io.BytesIO(item.img_bytes),
                        Emu(img_l + ox), Emu(img_t + oy), Emu(w), Emu(h))
                except Exception:
                    pass
            else:
                # 이미지 없으면 회색 박스
                from pptx.enum.shapes import MSO_SHAPE
                ph = slide.shapes.add_shape(
                    MSO_SHAPE.RECTANGLE, Emu(img_l), Emu(img_t),
                    Emu(IMG_BOX), Emu(IMG_BOX))
                ph.fill.solid()
                ph.fill.fore_color.rgb = RGBColor(0xEE, 0xEE, 0xEE)
                ph.line.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)

            # 텍스트박스
            tb = slide.shapes.add_textbox(
                Emu(txt_l), Emu(txt_t), Emu(TXT_W), Emu(TXT_H))
            tf = tb.text_frame
            tf.word_wrap = True
            for li, line in enumerate(_text_for(item, text_mode)):
                p = tf.paragraphs[0] if li == 0 else tf.add_paragraph()
                run = p.add_run()
                run.text = line
                run.font.size = Pt(name_pt if li == 0 else name_pt - 1)
                run.font.bold = (li == 0)

    prs.save(out_path)
    return n_slides


# ==================================================================
# GUI (tkinter)
# ==================================================================
def run_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
    from PIL import ImageTk

    THUMB = 56

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("엑셀 → PPT 품목 카탈로그 생성기")
            self.geometry("980x680")
            self.xlsx_path = None
            self.items = []            # 현재 시트 전체 Item
            self.included = set()      # 포함된 row id(index)
            self.order = []            # 표시/출력 순서(index 리스트)
            self.thumbs = {}           # index -> PhotoImage (참조 유지)
            self._build()

        # ---------- 레이아웃 ----------
        def _build(self):
            top = ttk.Frame(self, padding=8)
            top.pack(fill="x")
            ttk.Button(top, text="📂 엑셀 불러오기",
                       command=self.open_excel).pack(side="left")
            ttk.Label(top, text="시트:").pack(side="left", padx=(12, 2))
            self.sheet_cb = ttk.Combobox(top, state="readonly", width=16)
            self.sheet_cb.pack(side="left")
            self.sheet_cb.bind("<<ComboboxSelected>>", lambda e: self.load_sheet())
            ttk.Button(top, text="💾 PPT 내보내기",
                       command=self.export_ppt).pack(side="right")

            body = ttk.Frame(self, padding=(8, 0))
            body.pack(fill="both", expand=True)

            # 좌: 품목 리스트
            left = ttk.LabelFrame(body, text="품목 목록 (영역 선택 → 포함 체크)",
                                  padding=6)
            left.pack(side="left", fill="both", expand=True)

            bar = ttk.Frame(left)
            bar.pack(fill="x")
            ttk.Button(bar, text="전체 선택",
                       command=lambda: self.set_all(True)).pack(side="left")
            ttk.Button(bar, text="전체 해제",
                       command=lambda: self.set_all(False)).pack(side="left", padx=4)
            ttk.Button(bar, text="선택영역 포함",
                       command=lambda: self.toggle_selection(True)).pack(side="left")
            ttk.Button(bar, text="선택영역 제외",
                       command=lambda: self.toggle_selection(False)).pack(side="left", padx=4)
            ttk.Button(bar, text="▲ 위로",
                       command=lambda: self.move(-1)).pack(side="right")
            ttk.Button(bar, text="▼ 아래로",
                       command=lambda: self.move(1)).pack(side="right", padx=4)

            cols = ("inc", "name", "origin")
            self.tree = ttk.Treeview(left, columns=cols, show="tree headings",
                                     selectmode="extended", height=20)
            self.tree.heading("#0", text="이미지")
            self.tree.heading("inc", text="포함")
            self.tree.heading("name", text="품목명")
            self.tree.heading("origin", text="원산지")
            self.tree.column("#0", width=70, anchor="center")
            self.tree.column("inc", width=44, anchor="center")
            self.tree.column("name", width=300)
            self.tree.column("origin", width=90, anchor="center")
            self.tree.pack(side="left", fill="both", expand=True)
            sb = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
            sb.pack(side="right", fill="y")
            self.tree.configure(yscrollcommand=sb.set)
            self.tree.bind("<Button-1>", self.on_click)

            # 우: 설정
            right = ttk.LabelFrame(body, text="PPT 설정", padding=10)
            right.pack(side="right", fill="y")

            ttk.Label(right, text="슬라이드당 품목 수 (최대 6)").pack(anchor="w")
            self.per_slide = tk.IntVar(value=6)
            ttk.Spinbox(right, from_=1, to=6, width=6,
                        textvariable=self.per_slide,
                        command=self.refresh_summary).pack(anchor="w", pady=(0, 8))

            ttk.Label(right, text="텍스트 내용").pack(anchor="w")
            self.text_mode = tk.StringVar(value="origin")
            for val, lab in (("name", "품목명만"),
                             ("origin", "품목명 + 원산지"),
                             ("full", "품목명 + 원산지 + 시즌")):
                ttk.Radiobutton(right, text=lab, value=val,
                                variable=self.text_mode).pack(anchor="w")

            ttk.Label(right, text="").pack()
            ttk.Label(right, text="품목명 글자 크기(pt)").pack(anchor="w")
            self.name_pt = tk.IntVar(value=14)
            ttk.Spinbox(right, from_=8, to=28, width=6,
                        textvariable=self.name_pt).pack(anchor="w", pady=(0, 8))

            self.use_title = tk.BooleanVar(value=False)
            ttk.Checkbutton(right, text="슬라이드 제목 사용(시트명)",
                            variable=self.use_title).pack(anchor="w")

            ttk.Separator(right).pack(fill="x", pady=10)
            self.summary = tk.StringVar(value="불러온 품목: 0\n포함: 0\n예상 슬라이드: 0")
            ttk.Label(right, textvariable=self.summary,
                      justify="left").pack(anchor="w")

            self.status = tk.StringVar(value="엑셀 파일을 불러오세요.")
            ttk.Label(self, textvariable=self.status, relief="sunken",
                      anchor="w", padding=4).pack(fill="x", side="bottom")

        # ---------- 데이터 ----------
        def open_excel(self):
            path = filedialog.askopenfilename(
                title="엑셀 선택",
                filetypes=[("Excel", "*.xlsx"), ("All", "*.*")])
            if not path:
                return
            try:
                sheets = list_sheets(path)
            except Exception as e:
                messagebox.showerror("오류", f"엑셀을 열 수 없습니다:\n{e}")
                return
            self.xlsx_path = path
            self.sheet_cb["values"] = sheets
            if sheets:
                self.sheet_cb.current(0)
                self.load_sheet()

        def load_sheet(self):
            sheet = self.sheet_cb.get()
            self.status.set(f"'{sheet}' 불러오는 중...")
            self.update_idletasks()
            try:
                self.items = load_items(self.xlsx_path, sheet)
            except Exception as e:
                messagebox.showerror("오류", f"시트 로드 실패:\n{e}")
                return
            self.order = list(range(len(self.items)))
            self.included = set(range(len(self.items)))   # 기본 전체 포함
            self._make_thumbs()
            self.repaint()
            self.status.set(
                f"'{sheet}' — {len(self.items)}개 품목 로드 완료")

        def _make_thumbs(self):
            self.thumbs.clear()
            for i, it in enumerate(self.items):
                if not it.img_bytes:
                    continue
                try:
                    im = Image.open(io.BytesIO(it.img_bytes)).convert("RGB")
                    im.thumbnail((THUMB, THUMB))
                    self.thumbs[i] = ImageTk.PhotoImage(im)
                except Exception:
                    pass

        # ---------- 트리 그리기 ----------
        def repaint(self):
            self.tree.delete(*self.tree.get_children())
            self.tree.configure(rowheight=THUMB + 8)
            style = ttk.Style(self)
            style.configure("Treeview", rowheight=THUMB + 8)
            for pos, idx in enumerate(self.order):
                it = self.items[idx]
                mark = "☑" if idx in self.included else "☐"
                self.tree.insert(
                    "", "end", iid=str(idx),
                    text=str(pos + 1),
                    image=self.thumbs.get(idx, ""),
                    values=(mark, it.name, it.origin))
            self.refresh_summary()

        def refresh_summary(self):
            ps = max(1, min(self.per_slide.get(), 6))
            inc = len(self.included)
            slides = (inc + ps - 1) // ps if inc else 0
            self.summary.set(
                f"불러온 품목: {len(self.items)}\n"
                f"포함: {inc}\n"
                f"예상 슬라이드: {slides}")

        # ---------- 상호작용 ----------
        def on_click(self, event):
            # '포함' 컬럼 클릭 시 토글
            if self.tree.identify_region(event.x, event.y) != "cell":
                return
            if self.tree.identify_column(event.x) != "#1":   # inc 컬럼
                return
            iid = self.tree.identify_row(event.y)
            if not iid:
                return
            idx = int(iid)
            if idx in self.included:
                self.included.discard(idx)
            else:
                self.included.add(idx)
            self.tree.set(iid, "inc", "☑" if idx in self.included else "☐")
            self.refresh_summary()

        def _selected_idxs(self):
            return [int(i) for i in self.tree.selection()]

        def set_all(self, inc):
            self.included = set(self.order) if inc else set()
            self.repaint()

        def toggle_selection(self, inc):
            sel = self._selected_idxs()
            if not sel:
                self.status.set("먼저 트리에서 영역(행)을 선택하세요.")
                return
            for idx in sel:
                if inc:
                    self.included.add(idx)
                else:
                    self.included.discard(idx)
            self.repaint()

        def move(self, delta):
            sel = self._selected_idxs()
            if not sel:
                return
            positions = sorted(self.order.index(i) for i in sel)
            if delta < 0 and positions[0] == 0:
                return
            if delta > 0 and positions[-1] == len(self.order) - 1:
                return
            rng = positions if delta < 0 else positions[::-1]
            for p in rng:
                self.order[p + delta], self.order[p] = \
                    self.order[p], self.order[p + delta]
            self.repaint()
            self.tree.selection_set([str(i) for i in sel])

        # ---------- 내보내기 ----------
        def export_ppt(self):
            if not self.items:
                messagebox.showwarning("알림", "먼저 엑셀을 불러오세요.")
                return
            out = [self.items[i] for i in self.order if i in self.included]
            if not out:
                messagebox.showwarning("알림", "포함된 품목이 없습니다.")
                return
            path = filedialog.asksaveasfilename(
                title="PPT 저장", defaultextension=".pptx",
                filetypes=[("PowerPoint", "*.pptx")],
                initialfile="품목_카탈로그.pptx")
            if not path:
                return
            ps = max(1, min(self.per_slide.get(), 6))
            titles = None
            if self.use_title.get():
                n = (len(out) + ps - 1) // ps
                titles = [self.sheet_cb.get()] * n
            try:
                n = build_pptx(out, path, per_slide=ps,
                               text_mode=self.text_mode.get(),
                               slide_titles=titles,
                               name_pt=self.name_pt.get())
            except Exception as e:
                messagebox.showerror("오류", f"PPT 생성 실패:\n{e}")
                return
            self.status.set(f"완료: {n}개 슬라이드 → {path}")
            messagebox.showinfo("완료",
                                f"{len(out)}개 품목 / {n}개 슬라이드 생성\n{path}")

    App().mainloop()


if __name__ == "__main__":
    run_gui()
