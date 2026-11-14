import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { classifyJointPart } from '../models/UnifiedRobotModel.js';
import { isVisualizationObject } from './JointDragControls.js';
import { buildChains, findChainForLink, readChainValues, selectArmChains, solveChain } from './kinematics.js';

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

        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._onKeyDown);
        this._bindCanvasClick();
    }

    get activeChain() {
        return this.chains[this.activeIndex] || null;
    }

    /** 模型切换：重建可控末端链。 */
    setModel(model) {
        const previousModel = this.model;
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
    }

    _handleGizmoChange() {
        const chain = this.activeChain;
        if (!this.enabled || !chain || !this.transform?.dragging) return;

        this.proxy.getWorldPosition(this._targetPosition);
        this.proxy.getWorldQuaternion(this._targetQuaternion);

        const translateMode = this.mode === MODE_TRANSLATE;
        const result = solveChain({
            chain,
            targetPosition: this._targetPosition,
            targetQuaternion: translateMode ? null : this._targetQuaternion,
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
        this._jacobianBuffer = this._jacobianBuffer || new Float64Array(6 * chain.joints.length);
        this.lastResult = result;
        this.dragErrorBudget = Math.max(this.dragErrorBudget, result.positionError || 0);
        this._updateHud();
        this.sceneManager.redraw();
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

    _endDrag() {
        const chain = this.activeChain;
        this._lastGizmoAt = performance.now();
        if (this.sceneManager.controls) this.sceneManager.controls.enabled = true;
        if (!chain) return;

        const before = this.preDragValues || [];
        chain.joints.forEach((joint, index) => {
            if (typeof before[index] !== 'number') return;
            if (Math.abs((joint.currentValue ?? 0) - before[index]) <= 1e-6) return;
            // commit 交给 Auto Key：动画编辑器据此记录一次完整姿态
            this.poseController.commitJointValue(joint.name, { source: 'viewport' });
        });
        this.preDragValues = null;

        // 目标点回到真实末端位姿，避免不可达时 gizmo 越飘越远
        this._syncProxy();
        this.transform?.attach(this.proxy);
        this._updateHud();
        this.sceneManager.redraw();
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
