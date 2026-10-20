# -*- coding: utf-8 -*-
"""
TSK 静态图鉴生成器（移植自 TSKUnitViewer gen_viewer.mjs 的数据处理部分）
========================================================================

功能：
- 读 userdata/ 下三个 dump：unit_list.json（持有角色）、sister_unit_list.json、
  warehouse.json（chara_piece_list = 角色碎片，item_id 即卡牌 unit_id）
- 合并 viewer/ 下三个 wiki 静态数据：wiki_data.json / equip_wiki.json /
  sister_wiki.json（由 tools/fetch_wiki_images.py 运行时抓取，缺失时优雅降级）
- 扫描 viewer/img/ 本地图片（{unit_id}.png 立绘 / {unit_id}_icon.png 头像 /
  w{no}_icon.png 未持有卡头像 / equip/{equip_id}.png 装备图标）
- 用 viewer/template.html 注入 payload，产出单文件 viewer/index.html（双击即用）

用法：
    python gen_unit_viewer.py                # 项目根为 cwd 直接跑
    from gen_unit_viewer import generate
    path = generate()                        # 供 GUI 调用，返回产物路径
"""

import json
import math
import re
import sys
from pathlib import Path

# PyInstaller 打包后：用户数据在 exe 同级；template.html 是只读资源，
# 通过 --add-data 放进 bundle（_MEIPASS/viewer/）
if getattr(sys, "frozen", False):
    ROOT_DIR = Path(sys.executable).resolve().parent
    RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))
else:
    ROOT_DIR = Path(__file__).resolve().parent
    RESOURCE_DIR = ROOT_DIR

USERDATA_DIR = ROOT_DIR / "userdata"
VIEWER_DIR = ROOT_DIR / "viewer"
IMG_DIR = VIEWER_DIR / "img"
TEMPLATE_HTML = RESOURCE_DIR / "viewer" / "template.html"
OUT_HTML = VIEWER_DIR / "index.html"

# ---- 常量表（照抄 gen_viewer.mjs）----
# 升星所需碎片数 (来源: 官方帮助页 help/detail/6/limitBreaking, 与 dump 数据无关)
# 限界突破: 目标★ → 需求 (★1→2 50 / ★2→3 100 / ★3→4 200 / ★4→5 300)
LB_COST = {2: 50, 3: 100, 4: 200, 5: 300}
# コアLV强化 (★5 后): 目标コアLV → 需求 (0→1 50 / 1→2 120 / 2→3 180)
CORE_COST = {1: 50, 2: 120, 3: 180}

EQ_PART = {1: '武器', 2: '防具', 3: '装飾品'}
EQ_PARAM = {0: 'HP', 1: 'ATK', 2: 'EX上昇', 3: 'クリ', 4: 'EX', 5: '行動CT'}
WIKI_ATTR_ID = {'炎': 1, '水': 2, '雷': 3, '光': 4, '闇': 5}
WIKI_ROLE_ID = {'ATK': 1, 'SPD': 2, 'DEF': 3, 'SUP': 4, 'HEAL': 5, 'ヒール': 5}  # HEAL=Wiki 现行记法, ヒール=旧记法兜底
WIKI_CAMP_ID = {'人間': 1, '神族': 2, '魔族': 3}

# ---- 字段映射（已通过攻略 Wiki 交叉验证）----
ATTR = {1: '炎', 2: '水', 3: '雷', 4: '光', 5: '闇'}
ATTR_COLOR = {1: '#ff6b4a', 2: '#4a9eff', 3: '#3fd97f', 4: '#ffd94a', 5: '#8b5cf6'}
ROLE = {1: 'ATK', 2: 'SPD', 3: 'DEF', 4: 'SUP', 5: 'HEAL'}
CAMP = {1: '人間', 2: '神族', 3: '魔族'}
SP_TYPE = {1: '魔法', 2: '斬撃', 3: '打撃'}  # sp_equip_types[0] = 攻撃タイプ (可装备武器类型)
SP_TYPE_ID = {'魔法': 1, '斬撃': 2, '打撃': 3}  # Wiki 一覧「攻撃タイプ」列文本 → ID
# 所属名称已全部经 Wiki 角色详情页「所属」栏核验 (3=守護天使, 7=コラプサー, 8=極星学園 等)
AFFIL = {0: '無所属', 1: '流星学園', 2: '新星学園', 3: '守護天使', 4: 'ネビュラ', 5: '流星附属', 7: 'コラプサー', 8: '極星学園'}

_STYLE_RE = re.compile(r'<style[^>]*>|</style>')
_RUBY_RE = re.compile(r'&lt;style=p\d+&gt;([\s\S]*?)&lt;/style&gt;')


def _num(v):
    """对应 JS 的一元 +：数字原样返回；字符串转数字，整数值保持 int 以贴近 JSON.stringify 输出"""
    if isinstance(v, (int, float)):
        return v
    f = float(v)
    return int(f) if f.is_integer() else f


def _js_str(v):
    """对应 JS 的 String(number)：整数浮点不带小数点"""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _js_round(x):
    """对应 JS Math.round（正数四舍五入，Python round 是银行家舍入不能直接用）"""
    return math.floor(x + 0.5)


def clean_style(s):
    return _STYLE_RE.sub('', str(s if s is not None else ''))


def ruby_name(s):
    # full_name 的「東雲<style=p24>しののめ</style>」片段 → HTML <ruby> 注音 (style 标签内容即假名读法)
    t = str(s if s is not None else '')
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return _RUBY_RE.sub(r'<rt>\1</rt>', t)


def _load_json(path, default):
    """wiki/仓库 json 缺失或损坏时优雅降级（对应源 mjs 的 try/catch）"""
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def _scan_img_dir(path):
    try:
        return set(p.name for p in path.iterdir())
    except Exception:
        return set()


def generate(progress_cb=None):
    """生成 viewer/index.html，返回产物路径字符串。progress_cb(msg: str) 可选，逐步回报。"""
    def report(msg):
        if progress_cb:
            progress_cb(msg)

    VIEWER_DIR.mkdir(parents=True, exist_ok=True)  # 打包版首次使用时 exe 同级无 viewer/
    raw = _load_json(USERDATA_DIR / 'unit_list.json', [])

    # 仓库数据 (userdata/warehouse.json): chara_piece_list = 角色碎片持有数, item_id 即卡牌 unit_id
    warehouse = _load_json(USERDATA_DIR / 'warehouse.json', {})
    piece_by_unit = {str(p.get('item_id')): p for p in (warehouse.get('chara_piece_list') or [])}

    # Wiki 全图鉴数据: owned=已持有；wiki 中文属性/类型 → json 数字 ID 映射
    wiki_rows = _load_json(VIEWER_DIR / 'wiki_data.json', {}).get('rows') or []
    # 装备图鉴数据 (fetch_wiki_images.py 产物, 按名称精确匹配 dump equip_name)
    equip_wiki_rows = _load_json(VIEWER_DIR / 'equip_wiki.json', {}).get('rows') or []

    # 扫描本地图片: img/{unit_id}.png 为立绘, img/{unit_id}_icon.png 为 Wiki 头像, img/w{no}_icon.png 为未持有卡头像
    img_set = _scan_img_dir(IMG_DIR)
    eq_img_set = _scan_img_dir(IMG_DIR / 'equip')

    def pick_art(uid):
        if f'{uid}.png' in img_set:
            return f'img/{uid}.png'
        if f'{uid}.jpg' in img_set:
            return f'img/{uid}.jpg'
        return None

    def pick_icon(uid):
        return f'img/{uid}_icon.png' if f'{uid}_icon.png' in img_set else None

    # 未持有卡头像: img/w{no}_icon.png (fetch_wiki_images.py 下载)
    for r in wiki_rows:
        r['wimg'] = f'img/w{r["no"]}_icon.png' if f'w{r["no"]}_icon.png' in img_set else None

    # 未持有角色的碎片: 仅处理「不属于任何已持有卡」的碎片 (已持有卡在 units 映射里取 dump 值),
    # 按碎片名 (去掉「のピース」) 匹配 Wiki 行 —— 编号规则不可靠 (如 1020004 聖夜のキャロル 会被错配到 020004 ルルカ)
    owned_unit_ids = {str(u.get('unit_id')) for u in raw}
    for p in (warehouse.get('chara_piece_list') or []):
        if str(p.get('item_id')) in owned_unit_ids:
            continue
        base = re.sub(r'のピース$', '', str(p.get('item_name') or ''))
        hit = next((r for r in wiki_rows if base and base in (r.get('title') or '')), None)
        if hit:
            hit['piece'] = p.get('have_count') or 0

    def map_skill(s):
        # skills[].ss* = specific_skill_* (EX2+ 强化版技能, dump 里挂原 EX 槽; 无强化槽为 access violation 占位, 置空)
        ss_err = bool(re.match(r'^<error>', str(s.get('specific_skill_name') or '')))
        return {
            'type': s.get('skill_data_type'), 'name': s.get('skill_name'), 'detail': s.get('skill_detail'),
            'lv': s.get('lv'), 'max_lv': s.get('max_lv'), 'cost': s.get('cost_ex_gauge'),
            'unlock': s.get('is_unlock'), 'cond': s.get('unlock_condition'),
            'ssName': '' if ss_err else (s.get('specific_skill_name') or ''),
            'ssDetail': '' if ss_err else (s.get('specific_skill_detail') or ''),
            'ssCost': s.get('specific_skill_cost_ex_gauge') or 0,
        }

    def map_equip(e):
        def map_enchant(fr):
            ed = fr.get('enchant_data') or {}
            det = ed.get('detail') or {}
            text = det.get('detail') or ''
            if text and ed.get('effect_value') is not None:
                text = text.replace('0', _js_str(ed['effect_value']), 1)  # JS String.replace 只换第一处
            return {
                'frame': fr.get('frame_no'), 'rare': fr.get('is_rare'), 'open': fr.get('is_enchant_release'),
                'name': det.get('skill_name') or ed.get('skill_name') or '',
                'tier': ed.get('tier') or 0, 'rarity': ed.get('effect_rarity') or 0, 'text': text,
            }

        sd = e.get('skill_data')
        return {
            'part': e.get('equip_part'), 'name': e.get('equip_name'), 'rarity': e.get('rarity'),
            'lv': e.get('lv'), 'max_lv': e.get('max_lv'),
            'lb': e.get('limit_break_count'), 'max_lb': e.get('max_limit_break_count'),
            'params': [{'t': p.get('parameter_type'), 'v': p.get('parameter_value')} for p in (e.get('parameter_list') or [])],
            'skill': sd.get('skill_detail') if sd else '', 'skill_lv': sd.get('lv') if sd else None,
            'enchTotal': len(e.get('enchant_frame_list') or []),
            'enchOpen': sum(1 for x in (e.get('enchant_frame_list') or []) if x.get('is_enchant_release')),
            'enchants': [map_enchant(fr) for fr in (e.get('enchant_frame_list') or [])],
            'icon': f'img/equip/{e.get("equip_id")}.png' if f'{e.get("equip_id")}.png' in eq_img_set else None,
        }

    units = []
    for u in raw:
        piece = piece_by_unit.get(str(u.get('unit_id'))) or {}
        st_data = u.get('status_data') or {}
        bd = st_data.get('base_data')
        al = st_data.get('add_love_lv')
        units.append({
            'id': u.get('u_unit_id'),
            'unit_id': u.get('unit_id'),
            'char_id': u.get('character_id'),
            'cname': u.get('character_name'),
            'uname': u.get('unit_name'),
            'fname': clean_style(u.get('full_name')),
            'fnameRuby': ruby_name(u.get('full_name')),
            'rarity': u.get('rarity'),
            'max_rarity': u.get('max_rarity'),
            'attr': u.get('attr_type'),
            'role': u.get('role'),
            'spType': ((u.get('sp_equip_types') or [None])[0] or 0),  # (sp_equip_types || [])[0] || 0
            'camp': u.get('camp'),
            'camps': u.get('camp_list'),       # 完整陣営集合 (可能多个, camp 为主值)
            'affil': u.get('affiliation'),
            'affils': u.get('affiliation_list'),  # 完整所属集合 (可能多个, affiliation 为主值)
            'lv': u.get('lv'),
            'max_lv': u.get('max_lv'),
            'love': u.get('love_lv'),
            'max_love': u.get('max_love_lv'),
            'power': u.get('power'),
            'team_hp': u.get('team_hp'),
            'limit': u.get('lv_limit_count'),
            'core': u.get('core_lv'), 'maxCore': u.get('max_core_lv'),  # コア (核心) 等级, 与练度相关
            # 升星: 碎片持有数 (chara_piece_list, item_id = unit_id) / 下一星所需碎片 (None = 已满★5)
            'piece': piece.get('have_count') or 0,
            'pieceName': piece.get('item_name') or None,
            'lbNeed': LB_COST.get(u.get('rarity', 0) + 1) if (u.get('rarity') or 0) < 5 else None,
            'coreNeed': (CORE_COST.get((u.get('core_lv') or 0) + 1)
                         if (u.get('rarity') or 0) >= 5 and (u.get('max_core_lv') or 0) > 0 and (u.get('core_lv') or 0) < u.get('max_core_lv')
                         else None),
            'bond': u.get('is_bond_unit'),
            'event': u.get('is_event_unit'),
            'awake': u.get('is_awake_unit'),
            'illust': u.get('unit_illust_id'),
            'art': pick_art(u.get('unit_id')),
            'icon': pick_icon(u.get('unit_id')),
            'birthday': u.get('birthday'),
            'constellation': u.get('constellation'),
            'star': u.get('guardian_star'),
            'year': u.get('school_year'),
            'committee': u.get('committee'),
            'club': u.get('club'),
            'hobby': u.get('hobby'),
            'cv': u.get('cv'),
            'profile': u.get('profile'),
            # 新版 dump 已解析的实体 (旧版为类型名占位符): 技能 / 升星解锁被动 / 当前练度白值 / 好感加成
            'skills': [map_skill(s) for s in (u.get('skill_data') or [])],
            'uniques': [{'name': s.get('skill_name'), 'detail': s.get('detail'), 'unlock': s.get('is_unlock'), 'cond': s.get('unlock_condition')}
                        for s in (u.get('unique_skill_data') or [])],
            'st': ({'hp': _num(bd.get('hp')), 'atk': bd.get('attack'), 'crit': bd.get('critical'),
                    'initEx': bd.get('init_ex_gauge'), 'maxEx': bd.get('max_ex_gauge'),
                    'exRate': bd.get('ex_gauge_rate'), 'wtMin': bd.get('min_wt'), 'wtMax': bd.get('max_wt')}
                   if bd else None),
            'equips': [map_equip(e) for e in (u.get('equip_data') or [])],
            'loveB': ({'hp': _num(al.get('hp')), 'atk': al.get('attack'), 'crit': al.get('critical')} if al else None),
        })
    units.sort(key=lambda x: (-(x['power'] or 0), x['char_id'] if x['char_id'] is not None else 0))

    # 合并 Wiki 数据到持有卡 (fetch_wiki_images.py 已按 编号→标题 匹配, ownedUnit=持有 unit_id)
    wiki_by_unit = {}
    for idx, r in enumerate(wiki_rows):
        ou = r.get('ownedUnit')
        if ou is not None and str(ou) not in wiki_by_unit:
            wiki_by_unit[str(ou)] = (r, idx)
    for u in units:
        hit = wiki_by_unit.get(str(u['unit_id']))
        if not hit:
            continue
        w, row_idx = hit
        u.update({
            'wRar': w.get('rarity'),  # Wiki ★ = 初始稀有度 (json rarity 是升星〔限界突破〕后的当前稀有度)
            'whp': w.get('hp'), 'watk': w.get('atk'), 'wex': w.get('ex'), 'wexUp': w.get('exUp'),
            'wctMin': w.get('ctMin'), 'wctMax': w.get('ctMax'),
            'wcrit': w.get('crit'), 'watkType': w.get('atkType'), 'wdate': w.get('releaseDate'),
            'wobtain': w.get('obtain'), 'whref': w.get('href'), 'rowIdx': row_idx,
        })

    # 合并装备 Wiki 数据 (名称精确匹配): アビリティ满强文本 / 入手方法 / 专武对应卡名
    # 装备 Wiki 行按名称索引: 注册 name 与 nameAlt 两个 key (游戏内装飾品名含角色括号, Wiki 表名省略)
    eq_wiki_by_name = {}
    for r in equip_wiki_rows:
        if not r.get('owned'):
            continue
        eq_wiki_by_name[r.get('name')] = r
        if r.get('nameAlt'):
            eq_wiki_by_name[r['nameAlt']] = r
    for u in units:
        for e in u['equips']:
            w = eq_wiki_by_name.get(e['name'])
            if w:
                e['wAbility'] = w.get('ability')
                e['wObtain'] = w.get('obtain')
                e['wNo'] = w.get('no') or ''
                e['charCard'] = w.get('charCard') or ''
        # 装备加成合计 (t0=HP t1=ATK t2=EX上昇 t3=クリ%×100 t4=EX蓄积), 附到白值面板; 并算 HP/ATK 总值 (基础+装备+好感) 供显示与排序
        b = {'hp': 0, 'atk': 0, 'crit': 0, 'exUp': 0, 'ex': 0}
        for e in u['equips']:
            for p in e['params']:
                if p['t'] == 0:
                    b['hp'] += p['v']
                elif p['t'] == 1:
                    b['atk'] += p['v']
                elif p['t'] == 3:
                    b['crit'] += p['v']
                elif p['t'] == 2:
                    b['exUp'] += p['v']
                elif p['t'] == 4:
                    b['ex'] += p['v']
        b['crit'] = _js_round(b['crit']) / 100
        if b['hp'] or b['atk'] or b['crit'] or b['exUp'] or b['ex']:
            u['eqBonus'] = b
        if u['st']:
            lb = u['loveB'] or {}
            u['hpTotal'] = u['st']['hp'] + b['hp'] + (lb.get('hp') or 0)
            u['atkTotal'] = u['st']['atk'] + b['atk'] + (lb.get('atk') or 0)
            u['exUpTotal'] = (u['st'].get('exRate') or 0) + b['exUp']  # EX上升合计 (基础+装备)

    stats = {
        'total': len(units),
        'totalPower': sum(u['power'] or 0 for u in units),
        'maxLv': sum(1 for u in units if (u['lv'] or 0) >= (u['max_lv'] or 0)),
        'maxLove': sum(1 for u in units if (u['max_love'] or 0) > 0 and (u['love'] or 0) >= u['max_love']),
        'r5': sum(1 for u in units if u['rarity'] == 5),
        'chars': len({u['char_id'] for u in units}),
        'collected': sum(1 for r in wiki_rows if r.get('owned')),
        'dexTotal': len(wiki_rows),
        # 升星: 碎片已够、可立即限界突破 / コアLV強化 的卡牌数
        'lbReady': sum(1 for u in units if u['lbNeed'] is not None and u['piece'] >= u['lbNeed']),
        'coreReady': sum(1 for u in units if u['coreNeed'] is not None and u['piece'] >= u['coreNeed']),
    }

    # Wiki 行类型/攻撃タイプ统一归一为数字 ID (前端筛选/显示共用, 与持有卡的 u.role/u.spType 同一套枚举)
    for r in wiki_rows:
        r['typeId'] = WIKI_ROLE_ID.get(r.get('type'), 0)
        r['spId'] = SP_TYPE_ID.get(r.get('atkType'), 0)

    # ---- シスター (sister_unit_list.json dump + sister_wiki.json 全图鉴) ----
    sister_raw = _load_json(USERDATA_DIR / 'sister_unit_list.json', [])
    sister_wiki = _load_json(VIEWER_DIR / 'sister_wiki.json', {}).get('rows') or []

    def next_lv(d):
        # next_lv_list[0] = 下一级预览 (含 <color=#16C97B> 差分高亮 rich text, 前端 colorize 还原)
        nl = d.get('next_lv_list') if d else None
        if nl and isinstance(nl, list) and nl[0]:
            return {'lv': nl[0].get('lv'), 'detail': nl[0].get('skill_detail') or ''}
        return None

    # 注意: シスター是独立单位类型, 图片一律用 Wiki 专属图 (sw{idx}_icon/sw{idx}), 不复用 unit 立绘 (sister_unit_id 与基础卡 unit_id 重号)
    sisters = []
    for s in sister_raw:
        sup = s.get('support_skill_data')
        act = s.get('active_skill_data')
        exd = s.get('extra_support_skill_data')
        rel = (exd or {}).get('release_skill_data')
        sisters.append({
            'id': s.get('u_sister_unit_id'),
            'sid': s.get('sister_unit_id'),
            'cname': s.get('character_name'),
            'kana': s.get('character_name_kana'),
            'attr': s.get('attr_type'),
            'role': s.get('role'),
            'camp': s.get('camp'),
            'lb': s.get('limit_break_count'),
            'support': ({'name': sup.get('skill_name'), 'detail': sup.get('skill_detail'), 'lv': sup.get('lv'),
                         'max': sup.get('max_lv'), 'next': next_lv(sup)} if sup else None),
            'active': ({'name': act.get('skill_name'), 'detail': act.get('skill_detail'), 'lv': act.get('lv'),
                        'max': act.get('max_lv'), 'next': next_lv(act)} if act else None),
            'extra': ({'flg': exd.get('extra_support_skill_flg'), 'released': exd.get('is_release'),
                       'name': rel.get('skill_name'), 'detail': rel.get('skill_detail')}
                      if rel else None),
        })

    # Wiki 行合并到持有 sister (character_name 与 Wiki「名称」精确匹配, fetch_wiki_images.py 已标注 owned/ownedSister)
    sister_by_name = {s['cname']: s for s in sisters}
    sister_rows = []
    for idx, r in enumerate(sister_wiki):
        o = sister_by_name.get(r.get('name'))
        if o:
            o['wiki'] = {'cond': r.get('cond'), 'target': r.get('target'), 'gauge': r.get('gauge'),
                         'obtain': r.get('obtain'), 'date': r.get('date'), 'team': r.get('team'),
                         'wimg': r.get('wimg') or None, 'wart': r.get('wart') or None}
        sister_rows.append({
            'idx': idx, 'name': r.get('name'), 'attr': WIKI_ATTR_ID.get(r.get('attr'), 0),
            'typeId': WIKI_ROLE_ID.get(r.get('type'), 0),
            'team': r.get('team'), 'cond': r.get('cond'), 'target': r.get('target'), 'effect': r.get('effect'),
            'gauge': r.get('gauge'), 'obtain': r.get('obtain'), 'date': r.get('date'),
            'href': r.get('href') or None,  # Wiki 页面路径 (URL 编码, 拼在 https://twinklestarknights.wikiru.jp/? 后)
            'wimg': r.get('wimg') or None, 'wart': r.get('wart') or None,
            'owned': bool(o), 'sid': o['sid'] if o else None,
        })
    # Wiki 未收录的持有 sister 兜底追加 (仅 dump 数据, 无 Wiki 专属图)
    for s in sisters:
        if any(r['sid'] == s['sid'] for r in sister_rows):
            continue
        sister_rows.append({'idx': len(sister_rows), 'name': s['cname'], 'attr': s['attr'], 'typeId': s['role'],
                            'team': '', 'cond': '', 'target': '', 'effect': '', 'gauge': '', 'obtain': '', 'date': '',
                            'href': None, 'wimg': None, 'wart': None, 'owned': True, 'sid': s['sid']})
    stats['sisterOwned'] = len(sisters)
    stats['sisterTotal'] = len(sister_rows)

    payload = {
        'units': units, 'stats': stats, 'wikiRows': wiki_rows, 'sisters': sisters, 'sisterRows': sister_rows,
        'ATTR': ATTR, 'ATTR_COLOR': ATTR_COLOR, 'ROLE': ROLE, 'CAMP': CAMP, 'AFFIL': AFFIL,
        'WIKI_ATTR_ID': WIKI_ATTR_ID, 'WIKI_CAMP_ID': WIKI_CAMP_ID,
        'EQ_PART': EQ_PART, 'EQ_PARAM': EQ_PARAM, 'SP_TYPE': SP_TYPE,
    }
    report(f'payload 组装完成: 卡牌 {stats["total"]} 张 / 图鉴 {stats["collected"]}/{stats["dexTotal"]} / シスター {stats["sisterOwned"]}/{stats["sisterTotal"]}')

    # 数字 key 的常量表: JS 对象 key 是字符串, json.dumps 需拉齐 (int key 会自动转字符串)
    payload_js = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')

    template = TEMPLATE_HTML.read_text(encoding='utf-8')
    if '__PAYLOAD__' not in template:
        raise RuntimeError(f'{TEMPLATE_HTML} 缺少 __PAYLOAD__ 占位符，模板未正确抽取')
    html = template.replace('__PAYLOAD__', payload_js)
    OUT_HTML.write_text(html, encoding='utf-8', newline='\n')
    report(f'OK -> {OUT_HTML} ({len(html) / 1024:.1f} KB)')
    return str(OUT_HTML)


def main():
    out = generate(progress_cb=lambda m: print(m))
    # 与源 mjs 末尾相同的汇总信息（重算一份仅供控制台展示）
    data = json.loads(Path(out).read_text(encoding='utf-8').split('const DATA = ', 1)[1].split(';\n', 1)[0])
    stats = data['stats']
    units = data['units']
    wiki_rows = data['wikiRows']
    print(f'卡牌 {stats["total"]} 张 / 角色 {stats["chars"]} 名 / 总战力 {stats["totalPower"]:,} / ★5 {stats["r5"]} / 满级 {stats["maxLv"]} / 好感满 {stats["maxLove"]}')
    print(f'图鉴收集 {stats["collected"]}/{stats["dexTotal"]} (Wiki 全角色, 含覚醒強化別枠)')
    matched = sum(1 for u in units if u.get('pieceName'))
    print(f'仓库碎片匹配到卡牌 {matched} 张 / 可升星 {stats["lbReady"]} 张 / 可强化コア {stats["coreReady"]} 张')
    unowned_pc = sum(1 for r in wiki_rows if not r.get('owned') and (r.get('piece') or 0) > 0)
    print(f'未持有角色持有碎片 {unowned_pc} 名 (全图鉴视图角标显示)')


if __name__ == '__main__':
    main()
