/**
 * 国际化工具 - 支持中文和英文
 */

// 获取版本号（构建时会替换为实际版本号）
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

export const translations = {
    'zh-CN': {
        // 顶部控制栏
        'visual': '视觉',
        'collision': '碰撞',
        'com': '质心',
        'inertia': '惯量',
        'axes': '坐标轴',
        'jointAxes': '关节轴',
        'eeControl': '末端控制',
        'eeControlHint': '拖动箭头移动末端，拖动圆环调整姿态；R 循环切换平移/旋转，Tab 切换末端',
        'eeModeTranslate': '平移',
        'eeModeRotate': '旋转',
        'eeErrorPos': '位置误差',
        'eeErrorRot': '姿态误差',
        'eeNoChains': '当前模型无可控末端',
        'eeReady': '已就绪：拖动坐标轴 / 旋转环',
        'eeConverged': '已到达目标位姿',
        'eeLimitReached': '受关节限位限制',
        'eeUnreachable': '超出可达范围',
        'eeControlMenuHint': '末端控制选项：模式、腰部锁定、切换末端',
        'eeMenuTitle': '末端控制',
        'eeMenuMode': '模式',
        'eeMenuWaistLock': '锁定腰部关节',
        'eeMenuNoWaist': '当前模型无腰部关节',
        'eeMenuChains': '末端',
        'eeActive': '当前',
        'jointAxesSelect': '要显示的关节轴',
        'jointAxesEmpty': '当前模型没有可显示的关节轴',
        'linkAxesSelect': '要显示的坐标轴',
        'linkAxesEmpty': '当前模型没有可显示的坐标轴',
        'axesClickHint': '点击名称仅显示该项；勾选框可多选',
        'selectAll': '全选',
        'selectNone': '全不选',
        'shadow': '阴影',
        'lighting': '光照',
        'grid': '网格',
        'files': '文件',
        'joints': '关节',
        'structure': '结构',
        'edit': '编辑',
        'animation': '动画',
        'help': '帮助',
        'theme': '主题',
        'language': '语言',
        'viewOrientation': '视角方向',
        'alignViewAxis': '沿轴查看',
        'flipViewAxis': '再次点击查看反面',

        // 面板标题
        'fileList': '文件',
        'jointControl': '关节',
        'jointPartHead': '头部',
        'jointPartLeftArm': '左臂',
        'jointPartRightArm': '右臂',
        'jointPartArm': '上肢',
        'jointPartLeftHand': '左手',
        'jointPartRightHand': '右手',
        'jointPartHand': '手部',
        'jointPartWaist': '腰',
        'jointPartLeftLeg': '左腿',
        'jointPartRightLeg': '右腿',
        'jointPartLeg': '下肢',
        'jointPartOther': '其他',
        'modelStructure': '结构',
        'codeEditor': '编辑',
        'animationEditor': '动画编辑器',
        'animationExperimental': '实验功能 · 仍在开发中',

        // 动画编辑器
        'autoKey': '自动关键帧',
        'addKeyframe': '添加关键帧',
        'deleteKeyframe': '删除关键帧',
        'time': '时间',
        'duration': '时长',
        'loop': '循环',
        'importAnimation': '导入',
        'exportAnimation': '导出',
        'animationNoModel': '请加载 URDF、Xacro 或 MJCF 模型后制作动画。',
        'animationHint': '双击轨道添加关键帧；拖动菱形可调整关键帧时间。',
        'dopeSheet': '时间表',
        'graphView': '曲线',
        'catalogCustom': '＋ 新建机型 / 自定义机型…',
        'playToRobot': '真机播放',
        'playToRobotTitle': '把当前动画播放到真机',
        'playToRobotOffline': '未连接真机：请先在“真机控制”面板连接',
        'playToRobotNoClip': '没有可播放的动画',
        'playToRobotRunning': '正在播放到真机…',
        'addMarker': '标记',
        'addMedia': '媒体',
        'snapFrames': '吸附 30fps',
        'zoom': '缩放',
        'keyTime': '关键帧时间',
        'keyValue': '数值',
        'interpolation': '插值',
        'autoSmooth': '自动平滑',
        'smooth': '平滑',
        'broken': '自由手柄',
        'linear': '线性',
        'step': '阶跃',
        'selectionHint': 'Shift 多选，Ctrl/Cmd 切换选择，拖动空白区域框选。',
        'animationName': '动画名称',
        'markerName': '标记名称',
        'animationGuideStartTitle': '先记录起始姿势',
        'animationGuideStartText': '保持模型当前姿势，点击“记录起始姿势”。系统会记录全部关节并自动前进 1 秒。',
        'animationGuideStartButton': '记录起始姿势',
        'animationGuideAdjustTitle': '调整下一个姿势',
        'animationGuideAdjustText': '时间已到 {time}。在左侧关节面板拖动滑块，自动关键帧会记录变化；完成后继续。',
        'animationGuideContinueTitle': '继续添加姿势',
        'animationGuideContinueText': '已有 {count} 个姿势时间点，当前 {time}。调整模型后记录并前进，或直接播放预览。',
        'animationGuideRecord': '记录当前姿势',
        'animationGuideNext': '记录并前进 1 秒',
        'animationGuidePlay': '播放',
        'animationPoseRecorded': '已在 {time} 记录 {count} 个关节',
        'animationPoseRecordedNext': '姿势已记录，时间已前进到 {time}',
        'animationAutoKeyOn': '自动关键帧已开启：调整关节后会自动记录',
        'animationAutoKeyOff': '自动关键帧已关闭',
        'animationAutoKeyed': '已自动记录 {joint} · {time}',
        'animationImported': '已导入动画“{name}”',
        'animationAdd': '添加',
        'animationAddPose': '记录当前完整姿势',
        'animationAddPoseNext': '记录姿势并前进 1 秒',
        'animationAddSelectedKey': '仅给选中轨道添加关键帧',
        'animationAddMedia': '添加音频或视频',
        'animationAddEvent': '添加事件轨道',
        'animationAddMarker': '添加时间标记',
        'animationSavePose': '保存为可复用姿势',
        'animationKeySavedPose': '记录已保存姿势',
        'animationAudioReactive': '从音频生成关键帧',
        'animationClip': '动画',
        'animationClipOptions': '动画选项',
        'animationNewClip': '新建动画',
        'animationDuplicateClip': '复制副本',
        'animationRenameClip': '重命名',
        'animationDeleteClip': '删除',
        'animationUndo': '撤销 (Ctrl/Cmd+Z)',
        'animationRedo': '重做 (Ctrl/Cmd+Shift+Z)',
        'animationStop': '停止',
        'animationPlayPause': '播放/暂停（空格）',
        'animationRecordHint': '录制已武装或选中的轨道',
        'animationLiveInput': '实时输入（手柄）',
        'animationGuideOpen': '快速开始',
        'animationProjectFile': '项目文件',
        'animationImportJson': '导入 JSON',
        'animationExportJson': '导出 JSON',
        'animationClose': '关闭',
        'animationPrevKey': '上一个关键帧 (J)',
        'animationNextKey': '下一个关键帧 (K)',
        'animationPrevFrame': '上一帧 (←)',
        'animationNextFrame': '下一帧 (→)',
        'animationEditSelection': '编辑选区',
        'animationCopy': '复制',
        'animationPaste': '粘贴',
        'animationDeleteSelection': '删除所选',
        'animationLoopHint': '循环播放',
        'animationSnapHint': '吸附到 30 fps 帧',
        'animationZoomHint': '时间轴缩放',
        'animationFitTime': '适配动画',
        'animationFitValue': '适配曲线数值',
        'animationFreeMove': '自由移动',
        'animationLockTimeAxis': '锁定到时间轴',
        'animationLockValueAxis': '锁定到数值轴',
        'animationLockGraph': '锁定显示曲线到当前选择',
        'animationUnlockGraph': '解锁显示曲线',
        'animationEventState': '状态',
        'animationEventColor': '颜色',
        'animationSavedPose': '已保存姿势',
        'animationPose': '姿势',
        'animationDeletePose': '删除已保存姿势',
        'animationSelectionHelp': 'Shift 加选 · Ctrl/Cmd 切换 · Alt/Option+单击或双击选中整列 · 轨道红点参与录制',
        'animationDismiss': '关闭',
        'animationLiveInputTitle': '实时输入',
        'animationLiveInputDesc': '映射手柄轴或键盘按键，然后录制为可编辑关键帧。',
        'animationNoGamepad': '未检测到手柄',
        'animationKeyboardReady': '键盘就绪 · 未检测到手柄',
        'animationAxes': '轴',
        'animationButtons': '按键',
        'animationClearInput': '清空',
        'animationAutoMapAxes': '自动映射轴',
        'animationAudioReactiveTitle': '音频驱动关键帧',
        'animationAudioReactiveDesc': '把导入的波形转换为可编辑的关节关键帧。',
        'animationAudioSource': '音频来源',
        'animationTargetTrack': '目标轨道',
        'animationMinimum': '最小值',
        'animationMaximum': '最大值',
        'animationKeysPerSecond': '每秒关键帧',
        'animationSmoothing': '平滑',
        'animationReplaceKeys': '替换生成区间内的现有键',
        'animationGeneratedEditable': '生成的关键帧仍可在时间表与曲线视图中编辑。',
        'animationGenerateKeys': '生成关键帧',
        'animationShortcuts': '空格 播放 · J/K 关键帧 · ←/→ 帧 · Ctrl/Cmd C/V · Delete · Ctrl/Cmd Z',
        'animationTracks': '轨道',
        'animationGraphEmpty': '选择一个或多个轨道以编辑曲线',
        'animationImportAudioFirst': '请先导入音频文件并选择一个可动关节轨道。',
        'animationSaveFailed': '保存失败',
        'animationKeyCount': '{count} 个关键帧',
        'animationDefaultName': '动画 {index}',
        'animationUnmapped': '不映射',
        'animationAxisN': '轴 {index}',
        'animationKeysPair': '按键 {keys}',
        'animationInvert': '反向',
        'animationSmoothShort': '平滑',
        'animationLoadRobotFirst': '请先加载带可动关节的机器人。',
        'animationEventTrackName': '事件轨道名称',
        'animationEventTrigger': '触发事件',
        'animationEventOnOff': '开关事件',
        'animationEventValue': '数值事件',
        'animationEventColorEvent': '颜色事件',
        'animationPoseName': '姿势名称',
        'animationPoseDefault': '姿势 {index}',
        'animationMediaImportFailed': '媒体导入失败：{message}',
        'animationImportFailed': '动画导入失败：{message}',
        'animationUnsupportedMedia': '不支持的媒体文件',

        // 关节控制
        'radian': '弧度',
        'degree': '角度',
        'reset': '重置',
        'limits': '限位',

        // MuJoCo 仿真
        'mujocoReset': '重置',
        'mujocoSimulate': '仿真',
        'mujocoPause': '暂停',

        // 代码编辑器
        'reload': '重新加载',
        'download': '下载',
        'saved': '已保存',
        'unsaved': '未保存',
        'noFileOpen': '未打开文件',

        // 帮助对话框
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'robot': '真机',
        'robotPanelTitle': '真机控制',
        'robotCatalogLabel': '机型选择',
        'about': '关于',
        'aboutContent': 'Robot Viewer 是一个基于 Three.js 的网页端机器人模型 3D 查看器，提供直观的可视化界面，帮助您在浏览器中查看和分析机器人的结构、关节和物理属性，无需安装任何软件。<br><br>格式支持：URDF、Xacro、MJCF、USD（部分支持）<br>机器人类型：串联、分支结构及 MJCF 并联机构<br>并联机构支持关节联动，调整姿态时自动保持闭环。<br><br>由 <strong>范子琦</strong> 开发。',
        'projectHome': '项目主页',
        'email': '邮箱',
        'myGithub': '我的GitHub',
        'operations': '操作指南',
        'leftDrag': '左键拖动',
        'rotateView': '旋转视角',
        'rightDrag': '右键拖动',
        'panView': '平移视角',
        'scroll': '滚轮',
        'zoom': '缩放视图',
        'clickModel': '点击模型',
        'controlJoint': '控制关节（可拖动）',
        'dragFile': '拖拽文件',
        'loadModel': '加载机器人模型',
        'contact': '联系方式',
        'support': '支持',

        // 其他
        'noFolder': '未加载文件夹',
        'noModel': '未加载模型',
        'load': '加载',
        'loadFiles': '加载文件',
        'loadFolder': '加载文件夹',
        'orClickButton': '或点击下面的按钮加载',
        'noControllableJoints': '未找到可控制关节',
        'closedChainReady': '闭链约束已闭合',
        'closedChainPartial': '此模型含有暂未支持的约束',
        'actuatedJoint': '驱动',
        'springJoint': '弹性',
        'springJointHint': '弹簧关节；刚性网格不显示弹簧弯曲，较大偏转时外观可能出现间隙',
        'closedChainUnreachable': '此位置无法闭合，已保留上一姿态',
        'clickToEditMin': '点击编辑下限',
        'clickToEditMax': '点击编辑上限',
        'dropHint': '拖拽机器人模型文件或文件夹到页面任意位置',
        'dropHintSub': '支持 URDF, Xacro, MJCF 格式<br>支持拖拽文件夹以加载mesh文件',
        'graphHint': '拖动: 移动 | 滚轮: 缩放 | 右键: 隐藏/显示 | Ctrl+左键: 测量',
        'copyright': '© 2025 范子琦 版权所有。',

        // 模型信息
        'type': '类型',
        'links': 'Links',
        'joints': '关节',
        'controllable': '可控',
        'rootLink': '根Link',

        // 悬浮信息
        'linkName': 'Link名称',
        'jointName': '关节',
        'mass': '质量',
        'mergedLinks': '合并的Links',

        // 文件类型
        'model': '模型',
        'mesh': '网格',
        'link': '链接',

        // 单位
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // 状态消息
        'loading': '正在加载',
        'unsupportedFormat': '不支持的文件格式',
        'loadFailed': '加载失败',
        'noSupportedFiles': '未找到支持的文件（URDF, Xacro, MJCF, DAE, STL, OBJ）',
        'loadSuccess': '模型加载成功',
        'cannotLoadMesh': '无法加载 mesh 文件',

        // 编辑器消息
        'unsavedChanges': '您有未保存的更改，确定要关闭吗？',
        'newFile': '新文件.xml',
        'noFileToReload': '没有可重新加载的文件',
        'saveFirst': '请先保存为文件后再加载',
        'reloadingModel': '正在重新加载模型...',
        'modelReloaded': '模型已重新加载（未保存）',
        'reloadFailed': '重新加载失败',
        'downloadFailed': '下载失败',
        'fileDownloaded': '文件已下载',
        'emptyContent': '编辑器内容为空，无法加载',
        'fileType': '文件类型'
    },
    'en-US': {
        // Top control bar
        'visual': 'Visual',
        'collision': 'Collision',
        'com': 'COM',
        'inertia': 'Inertia',
        'axes': 'Axes',
        'jointAxes': 'Joint Axes',
        'eeControl': 'End Effector',
        'eeControlHint': 'Drag arrows to move, rings to rotate; R cycles move/rotate, Tab switches effector',
        'eeModeTranslate': 'Move',
        'eeModeRotate': 'Rotate',
        'eeErrorPos': 'Position error',
        'eeErrorRot': 'Orientation error',
        'eeNoChains': 'No controllable end effector',
        'eeReady': 'Ready: drag the gizmo',
        'eeConverged': 'Target pose reached',
        'eeLimitReached': 'Limited by joint limits',
        'eeUnreachable': 'Out of reach',
        'eeControlMenuHint': 'End effector options: mode, waist lock, switch effector',
        'eeMenuTitle': 'End Effector',
        'eeMenuMode': 'Mode',
        'eeMenuWaistLock': 'Lock waist joints',
        'eeMenuNoWaist': 'No waist joints on this model',
        'eeMenuChains': 'End effectors',
        'eeActive': 'Active',
        'jointAxesSelect': 'Joint axes to show',
        'jointAxesEmpty': 'No joint axes for this model',
        'linkAxesSelect': 'Coordinate axes to show',
        'linkAxesEmpty': 'No coordinate axes for this model',
        'axesClickHint': 'Click a name to show only it; checkboxes for multi-select',
        'selectAll': 'All',
        'selectNone': 'None',
        'shadow': 'Shadow',
        'lighting': 'Lighting',
        'grid': 'Grid',
        'files': 'Files',
        'joints': 'Joints',
        'structure': 'Structure',
        'edit': 'Edit',
        'animation': 'Animation',
        'help': 'Help',
        'theme': 'Theme',
        'language': 'Language',
        'viewOrientation': 'View orientation',
        'alignViewAxis': 'View along axis',
        'flipViewAxis': 'Click again for the opposite view',

        // Panel titles
        'fileList': 'Files',
        'jointControl': 'Joints',
        'jointPartHead': 'Head',
        'jointPartLeftArm': 'Left arm',
        'jointPartRightArm': 'Right arm',
        'jointPartArm': 'Upper limbs',
        'jointPartLeftHand': 'Left hand',
        'jointPartRightHand': 'Right hand',
        'jointPartHand': 'Hand',
        'jointPartWaist': 'Waist',
        'jointPartLeftLeg': 'Left leg',
        'jointPartRightLeg': 'Right leg',
        'jointPartLeg': 'Lower limbs',
        'jointPartOther': 'Other',
        'modelStructure': 'Structure',
        'codeEditor': 'Editor',
        'animationEditor': 'Animation Editor',
        'animationExperimental': 'Experimental · In development',

        // Animation editor
        'autoKey': 'Auto Key',
        'addKeyframe': 'Add Key',
        'deleteKeyframe': 'Delete Key',
        'time': 'Time',
        'duration': 'Duration',
        'loop': 'Loop',
        'importAnimation': 'Import',
        'exportAnimation': 'Export',
        'animationNoModel': 'Load a URDF, Xacro or MJCF model to animate it.',
        'animationHint': 'Double-click a track to add a keyframe. Drag a diamond to move it.',
        'dopeSheet': 'Dope Sheet',
        'graphView': 'Graph',
        'catalogCustom': '＋ New / custom model…',
        'playToRobot': 'Play on Robot',
        'playToRobotTitle': 'Play current animation on the real robot',
        'playToRobotOffline': 'Robot not connected: connect in the Robot panel first',
        'playToRobotNoClip': 'No animation to play',
        'playToRobotRunning': 'Playing on the robot…',
        'addMarker': 'Marker',
        'addMedia': 'Media',
        'snapFrames': 'Snap 30fps',
        'zoom': 'Zoom',
        'keyTime': 'Key Time',
        'keyValue': 'Value',
        'interpolation': 'Interpolation',
        'autoSmooth': 'Auto Smooth',
        'smooth': 'Smooth',
        'broken': 'Broken',
        'linear': 'Linear',
        'step': 'Step',
        'selectionHint': 'Shift adds, Ctrl/Cmd toggles, and dragging empty space box-selects.',
        'animationName': 'Animation name',
        'markerName': 'Marker name',
        'animationGuideStartTitle': 'Record the starting pose',
        'animationGuideStartText': 'Leave the model in its current pose. This records every joint and moves the playhead forward by one second.',
        'animationGuideStartButton': 'Record starting pose',
        'animationGuideAdjustTitle': 'Create the next pose',
        'animationGuideAdjustText': 'The playhead is at {time}. Adjust joints in the Joints panel; Auto Key records each change. Continue when the pose is ready.',
        'animationGuideContinueTitle': 'Keep adding poses',
        'animationGuideContinueText': '{count} pose times are ready. You are at {time}; adjust the model, record and advance, or preview the result.',
        'animationGuideRecord': 'Record current pose',
        'animationGuideNext': 'Record and advance 1s',
        'animationGuidePlay': 'Play',
        'animationPoseRecorded': 'Recorded {count} joints at {time}',
        'animationPoseRecordedNext': 'Pose recorded; moved to {time}',
        'animationAutoKeyOn': 'Auto Key is on: joint changes will be recorded',
        'animationAutoKeyOff': 'Auto Key is off',
        'animationAutoKeyed': 'Auto-keyed {joint} at {time}',
        'animationImported': 'Imported “{name}”',
        'animationAdd': 'Add',
        'animationAddPose': 'Record current pose',
        'animationAddPoseNext': 'Record pose and advance 1s',
        'animationAddSelectedKey': 'Key selected track only',
        'animationAddMedia': 'Add audio or video',
        'animationAddEvent': 'Add event track',
        'animationAddMarker': 'Add time marker',
        'animationSavePose': 'Save reusable pose',
        'animationKeySavedPose': 'Key saved pose',
        'animationAudioReactive': 'Generate keys from audio',
        'animationClip': 'Animation',
        'animationClipOptions': 'Animation options',
        'animationNewClip': 'New animation',
        'animationDuplicateClip': 'Duplicate',
        'animationRenameClip': 'Rename',
        'animationDeleteClip': 'Delete',
        'animationUndo': 'Undo (Ctrl/Cmd+Z)',
        'animationRedo': 'Redo (Ctrl/Cmd+Shift+Z)',
        'animationStop': 'Stop',
        'animationPlayPause': 'Play/Pause (Space)',
        'animationRecordHint': 'Record armed or selected tracks',
        'animationLiveInput': 'Live gamepad input',
        'animationGuideOpen': 'Quick start guide',
        'animationProjectFile': 'Project file',
        'animationImportJson': 'Import JSON',
        'animationExportJson': 'Export JSON',
        'animationClose': 'Close',
        'animationPrevKey': 'Previous keyframe (J)',
        'animationNextKey': 'Next keyframe (K)',
        'animationPrevFrame': 'Previous frame (Left)',
        'animationNextFrame': 'Next frame (Right)',
        'animationEditSelection': 'Edit selection',
        'animationCopy': 'Copy',
        'animationPaste': 'Paste',
        'animationDeleteSelection': 'Delete selection',
        'animationLoopHint': 'Loop playback',
        'animationSnapHint': 'Snap to 30 fps frames',
        'animationZoomHint': 'Timeline zoom',
        'animationFitTime': 'Fit animation',
        'animationFitValue': 'Fit graph values',
        'animationFreeMove': 'Free move',
        'animationLockTimeAxis': 'Lock to time axis',
        'animationLockValueAxis': 'Lock to value axis',
        'animationLockGraph': 'Lock displayed curves to the current selection',
        'animationUnlockGraph': 'Unlock displayed curves',
        'animationEventState': 'State',
        'animationEventColor': 'Color',
        'animationSavedPose': 'Saved pose',
        'animationPose': 'Pose',
        'animationDeletePose': 'Delete saved pose',
        'animationSelectionHelp': 'Shift adds · Ctrl/Cmd toggles · Alt/Option-click or double-click selects the whole column · red track dot arms recording',
        'animationDismiss': 'Dismiss',
        'animationLiveInputTitle': 'Live Input',
        'animationLiveInputDesc': 'Map gamepad axes or keyboard pairs, then record editable keys.',
        'animationNoGamepad': 'No gamepad detected',
        'animationKeyboardReady': 'Keyboard ready · no gamepad detected',
        'animationAxes': 'axes',
        'animationButtons': 'buttons',
        'animationClearInput': 'Clear',
        'animationAutoMapAxes': 'Auto map axes',
        'animationAudioReactiveTitle': 'Audio Reactive Keys',
        'animationAudioReactiveDesc': 'Convert an imported waveform into editable joint keyframes.',
        'animationAudioSource': 'Audio source',
        'animationTargetTrack': 'Target track',
        'animationMinimum': 'Minimum',
        'animationMaximum': 'Maximum',
        'animationKeysPerSecond': 'Keys / second',
        'animationSmoothing': 'Smoothing',
        'animationReplaceKeys': 'Replace existing keys in the generated range',
        'animationGeneratedEditable': 'The generated keys remain fully editable in Dope Sheet and Graph.',
        'animationGenerateKeys': 'Generate keys',
        'animationShortcuts': 'Space Play · J/K Keys · ←/→ Frames · Ctrl/Cmd C/V · Delete · Ctrl/Cmd Z',
        'animationTracks': 'Tracks',
        'animationGraphEmpty': 'Select one or more tracks to edit curves',
        'animationImportAudioFirst': 'Import an audio file and select a movable joint track first.',
        'animationSaveFailed': 'Save failed',
        'animationKeyCount': '{count} keys',
        'animationDefaultName': 'Animation {index}',
        'animationUnmapped': 'Unmapped',
        'animationAxisN': 'Axis {index}',
        'animationKeysPair': 'Keys {keys}',
        'animationInvert': 'Invert',
        'animationSmoothShort': 'Smooth',
        'animationLoadRobotFirst': 'Load a robot with movable joints first.',
        'animationEventTrackName': 'Event track name',
        'animationEventTrigger': 'Trigger event',
        'animationEventOnOff': 'On / off event',
        'animationEventValue': 'Curved value',
        'animationEventColorEvent': 'Color event',
        'animationPoseName': 'Pose name',
        'animationPoseDefault': 'Pose {index}',
        'animationMediaImportFailed': 'Media import failed: {message}',
        'animationImportFailed': 'Animation import failed: {message}',
        'animationUnsupportedMedia': 'Unsupported media file',

        // Joint control
        'radian': 'Radian',
        'degree': 'Degree',
        'reset': 'Reset',
        'limits': 'Limits',

        // MuJoCo simulation
        'mujocoReset': 'Reset',
        'mujocoSimulate': 'Simulate',
        'mujocoPause': 'Pause',

        // Code editor
        'reload': 'Reload',
        'download': 'Download',
        'saved': 'Saved',
        'unsaved': 'Unsaved',
        'noFileOpen': 'No File Open',

        // Help dialog
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'robot': 'Robot',
        'robotPanelTitle': 'Robot Control',
        'robotCatalogLabel': 'Model Select',
        'about': 'About',
        'aboutContent': 'Robot Viewer is a web-based 3D viewer for robot models and scenes. Built on top of Three.js, it provides an intuitive interface for visualizing, editing, and simulating robots directly in the browser without any installation required. This tool helps you visualize and analyze robot structures, joints, and physical properties.<br><br>Format Support: URDF, Xacro, MJCF, USD (partial support)<br>Robot Types: Serial and branched robots, plus MJCF parallel mechanisms<br>Linked joints automatically maintain closed chains while editing parallel mechanism poses.<br><br>Developed by <strong>Ziqi Fan</strong>.',
        'projectHome': 'Project Home',
        'email': 'Email',
        'myGithub': 'My GitHub',
        'operations': 'Operations',
        'leftDrag': 'Left Drag',
        'rotateView': 'Rotate View',
        'rightDrag': 'Right Drag',
        'panView': 'Pan View',
        'scroll': 'Scroll',
        'zoom': 'Zoom',
        'clickModel': 'Click Model',
        'controlJoint': 'Control Joint (Draggable)',
        'dragFile': 'Drag File',
        'loadModel': 'Load Robot Model',
        'contact': 'Contact',
        'support': 'Support',

        // Others
        'noFolder': 'No Folder Loaded',
        'noModel': 'No Model Loaded',
        'load': 'Load',
        'loadFiles': 'Load Files',
        'loadFolder': 'Load Folder',
        'orClickButton': 'or click the button below to load',
        'noControllableJoints': 'No Controllable Joints Found',
        'closedChainReady': 'Closed-chain constraints satisfied',
        'closedChainPartial': 'This model includes unsupported constraints',
        'actuatedJoint': 'Drive',
        'springJoint': 'Spring',
        'springJointHint': 'Spring joint; rigid meshes do not show spring bending and may separate visually at large deflections',
        'closedChainUnreachable': 'Position cannot close the chain; previous pose restored',
        'clickToEditMin': 'Click to edit minimum',
        'clickToEditMax': 'Click to edit maximum',
        'dropHint': 'Drag and drop robot model files or folders anywhere',
        'dropHintSub': 'Supports URDF, Xacro, MJCF formats<br>Supports folder dragging to load mesh files',
        'graphHint': 'Drag: Move | Scroll: Zoom | Right-click: Hide/Show | Ctrl+Click: Measure',
        'copyright': '© 2025 Ziqi Fan. All rights reserved.',

        // Model info
        'type': 'Type',
        'links': 'Links',
        'joints': 'Joints',
        'controllable': 'Controllable',
        'rootLink': 'Root Link',

        // Hover info
        'linkName': 'Link Name',
        'jointName': 'Joint',
        'mass': 'Mass',
        'mergedLinks': 'Merged Links',

        // File types
        'model': 'Model',
        'mesh': 'Mesh',
        'link': 'Link',

        // Units
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // Status messages
        'loading': 'Loading',
        'unsupportedFormat': 'Unsupported file format',
        'loadFailed': 'Load failed',
        'noSupportedFiles': 'No supported files found (URDF, Xacro, MJCF, DAE, STL, OBJ)',
        'loadSuccess': 'Model loaded successfully',
        'cannotLoadMesh': 'Cannot load mesh file',

        // Editor messages
        'unsavedChanges': 'You have unsaved changes. Are you sure you want to close?',
        'newFile': 'newfile.xml',
        'noFileToReload': 'No file to reload',
        'saveFirst': 'Please save the file first before loading',
        'reloadingModel': 'Reloading model...',
        'modelReloaded': 'Model reloaded (unsaved)',
        'reloadFailed': 'Reload failed',
        'downloadFailed': 'Download failed',
        'fileDownloaded': 'File downloaded',
        'emptyContent': 'Editor content is empty, cannot load',
        'fileType': 'File Type'
    }
};

class I18n {
    constructor() {
        // 检测浏览器语言
        const browserLang = this.detectBrowserLanguage();
        // 从localStorage读取语言设置，如果没有则使用浏览器语言
        this.currentLang = localStorage.getItem('language') || browserLang;
    }

    /**
     * 检测浏览器语言
     */
    detectBrowserLanguage() {
        const lang = navigator.language || navigator.userLanguage;
        // 如果浏览器语言是中文（包括zh, zh-CN, zh-TW等），返回zh-CN
        if (lang.toLowerCase().startsWith('zh')) {
            return 'zh-CN';
        }
        // 否则默认返回英文
        return 'en-US';
    }

    /**
     * 获取翻译文本
     */
    t(key) {
        const lang = translations[this.currentLang] || translations['zh-CN'];
        return lang[key] || key;
    }

    /**
     * 切换语言
     */
    setLanguage(lang) {
        if (translations[lang]) {
            this.currentLang = lang;
            localStorage.setItem('language', lang);
            this.updatePageLanguage();
        }
    }

    /**
     * 获取当前语言
     */
    getCurrentLanguage() {
        return this.currentLang;
    }

    /**
     * 更新页面上所有带有data-i18n属性的元素
     */
    updatePageLanguage() {
        // 更新所有带有data-i18n属性的元素
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const text = this.t(key);

            // 如果是input或textarea，更新placeholder
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                element.placeholder = text;
            } else {
                // 如果包含HTML标签（如<br>），使用innerHTML
                if (text.includes('<br>') || text.includes('<strong>')) {
                    element.innerHTML = text;
                } else {
                    element.textContent = text;
                }
            }
        });

        // 更新带 data-i18n-title 的提示气泡
        document.querySelectorAll('[data-i18n-title]').forEach(element => {
            element.title = this.t(element.getAttribute('data-i18n-title'));
        });

        // 更新HTML lang属性
        document.documentElement.lang = this.currentLang;
    }

    /**
     * 初始化页面语言
     */
    init() {
        this.updatePageLanguage();
    }
}

// 创建全局实例
export const i18n = new I18n();
