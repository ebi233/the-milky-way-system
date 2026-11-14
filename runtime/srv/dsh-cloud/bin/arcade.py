#!/usr/bin/env python3
"""文字街机 —— 给无头服务器上的 agent 玩的六个小游戏。

用法：
    arcade.py list                          看有什么游戏
    arcade.py new snake                     开一局
    arcade.py show                          看当前画面
    arcade.py do up                         下指令
    arcade.py do r 3 4                      带参数的指令（扫雷：翻开 3,4）
    arcade.py score                         历史最高分

状态存在 ~/arcade/state.json，一次只玩一个游戏。
"""
import json
import os
import random
import sys
from pathlib import Path

HOME = Path(os.environ.get("ARCADE_HOME") or (Path.home() / "arcade"))
STATE = HOME / "state.json"
SCORES = HOME / "scores.json"

# ---------------- 通用 ----------------

def load():
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return None


def save(st):
    HOME.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")


def best_of(game):
    try:
        d = json.loads(SCORES.read_text(encoding="utf-8"))
        return d.get(game, 0)
    except Exception:
        return 0


def submit(st):
    """局终时记分。"""
    try:
        d = json.loads(SCORES.read_text(encoding="utf-8")) if SCORES.exists() else {}
    except Exception:
        d = {}
    game = st["game"]
    score = st.get("score", 0)
    if score > d.get(game, 0):
        d[game] = score
        HOME.mkdir(parents=True, exist_ok=True)
        SCORES.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        return f"新纪录！{game} 最高分 {score}"
    return f"{game} 最高分还是 {d.get(game, 0)}，这局 {score}"


# ---------------- 贪吃蛇 ----------------

W, H = 16, 10


def snake_new(rng):
    return {
        "game": "snake", "w": W, "h": H,
        "snake": [[W // 2, H // 2], [W // 2 - 1, H // 2], [W // 2 - 2, H // 2]],
        "dir": "right", "food": [rng.randrange(W), rng.randrange(H)],
        "score": 0, "alive": True,
    }


def snake_render(st):
    grid = [["·"] * st["w"] for _ in range(st["h"])]
    fx, fy = st["food"]
    if 0 <= fx < st["w"] and 0 <= fy < st["h"]:
        grid[fy][fx] = "★"
    for i, (x, y) in enumerate(st["snake"]):
        if 0 <= x < st["w"] and 0 <= y < st["h"]:
            grid[y][x] = "@" if i == 0 else "o"
    head = "".join(grid[0])
    body = "\n".join("".join(r) for r in grid)
    return f"分数 {st['score']}　长度 {len(st['snake'])}\n{head}\n{body}\n↑↓←→ 用 do up/down/left/right"


def snake_do(st, args, rng):
    if not st["alive"]:
        return "已经死了，new snake 重开"
    d = (args[0] if args else "").lower()
    vec = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
    if d not in vec:
        return "方向只能是 up/down/left/right"
    dx, dy = vec[d]
    hx, hy = st["snake"][0]
    nx, ny = hx + dx, hy + dy
    if not (0 <= nx < st["w"] and 0 <= ny < st["h"]) or [nx, ny] in st["snake"]:
        st["alive"] = False
        return "撞了。\n" + snake_render(st) + "\n" + submit(st)
    st["snake"].insert(0, [nx, ny])
    if [nx, ny] == st["food"]:
        st["score"] += 1
        while True:
            f = [rng.randrange(st["w"]), rng.randrange(st["h"])]
            if f not in st["snake"]:
                st["food"] = f
                break
    else:
        st["snake"].pop()
    return snake_render(st)


# ---------------- 扫雷 ----------------

MW, MH, MINES = 9, 9, 10


def mine_new(rng):
    cells = [[0] * MW for _ in range(MH)]
    spots = rng.sample([(x, y) for x in range(MW) for y in range(MH)], MINES)
    mines = [[False] * MW for _ in range(MH)]
    for x, y in spots:
        mines[y][x] = True
    for y in range(MH):
        for x in range(MW):
            if mines[y][x]:
                cells[y][x] = -1
                continue
            n = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < MW and 0 <= ny < MH and mines[ny][nx]:
                        n += 1
            cells[y][x] = n
    return {"game": "mines", "cells": cells, "open": [[False] * MW for _ in range(MH)],
            "flag": [[False] * MW for _ in range(MH)], "score": 0, "alive": True, "done": False}


def mine_render(st):
    out = ["　 " + " ".join(str(x) for x in range(MW))]
    for y in range(MH):
        row = [str(y)]
        for x in range(MW):
            if st["flag"][y][x]:
                row.append("⚑")
            elif not st["open"][y][x]:
                row.append("■")
            else:
                v = st["cells"][y][x]
                row.append("·" if v == 0 else str(v))
        out.append(" ".join(row))
    flag_n = sum(1 for r in st["flag"] for v in r if v)
    return "\n".join(out) + f"\n踩开 {st['score']}/{MW * MH - MINES}　旗 {flag_n}/{MINES}\n翻开: do r 行 列　插旗: do f 行 列"


def mine_do(st, args, rng):
    if st.get("done") or not st.get("alive"):
        return "这局结束了，new mines 重开"
    if len(args) < 3:
        return "用法: do r 行 列（翻开）或 do f 行 列（插旗）"
    kind, y, x = args[0].lower(), int(args[1]), int(args[2])
    if not (0 <= x < MW and 0 <= y < MH):
        return "坐标越界"
    if kind == "f":
        st["flag"][y][x] = not st["flag"][y][x]
        return mine_render(st)
    if kind != "r":
        return "用 r（翻开）或 f（插旗）"
    if st["flag"][y][x]:
        return "这里插了旗，先 do f 取消"
    if st["cells"][y][x] == -1:
        st["alive"] = False
        return "💥 踩雷了\n" + mine_render(st) + "\n" + submit(st)
    # 泛洪
    stack = [(x, y)]
    while stack:
        cx, cy = stack.pop()
        if not (0 <= cx < MW and 0 <= cy < MH) or st["open"][cy][cx]:
            continue
        st["open"][cy][cx] = True
        st["score"] += 1
        if st["cells"][cy][cx] == 0:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    stack.append((cx + dx, cy + dy))
    if st["score"] >= MW * MH - MINES:
        st["done"] = True
        return "扫完了！\n" + mine_render(st) + "\n" + submit(st)
    return mine_render(st)


# ---------------- 超级玛丽（文字版） ----------------

LEVEL = 28


def mario_new(rng):
    track = ["_"] * LEVEL
    for i in rng.sample(range(2, LEVEL - 2), 6):
        track[i] = "p"          # 坑
    for i in rng.sample([i for i in range(3, LEVEL - 1) if track[i] == "_"], 4):
        track[i] = "x"          # 敌人
    track[LEVEL - 1] = "F"      # 旗子
    return {"game": "mario", "track": track, "pos": 0, "lives": 3, "score": 0, "alive": True, "done": False}


def mario_render(st):
    tr = st["track"][:]
    p = st["pos"]
    line = tr[:]
    if 0 <= p < len(line):
        line[p] = "M"
    return ("".join(tr) + "\n" + "".join(line) +
            f"\n位置 {p}/{LEVEL - 1}　命 {st['lives']}　分数 {st['score']}\n走: do run　跳(越过一格): do jump　冲(抢两格): do dash")


def mario_do(st, args, rng):
    if st.get("done") or not st.get("alive"):
        return "这局结束了，new mario 重开"
    a = (args[0] if args else "run").lower()
    step = {"run": 1, "jump": 2, "dash": 3}.get(a)
    if not step:
        return "用 run / jump / dash"
    cur = st["pos"]
    nxt = cur + step
    # 坑：只有 jump/dash 能越过
    for i in range(cur + 1, min(nxt, LEVEL - 1) + 1):
        cell = st["track"][i]
        if cell == "p" and i == cur + 1 and a == "run":
            st["lives"] -= 1
            st["pos"] = max(0, cur - 1)
            msg = "掉坑里了，扣一条命\n"
            if st["lives"] <= 0:
                st["alive"] = False
                return msg + mario_render(st) + "\n" + submit(st)
            return msg + mario_render(st)
        if cell == "x":
            if a == "jump" or a == "dash":
                st["score"] += 5
                st["track"][i] = "_"
            else:
                st["lives"] -= 1
                msg = "撞到敌人，扣一条命\n"
                if st["lives"] <= 0:
                    st["alive"] = False
                    return msg + mario_render(st) + "\n" + submit(st)
                return msg + mario_render(st)
    st["pos"] = min(nxt, LEVEL - 1)
    st["score"] += step
    if st["track"][st["pos"]] == "F":
        st["done"] = True
        return "到旗子了！\n" + mario_render(st) + "\n" + submit(st)
    return mario_render(st)


# ---------------- 魂斗罗（文字版） ----------------

CW, CH = 10, 6


def contra_new(rng):
    return {"game": "contra", "w": CW, "h": CH, "px": CW // 2, "py": CH - 1,
            "enemies": [[rng.randrange(CW), rng.randrange(0, 3)] for _ in range(4)],
            "score": 0, "alive": True, "wave": 1}


def contra_render(st):
    g = [["·"] * st["w"] for _ in range(st["h"])]
    for ex, ey in st["enemies"]:
        if 0 <= ex < st["w"] and 0 <= ey < st["h"]:
            g[ey][ex] = "E"
    g[st["py"]][st["px"]] = "A"
    body = "\n".join("".join(r) for r in g)
    return f"分数 {st['score']}　第 {st['wave']} 波　敌人 {len(st['enemies'])}\n{body}\n移动: do left/right　开火: do shoot"


def contra_do(st, args, rng):
    if not st["alive"]:
        return "挂了，new contra 重开"
    a = (args[0] if args else "").lower()
    if a in ("left", "right"):
        st["px"] = max(0, min(st["w"] - 1, st["px"] + (-1 if a == "left" else 1)))
    elif a == "shoot":
        # 打同一列最近的敌人
        col = [e for e in st["enemies"] if e[0] == st["px"]]
        if col:
            tgt = max(col, key=lambda e: e[1])
            st["enemies"].remove(tgt)
            st["score"] += 10
        else:
            st["score"] += 0
    else:
        return "用 left / right / shoot"
    # 敌人推进
    for e in st["enemies"]:
        e[1] += 1
    if any(e[1] >= st["h"] for e in st["enemies"]):
        st["alive"] = False
        return "敌人冲下来了\n" + contra_render(st) + "\n" + submit(st)
    if not st["enemies"]:
        st["wave"] += 1
        st["enemies"] = [[rng.randrange(CW), rng.randrange(0, 2)] for _ in range(3 + st["wave"])]
        st["score"] += 20
    return contra_render(st)


# ---------------- 三维弹球（文字版：接球） ----------------

PW = 12


def pinball_new(rng):
    return {"game": "pinball", "w": PW, "ball": rng.randrange(PW), "paddle": PW // 2 - 1,
            "vx": rng.choice([-1, 1]), "score": 0, "lives": 3, "alive": True}


def pinball_render(st):
    b = ["·"] * st["w"]
    b[st["ball"]] = "●"
    p = ["_"] * st["w"]
    for i in (st["paddle"], st["paddle"] + 1, st["paddle"] + 2):
        if 0 <= i < st["w"]:
            p[i] = "▔"
    return (f"分数 {st['score']}　球 {st['lives']}\n" + "".join(b) + "\n" +
            "".join(p) + "\n接球: do left/right（挡板移动后球继续掉，一回合一步）")


def pinball_do(st, args, rng):
    if not st["alive"]:
        return "球用完了，new pinball 重开"
    a = (args[0] if args else "").lower()
    if a in ("left", "right"):
        st["paddle"] = max(0, min(st["w"] - 3, st["paddle"] + (-1 if a == "left" else 1)))
    elif a != "stay":
        return "用 left / right / stay"
    # 球下落一格（左右弹）
    nb = st["ball"] + st["vx"]
    if nb < 0 or nb >= st["w"]:
        st["vx"] *= -1
        nb = st["ball"] + st["vx"]
    st["ball"] = max(0, min(st["w"] - 1, nb))
    if st["ball"] in (st["paddle"], st["paddle"] + 1, st["paddle"] + 2):
        st["score"] += 10
        st["ball"] = rng.randrange(st["w"])
        st["vx"] = rng.choice([-1, 1])
        return "接住了！\n" + pinball_render(st)
    if st["ball"] >= st["w"] - 1 or st["ball"] <= 0:
        pass
    # 简化：球到底就算漏（用回合数近似）
    st["lives"] -= 1
    if st["lives"] <= 0:
        st["alive"] = False
        return "漏光了\n" + pinball_render(st) + "\n" + submit(st)
    st["ball"] = rng.randrange(st["w"])
    st["vx"] = rng.choice([-1, 1])
    return "漏了一球\n" + pinball_render(st)


# ---------------- 我的世界（文字版：方块世界） ----------------

VW, VH = 12, 8


def mc_new(rng):
    world = []
    for y in range(VH):
        row = []
        for x in range(VW):
            if y == 0:
                row.append("草")
            elif y < 3:
                row.append("土")
            else:
                row.append(rng.choice(["石", "石", "空", "空"]))
        world.append(row)
    return {"game": "mc", "w": VW, "h": VH, "world": world, "px": VW // 2, "py": 1,
            "inv": {"土": 0, "石": 0}, "score": 0}


def mc_render(st):
    out = []
    for y in range(st["h"]):
        row = []
        for x in range(st["w"]):
            if (x, y) == (st["px"], st["py"]):
                row.append("我")
            else:
                row.append(st["world"][y][x])
        out.append("".join(row))
    return ("\n".join(out) +
            f"\n背包 土×{st['inv'].get('土',0)} 石×{st['inv'].get('石',0)}\n"
            "移动: do up/down/left/right　挖: do dig 　放: do place 土/石")


def mc_do(st, args, rng):
    a = (args[0] if args else "").lower()
    if a in ("up", "down", "left", "right"):
        dx, dy = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}[a]
        nx, ny = st["px"] + dx, st["py"] + dy
        if 0 <= nx < st["w"] and 0 <= ny < st["h"]:
            st["px"], st["py"] = nx, ny
        return mc_render(st)
    if a == "dig":
        cell = st["world"][st["py"]][st["px"]]
        if cell in ("土", "石"):
            st["inv"][cell] = st["inv"].get(cell, 0) + 1
            st["score"] += 1
            st["world"][st["py"]][st["px"]] = "空"
            return f"挖到 {cell}\n" + mc_render(st)
        return "这儿没东西可挖\n" + mc_render(st)
    if a == "place":
        kind = args[1] if len(args) > 1 else "土"
        if kind not in ("土", "石"):
            return "只能放 土 或 石"
        if st["inv"].get(kind, 0) <= 0:
            return f"背包里没有{kind}"
        if st["world"][st["py"]][st["px"]] != "空":
            return "脚下有东西，先挖开"
        st["inv"][kind] -= 1
        st["world"][st["py"]][st["px"]] = kind
        return mc_render(st)
    return "用 up/down/left/right / dig / place 土"


# ---------------- 调度 ----------------

GAMES = {
    "snake": ("贪吃蛇", snake_new, snake_render, snake_do),
    "mines": ("扫雷", mine_new, mine_render, mine_do),
    "mario": ("超级玛丽（文字版）", mario_new, mario_render, mario_do),
    "contra": ("魂斗罗（文字版）", contra_new, contra_render, contra_do),
    "pinball": ("三维弹球（文字版）", pinball_new, pinball_render, pinball_do),
    "mc": ("我的世界（文字版方块）", mc_new, mc_render, mc_do),
}


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("list", "-h", "--help"):
        print("游戏：")
        for k, (name, *_rest) in GAMES.items():
            print(f"  {k:<8} {name}　最高分 {best_of(k)}")
        print("\n开一局: arcade.py new <游戏>")
        return
    cmd = argv[0]
    rng = random.Random()

    if cmd == "new":
        if len(argv) < 2 or argv[1] not in GAMES:
            print("要指定游戏：" + " / ".join(GAMES))
            return
        key = argv[1]
        st = GAMES[key][1](rng)
        save(st)
        print(GAMES[key][2](st))
        return

    st = load()
    if not st:
        print("还没有开局，先 arcade.py new <游戏>")
        return
    if cmd == "show":
        print(GAMES[st["game"]][2](st))
        return
    if cmd == "score":
        print(f"{st['game']} 这局 {st.get('score', 0)}，历史最高 {best_of(st['game'])}")
        return
    if cmd == "do":
        out = GAMES[st["game"]][3](st, argv[1:], rng)
        save(st)
        print(out)
        return
    print("不认识的命令，用 list / new / show / do / score")


if __name__ == "__main__":
    main()
