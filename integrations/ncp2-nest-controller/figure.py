#!/usr/bin/env python3
"""Draw the distance of each drone from its target over time, from the NEST loop evidence.

    python3 figure.py EVIDENCE_DIR OUTPUT.svg

Three panels: one network with one drone, and the two worlds of three networks with five drones.
Standard library only. The colors are the first three slots of a validated categorical palette;
each line also carries its drone's name, and each legend gives the final distance.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from xml.sax.saxutils import escape

COLORS = ["#2a78d6", "#eb6834", "#1baf7a"]  # validated: all pairs, light surface #ffffff
INK, MUTED, GRID = "#172b45", "#4a5d75", "#e1e8f0"
WIDTH, HEIGHT = 1160, 495
PANEL_W, PANEL_H, TOP, LEFT0, GAP = 300, 230, 150, 82, 78
Y_MAX, T_MAX = 16.0, 12.0


def load(evidence: Path, name: str) -> tuple[dict, list[dict]]:
    summary = json.loads((evidence / f"{name}.summary.json").read_text())
    rows = [json.loads(line) for line in (evidence / f"{name}.trajectory.jsonl").read_text().splitlines()]
    return summary, rows


def series(summary: dict, rows: list[dict], world: int, tick_s: float) -> list[tuple[str, list[tuple[float, float]], float]]:
    drones = summary["worlds"][world]["drones"]
    out = []
    for index, drone in enumerate(drones):
        target = drone["target_m"]
        start = [r for r in rows if r["world"] == world][0]
        points = [(0.0, drone["initial_error_m"])]
        for r in rows:
            if r["world"] != world:
                continue
            position = r["position_m"][index * 3 : index * 3 + 3]
            points.append((r["tick_index"] * tick_s, math.dist(position, target)))
        assert start["tick_index"] == 1
        out.append((drone["id"], points, drone["final_error_m"]))
    return out


def panel(x0: float, title: str, subtitle: str, lines) -> list[str]:
    sx = lambda t: x0 + t / T_MAX * PANEL_W
    sy = lambda d: TOP + PANEL_H - d / Y_MAX * PANEL_H
    svg = [f'<rect x="{x0}" y="{TOP}" width="{PANEL_W}" height="{PANEL_H}" fill="#ffffff" stroke="#c9d6e3"/>']
    svg.append(f'<text class="label" x="{x0}" y="{TOP - 44}">{escape(title)}</text>')
    svg.append(f'<text class="small" x="{x0}" y="{TOP - 22}">{escape(subtitle)}</text>')
    for d in (4, 8, 12):
        svg.append(f'<line x1="{x0}" x2="{x0 + PANEL_W}" y1="{sy(d):.1f}" y2="{sy(d):.1f}" stroke="{GRID}"/>')
    for d in (0, 4, 8, 12, 16):
        unit = " m" if d == 16 else ""
        svg.append(f'<text class="tick" x="{x0 - 8}" y="{sy(d) + 4:.1f}" text-anchor="end">{d}{unit}</text>')
    for t in (0, 4, 8, 12):
        unit = " s" if t == 12 else ""
        svg.append(f'<text class="tick" x="{sx(t):.1f}" y="{TOP + PANEL_H + 20}" text-anchor="middle">{t}{unit}</text>')
    for color, (name, points, final) in zip(COLORS, lines):
        step = max(1, len(points) // 150)
        kept = points[::step] + [points[-1]]
        path = " ".join(f"{sx(t):.1f},{sy(d):.1f}" for t, d in kept)
        svg.append(f'<polyline points="{path}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"/>')
    # Direct labels just above the start of each line, where the lines are still flat, in ink.
    for distance, name in sorted(((points[0][1], name) for name, points, _ in lines), reverse=True):
        svg.append(f'<text class="name" x="{sx(0) + 8:.1f}" y="{sy(distance) - 6:.1f}">{escape(name)}</text>')
    # Legend under the panel: color, name, final distance. One line needs no swatch.
    for row, (color, (name, _, final)) in enumerate(zip(COLORS, lines)):
        y = TOP + PANEL_H + 46 + row * 20
        text = f"{escape(name)}: {final * 100:.1f} cm from its target at 12 s"
        if len(lines) == 1:
            svg.append(f'<text class="small" x="{x0}" y="{y}">{text}</text>')
            continue
        svg.append(f'<line x1="{x0}" x2="{x0 + 22}" y1="{y - 5}" y2="{y - 5}" stroke="{color}" stroke-width="3"/>')
        svg.append(f'<text class="small" x="{x0 + 30}" y="{y}">{text}</text>')
    return svg


def main() -> None:
    evidence, output = Path(sys.argv[1]), Path(sys.argv[2])
    one, one_rows = load(evidence, "one-network-one-drone")
    many, many_rows = load(evidence, "three-networks-five-drones")
    tick_s = one["tick_ms"] / 1000
    panels = [
        ("One network, one drone", "a NEST network flies alpha", series(one, one_rows, 0, tick_s)),
        ("World 1: two networks", "one flies alpha and bravo, one charlie", series(many, many_rows, 0, tick_s)),
        ("World 2: one network", "it flies delta and echo", series(many, many_rows, 1, tick_s)),
    ]
    finals = [f for _, _, lines in panels for _, _, f in lines]
    desc = (
        "Three line charts of the distance between each drone's true position and its target, in meters, over 12 seconds "
        f"of simulated time. Every line falls from its start, between {min(p[0][1] for _, _, ls in panels for _, p, _ in ls):.1f} "
        f"and {max(p[0][1] for _, _, ls in panels for _, p, _ in ls):.1f} m, to between {min(finals) * 100:.1f} and "
        f"{max(finals) * 100:.1f} cm at the end."
    )
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="title desc">',
        '  <title id="title">NEST networks fly CREBAIN drones to their targets over NCP 2</title>',
        f'  <desc id="desc">{escape(desc)}</desc>',
        f"  <defs><style>text{{font-family:Arial,Helvetica,sans-serif;fill:{INK}}} .heading{{font-size:25px;font-weight:700}}"
        f".label{{font-size:18px;font-weight:700}}.body{{font-size:16px}}.small{{font-size:14px}}.tick{{font-size:13px;fill:{MUTED}}}.name{{font-size:13px}}</style></defs>",
        f'  <rect width="{WIDTH}" height="{HEIGHT}" rx="20" fill="#f3f6fa"/>',
        '  <text class="heading" x="40" y="48">NEST networks fly CREBAIN drones to their targets over NCP 2</text>',
        '  <text class="body" x="40" y="77">Distance of each drone\'s true position from its target, in meters, over seconds of simulated time</text>',
    ]
    for index, (title, subtitle, lines) in enumerate(panels):
        svg += ["  " + line for line in panel(LEFT0 + index * (PANEL_W + GAP), title, subtitle, lines)]
    svg.append("</svg>")
    output.write_text("\n".join(svg) + "\n")


if __name__ == "__main__":
    main()
