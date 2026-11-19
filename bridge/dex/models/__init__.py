"""机型适配目录。

每个机型一个子目录，通过 model.json 声明机型 ID 与模块映射；
discovery.discover_models() 自动扫描，新增机型无需修改本文件。

协议层入口 dex_bridge.py 通过 bootstrap() 把当前机型目录注入 sys.path，
使机型模块内的扁平 import（from joint_map import ...）继续可用。
"""

from __future__ import annotations

import os
import sys

from .discovery import discover_models

# 兼容旧调用方：MODEL_DIRS 仍可用，但内容由自动发现生成。
MODEL_DIRS = {model_id: info['dir'] for model_id, info in discover_models().items()}

DEFAULT_MODEL = 'walker-tienkung-dex'


def model_dir(model: str) -> str | None:
    """返回机型对应的目录名；未登记的机型返回 None。"""
    return MODEL_DIRS.get(model)


def bootstrap(model: str) -> str:
    """把机型目录加入 sys.path 首位，返回该目录的绝对路径。

    未登记机型直接报错，避免拼写错误静默回退到 Dex。
    """
    dirname = model_dir(model)
    if dirname is None:
        available = ', '.join(sorted(MODEL_DIRS)) or '(无)'
        raise SystemExit(f'[models] 未知机型：{model!r}；可用机型：{available}')

    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, dirname)
    if path not in sys.path:
        sys.path.insert(0, path)
    return path
