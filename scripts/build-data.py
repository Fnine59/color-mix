"""Parse downloaded text as DATA only: no eval, JS runtime, or HTML scripts."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / "scripts/kuelox-source.txt"
text = source.read_text()
groups = re.findall(
    r"\{id:'([^']+)',(?:group:'([^']+)',)?palette:'([^']+)',products:\[([^\]]*)\],rows:`([^`]+)`\}",
    text,
)
assert len(groups) == 8
shared = set(re.search(r"const selectedShared=new Set\('([^']+)'", text)[1].split())
rules = text.split("const familyRules={", 1)[1]
families = {}
for quoted, plain, body in re.findall(r"(?:'([^']+)'|(\w+)):\{([^}]+)\}", rules):
    families[quoted or plain] = {
        code: family
        for family, codes in re.findall(r"'([^']+)':'([^']+)'", body)
        for code in codes.split()
    }
colors = {}
conflicts = []
for group, parent, palette, products, rows in groups:
    products = re.findall(r"'([^']+)'", products)
    for row in rows.strip().splitlines():
        code, en, zh, hex_value = row.split("|")
        assert re.fullmatch(r"\d{3}", code) and re.fullmatch(r"#[0-9A-Fa-f]{6}", hex_value)
        memberships = products + (["selected-72"] if group in ("macaron", "classic", "morandi") and code in shared else [])
        variant = dict(source=group, nameEn=en, nameZh=zh, hex=hex_value.upper(), products=memberships)
        if code not in colors:
            colors[code] = dict(code=code, nameEn=en, nameZh=zh, hex=hex_value.upper(),
                                family=families[group].get(code, "Grey & Neutral"),
                                palettes=[], products=[], materialType="oil-pastel", variants=[])
        color = colors[code]
        if hex_value.upper() != color["hex"]:
            conflicts.append(code)
        for key, values in [("products", memberships), ("palettes", [parent or group])]:
            color[key] = list(dict.fromkeys(color[key] + values))
        color["variants"].append(variant)
assert len(colors) == 237, len(colors)
data = dict(
    source="https://kueloxvibelab.com/pages/color-codes-index",
    retrieved="2026-11-17",
    sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
    valueNote="官网色块值，不是实测。同色号跨系列色块不同，沿用官网首条优先的合并规则，variants 保留全部原值。",
    expectedCount=237, count=len(colors), missingCodes=[],
    conflictingCodes=sorted(set(conflicts)),
    products=[
        dict(id=id, label=label) for id, label in [
            ("extra-soft", "Extra Soft · 超软"),
            ("professional-soft", "Professional Grade · 专业"),
            ("beginner-super-soft", "Beginner Grade · 入门"),
            ("selected-72", "Selected 72 · 木盒"),
            ("chinese-traditional", "Chinese Traditional · 中国传统色"),
            ("skyists", "Skyists Ultra Soft · 艺术家超软"),
        ]
    ],
    colors=list(colors.values()),
)
(ROOT / "site/data/kuelox.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print(f"整理 {len(colors)} 色，无缺失；{len(set(conflicts))} 个跨系列色块冲突已保留。")
