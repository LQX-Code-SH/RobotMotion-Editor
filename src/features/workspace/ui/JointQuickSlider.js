import * as THREE from 'three';
import { findJointAxisName, isVisualizationObject } from '../../../utils/JointDragControls.js';

const CLICK_MOVE_TOLERANCE = 5;
const CLICK_TIME_LIMIT = 400;

function isInCollider(object) {
    let node = object;
    while (node) {
        if (node.isURDFCollider) return true;
        node = node.parent;
    }
    return false;
}

function isVisibleInTree(object) {
    let node = object;
    while (node) {
        if (node.visible === false) return false;
        node = node.parent;
    }
    return true;
}

/**
 * 临时关节滑块：点击关节轴箭头或对应零件时，在鼠标附近弹出一个滑块，
 * 直接调节该关节。点击空白处 / Esc / 关闭按钮消失。
 */
export class JointQuickSlider {
    constructor({ sceneManager, poseController }) {
        this.sceneManager = sceneManager;
        this.poseController = poseController;
        this.joint = null;
        this.panel = null;
        this.pointerDown = null;
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.enableAll();

        this.poseController?.subscribe?.((event) => {
            if (!this.joint || this.panel?.hidden) return;
            if (event.type !== 'jointChanged' || event.jointName !== this.joint.name) return;
            // 自己拖动滑块产生的更新已在 _applyValue 中处理
            if (event.source === 'user') return;
            this.syncValue();
        });
    }

    init() {
        this.canvas = document.getElementById('canvas');
        if (!this.canvas) return;

        this.canvas.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            this.pointerDown = { x: event.clientX, y: event.clientY, t: Date.now() };
        });

        this.canvas.addEventListener('mouseup', (event) => {
            if (event.button !== 0 || !this.pointerDown) return;
            const distance = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
            const duration = Date.now() - this.pointerDown.t;
            this.pointerDown = null;
            if (distance <= CLICK_MOVE_TOLERANCE && duration <= CLICK_TIME_LIMIT) {
                this.handleCanvasClick(event.clientX, event.clientY);
            }
        });

        document.addEventListener('mousedown', (event) => {
            if (!this.panel || this.panel.hidden) return;
            if (this.panel.contains(event.target)) return;
            this.close();
        }, true);

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') this.close();
        });
    }

    /** 点击画布：命中关节轴箭头或零件时打开临时滑块 */
    handleCanvasClick(clientX, clientY) {
        // 末端 IK 模式下点击属于 gizmo 交互，不弹临时滑块
        if (this.sceneManager?.ikControlActive) return;
        const joint = this.pickJoint(clientX, clientY);
        if (!joint) {
            this.close();
            return;
        }
        this.open(joint, clientX, clientY);
    }

    pickJoint(clientX, clientY) {
        const model = this.sceneManager?.currentModel;
        const camera = this.sceneManager?.camera;
        if (!model?.threeObject || !camera || !this.canvas) return null;

        const rect = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        this.raycaster.setFromCamera(mouse, camera);
        const hits = this.raycaster.intersectObject(model.threeObject, true);

        for (const hit of hits) {
            const object = hit.object;
            if (!object.isMesh || isInCollider(object)) continue;

            if (isVisualizationObject(object)) {
                // 只有显示的关节轴箭头可以打开滑块
                const axisName = findJointAxisName(object);
                if (!axisName || !isVisibleInTree(object)) continue;
                const joint = model.joints?.get(axisName);
                if (joint && joint.type !== 'fixed') return joint;
                continue;
            }

            const joint = this.findJointFromLink(object, model);
            if (joint) return joint;
        }
        return null;
    }

    /** 从零件网格向上找最近的、可调节的关节（跳过 fixed） */
    findJointFromLink(object, model) {
        let node = object;
        while (node) {
            if (node.isURDFJoint || node.type === 'URDFJoint') {
                const joint = model.joints?.get(node.name);
                if (joint && joint.type !== 'fixed') return joint;
            }
            node = node.parent;
        }
        return null;
    }

    // ---------- 面板 ----------

    ensurePanel() {
        if (this.panel) return this.panel;

        const panel = document.createElement('div');
        panel.className = 'joint-quick-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <div class="joint-quick-head">
                <span class="joint-quick-name"></span>
                <button type="button" class="joint-quick-close" title="关闭">×</button>
            </div>
            <div class="joint-quick-row">
                <input type="range" class="joint-quick-slider" />
                <input type="number" class="joint-quick-value" step="0.01" />
                <span class="joint-quick-unit"></span>
                <button type="button" class="joint-quick-reset" title="重置为 0">↺</button>
            </div>
            <div class="joint-quick-limits"></div>
        `;

        this.nameEl = panel.querySelector('.joint-quick-name');
        this.sliderEl = panel.querySelector('.joint-quick-slider');
        this.valueEl = panel.querySelector('.joint-quick-value');
        this.unitEl = panel.querySelector('.joint-quick-unit');
        this.limitsEl = panel.querySelector('.joint-quick-limits');
        this.resetButton = panel.querySelector('.joint-quick-reset');

        panel.querySelector('.joint-quick-close').addEventListener('click', () => this.close());
        this.resetButton.addEventListener('click', () => this.resetValue());
        this.sliderEl.addEventListener('input', () => {
            this.applyValue(parseFloat(this.sliderEl.value), false);
        });
        this.sliderEl.addEventListener('change', () => this.commitValue());
        this.valueEl.addEventListener('change', () => {
            const display = parseFloat(this.valueEl.value);
            if (!Number.isFinite(display)) {
                this.syncValue();
                return;
            }
            this.applyValue(this.fromDisplay(display), false);
            this.commitValue();
        });

        document.body.appendChild(panel);
        this.panel = panel;
        return panel;
    }

    open(joint, clientX, clientY) {
        const panel = this.ensurePanel();
        this.joint = joint;

        this.nameEl.textContent = joint.name;
        this.nameEl.title = joint.name;

        const { lower, upper } = this.getRange(joint);
        this.sliderEl.min = String(lower);
        this.sliderEl.max = String(upper);
        this.sliderEl.step = String((upper - lower) / 1000);
        this.sliderEl.value = String(joint.currentValue ?? lower);
        this.syncValue();

        panel.hidden = false;
        const rect = panel.getBoundingClientRect();
        const left = Math.min(clientX + 14, window.innerWidth - rect.width - 8);
        const top = Math.min(clientY + 14, window.innerHeight - rect.height - 8);
        panel.style.left = `${Math.max(8, left)}px`;
        panel.style.top = `${Math.max(8, top)}px`;
    }

    close() {
        if (!this.panel) return;
        this.panel.hidden = true;
        this.joint = null;
    }

    getRange(joint) {
        const limits = joint.limits || {};
        let lower = Number.isFinite(limits.lower) ? limits.lower : -Math.PI;
        let upper = Number.isFinite(limits.upper) ? limits.upper : Math.PI;
        if (joint.type === 'continuous' || this.sceneManager?.ignoreLimits) {
            lower = -Math.PI;
            upper = Math.PI;
        }
        if (!(upper > lower)) {
            lower = -Math.PI;
            upper = Math.PI;
        }
        return { lower, upper };
    }

    get useDegrees() {
        return !this.isPrismatic && Boolean(document.getElementById('unit-deg')?.classList.contains('active'));
    }

    get isPrismatic() {
        return this.joint?.type === 'prismatic';
    }

    get digits() {
        if (this.isPrismatic) return 4;
        return this.useDegrees ? 1 : 3;
    }

    toDisplay(rad) {
        return this.useDegrees ? (rad * 180) / Math.PI : rad;
    }

    fromDisplay(value) {
        return this.useDegrees ? (value * Math.PI) / 180 : value;
    }

    syncValue() {
        if (!this.joint || !this.panel) return;
        const value = this.joint.currentValue ?? 0;
        this.sliderEl.value = String(value);
        this.valueEl.value = this.toDisplay(value).toFixed(this.digits);
        this.unitEl.textContent = this.isPrismatic ? 'm' : (this.useDegrees ? '°' : 'rad');

        const { lower, upper } = this.getRange(this.joint);
        const unit = this.isPrismatic ? 'm' : (this.useDegrees ? '°' : 'rad');
        this.limitsEl.textContent = `${this.toDisplay(lower).toFixed(this.digits)} ~ ${this.toDisplay(upper).toFixed(this.digits)} ${unit}`;
    }

    applyValue(rad, commit) {
        if (!this.joint) return;
        const applied = this.poseController?.setJointValue(this.joint.name, rad, {
            source: 'user',
            commit: false
        });
        if (Number.isFinite(applied)) this.joint.currentValue = applied;
        this.syncValue();
        if (commit) this.commitValue();
    }

    commitValue() {
        if (this.joint) this.poseController?.commitJointValue(this.joint.name, { source: 'user' });
    }

    /** 重置为 0（服务端/姿态控制器依旧按限位裁剪） */
    resetValue() {
        if (!this.joint) return;
        this.applyValue(0, true);
    }
}
