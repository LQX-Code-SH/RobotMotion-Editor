import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { classifyJointPart } from '../models/UnifiedRobotModel.js';
import { isVisualizationObject } from './JointDragControls.js';
import { buildChains, findChainForLink, readChainValues, selectArmChains, solveChain } from './kinematics.js';
import {
    isJogKey,
    JOG_ROTATE_STEP_RAD,
    JOG_TICK_MS,
    JOG_TRANSLATE_STEP_M,
    normalizeJogKey,
    summarizeJog
} from './endEffectorJog.js';

const MODE_TRANSLATE = 'translate';
const MODE_ROTATE = 'rotate';

/**
 * 末端笛卡尔空间拖拽控制。
 *
 * 开启后在各串联分支末端放置 TransformControls gizmo：拖动箭头改位置、拖动圆环改姿态，
 * 每次变化都用数值 IK 反解整条关节链。拖动过程中只预览（commit:false），
 * 松开鼠标才 commit，从而让动画编辑器的 Auto Key 记录一次完整姿态。
 */
export class EndEffectorIKControls {
    constructor({ sceneManager, poseController, hudElement = null } = {}) {
        this.sceneManager = sceneManager;
        this.poseController = poseController;
        this.hud = hudElement || document.getElementById('ee-hud');

        this.enabled = false;
        this.model = null;
        this.chains = [];
        this.activeIndex = 0;
        this.mode = MODE_TRANSLATE;

        this.transform = null;
        this.proxy = new THREE.Object3D();
        this.proxy.name = 'EE_IK_TARGET';
        this.proxy.userData.isVisualization = true;

        this.lastResult = null;
        this.preDragValues = null;
        this.dragErrorBudget = 0;

        /** 默认锁定的关节（腰部），避免拖手臂时把腰一起转走 */
        this.waistJoints = [];
        this.lockedWaistJoints = new Set();
        this.onMenuChange = null;

        this._targetPosition = new THREE.Vector3();
        this._targetQuaternion = new THREE.Quaternion();
        this._jacobianBuffer = null;
        this._lastGizmoAt = 0;
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._clickStart = null;

        // 键盘 jog（真机面板「键盘控制」）
        this.keyboardEnabled = false;
        this.onKeyboardStateChange = null;
        this._pressedJog = new Set();
        this._jogTimer = null;

        // 真机同步控制下的末端限速：拖拽目标以有限速度追随鼠标，
        // 让模型与真机沿同一条受限轨迹运动（平时编辑不启用）。
        this.teleopLimited = false;
        this.teleopMaxSpeed = 0.3;         // m/s
        this.teleopMaxAngularSpeed = 1.5;  // rad/s
        this._limitedPosition = new THREE.Vector3();
        this._limitedQuaternion = new THREE.Quaternion();
        this._limitRaf = null;
        this._limitLastAt = 0;
        this._limitTempPos = new THREE.Vector3();
        this._limitTempQuat = new THREE.Quaternion();
        this._limitDelta = new THREE.Vector3();
        this._pendingEndDrag = false;
        this._endDragAt = 0;

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onJogKeyDown = this._onJogKeyDown.bind(this);
        this._onJogKeyUp = this._onJogKeyUp.bind(this);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keydown', this._onJogKeyDown);
        window.addEventListener('keyup', this._onJogKeyUp);
        this._bindCanvasClick();
    }

    get activeChain() {
        return this.chains[this.activeIndex] || null;
    }

    /** 模型切换：重建可控末端链。 */
    setModel(model) {
        const previousModel = this.model;
        this._pendingEndDrag = false;
        this._stopLimitLoop();
        this.model = model || null;
        this.chains = this.model ? selectArmChains(buildChains(this.model)) : [];
        this.activeIndex = 0;
        this.lastResult = null;
        this._jacobianBuffer = null;
        this._syncWaistJoints(previousModel !== this.model);
        this.onMenuChange?.();

        if (!this.enabled) {
            this._updateHud();
            return;
        }
        if (!this.chains.length) {
            if (this.keyboardEnabled) this.setKeyboardEnabled(false);
            this.transform?.detach();
            this._updateHud();
            return;
        }
        this._syncProxy();
        this._attach();
    }

    setEnabled(enabled) {
        const next = Boolean(enabled);
        if (this.enabled === next) return;
        this.enabled = next;

        // IK 模式独占画布交互：暂停关节拖拽与临时滑块，避免抢走 gizmo 的点击
        this.sceneManager.ikControlActive = next;
        if (this.sceneManager.dragControls) {
            this.sceneManager.dragControls.enabled = !next;
        }
        if (!next) {
            this.sceneManager.dragControls?.update?.();
        }

        const button = document.getElementById('toggle-ee-control-btn');
        button?.classList.toggle('active', next);
        button?.setAttribute('data-checked', String(next));

        if (next) {
            this._ensureTransform();
            this._applyMode();
            this._syncProxy();
            this._attach();
        } else {
            // 关闭末端控制时一并退出键盘 jog，避免残留下发
            if (this.keyboardEnabled) this.setKeyboardEnabled(false);
            this._pendingEndDrag = false;
            this._stopLimitLoop();
            this.transform?.detach();
            this.sceneManager.controls && (this.sceneManager.controls.enabled = true);
        }

        this._updateHud();
        this.onMenuChange?.();
        this.sceneManager.redraw();
    }

    toggle() {
        this.setEnabled(!this.enabled);
    }

    setMode(mode) {
        const next = mode === MODE_ROTATE ? MODE_ROTATE : MODE_TRANSLATE;
        if (next === this.mode && this.transform?.mode === next) {
            this._updateHud();
            return;
        }
        this.mode = next;
        this._applyMode();
        this._updateHud();
        this.onMenuChange?.();
        // 渲染是按需的：不主动 redraw 时，gizmo 要等下一次点击才换形态
        this.sceneManager?.redraw();
    }

    /** R 键：平移 ⇄ 旋转 循环切换。 */
    toggleMode() {
        this.setMode(this.mode === MODE_TRANSLATE ? MODE_ROTATE : MODE_TRANSLATE);
    }

    // ==================== 下拉菜单数据 ====================

    /** 供控制栏下拉渲染的状态快照。 */
    getMenuState() {
        return {
            mode: this.mode,
            chains: this.chains.map((chain, index) => ({
                id: chain.id,
                label: chain.eeLinkName,
                active: index === this.activeIndex
            })),
            waistJoints: this.waistJoints.map((name) => ({
                name,
                locked: this.lockedWaistJoints.has(name)
            }))
        };
    }

    setWaistLocked(jointName, locked) {
        if (!this.waistJoints.includes(jointName)) return;
        if (locked) this.lockedWaistJoints.add(jointName);
        else this.lockedWaistJoints.delete(jointName);
        // 勾选状态由 checkbox 自己维护，不重渲染菜单，避免焦点/引用丢失
        this.lastResult = null;
        this._updateHud();
    }

    /** 按末端链 id 切换控制目标。 */
    selectChain(id) {
        const index = this.chains.findIndex((chain) => chain.id === id);
        if (index < 0 || index === this.activeIndex) return;
        this.activeIndex = index;
        this.lastResult = null;
        this._jacobianBuffer = null;
        this._syncProxy();
        this._attach();
        this._updateHud();
        this.onMenuChange?.();
    }

    /** 键盘 jog 开关（真机控制面板）。开启时自动启用末端控制。 */
    setKeyboardEnabled(enabled) {
        const next = Boolean(enabled);
        if (next) {
            if (!this.model || !this.chains.length) {
                this.onKeyboardStateChange?.(false);
                return;
            }
            this.setEnabled(true);
        }
        if (this.keyboardEnabled === next) return;
        this.keyboardEnabled = next;
        if (!next) this._stopJog();
        this.onKeyboardStateChange?.(next);
    }

    /** 语言切换后刷新 HUD 文案。 */
    refreshLanguage() {
        this._updateHud();
    }

    /** 关节被外部重置/播放后，让 gizmo 重新贴合真实末端。 */
    refresh() {
        if (!this.enabled || !this.activeChain) return;
        this.lastResult = null;
        this._syncProxy();
        this.transform?.attach(this.proxy);
        this._updateHud();
        this.sceneManager.redraw();
    }

    /** 在双臂/多分支之间切换控制目标。 */
    cycleChain() {
        if (!this.chains.length) return;
        this.activeIndex = (this.activeIndex + 1) % this.chains.length;
        this.lastResult = null;
        this._jacobianBuffer = null;
        this._syncProxy();
        this._attach();
        this._updateHud();
        this.onMenuChange?.();
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
        this.transform?.detach();
        if (this.transform) {
            this.sceneManager?.scene?.remove(this.transform);
            this.transform.dispose?.();
            this.transform = null;
        }
        if (this.proxy.parent) this.proxy.parent.remove(this.proxy);
    }

    // ==================== 内部实现 ====================

    /** 收集链上的腰部关节；模型切换时默认全部锁定。 */
    _syncWaistJoints(modelChanged = false) {
        const names = [];
        this.chains.forEach((chain) => {
            chain.joints.forEach((joint) => {
                if (classifyJointPart(joint.name) !== 'waist') return;
                if (!names.includes(joint.name)) names.push(joint.name);
            });
        });

        const previous = this.lockedWaistJoints;
        this.waistJoints = names;
        if (modelChanged || !previous.size) {
            this.lockedWaistJoints = new Set(names);
            return;
        }
        this.lockedWaistJoints = new Set(names.filter((name) => previous.has(name)));
    }

    /** 点击模型上的 link 时切换到该分支的末端（与 Tab 行为一致）。 */
    _bindCanvasClick() {
        const domElement = this.sceneManager?.renderer?.domElement
            || this.sceneManager?.canvas
            || document.getElementById('canvas');
        if (!domElement) return;
        this._domElement = domElement;

        domElement.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            this._clickStart = { x: event.clientX, y: event.clientY };
        });

        domElement.addEventListener('pointerup', (event) => {
            if (event.button !== 0 || !this._clickStart) return;
            const distance = Math.hypot(event.clientX - this._clickStart.x, event.clientY - this._clickStart.y);
            this._clickStart = null;
            if (!this.enabled || distance > 4) return;
            if (this.transform?.dragging) return;
            // 刚结束 gizmo 拖动时，这次 pointerup 属于 gizmo 交互
            if (performance.now() - this._lastGizmoAt < 250) return;
            this._selectChainAtPointer(event);
        });
    }

    _selectChainAtPointer(event) {
        const chain = this.activeChain;
        if (!chain || !this.model?.threeObject || !this.sceneManager?.camera) return;
        const rect = this._domElement.getBoundingClientRect();
        this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointer, this.sceneManager.camera);

        const hits = this._raycaster.intersectObject(this.model.threeObject, true);
        const hit = hits.find((item) => {
            const object = item.object;
            if (!object?.isMesh) return false;
            if (object.isURDFCollider || object.userData?.isCollision || object.userData?.isCollisionGeom) return false;
            return !isVisualizationObject(object);
        });
        if (!hit) return;

        let node = hit.object;
        while (node) {
            const isLink = node.isURDFLink || node.type === 'URDFLink';
            if (isLink && node.name && this.model.links?.has(node.name)) break;
            node = node.parent;
        }
        if (!node?.name) return;

        const matched = findChainForLink(this.chains, node.name);
        if (matched && matched.id !== chain.id) {
            this.selectChain(matched.id);
        }
    }

    _ensureTransform() {
        if (this.transform) return;
        const domElement = this.sceneManager?.renderer?.domElement
            || this.sceneManager?.canvas
            || document.getElementById('canvas');
        if (!domElement) return;

        const transform = new TransformControls(this.sceneManager.camera, domElement);
        transform.setSize(0.85);
        transform.setSpace('world');
        transform.setMode(this.mode);
        transform.addEventListener('objectChange', () => this._handleGizmoChange());
        transform.addEventListener('mouseDown', () => this._beginDrag());
        transform.addEventListener('mouseUp', () => this._endDrag());

        this.sceneManager.scene.add(transform);
        if (!this.proxy.parent) this.sceneManager.scene.add(this.proxy);
        this.transform = transform;
    }

    _applyMode() {
        this.transform?.setMode(this.mode);
    }

    _attach() {
        const chain = this.activeChain;
        if (!this.transform || !chain) return;
        this._syncProxy();
        this.transform.attach(this.proxy);
        this.sceneManager.redraw();
    }

    _syncProxy() {
        const chain = this.activeChain;
        if (!chain?.eeObject) return;
        chain.eeObject.getWorldPosition(this._targetPosition);
        chain.eeObject.getWorldQuaternion(this._targetQuaternion);
        this.proxy.position.copy(this._targetPosition);
        this.proxy.quaternion.copy(this._targetQuaternion);
        this.proxy.updateMatrixWorld(true);
    }

    _beginDrag() {
        const chain = this.activeChain;
        if (!chain) return;
        if (this.sceneManager.controls) this.sceneManager.controls.enabled = false;
        this.preDragValues = readChainValues(chain);
        this.dragErrorBudget = 0;
        this._pendingEndDrag = false;

        if (this.teleopLimited) {
            this.proxy.getWorldPosition(this._limitedPosition);
            this.proxy.getWorldQuaternion(this._limitedQuaternion);
            this._startLimitLoop();
        }
    }

    /**
     * 真机同步控制开关：开启后拖拽目标按有限末端速度追随鼠标。
     * @param {boolean} enabled
     * @param {{maxSpeed?: number, maxAngularSpeed?: number}} [options] m/s、rad/s
     */
    setTeleopLimited(enabled, { maxSpeed = 0.3, maxAngularSpeed = 1.5 } = {}) {
        this.teleopLimited = Boolean(enabled);
        if (Number.isFinite(maxSpeed)) this.teleopMaxSpeed = Math.max(0.02, maxSpeed);
        if (Number.isFinite(maxAngularSpeed)) this.teleopMaxAngularSpeed = Math.max(0.05, maxAngularSpeed);
        if (!this.teleopLimited) {
            this._pendingEndDrag = false;
            this._stopLimitLoop();
        }
    }

    _stopLimitLoop() {
        if (!this._limitRaf) return;
        cancelAnimationFrame(this._limitRaf);
        this._limitRaf = null;
    }

    /** 按帧推进“受限目标”，并对其解 IK。 */
    _startLimitLoop() {
        this._stopLimitLoop();
        this._limitLastAt = performance.now();
        const tick = () => {
            this._limitRaf = requestAnimationFrame(tick);
            if (!this.activeChain) return;

            const now = performance.now();
            const dt = Math.min(0.05, Math.max(0, (now - this._limitLastAt) / 1000));
            this._limitLastAt = now;
            if (dt <= 0) return;

            const translateMode = this.mode === MODE_TRANSLATE;
            let moved = false;

            this.proxy.getWorldPosition(this._limitTempPos);
            if (translateMode) {
                this._limitDelta.subVectors(this._limitTempPos, this._limitedPosition);
                const distance = this._limitDelta.length();
                if (distance > 1e-5) {
                    const maxStep = this.teleopMaxSpeed * dt;
                    if (distance <= maxStep) this._limitedPosition.copy(this._limitTempPos);
                    else this._limitedPosition.addScaledVector(this._limitDelta, maxStep / distance);
                    moved = true;
                }
            } else {
                this._limitedPosition.copy(this._limitTempPos);
            }

            this.proxy.getWorldQuaternion(this._limitTempQuat);
            if (!translateMode) {
                const angle = this._limitedQuaternion.angleTo(this._limitTempQuat);
                if (angle > 1e-5) {
                    const maxAngle = this.teleopMaxAngularSpeed * dt;
                    this._limitedQuaternion.slerp(this._limitTempQuat, Math.min(1, maxAngle / angle));
                    moved = true;
                }
            } else {
                this._limitedQuaternion.copy(this._limitTempQuat);
            }

            if (moved || this._pendingEndDrag) this._solveToLimitedTarget();

            if (this._pendingEndDrag) {
                const converged = this._limitedPosition.distanceToSquared(this._limitTempPos) < 1e-8;
                if (converged || now - this._endDragAt > 1500) this._finishDrag();
            }
        };
        this._limitRaf = requestAnimationFrame(tick);
    }

    /** 对“受限目标”解一次 IK（与 _solveToTarget 同参数口径）。 */
    _solveToLimitedTarget() {
        const chain = this.activeChain;
        if (!chain) return;
        const translateMode = this.mode === MODE_TRANSLATE;
        const result = solveChain({
            chain,
            targetPosition: this._limitedPosition,
            targetQuaternion: translateMode ? null : this._limitedQuaternion,
            applyValues: (values) => this._applyValues(chain, values),
            posWeight: translateMode ? 1 : 0.35,
            rotWeight: translateMode ? 0 : 1,
            maxIterations: 20,
            maxStep: translateMode ? 0.12 : 0.18,
            damping: 0.02,
            ignoreLimits: Boolean(this.sceneManager.ignoreLimits),
            lockedJointNames: Array.from(this.lockedWaistJoints),
            jacobianBuffer: this._jacobianBuffer
        });
        this.lastResult = result;
        this.dragErrorBudget = Math.max(this.dragErrorBudget, result.positionError || 0);
        this._updateHud();
        this.sceneManager.redraw();
    }

    _handleGizmoChange() {
        if (!this.enabled || !this.activeChain || !this.transform?.dragging) return;
        // 遥操作限速：目标由 _startLimitLoop 按帧推进，这里不再直接解算
        if (this.teleopLimited) return;
        const translateMode = this.mode === MODE_TRANSLATE;
        this._solveToTarget({
            posWeight: translateMode ? 1 : 0.35,
            rotWeight: translateMode ? 0 : 1,
            maxStep: translateMode ? 0.12 : 0.18,
            useOrientation: !translateMode
        });
    }

    /**
     * 把当前代理位姿当作目标解一次 IK。拖动与键盘 jog 共用。
     *
     * @returns {object|null} solveChain 结果
     */
    _solveToTarget({ posWeight = 1, rotWeight = 0.25, maxStep = 0.15, useOrientation = true } = {}) {
        const chain = this.activeChain;
        if (!chain) return null;

        this.proxy.getWorldPosition(this._targetPosition);
        this.proxy.getWorldQuaternion(this._targetQuaternion);

        const result = solveChain({
            chain,
            targetPosition: this._targetPosition,
            targetQuaternion: useOrientation ? this._targetQuaternion : null,
            applyValues: (values) => this._applyValues(chain, values),
            posWeight,
            rotWeight,
            maxIterations: 20,
            maxStep,
            damping: 0.02,
            ignoreLimits: Boolean(this.sceneManager.ignoreLimits),
            lockedJointNames: Array.from(this.lockedWaistJoints),
            jacobianBuffer: this._jacobianBuffer
        });
        this._jacobianBuffer = this._jacobianBuffer || new Float64Array(6 * chain.joints.length);
        this.lastResult = result;
        this.dragErrorBudget = Math.max(this.dragErrorBudget, result.positionError || 0);
        this._updateHud();
        this.sceneManager.redraw();
        return result;
    }

    _applyValues(chain, values) {
        chain.joints.forEach((joint, index) => {
            this.poseController.setJointValue(joint.name, values[index], {
                source: 'viewport',
                commit: false,
                render: false,
                measure: false,
                applyConstraints: false
            });
        });
        this.model?.threeObject?.updateMatrixWorld?.(true);
        if (chain.isParallel) {
            // 闭环机构：主链 IK 后再把被动关节投影回约束面
            this.poseController.projectConstraints(chain.joints);
        }
    }

    /** 拖动或 jog 结束时把变化的关节 commit 一次（Auto Key 据此记录关键帧）。 */
    _commitJointChanges(chain) {
        const before = this.preDragValues || [];
        chain.joints.forEach((joint, index) => {
            if (typeof before[index] !== 'number') return;
            if (Math.abs((joint.currentValue ?? 0) - before[index]) <= 1e-6) return;
            this.poseController.commitJointValue(joint.name, { source: 'viewport' });
        });
        this.preDragValues = null;
    }

    _endDrag() {
        this._lastGizmoAt = performance.now();
        if (this.sceneManager.controls) this.sceneManager.controls.enabled = true;
        if (!this.activeChain) return;

        if (this.teleopLimited && this._limitRaf) {
            // 受限目标可能还没追到鼠标位置：收敛后再 commit，避免拖动被截断
            this._pendingEndDrag = true;
            this._endDragAt = performance.now();
            return;
        }
        this._finishDrag();
    }

    _finishDrag() {
        const chain = this.activeChain;
        this._pendingEndDrag = false;
        this._stopLimitLoop();
        if (chain) this._commitJointChanges(chain);

        // 目标点回到真实末端位姿，避免不可达时 gizmo 越飘越远
        this._syncProxy();
        this.transform?.attach(this.proxy);
        this._updateHud();
        this.sceneManager.redraw();
    }

    // ==================== 键盘 jog ====================

    _onJogKeyDown(event) {
        if (!this.keyboardEnabled || !this.enabled) return;
        const target = event.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const key = normalizeJogKey(event.key);
        if (!isJogKey(key)) return;

        // 浏览器自动重复会带来不可控的速率，统一交给定时器
        event.preventDefault();
        if (event.repeat) return;

        this._pressedJog.add(key);
        this._startJog();
    }

    _onJogKeyUp(event) {
        if (!this.keyboardEnabled) return;
        const key = normalizeJogKey(event.key);
        if (!this._pressedJog.has(key)) return;
        this._pressedJog.delete(key);
        if (!this._pressedJog.size) this._stopJog();
    }

    _startJog() {
        const chain = this.activeChain;
        if (!chain) return;
        if (this._jogTimer) return;

        // 每次重新开始时以真实末端为起点，清掉上一次的累计误差
        if (!this.preDragValues) this.preDragValues = readChainValues(chain);
        this._syncProxy();
        this._jogTimer = setInterval(() => this._jogTick(), JOG_TICK_MS);
    }

    _stopJog() {
        if (this._jogTimer) {
            clearInterval(this._jogTimer);
            this._jogTimer = null;
        }
        this._pressedJog.clear();

        const chain = this.activeChain;
        if (!chain || !this.preDragValues) return;
        this._commitJointChanges(chain);
        this._syncProxy();
        this.transform?.attach(this.proxy);
        this._updateHud();
        this.sceneManager?.redraw();
    }

    _jogTick() {
        if (!this.keyboardEnabled || !this.enabled) {
            this._stopJog();
            return;
        }
        const intent = summarizeJog(this._pressedJog);
        if (!intent.active) return;
        this._applyJogStep(intent);
    }

    /** 基座坐标系平移 + 工具局部轴旋转，单 tick 一个步长。 */
    _applyJogStep(intent) {
        const chain = this.activeChain;
        if (!chain) return;

        const modelQuaternion = this.model?.threeObject?.getWorldQuaternion(new THREE.Quaternion())
            || new THREE.Quaternion();
        const step = new THREE.Vector3(
            intent.translation.x,
            intent.translation.y,
            intent.translation.z
        ).multiplyScalar(JOG_TRANSLATE_STEP_M).applyQuaternion(modelQuaternion);
        this.proxy.position.add(step);

        const { roll, pitch, yaw } = intent.rotation;
        const rotating = Boolean(roll || pitch || yaw);
        if (rotating) {
            const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                roll * JOG_ROTATE_STEP_RAD,
                pitch * JOG_ROTATE_STEP_RAD,
                yaw * JOG_ROTATE_STEP_RAD,
                'XYZ'
            ));
            this.proxy.quaternion.multiply(delta).normalize();
        }

        this.proxy.updateMatrixWorld(true);
        // 平移时用较低姿态权重保持工具朝向，旋转时同时跟踪位置与姿态
        this._solveToTarget({
            posWeight: 1,
            rotWeight: rotating ? 1 : 0.5,
            maxStep: 0.15,
            useOrientation: true
        });
    }

    _onKeyDown(event) {
        if (!this.enabled) return;
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (event.key === 'r' || event.key === 'R') {
            this.toggleMode();
        } else if (event.key === 'Tab') {
            event.preventDefault();
            this.cycleChain();
        }
    }

    _updateHud() {
        if (!this.hud) return;
        const t = (key, fallback) => window.i18n?.t?.(key) || fallback;
        const chain = this.activeChain;

        const title = this.hud.querySelector('#ee-hud-title');
        const mode = this.hud.querySelector('#ee-hud-mode');
        const pos = this.hud.querySelector('#ee-hud-pos');
        const rot = this.hud.querySelector('#ee-hud-rot');
        const status = this.hud.querySelector('#ee-hud-status');

        if (!this.enabled) {
            this.hud.hidden = true;
            return;
        }
        this.hud.hidden = false;
        this.hud.classList.remove('is-error', 'is-warn');

        if (!chain) {
            if (title) title.textContent = t('eeNoChains', '当前模型无可控末端');
            if (mode) mode.textContent = '';
            if (pos) pos.textContent = '—';
            if (rot) rot.textContent = '—';
            if (status) status.textContent = '';
            this.hud.classList.add('is-warn');
            return;
        }

        const index = this.chains.length > 1
            ? ` ${this.activeIndex + 1}/${this.chains.length}`
            : '';
        if (title) title.textContent = `${chain.eeLinkName}${index}`;
        if (mode) mode.textContent = t(
            this.mode === MODE_TRANSLATE ? 'eeModeTranslate' : 'eeModeRotate',
            this.mode === MODE_TRANSLATE ? '平移' : '旋转'
        );

        const result = this.lastResult;
        const positionError = result?.positionError;
        if (pos) pos.textContent = Number.isFinite(positionError) ? `${(positionError * 1000).toFixed(1)} mm` : '—';
        if (rot) {
            const rotationError = result?.rotationError;
            rot.textContent = Number.isFinite(rotationError) ? `${(rotationError * 180 / Math.PI).toFixed(1)}°` : '—';
        }

        if (status) {
            if (!Number.isFinite(positionError)) {
                status.textContent = t('eeReady', '已就绪：拖动坐标轴 / 旋转环');
            } else if (result.converged) {
                status.textContent = t('eeConverged', '已到达目标位姿');
            } else if (result.clampCount > 0) {
                status.textContent = t('eeLimitReached', '受关节限位限制');
                this.hud.classList.add('is-warn');
            } else {
                status.textContent = t('eeUnreachable', '超出可达范围');
                this.hud.classList.add('is-error');
            }
        }
    }
}
