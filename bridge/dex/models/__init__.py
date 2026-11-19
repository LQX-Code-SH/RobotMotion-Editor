"""机型适配目录。

每个机型一个子目录，包含该机型专属的：
  - joint_map.py   URDF 关节名 ↔ SDK 关节 ID/名 ↔ 限位
  - *_robot.py     关节控制与状态缓存（话题 / SDK 适配）
  - *_hands.py     末端执行器控制（实现 BaseHands 接口）
  - *_camera.py    相机 relay

协议层入口 dex_bridge.py 通过 bootstrap() 把当前机型目录注入 sys.path，
使机型模块内的扁平 import（from joint_map import ...）继续可用。
"""

from __future__ import annotations

import os
import sys

# 机型标识 → models/ 下的目录名。新增机型在此登记一行即可。
MODEL_DIRS = {
    'walker-tienkung-dex': 'tienkung_dex',
    'walker-tienkung-pro': 'tienkung_pro',
    'walker-c1': 'walker_c1',
    'walker-s2': 'walker_s2',
}

DEFAULT_MODEL = 'walker-tienkung-dex'


def model_dir(model: str) -> str | None:
    """返回机型对应的目录名；未登记的机型返回 None。"""
    return MODEL_DIRS.get(model)


def bootstrap(model: str) -> str:
    """把机型目录加入 sys.path 首位，返回该目录的绝对路径。

    未登记的机型回退到默认机型目录（Dex），避免协议层 import 失败。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    dirname = model_dir(model) or model_dir(DEFAULT_MODEL)
    path = os.path.join(here, dirname)
    if path not in sys.path:
        sys.path.insert(0, path)
    return path
