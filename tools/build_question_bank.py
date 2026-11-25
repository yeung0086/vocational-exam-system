#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从《【地区】【单位】家政培训考试题库.xlsx》重新生成考试题库。

规则：
- 只用单选题、多选题、判断题（不采用简答题）。
- 难度只保留“易/中”，不采用“难”，整体难度低于原题库。
- 共 100 题：单选 60、多选 25、判断 15。
- 单选题选项顺序重排，正确选项均匀分布在 A/B/C/D，且相邻题答案不重复。
- 多选题选项重排，正确项组合多样化，相邻题答案组合不重复。
- 判断题正确/错误交替排列，相邻题答案不重复。
- 章节顺序保持稳定，题目按章节归类。

用法：
    python tools/build_question_bank.py [题库.xlsx]

输出：
    questions.json（与 server.js 同目录）
"""

import argparse
import collections
import json
import os
import random
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit('缺少 openpyxl，请先执行：pip install openpyxl')

DEFAULT_XLSX = r'C:\Users\Administrator\Desktop\【地区】【单位】家政培训考试题库.xlsx'
OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'questions.json')

CHAPTER_ORDER = [
    '安全意识及防范',
    '家政服务前景与老龄化',
    '家政服务员行业分析',
    '课堂纪律',
    '养老护理',
    '老年人睡眠照料',
    '叩背排痰法',
    '初级家政服务大纲',
    '婴儿抚触操',
    '婴儿洗澡',
    '婴儿瓶喂与纸尿裤包被',
    '七步洗手法',
    '海姆立克急救法',
    '心源性猝死与心肺复苏',
    '血压计的使用',
    '测温枪的使用',
]
CAT_RANK = {c: i for i, c in enumerate(CHAPTER_ORDER)}

# 单选：全部“易”题 + 下列 28 道“中”题（覆盖各章节，避免偏科）
MEDIUM_SINGLE_NOS = {
    2, 15, 16,          # 安全意识及防范
    26, 33,             # 家政服务前景与老龄化
    36, 38,             # 家政服务员行业分析
    47,                 # 课堂纪律
    53, 58, 61,         # 养老护理
    69, 73,             # 老年人睡眠照料
    79, 82,             # 叩背排痰法
    90,                 # 初级家政服务大纲
    102,                # 婴儿抚触操
    109,                # 婴儿洗澡
    115, 117, 119,      # 婴儿瓶喂与纸尿裤包被
    129, 130, 132,      # 海姆立克急救法
    139, 140,           # 心源性猝死与心肺复苏
    148,                # 血压计的使用
    154,                # 测温枪的使用
}

# 多选只保留“易/中”题；去掉 5 道“全选”题，减少 ABCD 连续出现和全对题比例。
DROP_MULTI_NOS = {39, 41, 101, 116, 121}

# 判断题 16 道“易/中”题中，去掉 1 道“错误”题，使正确/错误为 7/8，可完全交替。
DROP_TF_NOS = {65}

RNG = random.Random(20261027)


def rewrite_letter_refs(text, opts):
    """把解析中的“A项 / B错误 / C不是……”改成引用选项原文，避免打乱选项后指代错误。"""
    def repl(m):
        letter = m.group(1)
        idx = ord(letter) - 65
        if 0 <= idx < len(opts):
            return '“' + opts[idx] + '”'
        return letter
    return re.sub(r'(?<![A-Za-z])([ABCD])(?=[\u4e00-\u9fff])', repl, text)


def parse_questions(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    questions = []

    for row in rows:
        if not row or row[0] is None:
            continue
        no = int(str(row[0]).strip())
        cat = str(row[1]).strip()
        typ = str(row[2]).strip()
        qtext = str(row[3]).strip()
        opts = [str(row[i]).strip() if row[i] is not None else '' for i in range(4, 8)]
        ans_raw = str(row[8]).strip()
        exp = str(row[9]).strip()
        diff = str(row[10]).strip()

        if typ not in ('单选题', '多选题', '判断题'):
            continue
        if not qtext or not exp or diff not in ('易', '中', '难'):
            raise ValueError(f'第 {no} 题字段不完整')

        if typ == '判断题':
            if ans_raw not in ('正确', '错误'):
                raise ValueError(f'第 {no} 题判断题答案无效：{ans_raw}')
            questions.append({
                'no': no, 'cat': cat, 'type': typ, 'q': qtext,
                'opts': [], 'ans_bool': ans_raw == '正确', 'exp': exp, 'diff': diff,
            })
            continue

        if any(not o for o in opts):
            raise ValueError(f'第 {no} 题选项不足 4 个')

        if typ == '单选题':
            if ans_raw not in ('A', 'B', 'C', 'D'):
                raise ValueError(f'第 {no} 题单选题答案无效：{ans_raw}')
            ans_idx = ord(ans_raw) - 65
            if ans_idx >= len(opts):
                raise ValueError(f'第 {no} 题答案超出选项范围')
            questions.append({
                'no': no, 'cat': cat, 'type': typ, 'q': qtext,
                'opts': opts, 'ans_idx': ans_idx, 'exp': exp, 'diff': diff,
            })
        else:
            if not ans_raw or any(c not in 'ABCD' for c in ans_raw) or len(set(ans_raw)) != len(ans_raw):
                raise ValueError(f'第 {no} 题多选题答案无效：{ans_raw}')
            ans_idx = sorted(ord(c) - 65 for c in ans_raw)
            if any(i >= len(opts) for i in ans_idx):
                raise ValueError(f'第 {no} 题答案超出选项范围')
            questions.append({
                'no': no, 'cat': cat, 'type': typ, 'q': qtext,
                'opts': opts, 'ans_idx': ans_idx, 'exp': exp, 'diff': diff,
            })

    if not questions:
        raise ValueError('未读取到题目')

    for q in questions:
        if q['type'] != '判断题':
            q['exp'] = rewrite_letter_refs(q['exp'], q['opts'])
    return questions


def make_single_answer_sequence(n, fixed_index, fixed_letter='D',
                                counts=None):
    """生成一个无相邻重复的答案字母序列，并保证 fixed_index 处为 fixed_letter。"""
    if counts is None:
        base, extra = divmod(n, 4)
        counts = {chr(65 + i): base + (1 if i < extra else 0) for i in range(4)}
    if sum(counts.values()) != n:
        raise ValueError('答案数量与题目数量不一致')

    for _ in range(20000):
        remain = dict(counts)
        seq = []
        prev = None
        ok = True
        for _i in range(n):
            cand = [c for c in 'ABCD' if remain[c] > 0 and c != prev]
            if not cand:
                ok = False
                break
            max_remain = max(remain[c] for c in cand)
            top = [c for c in cand if remain[c] == max_remain]
            c = RNG.choice(top)
            seq.append(c)
            remain[c] -= 1
            prev = c
        if ok and len(seq) == n and seq[fixed_index] == fixed_letter:
            return seq
    raise RuntimeError('无法生成满足条件的单选答案序列')


def arrange_singles(singles):
    singles = sorted(singles, key=lambda x: (CAT_RANK[x['cat']], x['no']))
    fixed_index = next((i for i, q in enumerate(singles) if q['no'] == 32), None)
    if fixed_index is None:
        raise ValueError('单选题中缺少第 32 题，无法固定“以上全部都是”选项')

    # 第 32 题的正确选项是“以上全部都是”，必须保持在 D 位。
    if singles[fixed_index]['ans_idx'] != 3:
        raise ValueError('第 32 题正确答案不是 D，无法保持选项顺序')

    seq = make_single_answer_sequence(len(singles), fixed_index)
    for q, letter in zip(singles, seq):
        target = ord(letter) - 65
        if q['no'] == 32:
            new_opts = list(q['opts'])
        else:
            correct = q['opts'][q['ans_idx']]
            wrong = [o for i, o in enumerate(q['opts']) if i != q['ans_idx']]
            RNG.shuffle(wrong)
            new_opts = list(wrong)
            new_opts.insert(target, correct)
        if len(new_opts) != 4 or len(set(new_opts)) != 4:
            raise ValueError(f"第 {q['no']} 题选项重排异常")
        q['opts'] = new_opts
        q['ans_idx'] = target
    return singles


def arrange_multis(multis):
    multis = sorted(multis, key=lambda x: (CAT_RANK[x['cat']], x['no']))
    all_correct = [q for q in multis if len(q['ans_idx']) == 4]
    others = [q for q in multis if len(q['ans_idx']) != 4]

    # 13 道“全对”题与 17 道非全对题交替，避免连续出现 ABCD。
    ordered = []
    for i, q in enumerate(all_correct):
        ordered.append(q)
        if i < len(others):
            ordered.append(others[i])
    ordered.extend(others[len(all_correct):])

    used = collections.Counter()
    prev = None
    for q in ordered:
        k = len(q['ans_idx'])
        if k == 4:
            target = 'ABCD'
        elif k == 3:
            cand = [s for s in ('ABC', 'ABD', 'ACD', 'BCD') if s != prev]
            low = min(used[s] for s in cand)
            target = RNG.choice([s for s in cand if used[s] == low])
        elif k == 2:
            cand = [s for s in ('AB', 'AC', 'AD', 'BC', 'BD', 'CD') if s != prev]
            low = min(used[s] for s in cand)
            target = RNG.choice([s for s in cand if used[s] == low])
        else:
            raise ValueError(f"第 {q['no']} 题多选答案数量异常：{k}")

        correct = [q['opts'][i] for i in q['ans_idx']]
        wrong = [q['opts'][i] for i in range(4) if i not in q['ans_idx']]
        RNG.shuffle(correct)
        RNG.shuffle(wrong)
        new_opts = []
        ci = wi = 0
        for letter in 'ABCD':
            if letter in target:
                new_opts.append(correct[ci])
                ci += 1
            else:
                new_opts.append(wrong[wi])
                wi += 1
        if len(new_opts) != 4 or len(set(new_opts)) != 4:
            raise ValueError(f"第 {q['no']} 题选项重排异常")

        q['opts'] = new_opts
        q['ans_idx'] = [i for i, letter in enumerate('ABCD') if letter in target]
        q['target'] = target
        used[target] += 1
        prev = target

    for a, b in zip(ordered, ordered[1:]):
        if tuple(a['ans_idx']) == tuple(b['ans_idx']):
            raise ValueError(f"多选相邻答案重复：第 {a['no']} 题 / 第 {b['no']} 题")
    return ordered


def arrange_bools(bools):
    bools = sorted(bools, key=lambda x: (CAT_RANK[x['cat']], x['no']))
    wrong = [q for q in bools if not q['ans_bool']]
    right = [q for q in bools if q['ans_bool']]
    if len(wrong) != len(right) + 1:
        raise ValueError(f'判断题正确/错误数量不满足交替条件：{len(right)}/{len(wrong)}')
    ordered = []
    for i in range(len(right)):
        ordered.append(wrong[i])
        ordered.append(right[i])
    ordered.append(wrong[-1])
    for a, b in zip(ordered, ordered[1:]):
        if a['ans_bool'] == b['ans_bool']:
            raise ValueError(f"判断题相邻答案重复：第 {a['no']} 题 / 第 {b['no']} 题")
    return ordered


def to_output(q):
    item = {
        'cat': q['cat'],
        'type': {'单选题': 'choice', '多选题': 'multi', '判断题': 'bool'}[q['type']],
        'q': q['q'],
    }
    if q['type'] != '判断题':
        item['o'] = q['opts']
    item['a'] = q['ans_bool'] if q['type'] == '判断题' else q['ans_idx']
    if q['type'] == '多选题':
        item['a'] = list(item['a'])
    item['e'] = q['exp']
    item['diff'] = q['diff']
    item['no'] = q['no']
    return item


def validate(final):
    if len(final) != 100:
        raise ValueError(f'题目总数不是 100：{len(final)}')
    types = collections.Counter(q['type'] for q in final)
    if types != {'choice': 60, 'multi': 25, 'bool': 15}:
        raise ValueError(f'题型数量不符合要求：{types}')
    diffs = collections.Counter(q['diff'] for q in final)
    if diffs != {'易': 50, '中': 50}:
        raise ValueError(f'难度数量不符合要求：{diffs}')

    prev = {}
    for q in final:
        t = q['type']
        if t == 'choice':
            if not isinstance(q['a'], int) or not 0 <= q['a'] <= 3:
                raise ValueError(f"单选答案无效：第 {q['no']} 题")
            if t in prev and prev[t] == q['a']:
                raise ValueError(f"单选相邻答案重复：第 {q['no']} 题")
            prev[t] = q['a']
        elif t == 'multi':
            if not isinstance(q['a'], list) or not q['a'] or any(not isinstance(i, int) or not 0 <= i <= 3 for i in q['a']):
                raise ValueError(f"多选答案无效：第 {q['no']} 题")
            key = tuple(q['a'])
            if t in prev and prev[t] == key:
                raise ValueError(f"多选相邻答案重复：第 {q['no']} 题")
            prev[t] = key
        else:
            if not isinstance(q['a'], bool):
                raise ValueError(f"判断答案无效：第 {q['no']} 题")
            if t in prev and prev[t] == q['a']:
                raise ValueError(f"判断相邻答案重复：第 {q['no']} 题")
            prev[t] = q['a']

        if t != 'bool':
            opts = q.get('o', [])
            if len(opts) != 4 or len(set(opts)) != 4 or any(not o for o in opts):
                raise ValueError(f"选项异常：第 {q['no']} 题")

    texts = [q['q'] for q in final]
    if len(set(texts)) != len(texts):
        raise ValueError('存在重复题干')


def main():
    parser = argparse.ArgumentParser(description='从 Excel 重新生成家政考试题库')
    parser.add_argument('xlsx', nargs='?', default=DEFAULT_XLSX, help='题库 Excel 路径')
    args = parser.parse_args()

    questions = parse_questions(args.xlsx)
    easy_singles = [q for q in questions if q['type'] == '单选题' and q['diff'] == '易']
    medium_singles = [q for q in questions if q['type'] == '单选题' and q['no'] in MEDIUM_SINGLE_NOS]
    multis = [q for q in questions if q['type'] == '多选题' and q['diff'] in ('易', '中') and q['no'] not in DROP_MULTI_NOS]
    bools = [q for q in questions if q['type'] == '判断题' and q['diff'] in ('易', '中') and q['no'] not in DROP_TF_NOS]

    if len(easy_singles) != 32:
        raise ValueError(f'易单选数量异常：{len(easy_singles)}')
    if len(medium_singles) != 28:
        raise ValueError(f'中单选数量异常：{len(medium_singles)}')
    if len(multis) != 25:
        raise ValueError(f'易/中多选数量异常：{len(multis)}')
    if len(bools) != 15:
        raise ValueError(f'易/中判断数量异常：{len(bools)}')

    singles = arrange_singles(easy_singles + medium_singles)
    ordered_multis = arrange_multis(multis)
    ordered_bools = arrange_bools(bools)

    final = [to_output(q) for q in singles + ordered_multis + ordered_bools]
    validate(final)

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(final, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print('题库已生成：' + OUT_PATH)
    print('题型：单选 %d / 多选 %d / 判断 %d' % (
        sum(1 for q in final if q['type'] == 'choice'),
        sum(1 for q in final if q['type'] == 'multi'),
        sum(1 for q in final if q['type'] == 'bool'),
    ))
    print('难度：易 %d / 中 %d' % (
        sum(1 for q in final if q['diff'] == '易'),
        sum(1 for q in final if q['diff'] == '中'),
    ))
    print('单选答案序列：' + ''.join(chr(65 + q['a']) for q in final if q['type'] == 'choice'))
    print('多选答案序列：' + ' '.join(''.join(chr(65 + i) for i in q['a']) for q in final if q['type'] == 'multi'))
    print('判断答案序列：' + ' '.join('对' if q['a'] else '错' for q in final if q['type'] == 'bool'))


if __name__ == '__main__':
    main()
