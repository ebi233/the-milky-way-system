#!/usr/bin/env python3
"""把 /srv/dsh-cloud/home/persona.md 套用成 agent 的系统提示（幂等版 v2）。

定位方式：找到 `- id: persona` 这个插件条目，整段替换它的 config，
不再依赖「原始 coding-agent 块」这个锚点（那个在反复套用后就没了）。

用法：
    sudo python3 apply-persona.py            # 套用并重启
    sudo python3 apply-persona.py --no-restart
"""
import pathlib
import re
import shutil
import subprocess
import sys

PERSONA = pathlib.Path("/srv/dsh-cloud/home/persona.md")
PATCH = pathlib.Path(
    "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml"
)
BACKUP = pathlib.Path("/srv/dsh-cloud/home/.standard.patch.original.bak")


def die(msg: str) -> None:
    print(f"错误: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if not PERSONA.exists():
        die(f"找不到人设文件 {PERSONA}")
    persona = PERSONA.read_text(encoding="utf-8").strip("\n")
    persona = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", persona)
    if len(persona) < 50:
        die("人设内容太短（至少 50 字）")

    if not PATCH.exists():
        die(f"找不到 {PATCH}")

    text = PATCH.read_text(encoding="utf-8")

    # 首次：留一份“安装包原始版”的备份（只留一次，之后不动它）
    if not BACKUP.exists():
        shutil.copy2(PATCH, BACKUP)
        print(f"已备份原始预设 -> {BACKUP}")

    # 每次套用前，先做一份可回滚的当前版备份
    shutil.copy2(PATCH, pathlib.Path("/tmp/standard.patch.yml.pre"))

    # 构造新的 persona 条目
    block = (
        "          - id: persona\n"
        "            name: '@deepseek-ai/dsh-persona'\n"
        "            config:\n"
        "              prefix: |-\n"
    )
    for line in persona.split("\n"):
        block += "                " + line + "\n"
    block += "              complete: true\n              includeRuntimeContext: false"

    # 定位并替换：从 `          - id: persona\n` 到下一个同缩进的 `          - id: `
    start = text.find("          - id: persona\n")
    if start < 0:
        die("没找到 persona 条目（缩进或结构变了）")
    tail = text[start + 1:]
    m = re.search(r"\n          - id: ", tail)
    if m:
        end = start + 1 + m.start()
        new_text = text[:start] + block + text[end:]
    else:
        new_text = text[:start] + block

    PATCH.write_text(new_text, encoding="utf-8")
    print(f"已写入人设：{len(persona.splitlines())} 行 / {len(persona)} 字符")

    # 校验：YAML 能解析（容忍 !js 等自定义标签）
    try:
        import yaml

        class _Lenient(yaml.SafeLoader):
            pass

        _Lenient.add_multi_constructor("tag:yaml.org,2002:", lambda loader, suffix, node: None)
        _Lenient.add_multi_constructor("!", lambda loader, suffix, node: None)
        with PATCH.open(encoding="utf-8") as f:
            yaml.load(f, Loader=_Lenient)
    except ModuleNotFoundError:
        pass
    except Exception as error:
        shutil.copy2(pathlib.Path("/tmp/standard.patch.yml.pre"), PATCH)
        die(f"生成的 YAML 解析失败，已回滚：{error}")

    if "--no-restart" in sys.argv:
        print("（--no-restart：没有重启，改动不会生效）")
        return

    print("重启 dsh-cloud ...")
    rc = subprocess.run(["systemctl", "restart", "dsh-cloud"]).returncode
    if rc != 0:
        die("重启失败，看 journalctl -u dsh-cloud")
    print("完成。验证：systemctl is-active dsh-cloud")


if __name__ == "__main__":
    main()
