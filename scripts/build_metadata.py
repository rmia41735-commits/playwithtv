#!/usr/bin/env python3
"""Build deterministic, metadata-only channel catalog. No URLs or credentials."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'metadata' / 'channels.json'
TARGET = ROOT / 'generated' / 'channels.json'


def main():
    raw = json.loads(SOURCE.read_text(encoding='utf-8'))
    if not isinstance(raw, list):
        raise ValueError('Channel source must be an array')
    seen = set()
    channels = []
    for item in raw:
        if not isinstance(item, dict) or set(item) != {'name', 'category'}:
            raise ValueError('Only name and category fields are permitted')
        name = item['name'].strip()
        category = item['category'].strip()
        if not name or not category:
            raise ValueError('Empty name/category')
        key = (category.casefold(), name.casefold())
        if key not in seen:
            channels.append({'name': name, 'category': category})
            seen.add(key)
    channels.sort(key=lambda c: (c['category'].casefold(), c['name'].casefold()))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps({'channels': channels, 'count': len(channels)}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Built {len(channels)} unique metadata records')

if __name__ == '__main__':
    main()
