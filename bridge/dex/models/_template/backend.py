"""机型后端模板。

复制 _template 目录后实现 create_backends()，返回 BackendBundle(robot, hands, cameras)。
"""

from __future__ import annotations

from models.contracts import BackendBundle


def create_backends(node, args, log=print) -> BackendBundle:
    raise NotImplementedError('请在机型目录中实现 create_backends()')
