"""机型后端模板。

复制 _template 目录后实现 create_backends()，返回 robot/hands/cameras 三元组。
"""

from __future__ import annotations


def create_backends(node, args, log=print):
    raise NotImplementedError('请在机型目录中实现 create_backends()')
