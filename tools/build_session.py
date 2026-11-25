#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
培训考试系统 · 通用场次转换器（六表工作簿 ↔ 三份 JSON）

用法：
  1) 首次生成模板（从现有 students.json / questions.json / session.json 反推）
         python tools/build_session.py --init
     产出：场次包/场次配置.xlsx（六个 sheet）

  2) 日常换场次：编辑 Excel 后运行（或双击 场次包/一键更新.bat）
         python tools/build_session.py 场次配置.xlsx --out <目录> [--out <目录2> ...]
     产出：students.json / questions.json / session.json

只需维护一份 Excel；server.js / 云端表 / SEA 打包链不动。
兼容旧版三表模板（场次信息 / 名单 / 题库），缺省的单位、主题、清单表走默认值。
依赖：openpyxl（python -m pip install openpyxl）

红线：题库「行序」就是服务端判分顺序（shuffle=false 时），请勿排序 / 删行 / 插行。
"""

import argparse
import json
import os
import sys

try:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
except ImportError:
    sys.exit('缺少 openpyxl，请执行：\n  python -m pip install openpyxl '
             '-i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                     # 工程源码/
BASE = os.path.dirname(ROOT)                     # 培训考试系统/
DEFAULT_TEMPLATE = os.path.join(BASE, '场次包', '场次配置.xlsx')

BACKUP_NAMES = ('备用账号1', '备用账号2')
SKIP_WORDS = ('备用', '测试')

TYPE_CN2JSON = {'单选题': 'choice', '多选题': 'multi', '判断题': 'bool'}
TYPE_JSON2CN = {v: k for k, v in TYPE_CN2JSON.items()}

# 六表表头
INFO_HEADER = ['字段', '值', '说明']
ORG_HEADER = ['字段', '值', '说明']
ROSTER_HEADER = ['序号', '姓名', '备注']
QUESTION_HEADER = ['题号', '专业/工种', '分类', '题型', '题干',
                   '选项A', '选项B', '选项C', '选项D', '答案', '解析', '难度', '分值']
THEME_HEADER = ['主题编号', '主题名称', '主色', '辅色', '适用端', '备注']
LIST_HEADER = ['场次编号', '名称', '考试日期', '名单来源', '题库来源', '主题编号', '状态']

# 预置 5 套主题（阶段五前端按主题编号注入 CSS 变量；表先就位）
PRESET_THEMES = [
    ['T1', '政务深蓝', '#1F4E79', '#2E75B6', '通用', '大屏默认，正式汇报'],
    ['T2', '护眼青绿', '#079E61', '#E8F5EF', '学员端', '长时间答题不刺眼（现行默认）'],
    ['T3', '暖橙家政', '#E8833A', '#FBEFE3', '通用', '亲和，家政/烹饪班次'],
    ['T4', '暗夜霓虹', '#1B1F3B', '#38E1C6', '大屏', '深色科技风，展示场合'],
    ['T5', '素白纸卷', '#333333', '#F5F1E8', '通用', '明亮机房、打印友好'],
]

# 场次信息字段：(键, 默认值, 说明)；旧模板字段名作兼容别名
INFO_FIELDS = [
    ('系统标题', '家政服务员理论考试系统', '学员端 / 大屏 / 分享页标题'),
    ('场次编号', '2026-11-【地区】【地区】家政-01', '归档标识，同时作为导出文件名前缀'),
    ('考试日期', '', 'YYYY-MM-DD，可空；阶段四定时门禁使用'),
    ('开考时间', '', 'HH:MM，可空；阶段四定时门禁使用'),
    ('收卷时间', '', 'HH:MM，可空；阶段四定时门禁使用'),
    ('时长(秒)', 3600, '单次答题时长上限，默认 1 小时'),
    ('及格线(%)', 60, '大屏及格率统计口径'),
    ('每人最多次数', 2, '重考次数由管理员人工把关'),
    ('学员进入口令', 'CHANGE_ME', '学员端进入口令'),
    ('管理端口令', 'CHANGE_ME', '大屏登录口令；仅服务端使用，不下发前端'),
    ('主题编号', 'T2', '对应「主题配置」表，T1~T5'),
    ('备注', '', '可选'),
]

# 单位信息字段：(键, 默认值, 说明)；兼容旧「单位 / 学校/承办 / 专业/工种」
ORG_FIELDS = [
    ('项目单位', '【地区】【地区】家政服务', '副标题主项'),
    ('培训学校', '【地区】市【单位】【单位】【单位】', '可选，追加到副标题'),
    ('专业/工种', '家政服务员', '可选，追加到副标题'),
    ('主办单位', '', '可选，仅台账留存'),
    ('承办单位', '', '可选，仅台账留存'),
    ('班次名称', '2026-11-【地区】【地区】家政-01', '归档/台账用'),
    ('地区', '', '可选，仅台账留存'),
]


# --------------------------------------------------------------------------
# 样式辅助
# --------------------------------------------------------------------------

def _style_header(ws, width_map):
    fill = PatternFill('solid', fgColor='1F4E79')
    for cell in ws[1]:
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = fill
        cell.alignment = Alignment(horizontal='center', vertical='center')
    ws.freeze_panes = 'A2'
    for col, width in width_map.items():
        ws.column_dimensions[col].width = width
    ws.row_dimensions[1].height = 22


def _header_map(ws):
    """按表头名取列索引（0 基），兼容新旧列顺序。"""
    m = {}
    for idx, cell in enumerate(ws[1]):
        if cell.value is not None:
            m[str(cell.value).strip()] = idx
    return m


def _row_values(ws):
    for row in ws.iter_rows(min_row=2, values_only=True):
        yield row


# --------------------------------------------------------------------------
# 模板生成（--init）
# --------------------------------------------------------------------------

def make_template(path):
    with open(os.path.join(ROOT, 'students.json'), encoding='utf-8') as f:
        students = json.load(f)
    with open(os.path.join(ROOT, 'questions.json'), encoding='utf-8') as f:
        questions = json.load(f)
    session = {}
    sess_path = os.path.join(ROOT, 'session.json')
    if os.path.exists(sess_path):
        try:
            with open(sess_path, encoding='utf-8') as f:
                session = json.load(f)
        except (ValueError, OSError):
            session = {}

    wb = openpyxl.Workbook()

    # Sheet 1：场次信息
    ws = wb.active
    ws.title = '场次信息'
    ws.append(INFO_HEADER)
    defaults = {k: v for k, v, _ in INFO_FIELDS}
    # 用现有 session 值回填默认
    backfill = {
        '系统标题': session.get('title', defaults['系统标题']),
        '场次编号': session.get('batch', defaults['场次编号']),
        '时长(秒)': session.get('timeLimitSec', defaults['时长(秒)']),
        '及格线(%)': session.get('passRate', defaults['及格线(%)']),
        '每人最多次数': session.get('maxAttempts', defaults['每人最多次数']),
        '学员进入口令': session.get('studentPassword', defaults['学员进入口令']),
        '管理端口令': session.get('adminPassword', defaults['管理端口令']),
        '主题编号': session.get('themeId', defaults['主题编号']),
    }
    for k, v, note in INFO_FIELDS:
        ws.append([k, backfill.get(k, v), note])
    _style_header(ws, {'A': 18, 'B': 32, 'C': 48})
    for row in ws.iter_rows(min_row=2, max_row=1 + len(INFO_FIELDS)):
        row[0].font = Font(bold=True)
        row[1].fill = PatternFill('solid', fgColor='FFF2CC')

    # Sheet 2：单位信息
    ws_org = wb.create_sheet('单位信息')
    ws_org.append(ORG_HEADER)
    org_backfill = {
        '项目单位': session.get('unit', defaults.get('项目单位', '')),
        '培训学校': session.get('school', defaults.get('培训学校', '')),
        '专业/工种': session.get('major', defaults.get('专业/工种', '')),
        '班次名称': session.get('batch', defaults.get('班次名称', '')),
    }
    for k, v, note in ORG_FIELDS:
        ws_org.append([k, org_backfill.get(k, v), note])
    _style_header(ws_org, {'A': 18, 'B': 32, 'C': 48})
    for row in ws_org.iter_rows(min_row=2, max_row=1 + len(ORG_FIELDS)):
        row[0].font = Font(bold=True)
        row[1].fill = PatternFill('solid', fgColor='FFF2CC')

    # Sheet 3：名单（备用账号不写入，转换器自动追加）
    ws2 = wb.create_sheet('名单')
    ws2.append(ROSTER_HEADER)
    real = [n for n in students if n not in BACKUP_NAMES]
    for i, name in enumerate(real, 1):
        ws2.append([i, name, ''])
    _style_header(ws2, {'A': 10, 'B': 20, 'C': 24})

    # Sheet 4：题库（行序 = 判分顺序）
    ws3 = wb.create_sheet('题库')
    ws3.append(QUESTION_HEADER)
    for q in questions:
        typ = TYPE_JSON2CN[q['type']]
        opts = q.get('o', ['正确', '错误', '', ''])
        if q['type'] == 'bool':
            ans = '正确' if q['a'] else '错误'
        elif q['type'] == 'choice':
            ans = chr(65 + q['a'])
        else:
            ans = ','.join(chr(65 + i) for i in q['a'])
        ws3.append([q['no'], q.get('major', ''), q['cat'], typ, q['q'],
                    opts[0], opts[1], opts[2], opts[3],
                    ans, q['e'], q.get('diff', '易'), q.get('score', 1)])
    _style_header(ws3, {'A': 8, 'B': 16, 'C': 22, 'D': 10, 'E': 48,
                        'F': 20, 'G': 20, 'H': 20, 'I': 20, 'J': 12,
                        'K': 48, 'L': 10, 'M': 8})
    for col in ('E', 'K'):
        for row in ws3.iter_rows(min_row=2, min_col=openpyxl.utils.column_index_from_string(col),
                                max_col=openpyxl.utils.column_index_from_string(col)):
            row[0].alignment = Alignment(wrap_text=True, vertical='top')

    dv_type = DataValidation(type='list', formula1='"单选题,多选题,判断题"', allow_blank=False)
    dv_type.error = '题型只能是 单选题 / 多选题 / 判断题'
    dv_type.errorTitle = '题型不合法'
    dv_type.showErrorMessage = True
    ws3.add_data_validation(dv_type)
    dv_type.add('D2:D2000')

    dv_diff = DataValidation(type='list', formula1='"易,中,难"', allow_blank=False)
    dv_diff.showErrorMessage = True
    ws3.add_data_validation(dv_diff)
    dv_diff.add('L2:L2000')

    # Sheet 5：主题配置（预置，阶段五接入）
    ws5 = wb.create_sheet('主题配置')
    ws5.append(THEME_HEADER)
    for t in PRESET_THEMES:
        ws5.append(t)
    _style_header(ws5, {'A': 10, 'B': 14, 'C': 12, 'D': 12, 'E': 10, 'F': 30})

    # Sheet 6：场次清单（台账，不参与生成）
    ws6 = wb.create_sheet('场次清单')
    ws6.append(LIST_HEADER)
    ws6.append([session.get('batch', ''), session.get('title', ''),
                session.get('examDate', ''), '名单', '题库',
                session.get('themeId', 'T2'), '现行'])
    _style_header(ws6, {'A': 22, 'B': 24, 'C': 12, 'D': 12, 'E': 12, 'F': 10, 'G': 10})

    wb.save(path)


# --------------------------------------------------------------------------
# 读取 Excel → 三份 JSON
# --------------------------------------------------------------------------

def _read_kv(ws, aliases=None):
    """读字段/值两列；aliases: 标准键 -> 旧模板别名列表。"""
    info = {}
    aliases = aliases or {}
    for row in _row_values(ws):
        if not row or len(row) < 2 or row[0] is None:
            continue
        key = str(row[0]).strip()
        val = '' if row[1] is None else str(row[1]).strip()
        if key:
            info[key] = val
    # 旧别名归一
    for std, old_list in aliases.items():
        if std not in info:
            for old in old_list:
                if old in info:
                    info[std] = info[old]
                    break
    return info


def read_roster(ws):
    names, seen = [], set()
    hm = _header_map(ws)
    name_col = hm.get('姓名', 1)
    no_col = hm.get('序号', 0)
    for row in _row_values(ws):
        if not row:
            continue
        no = row[no_col] if no_col < len(row) else None
        name = row[name_col] if name_col < len(row) else None
        if no is None or not str(no).strip().isdigit():
            continue
        name = str(name).strip() if name is not None else ''
        if not name or any(w in name for w in SKIP_WORDS):
            continue
        if name in seen:
            raise ValueError('「名单」sheet 存在重名学员：' + name)
        seen.add(name)
        names.append(name)
    if not names:
        raise ValueError('「名单」sheet 未读到学员，检查 序号 / 姓名 列')
    for backup in BACKUP_NAMES:
        if backup not in seen:
            seen.add(backup)
            names.append(backup)
    return names


def read_questions(ws):
    hm = _header_map(ws)
    def col(name, default):
        return hm.get(name, default)

    c_no = col('题号', 0)
    c_major = col('专业/工种', None)
    c_cat = col('分类', 1 if c_major is None else 2)
    c_type = col('题型', 2 if c_major is None else 3)
    c_q = col('题干', 3 if c_major is None else 4)
    c_opts = [col('选项A', 4), col('选项B', 5), col('选项C', 6), col('选项D', 7)]
    # 旧模板无专业/工种/分值列时，选项与答案列前移
    if c_major is None:
        c_opts = [4, 5, 6, 7]
    c_ans = col('答案', 8 if c_major is None else 9)
    c_exp = col('解析', 9 if c_major is None else 10)
    c_diff = col('难度', 10 if c_major is None else 11)
    c_score = col('分值', None)

    out, nos = [], set()
    for lineno, row in enumerate(_row_values(ws), start=2):
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue
        def at(i):
            return row[i] if i is not None and i < len(row) else None

        no = at(c_no)
        major = str(at(c_major) or '').strip() if c_major is not None else ''
        cat = str(at(c_cat) or '').strip()
        typ = str(at(c_type) or '').strip()
        qtext = str(at(c_q) or '').strip()
        opts = [str(at(j) or '').strip() for j in c_opts]
        ans = str(at(c_ans) or '').strip()
        exp = str(at(c_exp) or '').strip()
        diff = str(at(c_diff) or '').strip()
        score_raw = at(c_score) if c_score is not None else None

        if no is None or str(no).strip() == '':
            raise ValueError('「题库」第 %d 行缺题号' % lineno)
        try:
            no_i = int(float(str(no).strip()))
        except ValueError:
            raise ValueError('「题库」第 %d 行题号不是数字' % lineno)
        if no_i in nos:
            raise ValueError('「题库」第 %d 行题号重复：%d' % (lineno, no_i))
        nos.add(no_i)

        if typ not in TYPE_CN2JSON:
            raise ValueError('「题库」第 %d 行题型不合法：%s' % (lineno, typ or '空'))
        if not cat or not qtext or not exp:
            raise ValueError('「题库」第 %d 行 分类 / 题干 / 解析 不能为空' % lineno)

        t = TYPE_CN2JSON[typ]
        item = {'cat': cat, 'type': t, 'q': qtext}
        if major:
            item['major'] = major
        if t == 'bool':
            if ans not in ('正确', '错误'):
                raise ValueError('「题库」第 %d 行判断题答案须为 正确/错误，当前：%s' % (lineno, ans))
            item['a'] = (ans == '正确')
        else:
            if any(not o for o in opts):
                raise ValueError('「题库」第 %d 行选项不足 4 个' % lineno)
            item['o'] = opts
            letters = [c.strip().upper() for c in ans.replace('，', ',').split(',') if c.strip()]
            if not letters or any(c not in 'ABCD' for c in letters) or len(set(letters)) != len(letters):
                raise ValueError('「题库」第 %d 行答案格式错误：%s' % (lineno, ans or '空'))
            idxs = sorted(ord(c) - 65 for c in letters)
            if t == 'choice':
                if len(idxs) != 1:
                    raise ValueError('「题库」第 %d 行单选题答案须为单个字母' % lineno)
                item['a'] = idxs[0]
            else:
                if len(idxs) < 2:
                    raise ValueError('「题库」第 %d 行多选题答案至少 2 个字母' % lineno)
                item['a'] = idxs
        item['e'] = exp
        item['diff'] = diff or '易'
        # 分值：空值默认 1；当前判分按题计，分值字段为后续加权预留
        try:
            item['score'] = int(float(str(score_raw).strip())) if score_raw not in (None, '') else 1
        except (ValueError, TypeError):
            raise ValueError('「题库」第 %d 行分值不是数字：%s' % (lineno, score_raw))
        item['no'] = no_i
        out.append(item)
    if not out:
        raise ValueError('「题库」sheet 未读到题目')
    return out


def read_themes(ws):
    """读主题配置，返回 {编号: 行数据}；仅用于校验主题编号合法。"""
    themes = {}
    if ws is None:
        return themes
    for row in _row_values(ws):
        if not row or not row[0]:
            continue
        themes[str(row[0]).strip()] = [str(v).strip() if v is not None else '' for v in row[1:6]]
    return themes


def build_session(info, org):
    def s(d, key, default=''):
        return str(d.get(key, default)).strip()

    def n(d, key, default):
        try:
            return int(float(str(d.get(key, default)).strip()))
        except (ValueError, TypeError):
            return default

    unit = s(org, '项目单位') or s(info, '单位')
    school = s(org, '培训学校') or s(info, '学校/承办')
    major = s(org, '专业/工种') or s(info, '专业/工种')
    batch = s(info, '场次编号') or s(org, '班次名称')
    subtitle = ' · '.join(x for x in (unit, school, major) if x)

    theme_id = s(info, '主题编号', 'T2')
    session = {
        'title': s(info, '系统标题') or '培训考试系统',
        'unit': unit,
        'school': school,
        'major': major,
        'batch': batch,
        'subtitle': subtitle,
        'examDate': s(info, '考试日期'),
        'startTime': s(info, '开考时间'),
        'endTime': s(info, '收卷时间'),
        'themeId': theme_id,
        'studentPassword': s(info, '学员进入口令', 'CHANGE_ME'),
        'adminPassword': s(info, '管理端口令', 'CHANGE_ME'),
        'timeLimitSec': n(info, '时长(秒)', 3600),
        'passRate': n(info, '及格线(%)', 60),
        'maxAttempts': n(info, '每人最多次数', 2),
        'requireStudentPw': True,
        'exportPrefix': batch or '考试成绩',
        # ---- v3.0 引擎配置（Excel 不暴露，换场次时保留上次自定义值）----
        'schemaVersion': 3,
        'sessionId': batch or 'default',
        'questionPolicy': {'mode': 'all', 'sampleSize': None, 'shuffle': False, 'seed': ''},
        'security': {
            'revealMode': 'server', 'proctorEnabled': True,
            'blurThresholdSec': 3, 'blurFlagCount': 3,
            'maxLoginPerMinute': 5, 'maxRevealPerSecond': 6
        },
        'offline': {'serviceWorker': True, 'outbox': True, 'replayBatchSize': 20},
        'cloud': {'partitionBySession': False},
    }
    # 单位信息中的台账字段（不进引擎逻辑，留存备查）
    for k in ('主办单位', '承办单位', '地区'):
        v = s(org, k)
        if v:
            session[k] = v
    return session


V3_KEYS = ('schemaVersion', 'questionPolicy', 'security', 'offline', 'cloud')


def write_outputs(students, questions, session, outs):
    files = (
        ('students.json', students),
        ('questions.json', questions),
        ('session.json', session),
    )
    for directory in outs:
        os.makedirs(directory, exist_ok=True)
        # 保留该目录已有的 v3 引擎配置，避免换场次把安全/离线参数重置
        prev_path = os.path.join(directory, 'session.json')
        if os.path.exists(prev_path):
            try:
                with open(prev_path, encoding='utf-8') as pf:
                    prev = json.load(pf)
                for key in V3_KEYS:
                    if key in prev:
                        session[key] = prev[key]
            except (ValueError, OSError):
                pass
        for filename, obj in files:
            with open(os.path.join(directory, filename), 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
                f.write('\n')
        print('  已写入 -> ' + directory)


def main():
    ap = argparse.ArgumentParser(description='培训考试系统：六表 Excel ↔ 场次数据')
    ap.add_argument('xlsx', nargs='?', default=DEFAULT_TEMPLATE, help='场次配置.xlsx 路径')
    ap.add_argument('--out', action='append', default=None,
                    help='输出目录，可重复指定（工程源码 / 应用程序）')
    ap.add_argument('--init', action='store_true', help='从现有 JSON 反推生成 Excel 模板')
    ap.add_argument('--force', action='store_true', help='--init 时允许覆盖已存在的模板')
    args = ap.parse_args()

    if args.init:
        if os.path.exists(DEFAULT_TEMPLATE) and not args.force:
            sys.exit('模板已存在，未覆盖：' + DEFAULT_TEMPLATE + '\n（如需重建请加 --force）')
        os.makedirs(os.path.dirname(DEFAULT_TEMPLATE), exist_ok=True)
        make_template(DEFAULT_TEMPLATE)
        print('模板已生成：' + DEFAULT_TEMPLATE)
        return

    if not os.path.exists(args.xlsx):
        sys.exit('找不到 Excel：' + args.xlsx + '\n（首次使用请先执行 --init 生成模板）')

    wb = openpyxl.load_workbook(args.xlsx, data_only=True)
    missing = {'场次信息', '名单', '题库'} - set(wb.sheetnames)
    if missing:
        sys.exit('Excel 缺少 sheet：' + '、'.join(sorted(missing)))

    info = _read_kv(wb['场次信息'], {
        '单位': ['单位'], '学校/承办': ['学校/承办', '学校'], '专业/工种': ['专业/工种', '专业']
    })
    org = _read_kv(wb['单位信息']) if '单位信息' in wb.sheetnames else {}
    themes = read_themes(wb['主题配置']) if '主题配置' in wb.sheetnames else {}

    session = build_session(info, org)
    students = read_roster(wb['名单'])
    questions = read_questions(wb['题库'])

    # 主题编号合法性校验（主题表存在时）
    if themes and session['themeId'] not in themes:
        raise ValueError('主题编号 %s 不在「主题配置」表内：%s' %
                         (session['themeId'], '、'.join(themes.keys())))

    outs = [os.path.abspath(o) for o in (args.out or [ROOT])]
    write_outputs(students, questions, session, outs)

    types = {}
    for q in questions:
        types[q['type']] = types.get(q['type'], 0) + 1
    print('场次：%s' % session['title'])
    print('名单：%d 人（含 2 个备用账号，正式 %d 人）' % (len(students), len(students) - 2))
    print('题库：%d 题  单选 %d / 多选 %d / 判断 %d' % (
        len(questions), types.get('choice', 0), types.get('multi', 0), types.get('bool', 0)))
    print('主题：%s' % session['themeId'])
    print('提示：重启 exe / 服务后生效；换场次前请先导出成绩并备份本地 data.json（云端本轮冻结不动）。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, SystemExit) as e:
        print('[错误] ' + str(e))
        sys.exit(1)
