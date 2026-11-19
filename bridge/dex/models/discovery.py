"""机型自动发现。

扫描 models/ 下含 model.json 与 backend.py 的子目录，不再手工维护机型列表。
_template、common 以及下划线开头的目录不参与发现。
"""

from __future__ import annotations

import json
import os

MODELS_DIR = os.path.dirname(os.path.abspath(__file__))
IGNORED_DIRS = {'_template', 'common', '__pycache__'}


def discover_models() -> dict[str, dict]:
    """返回 {机型 ID: 机型元信息}，按目录名排序。"""
    discovered: dict[str, dict] = {}
    for name in sorted(os.listdir(MODELS_DIR)):
        if name.startswith('_') or name in IGNORED_DIRS:
            continue
        path = os.path.join(MODELS_DIR, name)
        if not os.path.isdir(path):
            continue

        meta_path = os.path.join(path, 'model.json')
        backend_path = os.path.join(path, 'backend.py')
        if not os.path.isfile(meta_path) or not os.path.isfile(backend_path):
            continue

        with open(meta_path, encoding='utf-8') as handle:
            meta = json.load(handle)

        model_id = meta.get('id')
        if not model_id:
            continue
        if model_id in discovered:
            raise ValueError(f'机型 ID 重复：{model_id}（{discovered[model_id]["dir"]} 与 {name}）')

        discovered[model_id] = {
            'dir': name,
            'displayName': meta.get('displayName') or model_id,
            'backend': meta.get('backend') or f'models.{name}.backend',
            'jointMap': meta.get('jointMap') or f'models.{name}.joint_map',
            'capabilities': meta.get('capabilities') or {},
        }
    return discovered
