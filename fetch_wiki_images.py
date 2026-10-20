# -*- coding: utf-8 -*-
"""
TSK Wiki 数据/图片下载器（移植自 TSKUnitViewer 的 fetch_images/fetch_sisters/fetch_equips.mjs）
==============================================================================================

功能（三阶段，全部只依赖标准库，可打进 PyInstaller exe）：
1. units  : 抓 wiki「キャラクター一覧」列表页 → 解析全部行写 viewer/wiki_data.json
            → 与 userdata/unit_list.json 匹配 → 下载头像（6 并发）+ 立绘（350ms 间隔礼貌延迟）
2. sisters: 抓「シスター」页 → viewer/sister_wiki.json + sw{idx}_icon/sw{idx} 专属图
3. equips : 抓武器/防具/装飾品三页 → viewer/equip_wiki.json + viewer/img/equip/ 图标
            （含 Wiki 未收录装备按 attach2 hex 命名规律补图）

图片落盘 viewer/img/，已存在文件自动跳过（增量更新，可随时重跑续传）。
所有请求带 UA / Accept-Language: ja，超时 + 3 次重试。

用法：
    python fetch_wiki_images.py              # 全量
    python fetch_wiki_images.py --icon-only  # 仅头像 + wiki json，跳过立绘
    from tools.fetch_wiki_images import fetch_all
    fetch_all(progress_cb)  # progress_cb(stage, current, total, label)，每个文件下载完成时调用
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

# PyInstaller 打包后 __file__ 指向 _internal 临时目录，用户数据在 exe 同级
if getattr(sys, "frozen", False):
    ROOT_DIR = Path(sys.executable).resolve().parent
else:
    ROOT_DIR = Path(__file__).resolve().parent

USERDATA_DIR = ROOT_DIR / "userdata"
VIEWER_DIR = ROOT_DIR / "viewer"
IMG_DIR = VIEWER_DIR / "img"
EQ_DIR = IMG_DIR / "equip"

BASE = 'https://twinklestarknights.wikiru.jp/'
LIST_URL = BASE + '?%E3%82%AD%E3%83%A3%E3%83%A9%E3%82%AF%E3%82%BF%E3%83%BC%E4%B8%80%E8%A6%A7'  # キャラクター一覧
SISTER_URL = BASE + '?%E3%82%B7%E3%82%B9%E3%82%BF%E3%83%BC'  # シスター
EQUIP_PAGES = [
    {'part': 1, 'name': '武器', 'url': '?%E6%AD%A6%E5%99%A8%E4%B8%80%E8%A6%A7'},
    {'part': 2, 'name': '防具', 'url': '?%E9%98%B2%E5%85%B7%E4%B8%80%E8%A6%A7'},
    {'part': 3, 'name': '装飾品', 'url': '?%E8%A3%85%E9%A3%BE%E5%93%81%E4%B8%80%E8%A6%A7'},
]
UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept-Language': 'ja',
}
TIMEOUT = 30
RETRY = 3

_TAG_RE = re.compile(r'<[^>]+>')
_TR_RE = re.compile(r'<tr>(?:(?!</tr>)[\s\S])*?</tr>')
_TD_RE = re.compile(r'<td[^>]*>([\s\S]*?)</td>')
_ICON_RE = re.compile(r'data-src="(attach2/[^"]+)"')
_LINK_RE = re.compile(r'<a[^>]+href="\.\/\?([^"]+)"[^>]*title="([^"]*)"')
_HREF_RE = re.compile(r'href="\.\/\?([^"]+)"')


def _strip(s):
    return _TAG_RE.sub('', s or '').replace('\u3000', ' ')


def _strip_nospace(s):
    return re.sub(r'\s+', '', _strip(s)).strip()


def _num(s):
    """对应 JS parseFloat + Number.isFinite: 去千分位逗号后解析，失败返回 None"""
    try:
        return float(str(s).replace(',', ''))
    except (ValueError, TypeError):
        return None


def _int_or_float(f):
    """Wiki 数值列: 整数保持 int (源 mjs JSON.stringify 不区分, 对齐用)"""
    if f is None:
        return None
    return int(f) if float(f).is_integer() else f


def _encode_uri(s):
    """对应 JS encodeURI: 保留 RFC2396 保留字与 % 不编码"""
    return urllib.parse.quote(s, safe=";,/?:@&=+$-_.!~*'()#%")


def _fetch_bytes(url, binary=True):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _fetch_text(url):
    return _fetch_bytes(url).decode('utf-8', errors='replace')


def _dl(url, file, retry=RETRY):
    """下载单个文件: 已存在跳过, 失败重试 retry 次 (对应源 dl())。返回 'skip'/'ok'/'fail'"""
    if file.exists():
        return 'skip'
    for _ in range(retry):
        try:
            data = _fetch_bytes(url)
            file.write_bytes(data)
            return 'ok'
        except Exception:
            time.sleep(0.5)
    return 'fail'


def _dl_if_image(url, file, retry=RETRY):
    """补图专用: 仅当响应 Content-Type 为图片才落盘 (对应 fetch_equips.mjs 第 4 段)"""
    if file.exists():
        return 'skip'
    for _ in range(retry):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if 'image' in (resp.headers.get('content-type') or ''):
                    file.write_bytes(resp.read())
                    return 'ok'
        except Exception:
            pass
        time.sleep(0.5)
    return 'fail'


def _load_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def _cb(progress_cb, stage, current, total, label):
    if progress_cb:
        progress_cb(stage, current, total, label)


# ======================================================================
# 1. 角色: wiki_data.json + 头像 + 立绘 (移植 fetch_images.mjs)
# ======================================================================
def fetch_units(progress_cb=None, icon_only=False):
    IMG_DIR.mkdir(parents=True, exist_ok=True)

    # ---- 1. 解析 Wiki 一覧页: 全部行的图鉴数据 ----
    html = _fetch_text(LIST_URL)
    wiki_rows = []
    for m in _TR_RE.finditer(html):
        row = m.group(0)
        tds = [x.group(1) for x in _TD_RE.finditer(row)]
        if len(tds) < 18 or not re.fullmatch(r'\d{6}', _strip_nospace(tds[0])):
            continue
        icon = _ICON_RE.search(row)
        link = _LINK_RE.search(row)
        wiki_rows.append({
            'no': _strip_nospace(tds[0]),                    # Wiki 行编号 (unit_id 后 6 位)
            'rarity': _int_or_float(_num(_strip_nospace(tds[1]))),  # ★ 初始稀有度
            'title': urllib.parse.unquote(link.group(2) or link.group(1)) if link else '',  # ［卡名］角色名
            'href': link.group(1) if link else '',           # 详情页路径
            'icon': icon.group(1) if icon else '',           # 头像相对路径
            'yomi': _strip_nospace(tds[4]),                  # 名前(ヨミ)
            'attr': _strip_nospace(tds[5]),                  # 属性 炎/水/雷/光/闇
            'camp': _strip_nospace(tds[6]),                  # 陣営 人間/神族/魔族
            'affil': _strip_nospace(tds[7]),                 # 所属
            'type': _strip_nospace(tds[8]),                  # タイプ ATK/SPD/DEF/SUP/ヒール
            'atkType': _strip_nospace(tds[9]),               # 攻撃タイプ 斬撃/打撃/魔法
            'hp': _int_or_float(_num(_strip_nospace(tds[10]))),    # Lv1 HP
            'atk': _int_or_float(_num(_strip_nospace(tds[11]))),   # Lv1 ATK
            'ex': _int_or_float(_num(_strip_nospace(tds[12]))),    # 消費EX
            'exUp': _int_or_float(_num(_strip_nospace(tds[13]))),  # EX上昇
            'ctMin': _int_or_float(_num(_strip_nospace(tds[14]))), # 最小CT
            'ctMax': _int_or_float(_num(_strip_nospace(tds[15]))), # 最大CT
            'crit': _int_or_float(_num(_strip_nospace(tds[16]))),  # クリティカル(%)
            'releaseDate': _strip_nospace(tds[17]),          # 実装日
            'obtain': _strip_nospace(tds[18]) if len(tds) > 18 else '',  # 入手方法
        })

    # ---- 2. 与 unit_list.json 匹配 (标题精确 > 编号+名字校验 > 标题包含兜底) ----
    # 注意: 部分卡游戏内 unit_id 与 Wiki 行编号错位, 仅靠编号会错配, 故编号匹配须通过名字校验
    units = _load_json(USERDATA_DIR / 'unit_list.json', [])
    jobs = []
    owned_row_idx = set()
    title_idx = {r['title']: i for i, r in enumerate(wiki_rows)}
    for u in units:
        no = str(u.get('unit_id'))[-6:]
        expect = f'［{u.get("unit_name")}］{u.get("character_name")}'

        def name_ok(r, u=u):
            return (u.get('unit_name') or '') in r['title'] or (u.get('character_name') or '') in r['title']

        idx = title_idx.get(expect)  # 1) 「［卡名］角色名」精确匹配
        if idx is None:
            cands = [(i, r) for i, r in enumerate(wiki_rows) if r['no'] == no]
            if len(cands) > 1:  # 2) 编号冲突按名消歧 (如 006001 两张クロト)
                p = next((c for c in cands if c[1]['title'] == expect), None) \
                    or next((c for c in cands if name_ok(c[1])), None) or cands[0]
                idx = p[0]
            elif len(cands) == 1 and name_ok(cands[0][1]):
                idx = cands[0][0]  # 3) 编号唯一且名字吻合
            else:
                ci = next((i for i, r in enumerate(wiki_rows)
                           if (u.get('unit_name') or '') in r['title'] and (u.get('character_name') or '') in r['title']), -1)
                if ci >= 0:  # 4) 编号错位: 标题包含回退
                    idx = ci
                elif len(cands) == 1:  # 5) 兜底: 仅编号吻合 (名字对不上)
                    idx = cands[0][0]
        if idx is None:
            continue
        owned_row_idx.add(idx)
        wiki_rows[idx]['ownedUnit'] = u.get('unit_id')  # 供 gen_unit_viewer.py 直接引用, 避免重复实现匹配逻辑
        jobs.append({'unit_id': u.get('unit_id'),
                     'name': f'{u.get("character_name")}「{u.get("unit_name")}」',
                     **wiki_rows[idx]})
    for i, r in enumerate(wiki_rows):
        r['owned'] = i in owned_row_idx

    # ---- 3. 输出全图鉴数据 wiki_data.json ----
    (VIEWER_DIR / 'wiki_data.json').write_text(
        json.dumps({'rows': wiki_rows}, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')

    # ---- 4. 下载头像: 持有卡用 {unit_id}_icon, 未持有卡用 w{no}_icon (6 并发) ----
    not_owned = [r for i, r in enumerate(wiki_rows) if i not in owned_row_idx]
    queue = ([{'url': j['icon'], 'file': f'{j["unit_id"]}_icon.png', 'label': j['name']} for j in jobs]
             + [{'url': r['icon'], 'file': f'w{r["no"]}_icon.png', 'label': r['title']} for r in not_owned])
    queue = [q for q in queue if q['url']]
    total = len(queue)
    done = [0]

    def dl_icon(q):
        r = _dl(BASE + q['url'], IMG_DIR / q['file'])
        done[0] += 1
        _cb(progress_cb, 'unit_icon', done[0], total, q['label'])
        return r

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(dl_icon, queue))

    # ---- 5. 立绘大图 (逐卡访问详情页, 350ms 间隔) ----
    if not icon_only:
        # NG 词: 私服/表情/差分/戦闘/攻撃/ドット 的 UTF-8 hex 大写
        ng = [s.encode('utf-8').hex().upper() for s in ('私服', '表情', '差分', '戦闘', '攻撃', 'ドット')]
        total = len(jobs)
        for i, j in enumerate(jobs, 1):
            out = IMG_DIR / f'{j["unit_id"]}.png'
            if out.exists():
                _cb(progress_cb, 'unit_art', i, total, j['name'])
                continue
            if not j.get('href') or not j.get('title'):
                _cb(progress_cb, 'unit_art', i, total, j['name'])
                continue
            try:
                page = _fetch_text(BASE + './?' + j['href'])
                hex_title = j['title'].encode('utf-8').hex().upper()
                cand = next((x.group(1) for x in _ICON_RE.finditer(page)
                             if hex_title in x.group(1).upper()
                             and not any(n in x.group(1).upper() for n in ng)), None)
                if cand:
                    _dl(BASE + cand, out)
            except Exception:
                pass
            _cb(progress_cb, 'unit_art', i, total, j['name'])
            time.sleep(0.35)
    return len(wiki_rows)


# ======================================================================
# 2. シスター: sister_wiki.json + 图标/立绘 (移植 fetch_sisters.mjs)
# ======================================================================
def fetch_sisters(progress_cb=None):
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    html = _fetch_text(SISTER_URL)

    # 解析 シスター一覧 表 (列: 画像/名称/属性/タイプ/チームスキル/発動条件/対象/効果/ゲージ速度/入手方法/実装日)
    def strip_sp(s):
        return re.sub(r'\s+', ' ', _strip(s)).strip()

    tables = re.findall(r'<table[^>]*>([\s\S]*?)</table>', html)
    t = next((x for x in tables if 'チームスキル' in x and 'ゲージ速度' in x), None)
    if t is None:
        raise RuntimeError('シスター一覧 table not found')
    rows = list(_TR_RE.finditer(t))

    # 持有 sister 名单 (dump): character_name 精确匹配
    dump_sisters = _load_json(USERDATA_DIR / 'sister_unit_list.json', [])
    own_by_name = {s.get('character_name'): s for s in dump_sisters}

    wiki_rows = []
    for i, r in enumerate(rows):
        if i == 0:
            continue  # 表头
        row = r.group(0)
        tds = [x.group(1) for x in _TD_RE.finditer(row)]
        if len(tds) < 8:
            continue
        icon_m = _ICON_RE.search(row)
        href_m = _HREF_RE.search(row)
        name = strip_sp(tds[1])
        own = own_by_name.get(name)
        wiki_rows.append({
            'idx': len(wiki_rows),
            'name': name,                                    # シスター名 (含【】变体)
            'icon': icon_m.group(1) if icon_m else '',       # Wiki 头像相对路径
            'href': href_m.group(1) if href_m else '',       # Wiki 详情页路径
            'attr': strip_sp(tds[2]),                        # 属性 炎/水/雷/光/闇
            'type': strip_sp(tds[3]),                        # タイプ ATK/SPD/DEF/SUP/HEAL
            'team': strip_sp(tds[4]),                        # チームスキル (满级合计文本)
            'cond': strip_sp(tds[5]),                        # アクティブスキル発動条件
            'target': strip_sp(tds[6]),                      # アクティブスキル対象
            'effect': strip_sp(tds[7]),                      # アクティブスキル効果 (满级)
            'gauge': strip_sp(tds[8]) if len(tds) > 8 else '',   # ゲージ速度
            'obtain': strip_sp(tds[9]) if len(tds) > 9 else '',  # 入手方法
            'date': strip_sp(tds[10]) if len(tds) > 10 else '',  # 実装日
            'owned': bool(own),
            'ownedSister': own.get('sister_unit_id') if own else None,
        })

    # 下载所有シスター的专属图标 (sw{idx}_icon.png, 持有/未持有统一用 Wiki シスター图标, 不复用 unit 图)
    total = len(wiki_rows)
    for i, r in enumerate(wiki_rows, 1):
        if not r['icon']:
            r['wimg'] = None
            _cb(progress_cb, 'sister_icon', i, total, r['name'])
            continue
        res = _dl(BASE + r['icon'], IMG_DIR / f'sw{r["idx"]}_icon.png')
        r['wimg'] = f'img/sw{r["idx"]}_icon.png' if res != 'fail' else None
        _cb(progress_cb, 'sister_icon', i, total, r['name'])
        time.sleep(0.15)

    # 逐卡访问详情页抓专属立绘 (文件名 シスター{名}.png; 排除攻撃作成/图标等杂图)
    ng_fn = re.compile(r'攻撃|作成|私服|表情|差分|ドット|戦闘|アイコン|icon')
    for i, r in enumerate(wiki_rows, 1):
        file = IMG_DIR / f'sw{r["idx"]}.png'
        if not r['href']:
            r['wart'] = None
            _cb(progress_cb, 'sister_art', i, total, r['name'])
            continue
        if file.exists():
            r['wart'] = f'img/sw{r["idx"]}.png'
            _cb(progress_cb, 'sister_art', i, total, r['name'])
            continue
        try:
            dh = _fetch_text(BASE + '?' + r['href'])
            # attach2 URL 结构: attach2/{hex(页名)}_{hex(文件名)}.png; 立绘文件名即 シスター{名}.png
            page_name = urllib.parse.unquote(r['href'])  # 例: シスターフィオナ
            cand = []
            for m in re.finditer(r'(?:data-src|src)="(attach2/[0-9A-Fa-f_]+\.png)"', dh):
                u = m.group(1)
                # 第二段是 UTF-8 文件名的 hex, 末尾还带字面量 .png 扩展名, 需先去掉再 hex 解码
                hex_part = re.sub(r'\.(?:png|jpg)$', '', (u.split('_')[1] if '_' in u else ''))
                try:
                    fn = bytes.fromhex(hex_part).decode('utf-8')
                except Exception:
                    fn = ''
                if re.match(r'^シスター.+\.png$', fn) and not ng_fn.search(fn):
                    cand.append({'u': u, 'fn': fn})
            # 优先取文件名包含详情页名的 (规避变体页串图)
            pick = next((c for c in cand if page_name in c['fn']), cand[0] if cand else None)
            if pick:
                res = _dl(BASE + pick['u'], file)
                r['wart'] = f'img/sw{r["idx"]}.png' if res != 'fail' else None
            else:
                r['wart'] = None
        except Exception:
            r['wart'] = None
        _cb(progress_cb, 'sister_art', i, total, r['name'])
        time.sleep(0.35)

    (VIEWER_DIR / 'sister_wiki.json').write_text(
        json.dumps({'fetchedAt': datetime.now(timezone.utc).date().isoformat(), 'rows': wiki_rows},
                   ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
    return len(wiki_rows)


# ======================================================================
# 3. 装备: equip_wiki.json + img/equip/ 图标 (移植 fetch_equips.mjs)
# ======================================================================
def fetch_equips(progress_cb=None):
    EQ_DIR.mkdir(parents=True, exist_ok=True)

    def ability_text(td):
        return _TAG_RE.sub('', re.sub(r'<br\s*/?>', '\n', td)).strip()

    # ---- 1. 抓取三页并解析行 ----
    # 列布局:
    #   武器   : 画像|アイテム|★|低確率|攻撃タイプ|有効属性|ATK|EX|EX上昇|クリ|アビリティ|入手方法
    #   防具   : 画像|アイテム|★|低確率|有効属性|HP|EX|EX上昇|クリ|アビリティ|入手方法
    #   装飾品 : No.|画像|アイテム/キャラ|タイプ|HP|ATK|EX|EX上昇|行動CT|クリ(%)|アビリティ
    wiki_equips = []
    for pg in EQUIP_PAGES:
        html = _fetch_text(BASE + pg['url'])
        for m in _TR_RE.finditer(html):
            row = m.group(0)
            tds = [x.group(1) for x in _TD_RE.finditer(row)]
            icon = _ICON_RE.search(row)
            name_link = _LINK_RE.search(row)
            r = None
            if pg['part'] == 1 and len(tds) >= 12 and _num(_strip_nospace(tds[2])) is not None:
                r = {'rarity': _int_or_float(_num(_strip_nospace(tds[2]))), 'atkType': _strip_nospace(tds[4]),
                     'attr': _strip_nospace(tds[5]), 'atk': _int_or_float(_num(_strip_nospace(tds[6]))),
                     'ex': _int_or_float(_num(_strip_nospace(tds[7]))), 'exUp': _int_or_float(_num(_strip_nospace(tds[8]))),
                     'crit': _int_or_float(_num(_strip_nospace(tds[9]))), 'ability': ability_text(tds[10]),
                     'obtain': _strip_nospace(tds[11])}
            elif pg['part'] == 2 and len(tds) >= 11 and _num(_strip_nospace(tds[2])) is not None:
                r = {'rarity': _int_or_float(_num(_strip_nospace(tds[2]))), 'atkType': '', 'attr': _strip_nospace(tds[4]),
                     'hp': _int_or_float(_num(_strip_nospace(tds[5]))), 'ex': _int_or_float(_num(_strip_nospace(tds[6]))),
                     'exUp': _int_or_float(_num(_strip_nospace(tds[7]))), 'crit': _int_or_float(_num(_strip_nospace(tds[8]))),
                     'ability': ability_text(tds[9]), 'obtain': _strip_nospace(tds[10])}
            elif pg['part'] == 3 and len(tds) >= 11 and re.fullmatch(r'\d+', _strip_nospace(tds[0])):
                # 名称列格式: 「装備名［卡名］角色名」→ 拆出装备名与卡名
                raw_name = _strip_nospace(tds[2])
                bm = re.match(r'^(.*?)[［[]([^］\]]+)[］\]](.*)$', raw_name)
                r = {'no': _strip_nospace(tds[0]), 'rarity': None, 'atkType': _strip_nospace(tds[3]), 'attr': '',
                     'hp': _int_or_float(_num(_strip_nospace(tds[4]))), 'atk': _int_or_float(_num(_strip_nospace(tds[5]))),
                     'ex': _int_or_float(_num(_strip_nospace(tds[6]))), 'exUp': _int_or_float(_num(_strip_nospace(tds[7]))),
                     'ct': _int_or_float(_num(_strip_nospace(tds[8]))), 'crit': _int_or_float(_num(_strip_nospace(tds[9]))),
                     'ability': ability_text(tds[10]), 'obtain': '', 'charCard': bm.group(2) if bm else ''}
                r['name'] = bm.group(1) if bm else raw_name
            if r is None:
                continue
            r['part'] = pg['part']
            if pg['part'] != 3:
                r['name'] = urllib.parse.unquote(name_link.group(2) or name_link.group(1)) if name_link else _strip_nospace(tds[1])
            r['icon'] = icon.group(1) if icon else ''
            r['href'] = name_link.group(1) if name_link else ''
            wiki_equips.append(r)
        time.sleep(0.4)

    # ---- 2. 与 dump 装备名称匹配 ----
    raw = _load_json(USERDATA_DIR / 'unit_list.json', [])
    by_name = {}  # equip_name -> { equip_id, part, rarity, exclusive, instances }
    for u in raw:
        for e in (u.get('equip_data') or []):
            if e.get('equip_name') not in by_name:
                by_name[e.get('equip_name')] = {'equip_id': e.get('equip_id'), 'part': e.get('equip_part'),
                                                'rarity': e.get('rarity'), 'exclusive': bool(e.get('exclusive_unit_id')),
                                                'instances': []}
            by_name[e.get('equip_name')]['instances'].append({
                'unit_id': u.get('unit_id'), 'unit': u.get('unit_name'), 'char': u.get('character_name'),
                'lv': e.get('lv'), 'max_lv': e.get('max_lv'), 'lb': e.get('limit_break_count'),
                'params': [[p.get('parameter_type'), p.get('parameter_value')] for p in (e.get('parameter_list') or [])],
                'skill': e['skill_data'].get('skill_detail') if e.get('skill_data') else '',
                'skill_lv': e['skill_data'].get('lv') if e.get('skill_data') else None})
    for w in wiki_equips:
        d = by_name.get(w['name'])
        if d:
            w['equip_id'] = d['equip_id']
            w['owned'] = True
            w['instances'] = d['instances']
        else:
            w['owned'] = False
    # 2.5 装飾品名修正: 游戏内名称含角色括号 (如「アルモタヘル(ちぃ)の被り物」), Wiki 表名省略括号段 → 去括号名二次匹配
    strip_paren = lambda s: re.sub(r'[(（][^)）]*[)）]', '', s)
    for name, d in by_name.items():
        if any(w['name'] == name for w in wiki_equips):
            continue
        alt = strip_paren(name)
        if alt == name:
            continue
        w = next((x for x in wiki_equips if x['name'] == alt and not x['owned']), None)
        if w:
            w['equip_id'] = d['equip_id']
            w['owned'] = True
            w['instances'] = d['instances']
            w['nameAlt'] = name

    # 入手方法列清洗: 武器/防具表的该列多为空, 仅含 PukiWiki「編集」链接, 剥离后只剩「編集/?」文本 → 置空
    for w in wiki_equips:
        if re.fullmatch(r'編集\??', w.get('obtain') or ''):
            w['obtain'] = ''

    # ---- 3. 输出 equip_wiki.json + 下载图标 ----
    (VIEWER_DIR / 'equip_wiki.json').write_text(
        json.dumps({'rows': wiki_equips}, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n')
    owned_with_icon = [w for w in wiki_equips if w['owned'] and w['icon']]
    total = len(owned_with_icon)
    for i, w in enumerate(owned_with_icon, 1):
        _dl(BASE + _encode_uri(w['icon']), EQ_DIR / f'{w["equip_id"]}.png')
        _cb(progress_cb, 'equip_icon', i, total, w['name'])
        time.sleep(0.15)

    # ---- 4. Wiki 一覧未收录装备: 按 attach2 hex 命名规律构造 URL 补图 ----
    # 已收录装备的图标文件名均为 img_equip_<装备名>_NF.png, 未收录的活动装备同样遵循该约定
    extra = [(name, d) for name, d in by_name.items() if not (EQ_DIR / f'{d["equip_id"]}.png').exists()]
    total4 = len(extra)
    for i, (name, d) in enumerate(extra, 1):
        hex_name = f'equip_{name}_NF.png'.encode('utf-8').hex().upper()
        url = f'{BASE}attach2/696D67_{hex_name}.png'  # 编码约定: hex('img')_hex('equip_<名>_NF.png') + 明文 '.png' 后缀
        _dl_if_image(url, EQ_DIR / f'{d["equip_id"]}.png')
        _cb(progress_cb, 'equip_extra', i, total4, name)
        time.sleep(0.15)
    return len(wiki_equips)


def fetch_all(progress_cb=None, icon_only=False):
    """按 units → sisters → equips 顺序全量抓取。progress_cb(stage, current, total, label)"""
    VIEWER_DIR.mkdir(parents=True, exist_ok=True)
    fetch_units(progress_cb, icon_only=icon_only)
    fetch_sisters(progress_cb)
    fetch_equips(progress_cb)


_STAGE_LABEL = {
    'unit_icon': '角色头像', 'unit_art': '角色立绘',
    'sister_icon': 'シスター头像', 'sister_art': 'シスター立绘',
    'equip_icon': '装备图标', 'equip_extra': '装备补图',
}


def main():
    icon_only = '--icon-only' in sys.argv
    last = ['']

    def cb(stage, current, total, label):
        line = f'[{_STAGE_LABEL.get(stage, stage)}] {current}/{total} {label}'
        print(' ' * max(0, len(last[0]) - len(line)), end='\r')
        print(line, end='\r', flush=True)
        last[0] = line
        if current == total:
            print()

    print('fetching wiki pages & images (已存在自动跳过, 可随时中断续传)...')
    fetch_all(progress_cb=cb, icon_only=icon_only)
    print('done -> 运行 python gen_unit_viewer.py 重新生成 index.html')


if __name__ == '__main__':
    main()
