#!/usr/bin/env python3
"""把常见文档转成纯文本，给 agent 读。

用法：
    doc-read.py <文件路径> [--max 字符数] [--sheet 名]

支持：.pdf .docx .xlsx .pptx .csv .txt .md .json
输出：纯文本到 stdout，不写文件。
"""
import argparse
import csv
import io
import json
import sys
from pathlib import Path


def read_pdf(p):
    from pypdf import PdfReader
    r = PdfReader(str(p))
    return "\n".join((page.extract_text() or "") for page in r.pages)


def read_docx(p):
    from docx import Document
    d = Document(str(p))
    parts = [para.text for para in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def read_xlsx(p, sheet):
    from openpyxl import load_workbook
    wb = load_workbook(str(p), read_only=True, data_only=True)
    name = sheet or wb.sheetnames[0]
    ws = wb[name]
    out = [f"# 工作表：{name}"]
    for row in ws.iter_rows(values_only=True):
        out.append("\t".join("" if c is None else str(c) for c in row))
    return "\n".join(out)


def read_pptx(p):
    from pptx import Presentation
    prs = Presentation(str(p))
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f"--- 第 {i} 页 ---")
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    parts.append(t)
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--max", type=int, default=12000)
    ap.add_argument("--sheet", default="")
    args = ap.parse_args()

    p = Path(args.file)
    if not p.exists():
        print(f"文件不存在：{p}", file=sys.stderr)
        sys.exit(1)

    ext = p.suffix.lower()
    try:
        if ext == ".pdf":
            text = read_pdf(p)
        elif ext == ".docx":
            text = read_docx(p)
        elif ext == ".xlsx":
            text = read_xlsx(p, args.sheet)
        elif ext == ".pptx":
            text = read_pptx(p)
        elif ext == ".csv":
            text = p.read_text(encoding="utf-8", errors="replace")
        elif ext in (".txt", ".md", ".log", ".py", ".js", ".json", ".jsonl", ".yml", ".yaml"):
            text = p.read_text(encoding="utf-8", errors="replace")
        elif ext == ".doc":
            print("老式 .doc 需要转成 .docx（WPS/Word 另存为即可）", file=sys.stderr)
            sys.exit(2)
        else:
            print(f"不认识的类型：{ext}", file=sys.stderr)
            sys.exit(2)
    except Exception as e:
        print(f"读取失败：{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(3)

    text = text or "(这个文件里没有文字，可能全是图片/扫描件)"
    if len(text) > args.max:
        text = text[: args.max] + f"\n…(已截断，全文 {len(text)} 字)"
    print(text)


if __name__ == "__main__":
    main()
