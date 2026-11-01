#!/usr/bin/env python3
"""重排 field-log banner 的路线：等距布点 + 标签自动避让。

为什么需要这个脚本
------------------
三张 banner 里的路线坐标原来是手摆的，而且是被"标签要地方"逼出来的：
```text
03 / DIGITAL-BRAIN  在 13px 下约 140px 宽，比相邻两点的水平间距还宽，
所以右侧几个点被迫靠拢，让标签有地方放。
```
实测段长：

    桌面  144 · 172 · 53 · 61 · 60   最长/最短 = 3.22x
    移动  161 · 151 · 68 · 60 · 50   最长/最短 = 3.23x
    紧凑  115 · 126 · 127 · 103 · 98 最长/最短 = 1.29x

也就是说这个"不均匀"不是在表达什么，是布局失败的副产品，顺带还把几个标签
压到了圆点上。手工调整无法同时满足"等距"和"不压字"，所以改成算出来。

本脚本做什么
------------
1. 用固定段长 L + 角度序列生成点位，相邻距离严格相等。
2. 标签位置用回溯搜索求解，硬约束：
     不压圆点、不压已放标签、不压角落文字、不超出裁切区。
   AI 节点外围有半径 27 的十字刻度，单独按 29 的半径避让，避免线条穿字。
3. 回写：背景虚线路径 / 背景圆环 / route-live / route-next /
   节点组 transform / 标签 / 探针关键帧 / reduced-motion 终点。
4. 从磁盘重新读回结果做复核，段长比和标签避让不达标就报错。

用法
----
    python3 tools/layout-field-log.py            # 就地改写仓库里的三张 SVG
    python3 tools/layout-field-log.py --dry-run  # 只打印，不写文件

脚本是幂等的：在已经生成好的文件上再跑一次不会产生任何改动。

注意
----
* 只重新排布几何，颜色、字号、动画曲线等样式不动。
* 三个 data-stat 数字（PUBLIC REPOS / OPEN ROUTES）由
  .github/scripts/update-field-stats.mjs 每天同步，本脚本不碰它们。
* 改完记得提交，工作流会把 README 里的图片地址重新钉到新提交。
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from pathlib import Path

# 以下三项都是从浏览器实测出来的，不是估的
# （等宽字体 SFMono-Regular / Menlo 在 Chrome 下量得）
ADVANCE = 0.602    # 字宽 / font-size
ASCENT = 0.923     # 文字顶部 = 基线 y - 0.923 × font-size
DESCENT = 0.231    # 文字底部 = 基线 y + 0.231 × font-size

TEXT_PAD = 2       # 标签之间最小间距
EDGE_PAD = 4       # 距裁切边界留白
STATIC_SLACK = 3   # 角落文字宽度预留字符数（数字将来变成 3 位也不会挤）


# ---------------------------------------------------------------- 几何

def make_points(start, angles, length):
    """按固定段长 L 和角度序列生成点位，相邻距离恒等于 L。"""
    pts, x, y = [start], *start
    for deg in angles:
        rad = math.radians(deg)
        x += length * math.cos(rad)
        y += length * math.sin(rad)
        pts.append((x, y))
    return pts


def text_bbox(x, y, text, font, anchor="middle", slack_chars=0):
    """粗估文字包围盒（用实测的字体度量）。"""
    w = (len(text) + slack_chars) * font * ADVANCE
    x0 = x - w / 2 if anchor == "middle" else (x - w if anchor == "end" else x)
    return (x0, y - font * ASCENT, x0 + w, y + font * DESCENT)


def overlaps(a, b, pad=TEXT_PAD):
    return not (
        a[2] + pad <= b[0] or b[2] + pad <= a[0]
        or a[3] + pad <= b[1] or b[3] + pad <= a[1]
    )


def place_labels(points, names, font, clip, static_boxes, candidates, radii):
    """回溯求解标签位置，返回 [(text, x, y, anchor), ...]。

    候选位置按优先级排列，DFS 取第一个可行解，因此越靠前的候选越容易被选中。
    """
    dots = [(x - r, y - r, x + r, y + r) for (x, y), r in zip(points, radii)]

    options = []
    for (cx, cy), text in zip(points, names):
        opts = []
        for dx, dy, anchor in candidates:
            x, y = cx + dx, cy + dy
            box = text_bbox(x, y, text, font, anchor)
            if box[0] < clip[0] + EDGE_PAD or box[2] > clip[0] + clip[2] - EDGE_PAD:
                continue
            if box[1] < clip[1] + EDGE_PAD or box[3] > clip[1] + clip[3] - EDGE_PAD:
                continue
            opts.append((x, y, anchor, box))
        options.append(opts)

    fixed = list(static_boxes) + dots

    def solve(i, used):
        if i == len(names):
            return []
        for x, y, anchor, box in options[i]:
            if any(overlaps(box, o) for o in fixed) or any(overlaps(box, o) for o in used):
                continue
            rest = solve(i + 1, used + [box])
            if rest is not None:
                return [(names[i], x, y, anchor)] + rest
        return None

    solved = solve(0, [])
    if solved is None:
        raise RuntimeError(
            f"标签无法全部避开彼此（第 {len(name for name in names)} 个附近）。"
            "请缩短标签文字，或调整 angles / length / candidates。"
        )
    return solved


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


# ---------------------------------------------------------------- 写回

def sub_once(pattern, repl, text, what):
    """只替换一次，替换不到就报错 —— 避免模板结构变了却静默不生效。"""
    new, n = re.subn(pattern, repl, text, count=1)
    if n != 1:
        raise RuntimeError(f"在 SVG 里找不到 {what}，模板结构可能已经变了。")
    return new


def patch_svg(path: Path, cfg: dict, dry_run: bool) -> tuple[bool, list[float]]:
    src = path.read_text(encoding="utf-8")

    trailhead = cfg.get("trailhead", True)
    pts = make_points(cfg["start"], cfg["angles"], cfg["length"])
    nodes = pts[1:] if trailhead else pts

    label_clip = cfg.get("label_clip", cfg["clip"])
    static_boxes = [
        text_bbox(x, y, t, cfg["font"], "start", STATIC_SLACK)
        for x, y, t in cfg["static_labels"]
    ]
    labels = place_labels(
        nodes, cfg["names"], cfg["font"], label_clip, static_boxes,
        cfg["candidates"], cfg["obstacle_radii"],
    )

    # 尾巴：沿最后一段方向再延伸一点，表示"路线还没画完"
    last, prev = pts[-1], pts[-2]
    dx, dy = last[0] - prev[0], last[1] - prev[1]
    norm = math.hypot(dx, dy)
    tail = (last[0] + dx / norm * cfg["tail"], last[1] + dy / norm * cfg["tail"])

    def xy(p):
        return f"{fmt(p[0])} {fmt(p[1])}"

    route_d = "M" + "L".join(xy(p) for p in pts)
    dashed_d = route_d + "L" + xy(tail)
    next_d = "M" + xy(last) + "L" + xy(tail)

    # 1) 背景虚线路径（含尾巴）
    src = sub_once(
        r'(<g opacity="\.3\d" stroke="#65707B" fill="none">\s*\n\s*<path d=")[^"]*(")',
        lambda m: m.group(1) + dashed_d + m.group(2), src, "背景虚线路径",
    )

    # 2) 背景圆环：可选起点 + 各节点（AI 不画环）
    rings = []
    if trailhead:
        rings.append(
            f'<circle cx="{fmt(pts[0][0])}" cy="{fmt(pts[0][1])}" r="{cfg["ring_start"]}"/>'
        )
    rings += [
        f'<circle cx="{fmt(p[0])}" cy="{fmt(p[1])}" r="{r}"/>'
        for p, r in zip(nodes[:-1], cfg["ring_radii"])
    ]
    src = sub_once(
        r'(<path d="[^"]*" stroke-dasharray="3 9"/>\n)(?:\s*<circle cx="[^"]*" cy="[^"]*" r="\d+"/>\n)+',
        lambda m: m.group(1) + "".join(f"        {r}\n" for r in rings),
        src, "背景圆环",
    )

    # 3) 主线与"下一段"
    src = sub_once(
        r'(<path class="route-live"\s*\n\s*d=")[^"]*(")',
        lambda m: m.group(1) + route_d + m.group(2), src, "route-live",
    )
    src = sub_once(
        r'(<path class="route-next"\s*\n\s*d=")[^"]*(")',
        lambda m: m.group(1) + next_d + m.group(2), src, "route-next",
    )

    # 4) 节点组位置
    for name, p in zip(["woo", "todo", "brain", "t101", "newapi", "ai"], nodes):
        src = sub_once(
            r'(<g transform="translate\()([^)]*)(\)">\s*\n\s*<circle class="node-' + name + r'")',
            lambda m, p=p: m.group(1) + xy(p) + m.group(3),
            src, f"节点 {name}",
        )

    # 5) 节点标签
    block = "\n".join(
        f'        <text x="{fmt(x)}" y="{fmt(y)}" text-anchor="{a}"'
        + (' fill="#E6B566"' if "AI" in t else "")
        + f">{t}</text>"
        for t, x, y, a in labels
    )
    src = sub_once(
        r'(<g fill="#[0-9A-Fa-f]{6}" font-size="\d+" font-weight="700">\n)'
        r'(?:\s*<text x="[^"]*" y="[^"]*"[^>]*>(?:\d\d|AI)[^<]*</text>\n)+',
        lambda m: m.group(1) + block + "\n", src, "节点标签",
    )

    # 6) 探针关键帧：按站点顺序推进，90% 时抵达终点再淡出
    marks = [0.23, 0.40, 0.58, 0.68, 0.79, 0.90][: len(pts) - 1]
    frames = [
        f"      0%, 7% {{ transform: translate({fmt(pts[0][0])}px, {fmt(pts[0][1])}px);"
        " opacity: 0; }",
        "      10% { opacity: 1; }",
    ]
    for i, mark in enumerate(marks):
        p = pts[min(i + 1, len(pts) - 1)]
        frames.append(
            f"      {round(mark * 100)}% {{ transform: translate({fmt(p[0])}px, {fmt(p[1])}px);"
            + (" opacity: 1;" if i == 0 else "")
            + " }"
        )
    end = f"translate({fmt(pts[-1][0])}px, {fmt(pts[-1][1])}px)"
    frames.append(f"      90% {{ transform: {end}; opacity: 1; }}")
    frames.append(f"      100% {{ transform: {end}; opacity: 0; }}")

    seen, unique = set(), []
    for frame in frames:
        key = frame.split("%")[0].strip()
        if key not in seen:
            seen.add(key)
            unique.append(frame)

    src = re.sub(
        r"(@keyframes probe-route \{\n)(?:.*?\n)(    \})",
        lambda m: m.group(1) + "\n".join(unique) + "\n" + m.group(2),
        src, count=1, flags=re.S,
    )

    # 7) prefers-reduced-motion 下探针停在终点
    src = sub_once(
        r"(\.probe \{ transform: translate\()[^)]*(\); opacity: 1; \})",
        lambda m: m.group(1) + f"{fmt(pts[-1][0])}px, {fmt(pts[-1][1])}px" + m.group(2),
        src, "reduced-motion 探针终点",
    )

    changed = src != path.read_text(encoding="utf-8")
    if changed and not dry_run:
        path.write_text(src, encoding="utf-8")

    segs = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    return changed, segs


# ---------------------------------------------------------------- 复核

def verify(path: Path, cfg: dict) -> None:
    """从磁盘读回结果，确认落盘的就是想要的。"""
    src = path.read_text(encoding="utf-8")
    found = re.findall(
        r'<g transform="translate\(([-\d.]+) ([-\d.]+)\)">\s*\n\s*<circle class="node-', src
    )
    pts = [(float(a), float(b)) for a, b in found]
    if len(pts) != 6:
        raise RuntimeError(f"{path.name}: 期望 6 个节点，实际解析到 {len(pts)} 个。")

    segs = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    ratio = max(segs) / min(segs)
    if ratio > 1.02:
        raise RuntimeError(f"{path.name}: 段长不均匀，最长/最短 = {ratio:.3f}x。")

    # 标签是否压到圆点（用同一套估算度量自检一遍）
    radii = cfg["obstacle_radii"]
    dots = [(x - r, y - r, x + r, y + r) for (x, y), r in zip(pts, radii)]
    labels = re.findall(
        r'<text x="([-\d.]+)" y="([-\d.]+)" text-anchor="(\w+)"[^>]*>([^<]+)</text>', src
    )
    for x, y, anchor, text in labels:
        box = text_bbox(float(x), float(y), text, cfg["font"], anchor)
        for dot in dots:
            if overlaps(box, dot, pad=0):
                raise RuntimeError(f"{path.name}: 标签 {text!r} 压在圆点上。")


# ---------------------------------------------------------------- 三套配置

DESKTOP = {
    "start": (250, 340),
    "angles": [-34, 16, -34, 16, -34, -34],
    "length": 114.6,
    "font": 13,
    "clip": (218, 62, 714, 326),
    "ring_start": 15,
    "ring_radii": [22, 22, 22, 22, 22],
    "tail": 88,
    # 圆点障碍半径：节点 8 + 描边 + 间隙 = 13；AI 有半径 27 的十字刻度 → 29
    "obstacle_radii": [13, 13, 13, 13, 13, 29],
    "names": ["01 / WOO", "02 / WOO-TODO", "03 / DIGITAL-BRAIN", "04 / T101",
              "05 / NEW-API", "AI / NEXT"],
    "static_labels": [
        (235, 83, "GRID / 07.24"), (820, 83, "SIGNAL / OPEN"),
        (235, 372, "ROUTE / ACTIVE"), (839, 372, "SCALE 1:07"),
    ],
    # 横向空间大，标签可以左右铺开
    "candidates": [
        (0, 26, "middle"), (0, -22, "middle"),
        (-14, -20, "end"), (14, 24, "start"),
        (-12, 26, "end"), (10, -22, "start"),
        (0, 44, "middle"), (0, -38, "middle"),
        (16, 4, "start"), (-16, 4, "end"),
        (0, -52, "middle"), (0, 58, "middle"),
    ],
}

MOBILE = {
    "start": (48, 500),
    "angles": [-35, 12, -35, -35, -35, -35],
    "length": 72.9,
    "font": 14,
    "clip": (18, 162, 444, 386),
    "ring_start": 14,
    "ring_radii": [21, 21, 21, 21, 21],
    "tail": 38,
    "obstacle_radii": [13, 13, 13, 13, 13, 29],
    # 444px 宽塞不下 6 个长标签，所以这里用短名，并优先分列路线两侧
    "names": ["01 WOO", "02 WOO-TODO", "03 BRAIN", "04 T101",
              "05 NEW-API", "AI / NEXT"],
    "static_labels": [
        (31, 182, "ROUTE / ACTIVE"), (378, 182, "REPOS 06"),
        (31, 531, "OPEN ROUTES 01"),
    ],
    "candidates": [
        (-14, -20, "end"), (14, 22, "start"),
        (-14, 22, "end"), (14, -20, "start"),
        (0, -24, "middle"), (0, 26, "middle"),
        (-14, -44, "end"), (14, 46, "start"),
        (0, -50, "middle"), (0, 52, "middle"),
    ],
}

COMPACT = {
    "start": (42, 216),
    "angles": [-12, 8, -12, 8, -12],
    "length": 121.7,
    "font": 16,
    "clip": (26, 148, 668, 108),
    # band 只有 108px 高，标签允许伸到画布空白区
    "label_clip": (12, 104, 696, 172),
    "trailhead": False,
    "ring_radii": [15, 20, 20, 20, 20],
    "tail": 46,
    "obstacle_radii": [13, 13, 13, 13, 13, 29],
    "names": ["01 WOO", "02 WOO-TODO", "03 BRAIN", "04 T101",
              "05 NEW-API", "AI / NEXT"],
    "static_labels": [(452, 96, "REPOS 06 · OPEN 01")],
    "candidates": [
        (0, -22, "middle"), (0, 26, "middle"),
        (-14, -20, "end"), (14, 24, "start"),
        (-12, 26, "end"), (10, -22, "start"),
        (0, -40, "middle"), (0, 42, "middle"),
        (16, 4, "start"), (-16, 4, "end"),
        (-34, -20, "end"), (-34, 8, "end"), (-34, -42, "end"),
    ],
}

TARGETS = [
    ("assets/field-log.svg", DESKTOP),
    ("assets/field-log-mobile.svg", MOBILE),
    ("assets/field-log-compact.svg", COMPACT),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="重排 field-log banner 的路线")
    parser.add_argument(
        "--root",
        default=None,
        help="仓库根目录，默认取本脚本所在的仓库",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    args = parser.parse_args()

    root = Path(args.root) if args.root else Path(__file__).resolve().parents[1]

    touched = 0
    for rel, cfg in TARGETS:
        path = root / rel
        if not path.exists():
            print(f"  跳过（不存在）：{rel}", file=sys.stderr)
            continue
        changed, segs = patch_svg(path, cfg, args.dry_run)
        touched += int(changed)
        state = "已改写" if changed else "无变化"
        print(f"  {rel}")
        print(f"    段长 {[round(s, 1) for s in segs]}  "
              f"最长/最短 = {max(segs) / min(segs):.3f}x  {state}")
        # --dry-run 时不校验磁盘内容（那里还是旧版本，校验必然失败）
        if not args.dry_run:
            verify(path, cfg)

    print()
    if args.dry_run:
        print("（--dry-run，未写入）")
    elif touched:
        print(f"完成：改写 {touched} 个文件。记得提交，"
              "工作流会把 README 的图片地址重新钉到新提交。")
    else:
        print("完成：所有文件都已经是目标状态，没有改动。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
