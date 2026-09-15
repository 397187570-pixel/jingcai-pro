#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bump_version.py — 竞彩智选 Pro 部署前版本戳升级

每日校准管道追加新赛果后，调用本脚本把 index.html 里的
`window.APP_VERSION` 与全部 `?v=...` 资源戳统一改为当天日期 YYYYMMDD，
使浏览器在下次部署后主动拉取新的 JS/CSS 与赛果数据（避免读旧快照）。

同日重复运行保持同值（幂等）。仅改版本戳字符串，不触碰业务逻辑。
"""
import re
import datetime
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent  # jingcai-pro/
INDEX = ROOT / "index.html"


def main():
    if not INDEX.exists():
        raise SystemExit(f"未找到 index.html: {INDEX}")
    s = INDEX.read_text(encoding="utf-8")
    ver = datetime.date.today().strftime("%Y%m%d")
    s = re.sub(r"window\.APP_VERSION = '[^']*'", f"window.APP_VERSION = '{ver}'", s)
    # 资源戳真实格式为 "?YYYYMMDDx"（仅 ? + 版本号，无 v=）
    s = re.sub(r"\?\d{8}[a-z]?", f"?{ver}", s)
    INDEX.write_text(s, encoding="utf-8")
    print("APP_VERSION ->", ver)


if __name__ == "__main__":
    main()
