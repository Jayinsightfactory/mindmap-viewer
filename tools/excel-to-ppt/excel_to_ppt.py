# -*- coding: utf-8 -*-
"""
엑셀 → PPT 품목 카탈로그 생성기 (Orbit AI / nenova)  v2

핵심
  - 슬라이드를 여러 개 생성, 슬라이드마다 가로×세로(그리드)를 개별 지정
  - 슬라이드마다 채울 품목을 개별 선택
  - 작업 내용(품목·이미지·슬라이드 구성) 자동 저장 → 재실행 시 복원
  - 품목 라이브러리: 큰 썸네일 + 4배 큰 체크박스, 드래그 복수선택
필요 패키지:  pip install openpyxl python-pptx pillow
exe 빌드   :  build.bat 실행 (PyInstaller --noconsole)
"""

import io
import os
import json
import base64

import openpyxl
from PIL import Image
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor

# ---------------- 슬라이드 크기 (템플릿 기준 27.5 x 19.1 cm) ----------------
SLIDE_W = 9906000
SLIDE_H = 6858000

KW_NAME   = ("품목", "품명", "name", "item")
KW_ORIGIN = ("원산지", "origin")
KW_SEASON = ("공급", "기간", "시즌", "season")

# 저장 위치 (작업 자동 저장)
APP_DIR   = os.path.join(os.path.expanduser("~"), ".orbit_ppt")
CACHE_DIR = os.path.join(APP_DIR, "cache")
PROJECT   = os.path.join(APP_DIR, "project.json")


# ==================================================================
# 그리드 슬롯 계산 (가로 cols × 세로 rows → 셀마다 이미지+텍스트 위치)
# ==================================================================
def grid_slots(cols, rows, top_pad=320000):
    mx, mb, gut = 500000, 300000, 160000
    my = top_pad
    usable_w = SLIDE_W - 2 * mx
    usable_h = SLIDE_H - my - mb
    cw = (usable_w - (cols - 1) * gut) / cols
    ch = (usable_h - (rows - 1) * gut) / rows
    slots = []
    for r in range(rows):
        for c in range(cols):
            cl = mx + c * (cw + gut)
            ct = my + r * (ch + gut)
            txt_h = min(ch * 0.30, 1000000)
            gap = 40000
            img_box = max(200000, min(cw, ch - txt_h - gap))
            img_l = cl + (cw - img_box) / 2
            slots.append((
                int(img_l), int(ct), int(img_box),
                int(cl), int(ct + img_box + gap),
                int(cw), int(ch - img_box - gap)))
    return slots


# ==================================================================
# 데이터 모델 + 엑셀 추출
# ==================================================================
class Item:
    __slots__ = ("name", "origin", "season", "img_bytes", "sheet", "row")
    def __init__(self, name, origin, season, img_bytes, sheet, row):
        self.name = (str(name) if name is not None else "").strip()
        self.origin = (str(origin) if origin is not None else "").strip()
        self.season = (str(season) if season is not None else "").strip()
        self.img_bytes = img_bytes
        self.sheet = sheet
        self.row = row

    @property
    def key(self):
        return (self.sheet, self.row)


def _find_col(ws, header_row, keywords):
    kws = [k.lower() for k in keywords]
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=header_row, column=c).value
        if v and any(k in str(v).lower() for k in kws):
            return c
    return None


def _detect_header_row(ws):
    kws = [k.lower() for k in KW_NAME]
    for r in range(1, min(6, ws.max_row + 1)):
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=r, column=c).value
            if v and any(k in str(v).lower() for k in kws):
                return r
    return 1


def list_sheets(path):
    wb = openpyxl.load_workbook(path, read_only=False)
    names = wb.sheetnames
    wb.close()
    return names


def load_items(path, sheet_name):
    wb = openpyxl.load_workbook(path)
    ws = wb[sheet_name]
    header_row = _detect_header_row(ws)
    name_col   = _find_col(ws, header_row, KW_NAME)   or 1
    origin_col = _find_col(ws, header_row, KW_ORIGIN)
    season_col = _find_col(ws, header_row, KW_SEASON)

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
# PPT 생성 (슬라이드마다 그리드/품목 다름)
# ==================================================================
def _fit(img_bytes, box):
    try:
        im = Image.open(io.BytesIO(img_bytes))
        iw, ih = im.size
    except Exception:
        return box, box, 0, 0
    s = min(box / iw, box / ih)
    w, h = int(iw * s), int(ih * s)
    return w, h, (box - w) // 2, (box - h) // 2


def _text_for(item, mode):
    lines = [f"품목명 : {item.name}"]
    if mode in ("origin", "full") and item.origin:
        lines.append(f"원산지 : {item.origin}")
    if mode == "full" and item.season:
        lines.append(f"시즌 : {item.season}")
    return lines


def build_pptx(slides, store, out_path,
               text_mode="origin", name_pt=14, titles=None):
    """
    slides : [{"cols":3,"rows":2,"items":[key, key, ...]}, ...]
    store  : {key(tuple): Item}
    titles : 슬라이드별 제목 리스트 또는 None
    """
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    blank = prs.slide_layouts[6]
    from pptx.enum.shapes import MSO_SHAPE

    for si, sd in enumerate(slides):
        cols, rows = int(sd["cols"]), int(sd["rows"])
        slide = prs.slides.add_slide(blank)

        title = titles[si] if (titles and si < len(titles) and titles[si]) else None
        top_pad = 320000
        if title:
            top_pad = 880000
            tb = slide.shapes.add_textbox(
                Emu(500000), Emu(180000), Emu(SLIDE_W - 1000000), Emu(560000))
            p = tb.text_frame.paragraphs[0]
            run = p.add_run()
            run.text = str(title)
            run.font.size = Pt(20)
            run.font.bold = True

        slots = grid_slots(cols, rows, top_pad)
        keys = sd["items"][:cols * rows]
        for idx, key in enumerate(keys):
            it = store.get(tuple(key))
            if not it:
                continue
            il, it_top, ibox, tl, tt, tw, th = slots[idx]
            if it.img_bytes:
                w, h, ox, oy = _fit(it.img_bytes, ibox)
                try:
                    slide.shapes.add_picture(
                        io.BytesIO(it.img_bytes),
                        Emu(il + ox), Emu(it_top + oy), Emu(w), Emu(h))
                except Exception:
                    pass
            else:
                ph = slide.shapes.add_shape(
                    MSO_SHAPE.RECTANGLE, Emu(il), Emu(it_top),
                    Emu(ibox), Emu(ibox))
                ph.fill.solid()
                ph.fill.fore_color.rgb = RGBColor(0xEE, 0xEE, 0xEE)
                ph.line.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)

            box = slide.shapes.add_textbox(Emu(tl), Emu(tt), Emu(tw), Emu(max(th, 300000)))
            tf = box.text_frame
            tf.word_wrap = True
            for li, line in enumerate(_text_for(it, text_mode)):
                p = tf.paragraphs[0] if li == 0 else tf.add_paragraph()
                run = p.add_run()
                run.text = line
                run.font.size = Pt(name_pt if li == 0 else max(8, name_pt - 1))
                run.font.bold = (li == 0)

    prs.save(out_path)
    return len(slides)


# ==================================================================
# 작업 자동 저장 / 복원
# ==================================================================
def _ensure_dirs():
    os.makedirs(CACHE_DIR, exist_ok=True)


def _cache_path(key):
    return os.path.join(CACHE_DIR, f"{key[0]}__{key[1]}.png")


def save_project(state, store):
    """state: dict(excel_path, text_mode, name_pt, use_title, slides[list])"""
    _ensure_dirs()
    # 이미지 캐시 저장
    for key, it in store.items():
        if it.img_bytes:
            p = _cache_path(key)
            if not os.path.exists(p):
                try:
                    Image.open(io.BytesIO(it.img_bytes)).convert("RGB").save(p, "PNG")
                except Exception:
                    pass
    meta = {key: {"name": it.name, "origin": it.origin, "season": it.season}
            for key, it in store.items()}
    data = {
        "excel_path": state.get("excel_path"),
        "text_mode": state.get("text_mode", "origin"),
        "name_pt": state.get("name_pt", 14),
        "use_title": state.get("use_title", False),
        "slides": [{"cols": s["cols"], "rows": s["rows"],
                    "items": [list(k) for k in s["items"]]}
                   for s in state.get("slides", [])],
        "store": {f"{k[0]}||{k[1]}": v for k, v in meta.items()},
    }
    with open(PROJECT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def load_project():
    if not os.path.exists(PROJECT):
        return None
    try:
        with open(PROJECT, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    store = {}
    for sk, meta in data.get("store", {}).items():
        sheet, row = sk.split("||")
        key = (sheet, int(row))
        img = None
        p = _cache_path(key)
        if os.path.exists(p):
            with open(p, "rb") as fp:
                img = fp.read()
        store[key] = Item(meta.get("name"), meta.get("origin"),
                          meta.get("season"), img, sheet, int(row))
    slides = [{"cols": s["cols"], "rows": s["rows"],
               "items": [tuple(k) for k in s["items"]]}
              for s in data.get("slides", [])]
    state = {
        "excel_path": data.get("excel_path"),
        "text_mode": data.get("text_mode", "origin"),
        "name_pt": data.get("name_pt", 14),
        "use_title": data.get("use_title", False),
        "slides": slides,
    }
    return state, store


# ==================================================================
# GUI
# ==================================================================
def run_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
    from PIL import ImageTk, ImageDraw

    THUMB = 64
    CB = 44          # 체크박스 크기 (기본 대비 약 4배)

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("엑셀 → PPT 품목 카탈로그 생성기  v2")
            self.geometry("1180x760")

            self.excel_path = None
            self.store = {}            # key -> Item (모든 시트 누적)
            self.lib_keys = []         # 라이브러리 표시 순서(현재 시트)
            self.thumbs = {}           # key -> PIL thumbnail
            self.row_imgs = {}         # iid -> PhotoImage (참조 유지)
            self.slides = []           # [{cols,rows,items:[key]}]
            self.cur_slide = None      # 선택된 슬라이드 index
            self._drag_anchor = None

            self._build()
            self._restore()

        # ---------------- 레이아웃 ----------------
        def _build(self):
            top = ttk.Frame(self, padding=6)
            top.pack(fill="x")
            ttk.Button(top, text="📂 엑셀 불러오기", command=self.open_excel).pack(side="left")
            ttk.Label(top, text="시트:").pack(side="left", padx=(10, 2))
            self.sheet_cb = ttk.Combobox(top, state="readonly", width=14)
            self.sheet_cb.pack(side="left")
            self.sheet_cb.bind("<<ComboboxSelected>>", lambda e: self.load_sheet())

            ttk.Label(top, text="  텍스트:").pack(side="left")
            self.text_mode = tk.StringVar(value="origin")
            ttk.Combobox(top, state="readonly", width=18, textvariable=self.text_mode,
                         values=["name", "origin", "full"]).pack(side="left")
            ttk.Label(top, text="글자pt:").pack(side="left", padx=(8, 2))
            self.name_pt = tk.IntVar(value=14)
            ttk.Spinbox(top, from_=8, to=28, width=4, textvariable=self.name_pt).pack(side="left")
            self.use_title = tk.BooleanVar(value=False)
            ttk.Checkbutton(top, text="슬라이드 제목(시트명)", variable=self.use_title,
                            command=self.autosave).pack(side="left", padx=8)

            ttk.Button(top, text="💾 PPT 내보내기", command=self.export_ppt).pack(side="right")
            self.save_lbl = ttk.Label(top, text="", foreground="#2a7")
            self.save_lbl.pack(side="right", padx=8)

            body = ttk.Frame(self, padding=(6, 0))
            body.pack(fill="both", expand=True)

            # ----- 왼쪽: 품목 라이브러리 -----
            left = ttk.LabelFrame(body, text="품목 라이브러리 (드래그=복수선택, 클릭=체크)", padding=6)
            left.pack(side="left", fill="both", expand=True)

            lb = ttk.Frame(left); lb.pack(fill="x")
            ttk.Button(lb, text="전체선택", command=self.sel_all).pack(side="left")
            ttk.Button(lb, text="선택해제", command=self.sel_none).pack(side="left", padx=4)
            ttk.Label(lb, text="선택한 품목을 →", foreground="#888").pack(side="right")

            self.tree = ttk.Treeview(left, columns=("name", "origin", "used"),
                                     show="tree headings", selectmode="extended")
            self.tree.heading("#0", text="✔  이미지")
            self.tree.heading("name", text="품목명")
            self.tree.heading("origin", text="원산지")
            self.tree.heading("used", text="배치")
            self.tree.column("#0", width=130, anchor="w")
            self.tree.column("name", width=260)
            self.tree.column("origin", width=80, anchor="center")
            self.tree.column("used", width=90, anchor="center")
            self.tree.pack(side="left", fill="both", expand=True)
            sb = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
            sb.pack(side="right", fill="y")
            self.tree.configure(yscrollcommand=sb.set)
            ttk.Style(self).configure("Treeview", rowheight=THUMB + 8)
            self.tree.bind("<ButtonPress-1>", self.on_press)
            self.tree.bind("<B1-Motion>", self.on_drag)
            self.tree.bind("<<TreeviewSelect>>", lambda e: self.refresh_checks())

            # ----- 가운데: 추가 버튼 -----
            mid = ttk.Frame(body, padding=6); mid.pack(side="left", fill="y")
            ttk.Label(mid, text="").pack(pady=20)
            ttk.Button(mid, text="선택 품목 ▶\n현재 슬라이드에 추가",
                       command=self.add_to_slide).pack(pady=6, ipady=8)
            ttk.Button(mid, text="◀ 슬라이드에서\n선택 품목 제거",
                       command=self.remove_from_slide).pack(pady=6, ipady=8)

            # ----- 오른쪽: 슬라이드 구성 -----
            right = ttk.LabelFrame(body, text="슬라이드 구성", padding=6)
            right.pack(side="right", fill="both", expand=True)

            sbar = ttk.Frame(right); sbar.pack(fill="x")
            ttk.Button(sbar, text="＋ 슬라이드 추가", command=self.add_slide).pack(side="left")
            ttk.Button(sbar, text="− 삭제", command=self.del_slide).pack(side="left", padx=4)
            ttk.Button(sbar, text="▲", width=3, command=lambda: self.move_slide(-1)).pack(side="left")
            ttk.Button(sbar, text="▼", width=3, command=lambda: self.move_slide(1)).pack(side="left")

            self.slide_lb = tk.Listbox(right, height=7, exportselection=False)
            self.slide_lb.pack(fill="x", pady=4)
            self.slide_lb.bind("<<ListboxSelect>>", lambda e: self.on_slide_select())

            grid_f = ttk.Frame(right); grid_f.pack(fill="x", pady=2)
            ttk.Label(grid_f, text="가로(열):").pack(side="left")
            self.cols_var = tk.IntVar(value=3)
            ttk.Spinbox(grid_f, from_=1, to=6, width=4, textvariable=self.cols_var,
                        command=self.apply_grid).pack(side="left", padx=(2, 10))
            ttk.Label(grid_f, text="세로(행):").pack(side="left")
            self.rows_var = tk.IntVar(value=2)
            ttk.Spinbox(grid_f, from_=1, to=6, width=4, textvariable=self.rows_var,
                        command=self.apply_grid).pack(side="left", padx=2)
            self.cap_lbl = ttk.Label(grid_f, text="", foreground="#888")
            self.cap_lbl.pack(side="left", padx=10)

            ttk.Label(right, text="이 슬라이드에 들어간 품목 (순서대로):").pack(anchor="w", pady=(6, 0))
            self.slide_items = tk.Listbox(right, height=10, exportselection=False,
                                          selectmode="extended")
            self.slide_items.pack(fill="both", expand=True)
            ib = ttk.Frame(right); ib.pack(fill="x")
            ttk.Button(ib, text="▲ 위로", command=lambda: self.move_item(-1)).pack(side="left")
            ttk.Button(ib, text="▼ 아래로", command=lambda: self.move_item(1)).pack(side="left", padx=4)

            self.status = tk.StringVar(value="엑셀을 불러오거나 이전 작업이 자동 복원됩니다.")
            ttk.Label(self, textvariable=self.status, relief="sunken", anchor="w",
                      padding=4).pack(fill="x", side="bottom")

        # ---------------- 체크박스 이미지 ----------------
        def _row_image(self, key, checked):
            thumb = self.thumbs.get(key)
            tw = thumb.width if thumb else 60
            th = thumb.height if thumb else 60
            H = max(CB, th)
            W = CB + 8 + tw
            img = Image.new("RGBA", (W, H), (255, 255, 255, 0))
            d = ImageDraw.Draw(img)
            y0 = (H - CB) // 2
            if checked:
                d.rounded_rectangle([2, y0, CB - 2, y0 + CB - 4], radius=7,
                                    fill=(46, 134, 222), outline=(46, 134, 222), width=3)
                d.line([(CB * 0.24, y0 + CB * 0.52), (CB * 0.42, y0 + CB * 0.70)],
                       fill="white", width=5)
                d.line([(CB * 0.42, y0 + CB * 0.70), (CB * 0.76, y0 + CB * 0.28)],
                       fill="white", width=5)
            else:
                d.rounded_rectangle([2, y0, CB - 2, y0 + CB - 4], radius=7,
                                    outline=(120, 120, 120), width=3, fill=(255, 255, 255))
            if thumb:
                img.paste(thumb, (CB + 8, (H - th) // 2))
            return ImageTk.PhotoImage(img)

        def refresh_checks(self):
            sel = set(self.tree.selection())
            for iid in self.tree.get_children():
                key = self._iid_key(iid)
                photo = self._row_image(key, iid in sel)
                self.row_imgs[iid] = photo
                self.tree.item(iid, image=photo)

        # ---------------- 키 ↔ iid ----------------
        def _iid_key(self, iid):
            sheet, row = iid.rsplit("##", 1)
            return (sheet, int(row))

        def _key_iid(self, key):
            return f"{key[0]}##{key[1]}"

        # ---------------- 엑셀 ----------------
        def open_excel(self):
            path = filedialog.askopenfilename(
                title="엑셀 선택", filetypes=[("Excel", "*.xlsx"), ("All", "*.*")])
            if not path:
                return
            try:
                sheets = list_sheets(path)
            except Exception as e:
                messagebox.showerror("오류", f"엑셀을 열 수 없습니다:\n{e}")
                return
            self.excel_path = path
            self.sheet_cb["values"] = sheets
            if sheets:
                self.sheet_cb.current(0)
                self.load_sheet()

        def load_sheet(self):
            if not self.excel_path:
                return
            sheet = self.sheet_cb.get()
            self.status.set(f"'{sheet}' 불러오는 중...")
            self.update_idletasks()
            try:
                items = load_items(self.excel_path, sheet)
            except Exception as e:
                messagebox.showerror("오류", f"시트 로드 실패:\n{e}")
                return
            self.lib_keys = []
            for it in items:
                self.store[it.key] = it
                self.lib_keys.append(it.key)
            self._make_thumbs(items)
            self.fill_library()
            self.autosave()
            self.status.set(f"'{sheet}' — {len(items)}개 품목")

        def _make_thumbs(self, items):
            for it in items:
                if not it.img_bytes or it.key in self.thumbs:
                    continue
                try:
                    im = Image.open(io.BytesIO(it.img_bytes)).convert("RGB")
                    im.thumbnail((THUMB, THUMB))
                    self.thumbs[it.key] = im
                except Exception:
                    pass

        # ---------------- 라이브러리 그리기 ----------------
        def fill_library(self):
            self.tree.delete(*self.tree.get_children())
            self.row_imgs.clear()
            for key in self.lib_keys:
                it = self.store.get(key)
                if not it:
                    continue
                iid = self._key_iid(key)
                photo = self._row_image(key, False)
                self.row_imgs[iid] = photo
                placed = self._slides_with(key)
                used = ",".join(str(i + 1) for i in placed) if placed else ""
                self.tree.insert("", "end", iid=iid, image=photo,
                                 values=(it.name, it.origin, used))

        def _slides_with(self, key):
            return [i for i, s in enumerate(self.slides) if key in s["items"]]

        # ---------------- 선택/드래그 ----------------
        def on_press(self, event):
            self._drag_anchor = self.tree.identify_row(event.y)

        def on_drag(self, event):
            row = self.tree.identify_row(event.y)
            if not row or not self._drag_anchor:
                return
            children = list(self.tree.get_children())
            try:
                a = children.index(self._drag_anchor)
                b = children.index(row)
            except ValueError:
                return
            lo, hi = sorted((a, b))
            self.tree.selection_set(children[lo:hi + 1])

        def sel_all(self):
            self.tree.selection_set(self.tree.get_children())

        def sel_none(self):
            self.tree.selection_remove(self.tree.get_children())

        def _selected_keys(self):
            return [self._iid_key(i) for i in self.tree.selection()]

        # ---------------- 슬라이드 ----------------
        def add_slide(self):
            self.slides.append({"cols": self.cols_var.get(),
                                "rows": self.rows_var.get(), "items": []})
            self.refresh_slides()
            self.slide_lb.selection_clear(0, "end")
            self.slide_lb.selection_set("end")
            self.on_slide_select()
            self.autosave()

        def del_slide(self):
            if self.cur_slide is None:
                return
            del self.slides[self.cur_slide]
            self.cur_slide = None
            self.refresh_slides()
            self.fill_library()
            self.autosave()

        def move_slide(self, delta):
            i = self.cur_slide
            if i is None:
                return
            j = i + delta
            if not (0 <= j < len(self.slides)):
                return
            self.slides[i], self.slides[j] = self.slides[j], self.slides[i]
            self.cur_slide = j
            self.refresh_slides()
            self.slide_lb.selection_set(j)
            self.on_slide_select()
            self.autosave()

        def refresh_slides(self):
            self.slide_lb.delete(0, "end")
            for i, s in enumerate(self.slides):
                cap = s["cols"] * s["rows"]
                self.slide_lb.insert(
                    "end", f"슬라이드 {i+1}  ({s['cols']}×{s['rows']})  "
                           f"{len(s['items'])}/{cap}")
            self.refresh_checks() if self.tree.get_children() else None

        def on_slide_select(self):
            sel = self.slide_lb.curselection()
            if not sel:
                self.cur_slide = None
                return
            self.cur_slide = sel[0]
            s = self.slides[self.cur_slide]
            self.cols_var.set(s["cols"])
            self.rows_var.set(s["rows"])
            self.fill_slide_items()

        def apply_grid(self):
            if self.cur_slide is None:
                return
            s = self.slides[self.cur_slide]
            s["cols"] = self.cols_var.get()
            s["rows"] = self.rows_var.get()
            self.refresh_slides()
            self.slide_lb.selection_set(self.cur_slide)
            self.fill_slide_items()
            self.autosave()

        def fill_slide_items(self):
            self.slide_items.delete(0, "end")
            if self.cur_slide is None:
                self.cap_lbl.config(text="")
                return
            s = self.slides[self.cur_slide]
            cap = s["cols"] * s["rows"]
            self.cap_lbl.config(text=f"최대 {cap}개")
            for key in s["items"]:
                it = self.store.get(key)
                self.slide_items.insert("end", it.name if it else str(key))

        def add_to_slide(self):
            if self.cur_slide is None:
                messagebox.showinfo("알림", "먼저 오른쪽에서 슬라이드를 선택(또는 추가)하세요.")
                return
            s = self.slides[self.cur_slide]
            cap = s["cols"] * s["rows"]
            added = 0
            for key in self._selected_keys():
                if len(s["items"]) >= cap:
                    messagebox.showinfo("가득 참",
                                        f"이 슬라이드는 최대 {cap}개입니다. {added}개만 추가됨.")
                    break
                if key not in s["items"]:
                    s["items"].append(key)
                    added += 1
            self.refresh_slides()
            self.slide_lb.selection_set(self.cur_slide)
            self.fill_slide_items()
            self.fill_library()
            self.autosave()
            self.status.set(f"{added}개 품목을 슬라이드 {self.cur_slide+1}에 추가")

        def remove_from_slide(self):
            if self.cur_slide is None:
                return
            sel = list(self.slide_items.curselection())
            if not sel:
                return
            s = self.slides[self.cur_slide]
            for idx in sorted(sel, reverse=True):
                del s["items"][idx]
            self.refresh_slides()
            self.slide_lb.selection_set(self.cur_slide)
            self.fill_slide_items()
            self.fill_library()
            self.autosave()

        def move_item(self, delta):
            if self.cur_slide is None:
                return
            sel = self.slide_items.curselection()
            if not sel:
                return
            i = sel[0]; j = i + delta
            s = self.slides[self.cur_slide]
            if not (0 <= j < len(s["items"])):
                return
            s["items"][i], s["items"][j] = s["items"][j], s["items"][i]
            self.fill_slide_items()
            self.slide_items.selection_set(j)
            self.autosave()

        # ---------------- 자동 저장 / 복원 ----------------
        def _state(self):
            return {
                "excel_path": self.excel_path,
                "text_mode": self.text_mode.get(),
                "name_pt": self.name_pt.get(),
                "use_title": self.use_title.get(),
                "slides": self.slides,
            }

        def autosave(self):
            try:
                save_project(self._state(), self.store)
                self.save_lbl.config(text="● 자동저장됨")
                self.after(1500, lambda: self.save_lbl.config(text=""))
            except Exception:
                pass

        def _restore(self):
            res = load_project()
            if not res:
                return
            state, store = res
            self.store = store
            self.excel_path = state.get("excel_path")
            self.text_mode.set(state.get("text_mode", "origin"))
            self.name_pt.set(state.get("name_pt", 14))
            self.use_title.set(state.get("use_title", False))
            self.slides = state.get("slides", [])
            # 썸네일 복원
            for key, it in store.items():
                if it.img_bytes and key not in self.thumbs:
                    try:
                        im = Image.open(io.BytesIO(it.img_bytes)).convert("RGB")
                        im.thumbnail((THUMB, THUMB))
                        self.thumbs[key] = im
                    except Exception:
                        pass
            # 라이브러리: 엑셀 있으면 시트 목록 복원
            if self.excel_path and os.path.exists(self.excel_path):
                try:
                    self.sheet_cb["values"] = list_sheets(self.excel_path)
                    if self.sheet_cb["values"]:
                        self.sheet_cb.current(0)
                        self.load_sheet()
                except Exception:
                    pass
            else:
                # 엑셀 없으면 캐시에 있는 품목 전부 라이브러리에 표시
                self.lib_keys = list(store.keys())
                self.fill_library()
            self.refresh_slides()
            self.status.set("이전 작업을 복원했습니다.")

        # ---------------- 내보내기 ----------------
        def export_ppt(self):
            if not self.slides or all(not s["items"] for s in self.slides):
                messagebox.showwarning("알림", "슬라이드에 품목을 먼저 추가하세요.")
                return
            path = filedialog.asksaveasfilename(
                title="PPT 저장", defaultextension=".pptx",
                filetypes=[("PowerPoint", "*.pptx")],
                initialfile="품목_카탈로그.pptx")
            if not path:
                return
            titles = None
            if self.use_title.get():
                titles = [self.sheet_cb.get() or ""] * len(self.slides)
            try:
                n = build_pptx(self.slides, self.store, path,
                               text_mode=self.text_mode.get(),
                               name_pt=self.name_pt.get(), titles=titles)
            except Exception as e:
                messagebox.showerror("오류", f"PPT 생성 실패:\n{e}")
                return
            self.status.set(f"완료: {n}개 슬라이드 → {path}")
            messagebox.showinfo("완료", f"{n}개 슬라이드 생성\n{path}")

    App().mainloop()


if __name__ == "__main__":
    run_gui()
