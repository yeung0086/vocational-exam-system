#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⚠️ 历史工具（v1.0 单表导入），已被 tools/build_session.py 六表转换器取代，仅留痕不再维护。
   现行换名单/题库请走「场次包\场次配置.xlsx → 一键更新.bat」，不要直接调用本脚本。

从 Excel 花名册导入学员名单到 students.json。

- 读取第一个工作表，取“序号”列和“姓名”列。
- 自动跳过 Excel 中的“备用账号”“测试账号”等非正式学员行。
- 导入完成后固定追加 2 个备用账号（备用账号1、备用账号2），用于测试。
- 导入后重启服务，或在管理端执行一次“清空”使新名单生效。

用法（历史）：
    python tools/import_students.py "C:\\path\\学员名单.xlsx"
"""

import json
import os
import sys

try:
    import openpyxl
except ImportError:
    sys.exit('缺少 openpyxl，请先执行：pip install openpyxl')

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'students.json')
SKIP_WORDS = ('备用', '测试')
BACKUP_NAMES = ('备用账号1', '备用账号2')


def main():
    if len(sys.argv) < 2:
        sys.exit('用法：python tools/import_students.py <花名册.xlsx>')

    wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
    ws = wb.worksheets[0]
    names = []
    seen = set()
    for row in ws.iter_rows(values_only=True):
        if not row or len(row) < 2:
            continue
        no, name = row[0], row[1]
        if no is None or str(no).strip() == '' or not str(no).strip().isdigit():
            continue
        name = str(name).strip() if name is not None else ''
        if not name or any(w in name for w in SKIP_WORDS):
            continue
        if name in seen:
            raise SystemExit('名单中存在重名：' + name)
        seen.add(name)
        names.append(name)

    if not names:
        raise SystemExit('未读取到学员姓名，请检查 Excel 列顺序是否为：序号、姓名')

    # 正式学员之后追加固定备用账号：确保换名单时测试账号不会丢失
    for backup in BACKUP_NAMES:
        if backup not in seen:
            seen.add(backup)
            names.append(backup)

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(names, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print('已导入 %d 名正式学员 + %d 个备用账号：%s' % (len(names) - len(BACKUP_NAMES), len(BACKUP_NAMES), OUT_PATH))
    print('、'.join(names))


if __name__ == '__main__':
    main()
