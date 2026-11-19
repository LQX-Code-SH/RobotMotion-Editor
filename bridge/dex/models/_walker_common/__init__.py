"""Walker 家族（S2 / C1）共享的 ROS2 后端骨架。

两个机型同消息族（mc_task_msgs/RobotCommand + JointCmd，按关节名寻址），
差异在关节映射表与末端执行器，由各机型目录的 joint_map.py 提供。
共享模块以 `models._walker_common` 包导入，不作为独立机型注册。
"""
